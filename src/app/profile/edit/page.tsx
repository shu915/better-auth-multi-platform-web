import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getMyProfile } from "@/lib/api-server";
import { ProfileForm } from "@/components/profile-form";

// The bio lives in the Go API. If it cannot be loaded the form leaves the bio field out, so
// the name can still be edited and the bio cannot be overwritten with an empty value.
async function loadBio(): Promise<string | null> {
  try {
    return (await getMyProfile()).bio;
  } catch (err) {
    console.error("[profile] failed to load the bio", err);
    return null;
  }
}

export default async function EditProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const bio = await loadBio();

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-semibold">Edit profile</h1>
        <ProfileForm name={session.user.name} bio={bio} />
        <Link href="/profile" className="text-sm underline">
          Cancel
        </Link>
      </div>
    </main>
  );
}
