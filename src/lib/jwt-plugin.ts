import { jwt } from "better-auth/plugins";

// The JWT the Go API verifies. Shared by auth.ts and the tests, so the tests run this configuration.
//
// disableSettingJwtHeader: by default the plugin adds a valid JWT to every get-session response
// (the "set-auth-jwt" header), and a script on the page that can call get-session (the cookie goes
// along) can read it. That would hand the browser a JWT for the Go API, which is exactly what the
// SERVER_ONLY rule for /token (google-auth-options.ts) exists to prevent. The JWT is issued only
// by /token, and only to our own server code (callApi).
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
