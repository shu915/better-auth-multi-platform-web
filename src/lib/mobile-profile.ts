import { authenticateBearer, readJsonBody, respond, type MobileResponse } from "@/lib/mobile-request";
import { parseProfileInput } from "@/lib/profile-form";

// Changes the signed-in user's name for the native app (Expo). Better Auth's own /update-user is
// refused over HTTP (see SERVER_ONLY_PATHS in google-auth-options.ts) because it skips our
// validation, and a native app has no server of ours to call it for it. So this is the one place
// the app can change the name, and it does what the profile Server Action does: validate with
// parseProfileInput, then call auth.api.updateUser from our own code. Authentication and body
// reading are shared with the other /api/mobile/* endpoints (mobile-request.ts).
export type MobileProfileDeps = {
  /** Resolves the session from the request's headers (the bearer plugin turns the header into one). */
  getSession: (headers: Headers) => Promise<{ user: { name: string } } | null>;
  updateName: (headers: Headers, name: string) => Promise<void>;
};

export type MobileProfileResponse = MobileResponse;

export async function updateNameFromApp(
  request: Request,
  deps: MobileProfileDeps,
): Promise<MobileProfileResponse> {
  const auth = await authenticateBearer(request, deps.getSession, "mobile-profile");
  if (!auth.ok) return auth.response;
  const { session } = auth;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const raw = body.value;
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
