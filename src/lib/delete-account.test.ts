import { afterEach, describe, expect, it, vi } from "vitest";
import { FRESH_SESSION_SECONDS } from "@/lib/google-auth-options";
import {
  accountDeletedEmail,
  deleteAccount,
  deleteAccountErrorText,
  isSessionFresh,
} from "@/lib/delete-account";

afterEach(() => {
  vi.restoreAllMocks();
});

const now = new Date("2026-10-08T12:00:00Z");
const fresh = new Date(now.getTime() - 60 * 1000);
const stale = new Date(now.getTime() - (FRESH_SESSION_SECONDS + 1) * 1000);

function setup(failAt?: "revoke" | "api" | "user" | "notify") {
  const calls: string[] = [];
  const step =
    (name: string, key: "revoke" | "api" | "user" | "notify") => async () => {
      calls.push(name);
      if (failAt === key) throw new Error(`${name} failed`);
    };
  return {
    calls,
    deps: {
      revokeOtherSessions: step("revoke", "revoke"),
      deleteApiData: step("api", "api"),
      deleteUser: step("user", "user"),
      notifyDeleted: step("notify", "notify"),
    },
  };
}

const input = {
  confirmEmail: "root@example.com",
  sessionEmail: "root@example.com",
  sessionCreatedAt: fresh,
  now,
};

describe("deleteAccount", () => {
  it("revokes other sessions, then deletes the Go data, then the user", async () => {
    const { calls, deps } = setup();
    expect(await deleteAccount(input, deps)).toEqual({ ok: true });
    expect(calls).toEqual(["revoke", "api", "user", "notify"]);
  });

  it("calls nothing when the confirmation email differs", async () => {
    const { calls, deps } = setup();
    const result = await deleteAccount(
      { ...input, confirmEmail: "other@example.com" },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "email_mismatch" });
    expect(calls).toEqual([]);
  });

  it("ignores case and surrounding spaces in the confirmation email", async () => {
    const { deps } = setup();
    const result = await deleteAccount(
      { ...input, confirmEmail: "  Root@Example.COM " },
      deps,
    );
    expect(result).toEqual({ ok: true });
  });

  it("calls nothing for a stale session, so the Go data is never deleted without the user", async () => {
    const { calls, deps } = setup();
    const result = await deleteAccount(
      { ...input, sessionCreatedAt: stale },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: "not_fresh" });
    expect(calls).toEqual([]);
  });

  it("stops before deleting the user when the Go API fails", async () => {
    const { calls, deps } = setup("api");
    const result = await deleteAccount(input, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: "failed",
      step: "delete-api-data",
    });
    expect(calls).toEqual(["revoke", "api"]);
  });

  it("stops before touching any data when revoking sessions fails", async () => {
    const { calls, deps } = setup("revoke");
    const result = await deleteAccount(input, deps);
    expect(result).toMatchObject({
      ok: false,
      reason: "failed",
      step: "revoke-sessions",
    });
    expect(calls).toEqual(["revoke"]);
  });

  it("sends the notice to the session's email, not the typed confirmation", async () => {
    const notifyDeleted = vi.fn(async () => {});
    const { deps } = setup();
    await deleteAccount(
      {
        ...input,
        confirmEmail: "  ROOT@example.com ",
        sessionEmail: "root@example.com",
      },
      { ...deps, notifyDeleted },
    );
    expect(notifyDeleted).toHaveBeenCalledWith({
      to: "root@example.com",
      at: now,
    });
  });

  it("succeeds even when the notice cannot be sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, deps } = setup("notify");
    expect(await deleteAccount(input, deps)).toEqual({ ok: true });
    expect(calls).toEqual(["revoke", "api", "user", "notify"]);
  });

  it("sends no notice when any earlier step fails", async () => {
    for (const failAt of ["revoke", "api", "user"] as const) {
      const { calls, deps } = setup(failAt);
      await deleteAccount(input, deps);
      expect(calls).not.toContain("notify");
    }
  });

  it("reports a user deletion failure, and a retry runs every step again", async () => {
    const failing = setup("user");
    expect(await deleteAccount(input, failing.deps)).toMatchObject({
      ok: false,
      reason: "failed",
      step: "delete-user",
    });
    const retry = setup();
    expect(await deleteAccount(input, retry.deps)).toEqual({ ok: true });
    expect(retry.calls).toEqual(["revoke", "api", "user", "notify"]);
  });
});

describe("isSessionFresh", () => {
  it("is stale 30 seconds before Better Auth's own window ends", () => {
    const edge = (FRESH_SESSION_SECONDS - 30) * 1000;
    expect(isSessionFresh(new Date(now.getTime() - (edge - 1)), now)).toBe(
      true,
    );
    expect(isSessionFresh(new Date(now.getTime() - edge), now)).toBe(false);
  });
});

describe("deleteAccountErrorText", () => {
  it("never includes the underlying error", () => {
    const text = deleteAccountErrorText({
      ok: false,
      reason: "failed",
      step: "delete-user",
      error: new Error("secret-detail"),
    });
    expect(text).not.toContain("secret-detail");
  });
});

describe("accountDeletedEmail", () => {
  it("states the time and what to do if it was not the user", () => {
    const email = accountDeletedEmail(new Date("2026-10-08T03:04:05Z"));
    expect(email.subject).toBe("Your account was deleted");
    expect(email.text).toContain("Thu, 08 Oct 2026 03:04:05 GMT");
    expect(email.text).toContain("If it was not");
    expect(email.text).toContain("cannot be restored");
    expect(email.html).toContain("Thu, 08 Oct 2026 03:04:05 GMT");
  });
});
