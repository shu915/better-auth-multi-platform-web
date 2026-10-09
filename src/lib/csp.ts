// Content-Security-Policy: tells the browser which scripts and resources the page may load, so a
// script that an attacker gets into the page is not run. Built per request in proxy.ts, because
// the nonce (a one-time password that marks our own scripts) must be new for every request.

/**
 * "report-only": the browser only logs what the policy would have blocked, and blocks nothing.
 * "enforce": it blocks. Start in report-only, check that no page logs a violation (the end-to-end
 * test fails on one), then switch to "enforce" here.
 */
export type CspMode = "enforce" | "report-only";
export const CSP_MODE: CspMode = "report-only";

export function cspHeaderName(mode: CspMode): string {
  return mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

/** A new, unguessable value. Base64 has no quote or semicolon, so it cannot break the header. */
export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function buildCsp({ nonce, dev }: { nonce: string; dev: boolean }): string {
  const directives = [
    "default-src 'self'",
    // Our scripts carry the nonce; 'strict-dynamic' lets them load the scripts they need. React
    // uses eval in development only (for readable error stacks), never in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Not allowed at all: plug-ins, a changed <base>, and being framed by another site.
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  // Upgrading http to https would break http://localhost in development.
  if (!dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
