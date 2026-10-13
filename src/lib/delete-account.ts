import { FRESH_SESSION_SECONDS } from "@/lib/google-auth-options";

// Everything of the user is in one database (the Go API shares it), so deleting the user row is
// the whole deletion: sessions and linked accounts go with it, and so does the Go API's data
// (profiles references the user with ON DELETE CASCADE). There is no call to the Go API.
//   1. revoke the other sessions: no new JWT can be issued from them (the current session is
//      needed for the next step). A JWT issued before this stays valid for a few minutes, but
//      the Go API refuses to write for a user that no longer exists.
//   2. delete the user
//   3. tell the user's own address that the account was deleted, so a deletion they did not
//      make gets noticed. A failure here never undoes or fails the deletion.
// A failure stops the rest and leaves the user in place, so submitting again finishes the job.

export type DeleteAccountStep = "revoke-sessions" | "delete-user";

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; reason: "email_mismatch" | "not_fresh" }
  | { ok: false; reason: "failed"; step: DeleteAccountStep; error: unknown };

export type DeleteAccountDeps = {
  revokeOtherSessions: () => Promise<void>;
  deleteUser: () => Promise<void>;
  // The recipient is decided in deleteAccount (the session's email), never by the caller.
  notifyDeleted: (notice: { to: string; at: Date }) => Promise<void>;
};

// Stricter than Better Auth's own check by this margin, so a session that passes here does not
// cross the window before deleteUser runs (it would then fail after the other sessions are revoked).
const FRESH_MARGIN_SECONDS = 30;

export function isSessionFresh(sessionCreatedAt: Date, now: Date): boolean {
  const limit = (FRESH_SESSION_SECONDS - FRESH_MARGIN_SECONDS) * 1000;
  return now.getTime() - sessionCreatedAt.getTime() < limit;
}

export async function deleteAccount(
  input: {
    confirmEmail: string;
    sessionEmail: string;
    sessionCreatedAt: Date;
    now: Date;
  },
  deps: DeleteAccountDeps,
): Promise<DeleteAccountResult> {
  if (
    input.confirmEmail.trim().toLowerCase() !==
    input.sessionEmail.trim().toLowerCase()
  ) {
    return { ok: false, reason: "email_mismatch" };
  }
  // Checked before anything is changed: deleting the user needs a fresh session, and failing
  // there after the other sessions are revoked would sign the user out everywhere for nothing.
  if (!isSessionFresh(input.sessionCreatedAt, input.now)) {
    return { ok: false, reason: "not_fresh" };
  }

  const steps: [DeleteAccountStep, () => Promise<void>][] = [
    ["revoke-sessions", deps.revokeOtherSessions],
    ["delete-user", deps.deleteUser],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (error) {
      return { ok: false, reason: "failed", step, error };
    }
  }
  try {
    await deps.notifyDeleted({ to: input.sessionEmail, at: input.now });
  } catch (error) {
    console.error("[profile] failed to send the account-deleted notice", error);
  }
  return { ok: true };
}

// Only our own text and the date go into the email; nothing the user typed is interpolated.
export function accountDeletedEmail(at: Date) {
  const line = `Your account was deleted on ${at.toUTCString()}.`;
  const advice =
    "If this was you, no action is needed. If it was not, someone had access to your session: your data cannot be restored. Signing in with an email link again would create a new, empty account. Be careful with your email account.";
  return {
    subject: "Your account was deleted",
    text: `${line}\n\n${advice}`,
    html: `<p>${line}</p><p>${advice}</p>`,
  };
}

export type DeleteAccountFormState = { error: string | null };

export function deleteAccountErrorText(
  result: Extract<DeleteAccountResult, { ok: false }>,
): string {
  switch (result.reason) {
    case "email_mismatch":
      return "The email address does not match your account.";
    case "not_fresh":
      return "For security, sign out from the home page, sign in again with an email link, then try deleting your account once more.";
    case "failed":
      return "Failed to delete your account. Please try again; repeating it is safe.";
  }
}
