import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export const security = { bearer: HttpApiSecurity.bearer };

export class AuthMiddleware extends HttpApiMiddleware.Service<AuthMiddleware>()("AuthMiddleware", {
  error: Unauthorized,
  security,
}) {}

export const WhitelistEntry = Schema.Struct({
  sender: Schema.String,
  alias: Schema.String,
  created_at: Schema.optional(Schema.String),
});

export const SenderAlias = Schema.Struct({
  sender: Schema.String,
  alias: Schema.String,
});

export const HeldRequest = Schema.Struct({
  id: Schema.String,
  sender: Schema.String,
  alias: Schema.String,
  subject: Schema.NullOr(Schema.String),
  received_at: Schema.String,
  status: Schema.String,
});

export const Ok = Schema.Struct({ ok: Schema.Boolean });
export const Approved = Schema.Struct({
  ok: Schema.Boolean,
  whitelisted: SenderAlias,
});

const listWhitelist = HttpApiEndpoint.get("listWhitelist", "/whitelist", {
  success: Schema.Array(WhitelistEntry),
});

const addWhitelist = HttpApiEndpoint.post("addWhitelist", "/whitelist", {
  success: Ok,
  payload: SenderAlias,
});

const removeWhitelist = HttpApiEndpoint.delete("removeWhitelist", "/whitelist", {
  success: Ok,
  payload: SenderAlias,
});

const listRequests = HttpApiEndpoint.get("listRequests", "/requests", {
  success: Schema.Array(HeldRequest),
});

export const EmailLogEntry = Schema.Struct({
  id: Schema.String,
  sender: Schema.String,
  alias: Schema.String,
  recipient: Schema.String,
  subject: Schema.NullOr(Schema.String),
  sent_at: Schema.String,
  trigger: Schema.String,
});

const listLog = HttpApiEndpoint.get("listLog", "/log", {
  success: Schema.Array(EmailLogEntry),
});

const approveRequest = HttpApiEndpoint.post("approveRequest", "/requests/:id/approve", {
  params: { id: Schema.String },
  success: Approved,
  error: NotFound,
});

const rejectRequest = HttpApiEndpoint.post("rejectRequest", "/requests/:id/reject", {
  params: { id: Schema.String },
  success: Ok,
  error: NotFound,
});

export class AdminGroup extends HttpApiGroup.make("Admin")
  .add(listWhitelist)
  .add(addWhitelist)
  .add(removeWhitelist)
  .add(listRequests)
  .add(approveRequest)
  .add(rejectRequest)
  .add(listLog)
  .middleware(AuthMiddleware) {}

export class MailRelayApi extends HttpApi.make("MailRelayApi").add(AdminGroup) {}
