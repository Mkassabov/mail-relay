/// <reference types="@cloudflare/workers-types" />

import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { AuthMiddleware, MailRelayApi, NotFound, Unauthorized } from "./api.ts";
import { resolveForwardAddress } from "./config.ts";
import {
  decodeWords,
  headerValue,
  parseAddress,
  parseMessage,
  sanitizeHeaderText,
  toForwardPayload,
} from "./mime.ts";
import { DB, Email, HeldEmails } from "./resources.ts";

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
});

/** Decode the sender's Subject for re-sending; never leave it empty. */
function forwardSubject(raw: string | null | undefined): string {
  return sanitizeHeaderText(decodeWords(raw ?? "")) || "(no subject)";
}

/**
 * Label the relayed message with the original sender. The display name comes
 * from the sender's own `From:` header, so it has to be decoded and stripped of
 * anything that could break out of the header line.
 */
function senderLabel(from: string, name?: string): string {
  const display = sanitizeHeaderText(name ?? "");
  return display && display.toLowerCase() !== from ? `MR ${display} (${from})` : `MR ${from}`;
}

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.url,
    domain: process.env.MAIL_RELAY_DOMAIN,
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(DB);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(HeldEmails);
    const email = yield* Cloudflare.Email.Send(yield* Email);
    const domain = yield* Config.string("MAIL_RELAY_DOMAIN");
    const forwardTemplate = yield* Config.string("MAIL_RELAY_FORWARD_TEMPLATE");
    const adminToken = yield* Config.redacted("ADMIN_BEARER_TOKEN");

    const authMiddleware = Layer.succeed(AuthMiddleware, {
      bearer: (httpEffect, { credential }) => {
        if (Redacted.value(adminToken) !== Redacted.value(credential)) {
          return Effect.fail(new Unauthorized());
        }
        return httpEffect;
      },
    });

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
              return yield* new NotFound({
                message: "Request not found or already processed",
              });
            }

            const recipientDomain = domain.toLowerCase();
            const forwardTo = resolveForwardAddress(forwardTemplate, row.alias);

            const r2Obj = yield* bucket.get(row.r2_key).pipe(Effect.orDie);
            const held = r2Obj
              ? parseMessage(yield* r2Obj.arrayBuffer().pipe(Effect.orDie))
              : undefined;
            const payload = held
              ? toForwardPayload(held)
              : { text: "(original message body unavailable)" };
            const originalFrom = held
              ? parseAddress(headerValue(held.headers, "from") ?? row.sender)
              : {};

            yield* email
              .send({
                from: {
                  name: senderLabel(row.sender, originalFrom.name),
                  email: `${row.alias}@${recipientDomain}`,
                },
                to: forwardTo,
                subject: forwardSubject(row.subject),
                replyTo: row.sender,
                ...payload,
              })
              .pipe(Effect.orDie);

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

            yield* bucket.delete(row.r2_key).pipe(Effect.orDie);

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
              return yield* new NotFound({
                message: "Request not found or already processed",
              });
            }

            yield* db
              .prepare("UPDATE held_requests SET status = 'rejected' WHERE id = ?1")
              .bind(params.id)
              .run();

            yield* bucket.delete(row.r2_key).pipe(Effect.orDie);

            return { ok: true as const };
          }),
        ),
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(MailRelayApi).pipe(
          Layer.provide(adminGroup),
          Layer.provide(authMiddleware),
          Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        ),
      ),
      email: (message: ForwardableEmailMessage) =>
        Effect.gen(function* () {
          const recipientDomain = domain.toLowerCase();
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
            const forwardTo = resolveForwardAddress(forwardTemplate, alias);

            // Read the message as bytes, not text: charset and transfer
            // encodings are per-part, so decoding up front corrupts anything
            // that isn't plain UTF-8.
            const raw = yield* Effect.promise(() => new Response(message.raw).arrayBuffer());
            const parsed = parseMessage(raw);

            const originalFrom = parseAddress(message.headers.get("from") ?? sender);
            const subject = forwardSubject(message.headers.get("subject"));

            yield* email
              .send({
                from: {
                  name: senderLabel(sender, originalFrom.name),
                  email: `${alias}@${recipientDomain}`,
                },
                to: forwardTo,
                subject,
                replyTo: sender,
                ...toForwardPayload(parsed),
              })
              .pipe(Effect.orDie);

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
          const subject = forwardSubject(message.headers.get("subject"));

          const raw = yield* Effect.promise(() => new Response(message.raw).arrayBuffer());
          yield* bucket.put(r2Key, raw).pipe(Effect.orDie);

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
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    Effect.provide(Cloudflare.R2.ReadWriteBucketBinding),
    Effect.provide(Cloudflare.Email.SendBinding),
    Effect.orDie,
  ),
);
