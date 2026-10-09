"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

type Status = "idle" | "sending" | "sent" | "redirecting";

export function LoginForm({
  callbackURL = "/",
  googleEnabled = false,
  initialError = null,
}: {
  callbackURL?: string;
  googleEnabled?: boolean;
  initialError?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(initialError);

  // Coming back from Google with the browser's back button restores this page from the
  // back/forward cache with the "Redirecting..." state still in place.
  useEffect(() => {
    function onPageShow(e: PageTransitionEvent) {
      if (e.persisted) setStatus((s) => (s === "redirecting" ? "idle" : s));
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function onGoogle() {
    setStatus("redirecting");
    setError(null);
    try {
      // On success the browser is sent to Google; this call only returns on failure. A Google
      // account that is not linked yet comes back to /login with ?error=... (no sign-up).
      const { error } = await authClient.signIn.social({
        provider: "google",
        callbackURL,
        errorCallbackURL: "/login",
      });
      if (error) {
        setError(error.message ?? "Failed to start Google sign-in.");
        setStatus("idle");
      }
    } catch (err) {
      console.error("[login] failed to start Google sign-in", err);
      setError("Network error. Please try again.");
      setStatus("idle");
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const address = email.trim();
    try {
      const { error } = await authClient.signIn.magicLink({
        email: address,
        callbackURL,
      });
      if (error) {
        setError(error.message ?? "Failed to send the sign-in link.");
        setStatus("idle");
        return;
      }
      setEmail(address);
      setStatus("sent");
    } catch (err) {
      console.error("[login] failed to send the sign-in link", err);
      setError("Network error. Please try again.");
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <div className="space-y-2 text-center">
        <p className="font-medium">Check your email</p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          We sent a sign-in link to {email}.
        </p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Not there after a few minutes? Check your spam folder, wait ten minutes, then try again.
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="text-sm underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  const busy = status === "sending" || status === "redirecting";

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-foreground px-3 py-2 font-medium text-background disabled:opacity-50"
        >
          {status === "sending" ? "Sending..." : "Send sign-in link"}
        </button>
      </form>
      {googleEnabled && (
        <>
          <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">or</p>
          <button
            type="button"
            onClick={onGoogle}
            disabled={busy}
            className="w-full rounded-md border border-zinc-300 px-3 py-2 font-medium disabled:opacity-50 dark:border-zinc-700"
          >
            {status === "redirecting" ? "Redirecting..." : "Continue with Google"}
          </button>
        </>
      )}
      {/* Last on purpose: a message that appears here pushes nothing else down. */}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
