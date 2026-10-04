import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getMyProfile } from "@/lib/api-server";
import type { Profile } from "@/lib/api";

// The email and name come from our own session; the bio lives in the Go API.
async function loadBio(): Promise<Profile | null> {
  try {
    return await getMyProfile();
  } catch (err) {
    console.error("[profile] failed to load the bio", err);
    return null;
  }
}

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const profile = await loadBio();

  return (
    <main className="flex flex-1 items-center justify-center px-4">
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
        <Link href="/" className="text-sm underline">
          Back
        </Link>
      </div>
    </main>
  );
}
