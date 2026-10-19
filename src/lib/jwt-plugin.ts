import { jwt } from "better-auth/plugins";

// The JWT the Go API verifies. Shared by auth.ts and the tests, so the tests run this configuration.
//
// The JWT is issued by /token only (to our own server code, callApi, and to a native app that sends
// a bearer token). The plugin's optional "set-auth-jwt" header on get-session responses is
// therefore switched off.
export function jwtPlugin({ issuer, audience }: { issuer: string; audience: string }) {
  return jwt({
    disableSettingJwtHeader: true,
    jwt: {
      issuer,
      audience,
      expirationTime: "5m",
      // By default the whole user record is embedded; keep only the standard
      // claims (iat, iss, aud, exp) plus `sub` (the user id, set by Better Auth) and `auth_time`.
      //
      // `auth_time` is when the session was created, in seconds, which is when the user last
      // signed in. It is not the time the JWT was issued (`iat`): a stolen session can mint a new
      // JWT at any moment, but it cannot make the sign-in newer. The Go API asks for a recent
      // `auth_time` before it does something that cannot be undone (DELETE /me), which is the
      // "signed in within 5 minutes" rule the web app applies to the same actions.
      definePayload: ({ session }) => ({
        auth_time: Math.floor(new Date(session.createdAt).getTime() / 1000),
      }),
    },
  });
}
