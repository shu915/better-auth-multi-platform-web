import Link from "next/link";
import { connection } from "next/server";

// The Content-Security-Policy needs a nonce on every script and style, and Next.js can only add
// one while it renders a request. The built-in 404 page is rendered once at build time, where
// there is no request and no nonce, so the browser blocks its scripts and styles. Waiting for the
// request here makes this page render per request like the others.
export default async function NotFound() {
  await connection();
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p>There is nothing at this address.</p>
      <Link href="/" className="underline">
        Go to the home page
      </Link>
    </main>
  );
}
