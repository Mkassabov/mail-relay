import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "MailRelay",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  // Email.Routing and the zone's Email.CatchAll are no longer declared here:
  // the `Cloudflare.email({ zone }).subscribe(...)` call inside the Worker
  // yields both as siblings of the Worker at deploy time.
  Effect.gen(function* () {
    const worker = yield* Worker;

    return {
      url: worker.url,
    };
  }),
);
