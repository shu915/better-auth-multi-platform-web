"use client";

import { useActionState } from "react";
import { deleteMyAccount } from "@/app/profile/actions";
import type { DeleteAccountFormState } from "@/lib/delete-account";

const initialState: DeleteAccountFormState = { error: null };

export function DeleteAccountForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(deleteMyAccount, initialState);

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm("Delete your account? This cannot be undone.")) {
          event.preventDefault();
        }
      }}
      className="space-y-2"
    >
      <label htmlFor="confirmEmail" className="block text-sm">
        Type your email address <span className="font-bold">{email}</span> to confirm.
      </label>
      <input
        id="confirmEmail"
        name="confirmEmail"
        type="email"
        required
        autoComplete="off"
        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-red-600 px-3 py-2 text-sm text-red-600 disabled:opacity-50"
      >
        {pending ? "Deleting..." : "Delete account"}
      </button>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
    </form>
  );
}
