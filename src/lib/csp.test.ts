import { describe, expect, it } from "vitest";
import { buildCsp, CSP_MODE, cspHeaderName, generateNonce } from "@/lib/csp";

const nonce = "dGVzdC1ub25jZQ==";

function directive(policy: string, name: string): string | undefined {
  return policy.split("; ").find((d) => d === name || d.startsWith(`${name} `));
}

describe("buildCsp", () => {
  const production = buildCsp({ nonce, dev: false });

  it("lets only our own scripts run: the nonce and what they load, never inline or eval", () => {
    const script = directive(production, "script-src");
    expect(script).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(production).not.toContain("unsafe-inline");
    expect(production).not.toContain("unsafe-eval");
  });

  it("allows eval in development only, where React needs it for error stacks", () => {
    const dev = buildCsp({ nonce, dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(production).not.toContain("'unsafe-eval'");
  });

  it("forbids plug-ins, a changed base URL and being framed", () => {
    expect(directive(production, "object-src")).toBe("object-src 'none'");
    expect(directive(production, "base-uri")).toBe("base-uri 'self'");
    expect(directive(production, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("keeps everything else on our own origin", () => {
    expect(directive(production, "default-src")).toBe("default-src 'self'");
    expect(directive(production, "form-action")).toBe("form-action 'self'");
  });

  it("upgrades http to https in production but not in development (localhost has no TLS)", () => {
    expect(production).toContain("upgrade-insecure-requests");
    expect(buildCsp({ nonce, dev: true })).not.toContain("upgrade-insecure-requests");
  });

  it("puts the nonce in the script and style rules and nowhere else", () => {
    const withNonce = production.split("; ").filter((d) => d.includes(nonce));
    expect(withNonce.map((d) => d.split(" ")[0])).toEqual(["script-src", "style-src"]);
  });
});

describe("generateNonce", () => {
  it("is new each time", () => {
    const nonces = new Set(Array.from({ length: 50 }, generateNonce));
    expect(nonces.size).toBe(50);
  });

  it("cannot break out of the header", () => {
    expect(generateNonce()).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("cspHeaderName", () => {
  it("names the header by mode", () => {
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy");
    expect(cspHeaderName("report-only")).toBe("Content-Security-Policy-Report-Only");
  });

  it("is in report-only mode until the pages are known to run under the policy", () => {
    expect(CSP_MODE).toBe("report-only");
  });
});
