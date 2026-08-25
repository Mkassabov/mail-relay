#!/usr/bin/env node

declare const __WORKER_URL__: string | undefined;
declare const __ADMIN_BEARER_TOKEN__: string | undefined;
if (typeof __WORKER_URL__ === "string" && __WORKER_URL__.length > 0) {
  process.env.WORKER_URL ??= __WORKER_URL__;
}
if (typeof __ADMIN_BEARER_TOKEN__ === "string" && __ADMIN_BEARER_TOKEN__.length > 0) {
  process.env.ADMIN_BEARER_TOKEN ??= __ADMIN_BEARER_TOKEN__;
}

import * as Clank from "alchemy/Util/Clank";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { MailRelayApi } from "./api.ts";

const env = Effect.orDie(
  Effect.all({
    url: Config.string("WORKER_URL"),
    token: Config.string("ADMIN_BEARER_TOKEN"),
  }),
);

const ClientLive = Layer.unwrap(
  Effect.map(env, ({ token }) =>
    Layer.effect(
      HttpClient.HttpClient,
      HttpClient.HttpClient.pipe(
        Effect.map(HttpClient.mapRequest(HttpClientRequest.bearerToken(token))),
      ),
    ).pipe(Layer.provide(FetchHttpClient.layer)),
  ),
);

const makeClient = Effect.flatMap(env, ({ url }) =>
  HttpApiClient.make(MailRelayApi, { baseUrl: url }),
);

const whitelist = {
  list: Effect.gen(function* () {
    const client = yield* makeClient;
    const entries = yield* client.Admin.listWhitelist({});
    if (entries.length === 0) {
      yield* Clank.info("No whitelist entries.");
      return;
    }
    for (const e of entries) {
      yield* Clank.info(`${e.sender} → ${e.alias}  (${e.created_at ?? "?"})`);
    }
  }),

  add: (sender: string, alias: string) =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      yield* client.Admin.addWhitelist({ payload: { sender, alias } });
      yield* Clank.success(`Added ${sender} → ${alias}`);
    }),

  remove: (sender: string, alias: string) =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      yield* client.Admin.removeWhitelist({ payload: { sender, alias } });
      yield* Clank.success(`Removed ${sender} → ${alias}`);
    }),
};

const requests = {
  list: Effect.gen(function* () {
    const client = yield* makeClient;
    const rows = yield* client.Admin.listRequests({});
    if (rows.length === 0) {
      yield* Clank.info("No held requests.");
      return;
    }
    for (const r of rows) {
      yield* Clank.info(
        `[${r.status}] ${r.id.slice(0, 8)} — ${r.sender} → ${r.alias} — ${r.subject ?? "(no subject)"}  (${r.received_at})`,
      );
    }
  }),

  approve: (id: string) =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      yield* client.Admin.approveRequest({ params: { id } });
      yield* Clank.success(`Approved ${id}`);
    }),

  reject: (id: string) =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      yield* client.Admin.rejectRequest({ params: { id } });
      yield* Clank.success(`Rejected ${id}`);
    }),

  review: Effect.gen(function* () {
    const client = yield* makeClient;
    const rows = yield* client.Admin.listRequests({});
    const pending = rows.filter((r) => r.status === "pending");
    if (pending.length === 0) {
      yield* Clank.info("No pending requests.");
      return;
    }

    for (const r of pending) {
      yield* Clank.info(
        `\n${r.sender} → ${r.alias}\n  Subject: ${r.subject ?? "(no subject)"}\n  Received: ${r.received_at}`,
      );
      const action = yield* Clank.select({
        message: `Action for ${r.id.slice(0, 8)}?`,
        options: [
          { value: "approve" as const, label: "Approve" },
          { value: "reject" as const, label: "Reject" },
          { value: "skip" as const, label: "Skip" },
        ],
      });
      if (action === "skip") continue;
      if (action === "approve") {
        const result = yield* client.Admin.approveRequest({ params: { id: r.id } });
        yield* Clank.success(
          `Approved — ${result.whitelisted.sender} whitelisted for ${result.whitelisted.alias}`,
        );
      } else {
        yield* client.Admin.rejectRequest({ params: { id: r.id } });
        yield* Clank.success("Rejected");
      }
    }
  }),
};

const log = {
  list: Effect.gen(function* () {
    const client = yield* makeClient;
    const entries = yield* client.Admin.listLog({});
    if (entries.length === 0) {
      yield* Clank.info("No emails sent.");
      return;
    }
    for (const e of entries) {
      yield* Clank.info(
        `[${e.trigger}] ${e.sender} → ${e.alias} → ${e.recipient}  "${e.subject ?? "(no subject)"}"  (${e.sent_at})`,
      );
    }
  }),
};

const USAGE = `Usage: pnpm admin <command>
       ./dist/mail-relay <command>

Commands:
  whitelist list                     List all whitelist entries
  whitelist add <sender> <alias>     Add a whitelist entry
  whitelist remove <sender> <alias>  Remove a whitelist entry
  requests list                      List all held requests
  requests approve <id>              Approve a held request
  requests reject <id>               Reject a held request
  requests review                    Interactively review pending requests
  log                                List sent email log`;

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

const main = (() => {
  if (cmd === "whitelist") {
    if (sub === "list") return whitelist.list;
    if (sub === "add" && args[2] && args[3]) return whitelist.add(args[2], args[3]);
    if (sub === "remove" && args[2] && args[3]) return whitelist.remove(args[2], args[3]);
  }
  if (cmd === "requests") {
    if (sub === "list") return requests.list;
    if (sub === "approve" && args[2]) return requests.approve(args[2]);
    if (sub === "reject" && args[2]) return requests.reject(args[2]);
    if (sub === "review") return requests.review;
  }
  if (cmd === "log") return log.list;
  console.log(USAGE);
  // `return` so the fall-through is typed `never`; without it the IIFE
  // infers `... | undefined` and `main.pipe(...)` stops type-checking
  // against alchemy's published .d.ts surface.
  return process.exit(1);
})();

Effect.runPromise(main.pipe(Effect.orDie, Effect.provide(ClientLive)) as Effect.Effect<void>).catch(
  console.error,
);
