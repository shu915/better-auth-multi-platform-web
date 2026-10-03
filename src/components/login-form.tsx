"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

type Status = "idle" | "sending" | "sent";

export function LoginForm({ callbackURL = "/" }: { callbackURL?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

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
    } catch {
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

  return (
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
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={status === "sending"}
        className="w-full rounded-md bg-foreground px-3 py-2 font-medium text-background disabled:opacity-50"
      >
        {status === "sending" ? "Sending..." : "Send sign-in link"}
      </button>
    </form>
  );
}
