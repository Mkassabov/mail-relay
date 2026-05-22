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

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.path, domain: process.env.MAIL_RELAY_DOMAIN },
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
                 FROM held_requests ORDER BY received_at DESC`,
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

            const held = yield* bucket.get(row.r2_key).pipe(Effect.orDie);
            if (held) {
              const tmpl = yield* forwardTemplate;
              const dom = yield* domain;
              const forwardTo = resolveForwardAddress(tmpl, row.alias);
              const rawBytes = yield* Effect.orDie(held.arrayBuffer());

              yield* Effect.orDie(
                email.send({
                  from: { email: `relay@${dom}`, name: row.sender },
                  replyTo: row.sender,
                  to: forwardTo,
                  subject: row.subject ?? "(no subject)",
                  text: new TextDecoder().decode(rawBytes),
                }),
              );
            }

            yield* db.batch([
              db
                .prepare("INSERT OR IGNORE INTO whitelist (sender, alias) VALUES (?1, ?2)")
                .bind(row.sender, row.alias),
              db
                .prepare("UPDATE held_requests SET status = 'approved' WHERE id = ?1")
                .bind(params.id),
            ]);

            yield* Effect.orDie(bucket.delete(row.r2_key));

            return {
              ok: true as const,
              whitelisted: { sender: row.sender, alias: row.alias },
            };
          }),
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
            yield* Effect.promise(() => message.forward(forwardTo));
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
