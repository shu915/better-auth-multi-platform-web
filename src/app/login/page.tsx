import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, googleEnabled } from "@/lib/auth";
import { oauthErrorMessage } from "@/lib/oauth-errors";
import { LoginForm } from "@/components/login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect("/");

  const { error } = await searchParams;
  const initialError = oauthErrorMessage(typeof error === "string" ? error : undefined);

  return (
    // Top-aligned, not centered: a message appearing below the form must not shift it.
    <main className="flex flex-1 items-start justify-center px-4 pt-24">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <LoginForm googleEnabled={googleEnabled} initialError={initialError} />
      </div>
    </main>
  );
}
