import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

function headerOf(response: Response, name: string) {
  return response.headers.get(name) ?? "";
}

describe("proxy", () => {
  it("sets the policy on the response with a nonce, and passes the same nonce on to the page", () => {
    const response = proxy(new NextRequest("http://localhost/profile"));

    const policy = headerOf(response, "content-security-policy-report-only");
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    // Next.js reads the nonce from the request headers; they travel in x-middleware-request-*.
    expect(headerOf(response, "x-middleware-request-x-nonce")).toBe(nonce);
    expect(headerOf(response, "x-middleware-request-content-security-policy-report-only")).toBe(policy);
  });

  it("gives every request its own nonce", () => {
    const a = headerOf(proxy(new NextRequest("http://localhost/")), "x-middleware-request-x-nonce");
    const b = headerOf(proxy(new NextRequest("http://localhost/")), "x-middleware-request-x-nonce");
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });
});
