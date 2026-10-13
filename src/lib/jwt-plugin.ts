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
      // claims (iat, iss, aud, exp) plus `sub` (the user id, set by Better Auth).
      definePayload: () => ({}),
    },
  });
}
