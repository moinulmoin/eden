import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import type { SessionAuthContext } from "eve/context";

const authenticate: AuthFn<Request> = (request) => {
  const expected = process.env.EVE_COMPAT_AUTH_TOKEN;
  if (
    expected === undefined ||
    request.headers.get("authorization") !== `Bearer ${expected}`
  ) {
    return null;
  }

  const principal: SessionAuthContext = {
    attributes: {},
    authenticator: "eden-compatibility-token",
    principalId: "eden-compatibility-client",
    principalType: "app",
  };
  return principal;
};

export default eveChannel({ auth: authenticate });
