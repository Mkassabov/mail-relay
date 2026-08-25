# mail-relay

A Cloudflare Worker that receives inbound email on a domain you own and forwards it to a configurable destination, with a per-(sender, alias) whitelist and held-email review flow.

## How it works

- Mail to `<alias>@<MAIL_RELAY_DOMAIN>` is delivered to the Worker by Cloudflare Email Routing.
- If that sender is already whitelisted for that alias, the Worker sends the message onward using `MAIL_RELAY_FORWARD_TEMPLATE`.
- Otherwise the raw `.eml` is stored in R2 and a pending request is written to D1. R2 lifecycle deletes held objects after 3 days.
- An admin approves or rejects via HTTP API or `pnpm admin`. Approve forwards the original message, then adds the sender to the whitelist for that alias.

Whitelists are **per sender per alias**. Approval for `foo@<domain>` does not grant `bar@<domain>`.

Outbound mail uses Cloudflare’s `send_email` binding. `Reply-To` is the original sender.

The relay re-sends rather than bounces, so it rebuilds the message: MIME parts are decoded and
re-encoded (text, HTML, inline images and attachments are all preserved), and `In-Reply-To` /
`References` are carried over with the original’s `Message-ID` appended, so a relayed exchange
stays one thread in both mailboxes. Attachments over 12 MB in total are dropped, with a note in
the body naming them.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 11+
- A Cloudflare account
- The zone for `MAIL_RELAY_DOMAIN` already in that account (Alchemy will not register a domain)
- That zone using Cloudflare nameservers (Email Routing's MX/SPF records are written on the zone)

Alchemy is a project dependency. You do not need a global install.

> **The `alchemy` dependency is pinned to a PR preview build**, not a published
> release: `https://pkg.ing/alchemy/dc87a4d`. This project uses
> `Cloudflare.email({ zone }).subscribe(...)`, which is not in `2.0.0-beta.74`.
> It ships in [alchemy#401](https://github.com/alchemy-run/alchemy/pull/401)
> (with [#1349](https://github.com/alchemy-run/alchemy/pull/1349)); swap the pin
> for a released version once those land. `pnpm-workspace.yaml` sets
> `blockExoticSubdeps: false` because that preview resolves some of its own
> dependencies by URL — that can be dropped at the same time.

### Cloudflare credentials: API token, not OAuth

**`alchemy login`'s OAuth flow cannot deploy this project.** Cloudflare publishes no
Email Routing OAuth scope, so an OAuth credential gets `Forbidden: Authentication error`
on every `/email/routing` call — including plain reads. Use an **API token** (or the
Global API Key).

Create the token at **My Profile → API Tokens → Create Token → Create Custom Token**.
The stack touches:

| Scope   | Permission                    | Why                                       |
| ------- | ----------------------------- | ----------------------------------------- |
| Account | Workers Scripts: Edit         | the Worker, its subdomain and custom domain |
| Account | D1: Edit                      | whitelist / held / log database           |
| Account | Workers R2 Storage: Edit      | held `.eml` bucket and its lifecycle rule |
| Account | Email Routing Addresses: Edit | register the forward destination          |
| Account | Account Settings: Read        | resolve the account                       |
| Zone    | Email Routing Rules: Edit     | enable routing, point the catch-all at the Worker |
| Zone    | Zone: Read                    | resolve the zone from `MAIL_RELAY_DOMAIN` |
| Zone    | DNS: Edit                     | the Worker's custom-domain record         |

Scope the zone permissions to the zone holding `MAIL_RELAY_DOMAIN`. A Global API Key
works too and skips the permission list, at the cost of being an all-permissions
account credential.

## Setup

```sh
pnpm install
cp .env.example .env
# Edit .env — MAIL_RELAY_DOMAIN, MAIL_RELAY_FORWARD_TEMPLATE, ADMIN_BEARER_TOKEN
pnpm alchemy login          # choose "API token", paste the token from above
pnpm deploy
```

`pnpm deploy` wraps `alchemy deploy --stage prod`. The stage is pinned in
`package.json` on purpose: the CLI otherwise defaults to `dev_${USER}`, which differs
between machines and would deploy a **second** relay alongside the live one. `plan`,
`destroy`, `tail` and `dev` are pinned the same way.

If your saved profile is not the default, prefix commands with it:

```sh
ALCHEMY_PROFILE=personal pnpm deploy
```

Note `--profile` is a CLI flag and `STAGE` is read before `.env` is loaded, so neither
can be set from `.env`.

The deploy creates, in one pass:

1. Email Routing enabled on the zone (`example.com` for `xyz.mail.example.com`)
2. The zone's catch-all rule, pointed at the Worker
3. The D1 database (and applies `migrations/`)
4. The R2 bucket
5. The forward destination, registered as an Email Routing address
6. The Worker, with `MAIL_RELAY_DOMAIN` as its custom domain

Steps 1, 2 and 5 are declared **by the Worker itself** — `Cloudflare.email({ zone }).subscribe(...)`
in `src/worker.ts` yields the routing resources as siblings of the Worker, so `alchemy.run.ts`
holds nothing but the Worker.

### Environment variables

| Variable                      | Required for | Description                                                               | Example                       |
| ----------------------------- | ------------ | ------------------------------------------------------------------------- | ----------------------------- |
| `MAIL_RELAY_DOMAIN`           | deploy       | Hostname that receives mail (and the Worker's custom domain)              | `relay.example.com`           |
| `MAIL_RELAY_FORWARD_TEMPLATE` | deploy       | Destination template — `${alias}` is replaced with the inbound local part | `you+${alias}@example.com`    |
| `ADMIN_BEARER_TOKEN`          | deploy, CLI  | Bearer token for the admin HTTP API                                       | `openssl rand -hex 32`        |
| `WORKER_URL`                  | admin CLI    | Worker URL from the deploy output — not set automatically                 | `https://relay.example.com`   |

`MAIL_RELAY_DOMAIN` may be a subdomain several levels deep. The zone is derived from its
last two labels (`xyz.mail.example.com` → `example.com`), and that zone is what Email Routing is
enabled on.

## The one manual step

**Verify the forward destination.** Cloudflare will not deliver `send_email` to an address
it has not verified. The deploy registers the address, which makes Cloudflare send a
verification mail to it — **click the link in that mail**. Until you do, forwards fail
with `SendEmailError`.

It is genuinely manual: the API can set an address back to `unverified`, but setting it to
`verified` requires account-admin privileges, so there is nothing to automate against a
normal API token.

Only the **base** address needs verifying, even with a plus-addressed template. Cloudflare
matches `you+anything@example.com` against a verified `you@example.com`, so
`MAIL_RELAY_FORWARD_TEMPLATE=you+${alias}@example.com` needs exactly one click, not one
per alias.

Nothing else is manual. MX and SPF records are written when Email Routing is enabled; the
catch-all, the custom domain and its certificate are all provisioned by the deploy.

## Verifying a deployment

```sh
export TOKEN=$(grep '^ADMIN_BEARER_TOKEN=' .env | cut -d= -f2)
export URL=$(grep '^WORKER_URL=' .env | cut -d= -f2-)

curl -s -H "Authorization: Bearer $TOKEN" "$URL/whitelist" | jq length
curl -s -o /dev/null -w '%{http_code}\n' "$URL/whitelist"    # 401 — auth is enforced
```

To exercise the full inbound path without another mail account, register a throwaway
Email Routing address **on the relay's own domain**. Cloudflare's verification mail then
travels the real route — MX, Email Routing, catch-all, the Worker:

```sh
# in the Cloudflare dashboard: Email → Email Routing → Destination addresses →
# add  probe@<MAIL_RELAY_DOMAIN>   (do NOT verify it)

curl -s -H "Authorization: Bearer $TOKEN" "$URL/requests" | jq
# the verification mail appears as a held request from
# bounces@cf-bounce.notify.cloudflare.com

curl -X POST -H "Authorization: Bearer $TOKEN" "$URL/requests/<ID>/approve"
# forwards it on and whitelists that (sender, alias) pair
```

Mail that arrives from an already-whitelisted sender skips `/requests` entirely and shows
up in `/log` with `trigger: "forward"`. Delete the throwaway address afterwards; Cloudflare
refuses for the first few minutes with `EmailAddressCreatedTooRecently`.

If a message is held that you expected to be forwarded, the sender is not whitelisted for
that exact alias — whitelisting is per (sender, alias).

## Admin API

All endpoints require `Authorization: Bearer <ADMIN_BEARER_TOKEN>`.

### Whitelist

```sh
curl "$WORKER_URL/whitelist" -H "Authorization: Bearer $ADMIN_BEARER_TOKEN"

curl -X POST "$WORKER_URL/whitelist" \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sender": "alice@example.com", "alias": "support"}'

curl -X DELETE "$WORKER_URL/whitelist" \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sender": "alice@example.com", "alias": "support"}'
```

### Held requests

```sh
curl "$WORKER_URL/requests" -H "Authorization: Bearer $ADMIN_BEARER_TOKEN"

curl -X POST "$WORKER_URL/requests/<ID>/approve" \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN"

curl -X POST "$WORKER_URL/requests/<ID>/reject" \
  -H "Authorization: Bearer $ADMIN_BEARER_TOKEN"
```

### Sent log

```sh
curl "$WORKER_URL/log" -H "Authorization: Bearer $ADMIN_BEARER_TOKEN"
```

## Admin CLI

Reads `WORKER_URL` and `ADMIN_BEARER_TOKEN` from `.env`. Node 22+ runs the TypeScript entry directly.

```sh
pnpm admin whitelist list
pnpm admin whitelist add alice@example.com support
pnpm admin whitelist remove alice@example.com support

pnpm admin requests list
pnpm admin requests approve <id>
pnpm admin requests reject <id>
pnpm admin requests review   # interactive review of pending requests

pnpm admin log
```

To bake those env values into a standalone binary (Node [SEA](https://nodejs.org/api/single-executable-applications.html), no Bun compile):

```sh
pnpm build:cli
./dist/mail-relay whitelist list
```

## Resources

Every one of these is created by `pnpm deploy`; none are configured by hand.

| Resource       | Logical ID       | Declared in       | Purpose                                    |
| -------------- | ---------------- | ----------------- | ------------------------------------------ |
| D1 Database    | `DB`             | `src/resources.ts`| Whitelist, held requests, sent-mail log    |
| R2 Bucket      | `HeldEmails`     | `src/resources.ts`| Raw `.eml` storage (3-day lifecycle)       |
| SendEmail      | `EMAIL`          | `src/resources.ts`| Outbound `send_email` binding              |
| Worker         | `Worker`         | `src/worker.ts`   | Email handler + admin API + custom domain  |
| Email Routing  | `EmailRouting`   | `src/worker.ts`   | Enables inbound mail on the zone           |
| Catch-all      | `EmailCatchAll`  | `src/worker.ts`   | Hands unmatched inbound mail to the Worker |
| Email Address  | `Destination`    | `src/worker.ts`   | Registers the forward destination          |

`EmailRouting`, `EmailCatchAll` and `Destination` are yielded from inside the Worker's
own Effect rather than from `alchemy.run.ts` — the first two by
`Cloudflare.email({ zone }).subscribe(...)`, which wires the runtime `email` listener and
the deploy-time routing in one call.

The `send_email` binding is deliberately **unrestricted**. Setting `destinationAddress`
pins it to one exact recipient, which would reject every plus-addressed forward the relay
sends. Cloudflare still only delivers to addresses verified on the account.

## Development

```sh
pnpm typecheck   # tsgo --noEmit
pnpm lint        # oxlint
pnpm fmt         # oxfmt
pnpm test        # node --test, MIME round-trip cases
pnpm plan        # show what a deploy would change, without changing it
```

Local Worker loop (cloud resources still deploy; email send is simulated unless you opt the binding into live):

```sh
pnpm dev
```

### Config is read through `Config`, not `process.env`

`MAIL_RELAY_DOMAIN` and friends are resolved with `effect/Config` inside the Worker's
Effect, and the Worker's own props are an Effect for the same reason. A module-scope
`process.env.X` read returns `undefined`: the CLI imports `alchemy.run.ts` **before** it
loads `.env`. That silently produced a Worker with no custom domain. Keep new config on
the `Config` path.

## Tear down

```sh
pnpm destroy
```

Held R2 objects are emptied on destroy (`forceDestroy`). The zone itself is not deleted,
and Email Routing is left enabled on it — it is a per-zone singleton that other rules may
depend on, so the relay declines to switch it off. The catch-all is restored to whatever
it was before the relay first claimed it.
