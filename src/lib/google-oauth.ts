export type GoogleCredentials = { clientId: string; clientSecret: string };

// Google login is optional: it is on only when both values are set. Setting just one
// is almost certainly a mistake, so fail loudly instead of silently leaving it off.
export function resolveGoogleCredentials(env: {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}): GoogleCredentials | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
    );
  }
  return { clientId, clientSecret };
}
