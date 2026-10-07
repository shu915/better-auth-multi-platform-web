"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { unlinkErrorMessage } from "@/lib/linked-accounts";

export function UnlinkGoogleButton({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (!window.confirm("Unlink Google? You can still sign in with an email link.")) return;
    setBusy(true);
    setError(null);
    try {
      const { error } = await authClient.unlinkAccount({ accountId });
      if (error) {
        setError(unlinkErrorMessage(error));
        setBusy(false);
        return;
      }
      router.refresh();
    } catch (err) {
      console.error("[profile] failed to unlink Google", err);
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700"
      >
        {busy ? "Unlinking..." : "Unlink Google"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
