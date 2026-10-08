import { beforeEach, describe, expect, it, vi } from "vitest";

// deleteMyAccount is the wiring between the Next.js request, Better Auth, the Go API and the
// mail sender. The logic is tested in delete-account.test.ts; this checks that the real Server
// Action passes the right things to the right place, in the right order. Everything outside
// our code is replaced.

const mocks = vi.hoisted(() => {
  class Redirected extends Error {
    constructor(readonly to: string) {
      super(`redirect to ${to}`);
    }
  }
  return {
    Redirected,
    calls: [] as string[],
    afterTasks: [] as (() => Promise<void>)[],
    getSession: vi.fn(),
    updateUser: vi.fn(),
    revokeOtherSessions: vi.fn(),
    deleteUser: vi.fn(),
    callApi: vi.fn(),
    sendEmail: vi.fn(),
  };
});

const requestHeaders = new Headers({ cookie: "session=abc" });

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new mocks.Redirected(to);
  },
}));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    mocks.afterTasks.push(task);
  },
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mocks.getSession,
      revokeOtherSessions: mocks.revokeOtherSessions,
      deleteUser: mocks.deleteUser,
      updateUser: mocks.updateUser,
    },
  },
}));
vi.mock("@/lib/api-server", () => ({ callApi: mocks.callApi }));
vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));

import { deleteMyAccount, updateProfile } from "@/app/profile/actions";
import { initialProfileFormState } from "@/lib/profile-form";
import { accountDeleteLimiter, profileUpdateLimiter } from "@/lib/rate-limits";

const initial = { error: null };

function formWith(confirmEmail: string) {
  const form = new FormData();
  form.set("confirmEmail", confirmEmail);
  return form;
}

function freshSession(email = "root@example.com") {
  return { user: { id: "user-1", email }, session: { createdAt: new Date() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  accountDeleteLimiter.reset();
  profileUpdateLimiter.reset();
  mocks.calls.length = 0;
  mocks.afterTasks.length = 0;
  mocks.getSession.mockResolvedValue(freshSession());
  mocks.revokeOtherSessions.mockImplementation(async () => void mocks.calls.push("revoke"));
  mocks.callApi.mockImplementation(async () => void mocks.calls.push("api"));
  mocks.deleteUser.mockImplementation(async () => void mocks.calls.push("user"));
  mocks.sendEmail.mockResolvedValue(undefined);
});

async function run(confirmEmail: string) {
  try {
    return { state: await deleteMyAccount(initial, formWith(confirmEmail)), redirectedTo: null };
  } catch (err) {
    if (err instanceof mocks.Redirected) return { state: null, redirectedTo: err.to };
    throw err;
  }
}

describe("deleteMyAccount", () => {
  it("revokes other sessions, deletes the Go data, deletes the user, then redirects home", async () => {
    const result = await run("root@example.com");

    expect(mocks.calls).toEqual(["revoke", "api", "user"]);
    expect(result.redirectedTo).toBe("/");
    expect(mocks.revokeOtherSessions).toHaveBeenCalledWith({ headers: requestHeaders });
    expect(mocks.callApi).toHaveBeenCalledWith("/me", { method: "DELETE" });
    expect(mocks.deleteUser).toHaveBeenCalledWith({ headers: requestHeaders, body: {} });
  });

  it("sends the notice to the session's email, after the response, not to what was typed", async () => {
    await run("  ROOT@example.com ");

    expect(mocks.sendEmail).not.toHaveBeenCalled(); // scheduled with after(), not sent inline
    expect(mocks.afterTasks).toHaveLength(1);
    await mocks.afterTasks[0]();
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({
      to: "root@example.com",
      subject: "Your account was deleted",
    });
  });

  it("still finishes the deletion when the notice cannot be sent", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("mail is down"));

    const result = await run("root@example.com");
    await expect(mocks.afterTasks[0]()).resolves.toBeUndefined();

    expect(result.redirectedTo).toBe("/");
    expect(mocks.calls).toEqual(["revoke", "api", "user"]);
  });

  it("sends the visitor to /login and touches nothing without a session", async () => {
    mocks.getSession.mockResolvedValue(null);

    const result = await run("root@example.com");

    expect(result.redirectedTo).toBe("/login");
    expect(mocks.calls).toEqual([]);
    expect(mocks.afterTasks).toHaveLength(0);
  });

  it("does nothing when the typed email is not the account's", async () => {
    const result = await run("someone-else@example.com");

    expect(result.state?.error).toMatch(/does not match/);
    expect(mocks.calls).toEqual([]);
    expect(mocks.afterTasks).toHaveLength(0);
  });

  it("does nothing for a session that is no longer fresh", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", email: "root@example.com" },
      session: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const result = await run("root@example.com");

    expect(result.state?.error).toMatch(/sign in again/);
    expect(mocks.calls).toEqual([]);
  });

  it("keeps the user and sends no notice when the Go API fails", async () => {
    mocks.callApi.mockRejectedValue(new Error("api down"));

    const result = await run("root@example.com");

    expect(result.state?.error).toMatch(/Failed to delete/);
    expect(result.state?.error).not.toContain("api down");
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.afterTasks).toHaveLength(0);
  });
});

describe("rate limits on the Server Actions", () => {
  it("stops a user who keeps trying to delete the account, before doing anything", async () => {
    for (let i = 0; i < 5; i++) await run("wrong@example.com"); // a wrong email each time

    const result = await run("root@example.com");

    expect(result.state?.error).toMatch(/Too many requests/);
    expect(mocks.calls).toEqual([]); // not even the correct email got through
    expect(mocks.afterTasks).toHaveLength(0);
  });

  it("keeps the delete limit per user", async () => {
    for (let i = 0; i < 5; i++) await run("wrong@example.com");
    mocks.getSession.mockResolvedValue({
      user: { id: "user-2", email: "other@example.com" },
      session: { createdAt: new Date() },
    });

    const result = await run("other@example.com");

    expect(result.redirectedTo).toBe("/");
  });

  it("keeps what the user typed when the save is rejected for validation or for too many requests", async () => {
    const tooLong = "a".repeat(1001);
    const form = new FormData();
    form.set("name", "Alice");
    form.set("bio", tooLong);

    const invalid = await updateProfile(initialProfileFormState, form);
    expect(invalid.errors.bio).toBeDefined();
    expect(invalid.values).toEqual({ name: "Alice", bio: tooLong });

    for (let i = 0; i < 20; i++) await updateProfile(initialProfileFormState, form);
    const limited = await updateProfile(initialProfileFormState, form);
    expect(limited.formError).toMatch(/Too many requests/);
    expect(limited.values).toEqual({ name: "Alice", bio: tooLong });
  });

  it("stops a user who keeps saving the profile, without writing", async () => {
    const form = new FormData();
    form.set("name", "Alice");
    form.set("bio", "hi");
    for (let i = 0; i < 20; i++) {
      // A successful save redirects to /profile, which the mock raises as an error.
      await updateProfile(initialProfileFormState, form).catch((err: unknown) => {
        if (!(err instanceof mocks.Redirected)) throw err;
      });
    }
    mocks.updateUser.mockClear();
    mocks.callApi.mockClear();

    const state = await updateProfile(initialProfileFormState, form);

    expect(state.formError).toMatch(/Too many requests/);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.callApi).not.toHaveBeenCalled();
  });
});
