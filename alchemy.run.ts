import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { parseDomain } from "./src/config.ts";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "MailRelay",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const domain = yield* Effect.orDie(Config.string("MAIL_RELAY_DOMAIN"));
    const { rootZone } = parseDomain(domain);

    yield* Cloudflare.EmailRouting("EmailRouting", {
      zone: rootZone,
    });

    const worker = yield* Worker;

    return {
      url: worker.url,
    };
  }),
);
