import { after } from "next/server";
import { auth } from "@/lib/auth";
import { apiRequest } from "@/lib/api";
import { accountDeletedEmail } from "@/lib/delete-account";
import { sendEmail } from "@/lib/email";
import { deleteAccountFromApp } from "@/lib/mobile-account";

// DELETE /api/mobile/account  { "confirmEmail": "..." }  for the native app. See mobile-account.ts.
export async function DELETE(request: Request): Promise<Response> {
  const { status, body } = await deleteAccountFromApp(request, {
    getSession: (headers) => auth.api.getSession({ headers }),
    steps: (headers) => ({
      revokeOtherSessions: async () => {
        await auth.api.revokeOtherSessions({ headers });
      },
      deleteApiData: async () => {
        // The JWT is issued here from the request's session (the app never holds one for this).
        const { token } = await auth.api.getToken({ headers });
        await apiRequest<void>("/me", token, { method: "DELETE" });
      },
      deleteUser: async () => {
        await auth.api.deleteUser({ headers, body: {} });
      },
      // To the root email, taken from the session before the user is gone. Not awaited: mail
      // must not delay or fail the deletion.
      notifyDeleted: async ({ to, at }) => {
        const { subject, text, html } = accountDeletedEmail(at);
        after(async () => {
          try {
            await sendEmail({ to, subject, text, html });
          } catch (err) {
            console.error("[email] failed to send the account-deleted notice", err);
          }
        });
      },
    }),
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
