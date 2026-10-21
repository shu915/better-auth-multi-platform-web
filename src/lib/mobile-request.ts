import { isBearerOnly } from "@/lib/google-auth-options";

// What every /api/mobile/* endpoint does first. These endpoints are outside Better Auth, so none
// of its hooks (the SERVER_ONLY list, the fresh-session check on /link-social) run for them: an
// endpoint that needs a fresh session must check session.createdAt itself.
//
// The caller must be authenticated like /token is: "Authorization: Bearer <signed session token>"
// and NO Cookie header (isBearerOnly). A browser cannot send that to us from another site (a
// custom header needs a CORS preflight, which we do not answer), and with no Cookie there is no
// ambient credential for a forged request to ride on.
export type MobileResponse = { status: number; body: Record<string, unknown> };

export const respond = (status: number, body: Record<string, unknown>): MobileResponse => ({
  status,
  body,
});

// A name or an email is far below this; it stops a huge body from being parsed.
export const MAX_BODY_BYTES = 2048;

type Authenticated<S> = { ok: true; session: S } | { ok: false; response: MobileResponse };

export async function authenticateBearer<S>(
  request: Request,
  getSession: (headers: Headers) => Promise<S | null>,
  label: string,
): Promise<Authenticated<S>> {
  // A Cookie header is refused (403) whatever else is sent; without one, anything that is not a
  // bearer token (none, empty, another scheme) is "signed out" (401).
  if (request.headers.get("cookie")) {
    return { ok: false, response: respond(403, { error: "bearer token only" }) };
  }
  if (!isBearerOnly(request)) {
    return { ok: false, response: respond(401, { error: "unauthorized" }) };
  }
  let session: S | null;
  try {
    session = await getSession(request.headers);
  } catch (err) {
    console.error(`[${label}] failed to read the session`, err);
    return { ok: false, response: respond(503, { error: "unavailable" }) };
  }
  if (!session) return { ok: false, response: respond(401, { error: "unauthorized" }) };
  return { ok: true, session };
}

type Body = { ok: true; value: unknown } | { ok: false; response: MobileResponse };

export async function readJsonBody(request: Request): Promise<Body> {
  // Refuse a body that says it is too large before reading it.
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return { ok: false, response: respond(413, { error: "too large" }) };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: respond(413, { error: "too large" }) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: respond(400, { error: "invalid body" }) };
  }
}
