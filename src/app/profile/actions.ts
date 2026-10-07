"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { auth } from "@/lib/auth";
import { callApi } from "@/lib/api-server";
import {
  normalizeNewlines,
  parseProfileInput,
  saveProfile,
  shouldLeaveEditPage,
  toFormState,
  type ProfileFormState,
} from "@/lib/profile-form";

// Saves the signed-in user's name (our database) and bio (the Go API). The browser never talks
// to either directly, and the JWT for the Go API is issued here, per call, by callApi.
export async function updateProfile(
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  // Check the session here, not only on the page: a Server Action can be called on its own.
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  const parsed = parseProfileInput({ name: formData.get("name"), bio: formData.get("bio") });
  if (!parsed.ok) return { errors: parsed.errors, saved: { name: false, bio: false } };

  // The bio the form was showing; only used to skip a write that would change nothing.
  const initialBio = formData.get("initialBio");

  const result = await saveProfile(parsed.value, {
    currentName: session.user.name,
    initialBio: typeof initialBio === "string" ? normalizeNewlines(initialBio) : null,
    updateName: async (name) => {
      try {
        await auth.api.updateUser({ headers: requestHeaders, body: { name } });
      } catch (err) {
        console.error("[profile] failed to save the name", err);
        throw err;
      }
    },
    updateBio: async (bio) => {
      try {
        await callApi("/me/profile", { method: "PUT", body: { bio } });
      } catch (err) {
        console.error("[profile] failed to save the bio", err);
        throw err;
      }
    },
  });

  // redirect() throws, so it must come last. The profile page is rendered fresh on arrival.
  if (shouldLeaveEditPage(result)) redirect("/profile");

  refresh(); // a partial failure stays here: show the saved field's new value
  return toFormState(parsed.value, result);
}
