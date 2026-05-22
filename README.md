# mail-relay

A Cloudflare Worker that receives inbound email on a subdomain and forwards it to a configurable destination, with a per-(sender, alias) whitelist and held-email review flow.

## How it works

- Email sent to `<alias>@<MAIL_RELAY_DOMAIN>` is received by the Worker via Cloudflare Email Routing.
- If the sender is whitelisted for that alias, the email is forwarded immediately to the address derived from `MAIL_RELAY_FORWARD_TEMPLATE`.
- If not, the raw email is stored in R2 and a review request is created in D1. The email is held for up to 3 days (R2 lifecycle auto-deletes it).
- An admin can approve (adds sender to whitelist for that alias) or reject the request via the HTTP API.

Whitelists are **per sender per alias** — a sender approved for `foo@<domain>` is not automatically approved for `bar@<domain>`.

When a held request is approved, the original email is forwarded to the destination via Cloudflare's `send_email` binding, with `Reply-To` set to the original sender.

## Prerequisites

- [Bun](https://bun.sh) installed
- A Cloudflare account with the relay domain added as a zone
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) enabled with a verified sending domain
- [Alchemy CLI](https://v2.alchemy.run/getting-started) (`alchemy` is installed as a project dependency)

### Email Routing setup

After the first deploy, configure Email Routing in the Cloudflare dashboard:

1. Go to **Email > Email Routing > Settings** for your zone. This will prompt you to add the required MX and verification DNS records automatically.
2. Under **Email > Email Routing > Routing rules**, edit the default catch-all rule to forward to the deployed Worker.

> **Why not automated?** Cloudflare only allows one catch-all rule per zone and the default cannot be deleted. The alchemy `EmailRule` provider always tries to create a new rule on first deploy, which conflicts. See [alchemy-effect#413](https://github.com/alchemy-run/alchemy-effect/issues/413).

## Setup

```sh
bun install
cp .env.example .env
# Edit .env with your values
```

### Environment variables

| Variable                      | Description                                                                        | Example                           |
| ----------------------------- | ---------------------------------------------------------------------------------- | --------------------------------- |
| `MAIL_RELAY_DOMAIN`           | Full domain (including subdomain) that receives email                              | `relay.example.com`               |
| `MAIL_RELAY_FORWARD_TEMPLATE` | Forwarding address template — `${alias}` is replaced with the recipient local part | `user+${alias}@example.com`       |
| `ADMIN_BEARER_TOKEN`          | Bearer token for the admin HTTP API                                                | (generate a secure random string) |

## Deploy

```sh
bun alchemy deploy --profile personal
```

First run will prompt for Cloudflare OAuth or API token login.

## Admin API

All endpoints require `Authorization: Bearer <ADMIN_BEARER_TOKEN>`.

### Whitelist

```sh
# List all whitelist entries
curl <WORKER_URL>/whitelist -H "Authorization: Bearer $TOKEN"

# Add a sender to the whitelist for an alias
curl -X POST <WORKER_URL>/whitelist \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sender": "alice@example.com", "alias": "support"}'

# Remove a whitelist entry
curl -X DELETE <WORKER_URL>/whitelist \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sender": "alice@example.com", "alias": "support"}'
```

### Held requests

```sh
# List all requests (pending, approved, rejected)
curl <WORKER_URL>/requests -H "Authorization: Bearer $TOKEN"

# Approve a request (adds sender+alias to whitelist)
curl -X POST <WORKER_URL>/requests/<ID>/approve \
  -H "Authorization: Bearer $TOKEN"

# Reject a request
curl -X POST <WORKER_URL>/requests/<ID>/reject \
  -H "Authorization: Bearer $TOKEN"
```

## Resources provisioned

| Resource      | Logical ID     | Purpose                                      |
| ------------- | -------------- | -------------------------------------------- |
| D1 Database   | `DB`           | Whitelist + held request metadata            |
| R2 Bucket     | `HeldEmails`   | Raw `.eml` storage (3-day lifecycle)         |
| Email Routing | `EmailRouting` | Enables inbound email on the zone            |
| SendEmail     | `EMAIL`        | Outbound email binding for approved forwards |
| Worker        | `Worker`       | Email handler + admin API                    |

## Admin CLI

Reads `WORKER_URL` and `ADMIN_BEARER_TOKEN` from `.env`.

```sh
bun run admin whitelist list
bun run admin whitelist add alice@example.com support
bun run admin whitelist remove alice@example.com support

bun run admin requests list
bun run admin requests approve <id>
bun run admin requests reject <id>
bun run admin requests review   # interactive review of pending requests
```

## Development

```sh
bun run typecheck   # tsgo --noEmit
bun run lint        # oxlint
bun run fmt         # oxfmt
```

## Tear down

```sh
bun alchemy destroy --profile personal
```
