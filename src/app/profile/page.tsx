import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, googleEnabled } from "@/lib/auth";
import { getMyProfile } from "@/lib/api-server";
import type { Profile } from "@/lib/api";
import { oauthErrorMessage } from "@/lib/oauth-errors";
import { findLinkedAccountId } from "@/lib/linked-accounts";
import { LinkGoogleButton } from "@/components/link-google-button";
import { DeleteAccountForm } from "@/components/delete-account-form";
import { UnlinkGoogleButton } from "@/components/unlink-google-button";

// The email and name come from our own session; the bio lives in the Go API.
async function loadBio(): Promise<Profile | null> {
  try {
    return await getMyProfile();
  } catch (err) {
    console.error("[profile] failed to load the bio", err);
    return null;
  }
}

type GoogleLink =
  | { status: "disabled" }
  | { status: "unknown" }
  | { status: "none" }
  | { status: "linked"; accountId: string };

// "unknown" means we could not tell, so the page shows neither the link nor the unlink button
// instead of guessing.
async function loadGoogleLink(requestHeaders: Headers): Promise<GoogleLink> {
  try {
    const accounts = await auth.api.listUserAccounts({ headers: requestHeaders });
    const accountId = findLinkedAccountId(accounts, "google");
    return accountId ? { status: "linked", accountId } : { status: "none" };
  } catch (err) {
    console.error("[profile] failed to list linked accounts", err);
    return { status: "unknown" };
  }
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  // Independent of each other, and both swallow their own errors, so they can run together.
  const [profile, googleLink] = await Promise.all([
    loadBio(),
    googleEnabled
      ? loadGoogleLink(requestHeaders)
      : Promise.resolve<GoogleLink>({ status: "disabled" }),
  ]);
  const { error } = await searchParams;
  const linkError = oauthErrorMessage(typeof error === "string" ? error : undefined);

  return (
    // Top-aligned, not centered: errors that appear below must not shift the page.
    <main className="flex flex-1 items-start justify-center px-4 pt-24">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-semibold">Profile</h1>
        <dl className="space-y-4">
          <div>
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">Email</dt>
            <dd className="break-all font-medium">{session.user.email}</dd>
          </div>
          <div>
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">Name</dt>
            <dd className="font-medium">{session.user.name || "—"}</dd>
          </div>
          <div>
            <dt className="text-sm text-zinc-600 dark:text-zinc-400">Bio</dt>
            {profile ? (
              <dd className="whitespace-pre-wrap">
                {profile.bio || (
                  <span className="text-zinc-600 dark:text-zinc-400">No bio yet.</span>
                )}
              </dd>
            ) : (
              <dd role="alert" className="text-sm text-red-600">
                Could not load your bio. Please try again later.
              </dd>
            )}
          </div>
        </dl>
        <div className="flex items-center gap-4">
          <Link
            href="/profile/edit"
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
          >
            Edit
          </Link>
          <Link href="/" className="text-sm underline">
            Back
          </Link>
        </div>
        {/* Last on purpose: the link and unlink buttons show errors below themselves, and
            nothing else should move when they do. */}
        {googleEnabled && (
          <section className="space-y-2">
            <h2 className="text-sm text-zinc-600 dark:text-zinc-400">Other ways to sign in</h2>
            {googleLink.status === "linked" && (
              <div className="flex items-center gap-4">
                <p className="text-sm">Google: linked</p>
                <UnlinkGoogleButton accountId={googleLink.accountId} />
              </div>
            )}
            {googleLink.status === "none" && <LinkGoogleButton />}
            {googleLink.status === "unknown" && (
              <p role="alert" className="text-sm text-red-600">
                Could not load your linked accounts. Reload to try again.
              </p>
            )}
            {linkError && (
              <p role="alert" className="text-sm text-red-600">
                {linkError}
              </p>
            )}
          </section>
        )}
        <section className="space-y-2">
          <h2 className="text-sm text-zinc-600 dark:text-zinc-400">Delete account</h2>
          <p className="text-sm">
            Deletes your profile and your account, including any linked Google sign-in.
          </p>
          <DeleteAccountForm email={session.user.email} />
        </section>
      </div>
    </main>
  );
}
