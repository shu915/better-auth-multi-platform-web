import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignOutButton } from "@/components/sign-out-button";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <div className="space-y-4 text-center">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Signed in as</p>
        <p className="text-xl font-semibold">{session.user.email}</p>
        <SignOutButton />
      </div>
    </main>
  );
}
