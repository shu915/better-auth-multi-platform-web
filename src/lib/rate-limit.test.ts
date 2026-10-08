import { describe, expect, it } from "vitest";
import { createRateLimiter, tooManyRequestsMessage } from "@/lib/rate-limit";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("createRateLimiter", () => {
  it("lets max attempts through and blocks the next one", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 10_000, max: 3 }, c.now);
    for (let i = 0; i < 3; i++) expect(limiter.check("u1")).toEqual({ allowed: true });
    expect(limiter.check("u1").allowed).toBe(false);
  });

  it("says how long to wait, counted from the oldest attempt in the window", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 10_000, max: 2 }, c.now);
    limiter.check("u1");
    c.advance(4_000);
    limiter.check("u1");
    c.advance(1_000);
    expect(limiter.check("u1")).toEqual({ allowed: false, retryAfterSeconds: 5 });
  });

  it("lets attempts through again as old ones leave the window", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 10_000, max: 2 }, c.now);
    limiter.check("u1");
    limiter.check("u1");
    expect(limiter.check("u1").allowed).toBe(false);
    c.advance(10_000);
    expect(limiter.check("u1")).toEqual({ allowed: true });
  });

  it("does not count a blocked attempt, so waiting out the window is enough", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1 }, c.now);
    limiter.check("u1");
    for (let i = 0; i < 20; i++) {
      c.advance(100);
      limiter.check("u1"); // hammering while blocked
    }
    c.advance(10_000);
    expect(limiter.check("u1")).toEqual({ allowed: true });
  });

  it("keeps users apart", () => {
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1 });
    expect(limiter.check("alice")).toEqual({ allowed: true });
    expect(limiter.check("alice").allowed).toBe(false);
    expect(limiter.check("bob")).toEqual({ allowed: true });
  });

  it("never reports a wait of less than one second", () => {
    const c = clock();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1 }, c.now);
    limiter.check("u1");
    c.advance(999);
    expect(limiter.check("u1")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("does not grow without bound under a flood of different keys", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    for (let i = 0; i < 12_000; i++) limiter.check(`key-${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
  });

  it("forgets everything on reset", () => {
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1 });
    limiter.check("u1");
    limiter.reset();
    expect(limiter.check("u1")).toEqual({ allowed: true });
  });
});

describe("tooManyRequestsMessage", () => {
  it("tells the user how long to wait", () => {
    expect(tooManyRequestsMessage(7)).toContain("7 seconds");
  });
});
