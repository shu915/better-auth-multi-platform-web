import { isBearerOnly } from "@/lib/google-auth-options";
import { parseProfileInput } from "@/lib/profile-form";

// Changes the signed-in user's name for the native app (Expo). Better Auth's own /update-user is
// refused over HTTP (see SERVER_ONLY_PATHS in google-auth-options.ts) because it skips our
// validation, and a native app has no server of ours to call it for it. So this is the one place
// the app can change the name, and it does what the profile Server Action does: validate with
// parseProfileInput, then call auth.api.updateUser from our own code.
//
// The caller must be authenticated like /token is: "Authorization: Bearer <signed session token>"
// and NO Cookie header (isBearerOnly). A browser cannot send that to us from another site
// (a custom header needs a CORS preflight, which we do not answer), and with no Cookie there is
// no ambient credential for a forged request to ride on.
export type MobileProfileDeps = {
  /** Resolves the session from the request's headers (the bearer plugin turns the header into one). */
  getSession: (headers: Headers) => Promise<{ user: { name: string } } | null>;
  updateName: (headers: Headers, name: string) => Promise<void>;
};

export type MobileProfileResponse = { status: number; body: Record<string, unknown> };

// A name is at most 50 characters; this is far above that and stops a huge body from being parsed.
const MAX_BODY_BYTES = 2048;

const respond = (status: number, body: Record<string, unknown>): MobileProfileResponse => ({
  status,
  body,
});

export async function updateNameFromApp(
  request: Request,
  deps: MobileProfileDeps,
): Promise<MobileProfileResponse> {
  // Bearer and nothing else. A Cookie header is refused (403) whatever else is sent; without one,
  // anything that is not a bearer token (none, empty, another scheme) is "signed out" (401).
  if (request.headers.get("cookie")) return respond(403, { error: "bearer token only" });
  if (!isBearerOnly(request)) return respond(401, { error: "unauthorized" });

  let session: Awaited<ReturnType<MobileProfileDeps["getSession"]>>;
  try {
    session = await deps.getSession(request.headers);
  } catch (err) {
    console.error("[mobile-profile] failed to read the session", err);
    return respond(503, { error: "unavailable" });
  }
  if (!session) return respond(401, { error: "unauthorized" });

  // Refuse a body that says it is too large before reading it.
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return respond(413, { error: "too large" });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return respond(413, { error: "too large" });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return respond(400, { error: "invalid body" });
  }
  const name = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).name : undefined;

  const parsed = parseProfileInput({ name, bio: null });
  if (!parsed.ok) return respond(422, { errors: { name: parsed.errors.name ?? "Invalid name." } });

  if (parsed.value.name !== session.user.name) {
    try {
      await deps.updateName(request.headers, parsed.value.name);
    } catch (err) {
      console.error("[mobile-profile] failed to save the name", err);
      return respond(500, { error: "could not save" });
    }
  }
  return respond(200, { name: parsed.value.name });
}
