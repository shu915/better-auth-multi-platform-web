"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();

  async function onClick() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
    >
      Sign out
    </button>
  );
}
