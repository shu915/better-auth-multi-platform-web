import { auth } from "@/lib/auth";
import { updateNameFromApp } from "@/lib/mobile-profile";

// PATCH /api/mobile/profile  { "name": "..." }  for the native app. See mobile-profile.ts.
export async function PATCH(request: Request): Promise<Response> {
  const { status, body } = await updateNameFromApp(request, {
    getSession: (headers) => auth.api.getSession({ headers }),
    updateName: async (headers, name) => {
      await auth.api.updateUser({ headers, body: { name } });
    },
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
