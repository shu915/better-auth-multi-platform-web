import type { BetterAuthPlugin } from "better-auth";
import { bearer } from "better-auth/plugins";

// What a native app (Expo) needs to get a JWT for the Go API from /api/auth/token without a
// browser cookie: the session token sent as "Authorization: Bearer ...". Shared by auth.ts and the
// tests, so the tests run exactly this configuration.
//
// Rules (see isBearerOnly in google-auth-options.ts): /token answers over HTTP only to a request
// authenticated by a bearer token and nothing else, and that token must be the signed session value.
//  - requireSignature: bearer() accepts only the signed value (the session cookie's value), never
//    the raw session token that some responses include in their body.
//  - The "set-auth-token" response header, which bearer() adds to responses that set the session
//    cookie, is removed below: the native app keeps the cookie that expoClient stores and does not
//    need it.
const HEADER = "set-auth-token";

const hideSessionTokenHeader: BetterAuthPlugin = {
  id: "hide-set-auth-token",
  // Runs last, after bearer()'s own hook has added the header.
  onResponse: async (response) => {
    const exposed = response.headers.get("access-control-expose-headers");
    if (!response.headers.has(HEADER) && !exposed?.toLowerCase().includes(HEADER)) return;
    const headers = new Headers(response.headers);
    headers.delete(HEADER);
    if (exposed) {
      const rest = exposed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "" && name.toLowerCase() !== HEADER);
      if (rest.length > 0) headers.set("access-control-expose-headers", rest.join(", "));
      else headers.delete("access-control-expose-headers");
    }
    return {
      response: new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    };
  },
};

export function nativeClientPlugins(): BetterAuthPlugin[] {
  return [bearer({ requireSignature: true }), hideSessionTokenHeader];
}
