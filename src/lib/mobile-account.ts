import {
  deleteAccount,
  type DeleteAccountDeps,
  type DeleteAccountResult,
} from "@/lib/delete-account";
import {
  authenticateBearer,
  readJsonBody,
  respond,
  type MobileResponse,
} from "@/lib/mobile-request";

// Deletes the signed-in user's account for the native app (Expo): the same thing the "Delete
// account" form on /profile does, with the same rules, because it is the same deleteAccount():
// the typed email must match, the session must be fresh (it checks session.createdAt itself, which
// Better Auth's hooks would not do for a route outside it), the other sessions are revoked, the
// Go API data goes, then the user, and the user's own address gets a notice.
// Better Auth's /delete-user stays refused over HTTP.
export type MobileAccountDeps = {
  getSession: (
    headers: Headers,
  ) => Promise<{ user: { email: string }; session: { createdAt: Date | string } } | null>;
  /** The steps of deleteAccount, bound to this request's session. */
  steps: (headers: Headers) => DeleteAccountDeps;
  now?: () => Date;
};

type Failure = Extract<DeleteAccountResult, { ok: false }>;

function failureResponse(result: Failure): MobileResponse {
  switch (result.reason) {
    case "email_mismatch":
      return respond(422, { error: "email_mismatch" });
    // The app turns this into "sign in again, then try once more".
    case "not_fresh":
      return respond(403, { error: "recent_sign_in_required" });
    case "failed":
      // What went wrong is logged by the caller; the app only needs to know it can try again.
      return respond(500, { error: "failed" });
  }
}

export async function deleteAccountFromApp(
  request: Request,
  deps: MobileAccountDeps,
): Promise<MobileResponse> {
  const auth = await authenticateBearer(request, deps.getSession, "mobile-account");
  if (!auth.ok) return auth.response;
  const { session } = auth;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const raw = body.value;
  const confirmEmail =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).confirmEmail : undefined;

  const result = await deleteAccount(
    {
      confirmEmail: typeof confirmEmail === "string" ? confirmEmail : "",
      sessionEmail: session.user.email,
      sessionCreatedAt: new Date(session.session.createdAt),
      now: (deps.now ?? (() => new Date()))(),
    },
    deps.steps(request.headers),
  );

  if (!result.ok) {
    if (result.reason === "failed") {
      console.error(`[mobile-account] account deletion failed at ${result.step}`, result.error);
    }
    return failureResponse(result);
  }
  return respond(200, { deleted: true });
}
