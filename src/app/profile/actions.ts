"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { callApi } from "@/lib/api-server";
import { sendEmail } from "@/lib/email";
import { tooManyRequestsMessage } from "@/lib/rate-limit";
import { accountDeleteLimiter, profileUpdateLimiter } from "@/lib/rate-limits";
import {
  accountDeletedEmail,
  deleteAccount,
  deleteAccountErrorText,
  type DeleteAccountFormState,
} from "@/lib/delete-account";
import {
  normalizeNewlines,
  parseProfileInput,
  saveProfile,
  shouldLeaveEditPage,
  submittedValues,
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

  const submitted = submittedValues({ name: formData.get("name"), bio: formData.get("bio") });
  const limit = profileUpdateLimiter.check(session.user.id);
  if (!limit.allowed) {
    return {
      values: submitted,
      errors: {},
      saved: { name: false, bio: false },
      formError: tooManyRequestsMessage(limit.retryAfterSeconds),
    };
  }

  const parsed = parseProfileInput({ name: formData.get("name"), bio: formData.get("bio") });
  if (!parsed.ok) {
    return { values: submitted, errors: parsed.errors, saved: { name: false, bio: false } };
  }

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

// Deletes the signed-in user's account: their data in the Go API, then the user itself (which
// takes the sessions and linked accounts such as Google with it). See deleteAccount for the order.
export async function deleteMyAccount(
  _previous: DeleteAccountFormState,
  formData: FormData,
): Promise<DeleteAccountFormState> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  const userId = session.user.id;
  const limit = accountDeleteLimiter.check(userId);
  if (!limit.allowed) return { error: tooManyRequestsMessage(limit.retryAfterSeconds) };

  const confirmEmail = formData.get("confirmEmail");
  const result = await deleteAccount(
    {
      confirmEmail: typeof confirmEmail === "string" ? confirmEmail : "",
      sessionEmail: session.user.email,
      sessionCreatedAt: new Date(session.session.createdAt),
      now: new Date(),
    },
    {
      revokeOtherSessions: async () => {
        await auth.api.revokeOtherSessions({ headers: requestHeaders });
      },
      deleteApiData: async () => {
        await callApi<void>("/me", { method: "DELETE" });
      },
      deleteUser: async () => {
        await auth.api.deleteUser({ headers: requestHeaders, body: {} });
      },
      // To the root email, taken from the session before the user is gone. Not awaited, like the
      // linked-account notice: mail must not delay or fail the deletion.
      notifyDeleted: async ({ to, at }) => {
        const { subject, text, html } = accountDeletedEmail(at);
        after(async () => {
          try {
            await sendEmail({ to, subject, text, html });
          } catch (err) {
            // The notice is the only way to notice a deletion the user did not make, so say
            // which user it was for (not the address).
            console.error(`[email] failed to send the account-deleted notice user=${userId}`, err);
          }
        });
      },
    },
  );

  if (!result.ok) {
    if (result.reason === "failed") {
      console.error(`[profile] account deletion failed at ${result.step}`, result.error);
    }
    return { error: deleteAccountErrorText(result) };
  }
  console.info(`[profile] account deleted user=${userId}`);
  redirect("/"); // redirect() throws, so it comes last
}
