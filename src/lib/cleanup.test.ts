import { afterEach, describe, expect, it, vi } from "vitest";
import { createCleanupHandler } from "@/lib/cleanup";

const result = { verification: 2, session: 1, rateLimit: 3 };

function call(handler: (r: Request) => Promise<Response>, authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return handler(new Request("http://localhost/api/cron/cleanup", { headers }));
}

afterEach(() => vi.restoreAllMocks());

describe("the scheduled cleanup handler", () => {
  it("runs the cleanup and reports the counts when the secret matches", async () => {
    const run = vi.fn().mockResolvedValue(result);
    const res = await call(createCleanupHandler({ secret: () => "s3cret", run }), "Bearer s3cret");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(run).toHaveBeenCalledOnce();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does nothing without the secret, or with a wrong one", async () => {
    const run = vi.fn().mockResolvedValue(result);
    const handler = createCleanupHandler({ secret: () => "s3cret", run });

    for (const header of [undefined, "", "Bearer ", "Bearer wrong", "s3cret", "bearer s3cret"]) {
      expect((await call(handler, header)).status).toBe(401);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("never opens because the secret is not set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn().mockResolvedValue(result);

    for (const secret of [undefined, ""]) {
      const handler = createCleanupHandler({ secret: () => secret, run });
      // "Bearer undefined" and "Bearer " are what a careless comparison would accept.
      expect((await call(handler, `Bearer ${secret}`)).status).toBe(503);
      expect((await call(handler, "Bearer ")).status).toBe(503);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("answers 500 without details when the cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn().mockRejectedValue(new Error("password=hunter2 refused"));
    const res = await call(createCleanupHandler({ secret: () => "s3cret", run }), "Bearer s3cret");

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("hunter2");
  });
});
