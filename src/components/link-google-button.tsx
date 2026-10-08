"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { linkErrorMessage } from "@/lib/linked-accounts";

export function LinkGoogleButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Coming back from Google with the browser's back button restores this page from the
  // back/forward cache with the "Redirecting..." state still in place.
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) setBusy(false);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      // On success the browser is sent to Google; this call only returns on failure.
      const { error } = await authClient.linkSocial({
        provider: "google",
        callbackURL: "/profile",
        errorCallbackURL: "/profile",
      });
      if (error) {
        setError(linkErrorMessage(error));
        setBusy(false);
      }
    } catch (err) {
      console.error("[profile] failed to start linking Google", err);
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
        {busy ? "Redirecting..." : "Link Google"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
