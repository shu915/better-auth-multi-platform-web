export type LinkedAccount = { id: string; providerId: string };

// The Better Auth account id of the user's link to `providerId`, or null when there is none.
// Unlinking takes this id, not the provider name.
export function findLinkedAccountId(
  accounts: readonly LinkedAccount[],
  providerId: string,
): string | null {
  return accounts.find((account) => account.providerId === providerId)?.id ?? null;
}

// Linking and unlinking need a recently signed-in session; say how to fix that instead of
// showing the raw API message. /login redirects a signed-in user away and only the home page
// has the sign-out button, so the steps start there.
function signInAgainMessage(doing: "linking" | "unlinking"): string {
  return `For security, sign out from the home page, sign in again with an email link, then try ${doing} once more.`;
}

export function unlinkErrorMessage(error: { code?: string; message?: string }): string {
  if (error.code === "SESSION_NOT_FRESH") return signInAgainMessage("unlinking");
  return "Failed to unlink Google. Please try again.";
}

export function linkErrorMessage(error: { code?: string; message?: string }): string {
  if (error.code === "SESSION_NOT_FRESH") return signInAgainMessage("linking");
  return "Failed to start linking Google. Please try again.";
}

const PROVIDER_LABELS = new Map([["google", "Google"]]);

// The email sent to the user's own address when a sign-in method is linked, so a link they did
// not make gets noticed. Only our own labels and the date go into the text; nothing from the
// provider is interpolated.
export function linkedAccountEmail(provider: string, at: Date) {
  const label = PROVIDER_LABELS.get(provider);
  const what = label ? `A ${label} account` : "A new sign-in method";
  const line = `${what} was linked to your account on ${at.toUTCString()}.`;
  const advice =
    "If this was you, no action is needed. If it was not, sign in with an email link and unlink it from your profile page.";
  return {
    subject: "A sign-in method was added to your account",
    text: `${line}\n\n${advice}`,
    html: `<p>${line}</p><p>${advice}</p>`,
  };
}
