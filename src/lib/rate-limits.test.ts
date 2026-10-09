import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressKey, allowMagicLinkTo, resetMemoryRateLimits } from "@/lib/rate-limits";

beforeEach(() => {
  resetMemoryRateLimits();
});

describe("allowMagicLinkTo", () => {
  it("allows three links to one address and refuses the fourth", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await allowMagicLinkTo("a@example.com"));
    expect(results).toEqual([true, true, true, false]);
  });

  it("counts one address however it is written", async () => {
    await allowMagicLinkTo("A@Example.com");
    await allowMagicLinkTo(" a@example.COM ");
    await allowMagicLinkTo("a@example.com");
    expect(await allowMagicLinkTo("a@EXAMPLE.com")).toBe(false);
  });

  it("keeps addresses apart, so one person's inbox being full does not block another", async () => {
    for (let i = 0; i < 5; i++) await allowMagicLinkTo("a@example.com");
    expect(await allowMagicLinkTo("b@example.com")).toBe(true);
  });
});

describe("in production", () => {
  it("counts in the database, not in memory", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const queries: string[] = [];
    vi.doMock("@/lib/db", () => ({
      db: {
        execute: async (query: { queryChunks: unknown[] }) => {
          queries.push(JSON.stringify(query));
          return { rows: [{ count: 2 }] };
        },
      },
    }));
    try {
      const { allowMagicLinkTo: allow } = await import("@/lib/rate-limits");

      expect(await allow("A@Example.com")).toBe(true);

      expect(queries.length).toBeGreaterThan(0);
      expect(queries.join()).toContain(`action:magic-link-recipient:${addressKey("a@example.com")}`);
      expect(queries.join()).not.toContain("example.com"); // the address itself is never stored
    } finally {
      vi.doUnmock("@/lib/db");
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("addressKey", () => {
  it("is the same for one address however it is written, and different for another", () => {
    expect(addressKey("A@Example.com")).toBe(addressKey(" a@example.COM "));
    expect(addressKey("a@example.com")).not.toBe(addressKey("b@example.com"));
  });

  it("does not contain the address", () => {
    expect(addressKey("someone@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});
