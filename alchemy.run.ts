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
    const domain = yield* Config.string("MAIL_RELAY_DOMAIN");
    const { rootZone } = parseDomain(domain);

    yield* Cloudflare.Email.Routing("EmailRouting", {
      zone: rootZone,
    });

    const worker = yield* Worker;

    yield* Cloudflare.Email.CatchAll("CatchAll", {
      zone: rootZone,
      name: "MailRelay worker",
      actions: [{ type: "worker", value: [worker.workerName] }],
    });

    return {
      url: worker.url,
    };
  }),
);
