/// <reference types="@cloudflare/workers-types" />

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { AuthMiddleware, MailRelayApi, NotFound, Unauthorized } from "./api.ts";
import { resolveForwardAddress } from "./config.ts";
import { DB, Email, HeldEmails } from "./resources.ts";

function extractBody(raw: string): { text?: string; html?: string } {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) return { text: raw };
  const headers = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd + 4);

  const ctMatch = headers.match(/^Content-Type:\s*(.+)/im);
  const ct = ctMatch?.[1] ?? "";

  const boundaryMatch = ct.match(/boundary="?([^";\r\n]+)"?/);
  if (!boundaryMatch) {
    if (/text\/html/i.test(ct)) return { html: body.trim() };
    return { text: body.trim() };
  }

  const boundary = boundaryMatch[1];
  const parts = body.split(`--${boundary}`);
  let text: string | undefined;
  let html: string | undefined;
  for (const part of parts) {
    const partBody = part.indexOf("\r\n\r\n");
    if (partBody === -1) continue;
    const content = part.slice(partBody + 4).trim();
    if (!text && /Content-Type:\s*text\/plain/i.test(part)) text = content;
    if (!html && /Content-Type:\s*text\/html/i.test(part)) html = content;
  }
  return { text, html: html ?? (text ? undefined : body.trim()) };
}

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.path,
    domain: process.env.MAIL_RELAY_DOMAIN,
    env: {
      test: "string",
    },
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1Connection.bind(DB);
    const bucket = yield* Cloudflare.R2Bucket.bind(HeldEmails);
    const email = yield* Cloudflare.SendEmail.bind(Email);
    const domain = yield* Alchemy.Variable("MAIL_RELAY_DOMAIN");
    const forwardTemplate = yield* Alchemy.Variable("MAIL_RELAY_FORWARD_TEMPLATE");
    const adminToken = yield* Alchemy.Secret("ADMIN_BEARER_TOKEN");

    // --- admin API ---

    const authMiddleware = Layer.succeed(AuthMiddleware, {
      bearer: (httpEffect: any, { credential }: any) =>
        Effect.gen(function* () {
          const token = yield* adminToken;
          if (Redacted.value(token) !== Redacted.value(credential)) {
            return yield* Effect.fail(new (Unauthorized as any)());
          }
          return yield* httpEffect;
        }),
    } as any);

    const adminGroup = HttpApiBuilder.group(MailRelayApi, "Admin", (handlers) =>
      handlers
        .handle("listWhitelist", () =>
          db
            .prepare("SELECT sender, alias, created_at FROM whitelist ORDER BY created_at DESC")
            .all<{ sender: string; alias: string; created_at: string }>()
            .pipe(Effect.map((r) => r.results ?? [])),
        )
        .handle("addWhitelist", ({ payload }) =>
          db
            .prepare("INSERT OR IGNORE INTO whitelist (sender, alias) VALUES (?1, ?2)")
            .bind(payload.sender.toLowerCase(), payload.alias.toLowerCase())
            .run()
            .pipe(Effect.map(() => ({ ok: true as const }))),
        )
        .handle("removeWhitelist", ({ payload }) =>
          db
            .prepare("DELETE FROM whitelist WHERE sender = ?1 AND alias = ?2")
            .bind(payload.sender.toLowerCase(), payload.alias.toLowerCase())
            .run()
            .pipe(Effect.map(() => ({ ok: true as const }))),
        )
        .handle("listRequests", () =>
          db
            .prepare(
              `SELECT id, sender, alias, subject, received_at, status
                 FROM held_requests WHERE status = 'pending' ORDER BY received_at DESC`,
            )
            .all<{
              id: string;
              sender: string;
              alias: string;
              subject: string | null;
              received_at: string;
              status: string;
            }>()
            .pipe(Effect.map((r) => r.results ?? [])),
        )
        .handle("approveRequest", ({ params }) =>
          Effect.gen(function* () {
            const row = yield* db
              .prepare(
                "SELECT sender, alias, subject, r2_key FROM held_requests WHERE id = ?1 AND status = 'pending'",
              )
              .bind(params.id)
              .first<{
                sender: string;
                alias: string;
                subject: string;
                r2_key: string;
              }>();

            if (!row) {
              return yield* Effect.fail(
                new NotFound({
                  message: "Request not found or already processed",
                }),
              );
            }

            const tmpl = yield* forwardTemplate;
            const recipientDomain = (yield* domain).toLowerCase();
            const forwardTo = resolveForwardAddress(tmpl, row.alias);

            const r2Obj = yield* Effect.orDie(bucket.get(row.r2_key));
            const body = r2Obj
              ? extractBody(yield* Effect.orDie(r2Obj.text()))
              : { text: "(original message body unavailable)" };

            yield* Effect.orDie(
              email.send({
                from: { name: `MR ${row.sender}`, email: `${row.alias}@${recipientDomain}` },
                to: forwardTo,
                subject: row.subject ?? "(no subject)",
                replyTo: row.sender,
                ...body,
              }),
            );

            yield* db.batch([
              db
                .prepare("INSERT OR IGNORE INTO whitelist (sender, alias) VALUES (?1, ?2)")
                .bind(row.sender, row.alias),
              db
                .prepare("UPDATE held_requests SET status = 'approved' WHERE id = ?1")
                .bind(params.id),
              db
                .prepare(
                  `INSERT INTO email_log (id, sender, alias, recipient, subject, trigger)
                   VALUES (?1, ?2, ?3, ?4, ?5, 'approve')`,
                )
                .bind(crypto.randomUUID(), row.sender, row.alias, forwardTo, row.subject),
            ]);

            yield* Effect.orDie(bucket.delete(row.r2_key));

            return {
              ok: true as const,
              whitelisted: { sender: row.sender, alias: row.alias },
            };
          }),
        )
        .handle("listLog", () =>
          db
            .prepare(
              `SELECT id, sender, alias, recipient, subject, sent_at, trigger
                 FROM email_log ORDER BY sent_at DESC`,
            )
            .all<{
              id: string;
              sender: string;
              alias: string;
              recipient: string;
              subject: string | null;
              sent_at: string;
              trigger: string;
            }>()
            .pipe(Effect.map((r) => r.results ?? [])),
        )
        .handle("rejectRequest", ({ params }) =>
          Effect.gen(function* () {
            const row = yield* db
              .prepare("SELECT r2_key FROM held_requests WHERE id = ?1 AND status = 'pending'")
              .bind(params.id)
              .first<{ r2_key: string }>();

            if (!row) {
              return yield* Effect.fail(
                new NotFound({
                  message: "Request not found or already processed",
                }),
              );
            }

            yield* db
              .prepare("UPDATE held_requests SET status = 'rejected' WHERE id = ?1")
              .bind(params.id)
              .run();

            yield* Effect.orDie(bucket.delete(row.r2_key));

            return { ok: true as const };
          }),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(MailRelayApi).pipe(
        Layer.provide(adminGroup),
        Layer.provide(authMiddleware),
        Layer.provide([HttpPlatform.layer, Etag.layer]),
        HttpRouter.toHttpEffect,
      ),
      email: (message: ForwardableEmailMessage) =>
        Effect.gen(function* () {
          const recipientDomain = (yield* domain).toLowerCase();
          const to = message.to.toLowerCase();

          if (!to.endsWith(`@${recipientDomain}`)) {
            message.setReject("Unknown recipient domain");
            return;
          }

          const alias = to.slice(0, to.indexOf("@"));
          const sender = message.from.toLowerCase();

          const whitelisted = yield* db
            .prepare("SELECT 1 FROM whitelist WHERE sender = ?1 AND alias = ?2")
            .bind(sender, alias)
            .first();

          if (whitelisted) {
            const tmpl = yield* forwardTemplate;
            const forwardTo = resolveForwardAddress(tmpl, alias);
            const recipientDomain = (yield* domain).toLowerCase();

            const raw = yield* Effect.promise(() => new Response(message.raw).text());
            const body = extractBody(raw);

            const fromHeader = message.headers.get("from") ?? sender;
            const nameMatch = fromHeader.match(/^"?([^"<]+)"?\s*</);
            const senderName = nameMatch?.[1]?.trim() ?? sender;
            const subject = message.headers.get("subject") ?? "(no subject)";

            yield* Effect.orDie(
              email.send({
                from: { name: `MR ${senderName} (${sender})`, email: `${alias}@${recipientDomain}` },
                to: forwardTo,
                subject,
                replyTo: sender,
                ...body,
              }),
            );

            yield* db
              .prepare(
                `INSERT INTO email_log (id, sender, alias, recipient, subject, trigger)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'forward')`,
              )
              .bind(crypto.randomUUID(), sender, alias, forwardTo, subject)
              .run();

            return;
          }

          const id = crypto.randomUUID();
          const r2Key = `held/${id}.eml`;
          const subject = message.headers.get("subject") ?? "(no subject)";

          const raw = yield* Effect.promise(() => new Response(message.raw).arrayBuffer());
          yield* bucket.put(r2Key, raw);

          yield* db
            .prepare(
              `INSERT INTO held_requests (id, sender, alias, subject, r2_key)
               VALUES (?1, ?2, ?3, ?4, ?5)`,
            )
            .bind(id, sender, alias, subject, r2Key)
            .run();
        }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(Cloudflare.D1ConnectionLive),
    Effect.provide(Cloudflare.R2BucketBindingLive),
    Effect.provide(Cloudflare.SendEmailBindingLive),
    Effect.orDie,
  ),
);
