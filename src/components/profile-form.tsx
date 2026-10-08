"use client";

import { useActionState } from "react";
import { updateProfile } from "@/app/profile/actions";
import { initialProfileFormState } from "@/lib/profile-form";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";

function FieldMessage({ error, saved }: { error?: string; saved: boolean }) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {error}
      </p>
    );
  }
  if (saved) return <p className="text-sm text-green-700 dark:text-green-500">Saved.</p>;
  return null;
}

/** `bio` is null when the Go API could not be reached: the field is then left out, so it cannot be overwritten. */
export function ProfileForm({ name, bio }: { name: string; bio: string | null }) {
  const [state, formAction, pending] = useActionState(updateProfile, initialProfileFormState);

  // After a submit, keep what the user typed (React resets uncontrolled fields after an action).
  const shownName = state.values?.name ?? name;
  const shownBio = state.values?.bio ?? bio;

  return (
    <form action={formAction} className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium">Name</span>
        <input
          type="text"
          name="name"
          required
          autoComplete="name"
          defaultValue={shownName}
          aria-invalid={state.errors.name ? true : undefined}
          className={inputClass}
        />
        <FieldMessage error={state.errors.name} saved={state.saved.name} />
      </label>

      {bio === null ? (
        <p role="alert" className="text-sm text-red-600">
          Could not load your bio. Please try again later.
        </p>
      ) : (
        <label className="block space-y-1">
          <span className="text-sm font-medium">Bio</span>
          <textarea
            name="bio"
            rows={4}
            defaultValue={shownBio ?? ""}
            aria-invalid={state.errors.bio ? true : undefined}
            className={inputClass}
          />
          <input type="hidden" name="initialBio" value={bio} />
          <FieldMessage error={state.errors.bio} saved={state.saved.bio} />
        </label>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-foreground px-3 py-2 font-medium text-background disabled:opacity-50"
      >
        {pending ? "Saving..." : "Save"}
      </button>
      {state.formError && (
        <p role="alert" className="text-sm text-red-600">
          {state.formError}
        </p>
      )}
    </form>
  );
}
