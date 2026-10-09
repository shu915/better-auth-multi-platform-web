import { NextRequest, NextResponse } from "next/server";
import { buildCsp, CSP_MODE, cspHeaderName, generateNonce } from "@/lib/csp";

// Runs before every page request: gives it a new nonce and the Content-Security-Policy that
// allows only scripts carrying that nonce. Next.js reads the nonce from the request's header and
// puts it on its own scripts and styles while rendering, so pages must be rendered per request
// (they are: every page reads the session).
export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const policy = buildCsp({ nonce, dev: process.env.NODE_ENV === "development" });
  const header = cspHeaderName(CSP_MODE);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(header, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(header, policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Not the API routes (JSON, no page), the static files, the image optimizer or the icon.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      // Nor the prefetches that next/link makes ahead of a click.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
