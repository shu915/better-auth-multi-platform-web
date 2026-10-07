const NOT_LINKED =
  "This Google account is not linked to a user. Sign in with an email link first, then link Google from your profile.";

// Better Auth redirects back with `?error=<code>`. Show our own text for known codes and a
// generic one otherwise, so an arbitrary query string is never echoed into the page.
const MESSAGES = new Map<string, string>([
  ["signup_disabled", NOT_LINKED],
  ["account_not_linked", NOT_LINKED],
  ["unable_to_link_account", "Could not link that Google account. Please try again."],
  [
    "account_already_linked_to_different_user",
    "That Google account is already linked to another user.",
  ],
]);

export function oauthErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return MESSAGES.get(code) ?? "Google sign-in failed. Please try again.";
}
