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
- That zone using Cloudflare nameservers (Email Routing’s MX/SPF records are written on the zone)

Alchemy is a project dependency (`alchemy@2.0.0-beta.74`). You do not need a global install.

## Setup

```sh
pnpm install
cp .env.example .env
# Edit .env — at least MAIL_RELAY_DOMAIN, MAIL_RELAY_FORWARD_TEMPLATE, ADMIN_BEARER_TOKEN
pnpm alchemy login          # once per machine / profile
pnpm alchemy deploy         # add --profile personal if that is your saved profile
```

The first deploy:

1. Enables Email Routing on the zone (`example.com` for `relay.example.com`)
2. Creates the D1 database (and applies `migrations/`)
3. Creates the R2 bucket
4. Deploys the Worker (custom domain = `MAIL_RELAY_DOMAIN`)
5. Points the zone’s catch-all rule at that Worker

Then finish the human steps in [After deploy](#after-deploy). A single `alchemy deploy` cannot complete those.

### Environment variables

| Variable                      | Required for | Description                                                               | Example                     |
| ----------------------------- | ------------ | ------------------------------------------------------------------------- | --------------------------- |
| `MAIL_RELAY_DOMAIN`           | deploy       | Hostname that receives mail (and the Worker’s custom domain)              | `relay.example.com`         |
| `MAIL_RELAY_FORWARD_TEMPLATE` | deploy       | Destination template — `${alias}` is replaced with the inbound local part | `user+${alias}@example.com` |
| `ADMIN_BEARER_TOKEN`          | deploy, CLI  | Bearer token for the admin HTTP API                                       | a long random string        |
| `WORKER_URL`                  | admin CLI    | Worker URL from the deploy output — not set automatically                 | `https://relay.example.com` |

## After deploy

Do these before expecting mail to flow:

1. **Copy `WORKER_URL`.** Stack output `url` → `.env` as `WORKER_URL` if you use the admin CLI.
2. **Verify the send destination.** Cloudflare only delivers `send_email` to a destination that has been verified on the account. Register it under **Email → Email Routing → Destination addresses** (or `Cloudflare.Email.Address` in a stack) and **click the link Cloudflare emails**. Until that happens, forwards fail with `SendEmailError`.
   - A static template (`you@example.com`) needs that one address verified.
   - A plus-address template (`you+${alias}@example.com`) needs each exact address you send to verified, not only `you@example.com`.
3. **Confirm MX.** If the zone was already on Cloudflare DNS, enabling routing should have added MX/SPF. If nameservers are not Cloudflare, inbound mail will not arrive until they are.

Catch-all is managed as code now (`Cloudflare.Email.CatchAll`). You no longer need to edit the default catch-all in the dashboard. Cloudflare still allows only **one catch-all per zone** — if that zone already receives other mail, this Worker will take it. Use a dedicated zone if you need isolation.

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

| Resource      | Logical ID     | Purpose                                    |
| ------------- | -------------- | ------------------------------------------ |
| D1 Database   | `DB`           | Whitelist, held requests, sent-mail log    |
| R2 Bucket     | `HeldEmails`   | Raw `.eml` storage (3-day lifecycle)       |
| Email Routing | `EmailRouting` | Enables inbound mail on the zone           |
| Catch-all     | `CatchAll`     | Hands unmatched inbound mail to the Worker |
| SendEmail     | `EMAIL`        | Outbound `send_email` binding              |
| Worker        | `Worker`       | Email handler + admin API                  |

## Development

```sh
pnpm typecheck   # tsgo --noEmit
pnpm lint        # oxlint
pnpm fmt         # oxfmt
```

Local Worker loop (cloud resources still deploy; email send is simulated unless you opt the binding into live):

```sh
pnpm alchemy dev
```

## Tear down

```sh
pnpm alchemy destroy
```

Held R2 objects are emptied on destroy (`forceDestroy`). The zone itself is not deleted.
