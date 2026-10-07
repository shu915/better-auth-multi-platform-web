import { describe, expect, it } from "vitest";
import {
  findLinkedAccountId,
  linkedAccountEmail,
  linkErrorMessage,
  unlinkErrorMessage,
} from "@/lib/linked-accounts";

describe("findLinkedAccountId", () => {
  it("returns the id of the account for the provider", () => {
    const accounts = [
      { id: "a1", providerId: "credential" },
      { id: "a2", providerId: "google" },
    ];
    expect(findLinkedAccountId(accounts, "google")).toBe("a2");
  });

  it("returns null when the provider is not linked", () => {
    expect(findLinkedAccountId([{ id: "a1", providerId: "github" }], "google")).toBeNull();
    expect(findLinkedAccountId([], "google")).toBeNull();
  });
});

describe("unlinkErrorMessage", () => {
  it("tells the user to sign out and sign in again when the session is not fresh", () => {
    const message = unlinkErrorMessage({ code: "SESSION_NOT_FRESH", message: "raw" });
    expect(message).toContain("sign out");
    expect(message).toContain("sign in again");
  });

  it("uses a generic message for other errors and never echoes the raw one", () => {
    const message = unlinkErrorMessage({ code: "SOMETHING_ELSE", message: "<b>raw</b>" });
    expect(message).toBe("Failed to unlink Google. Please try again.");
    expect(message).not.toContain("raw");
  });
});

describe("linkErrorMessage", () => {
  it("tells the user to sign out and sign in again when the session is not fresh", () => {
    const message = linkErrorMessage({ code: "SESSION_NOT_FRESH", message: "raw" });
    expect(message).toContain("sign out");
    expect(message).toContain("sign in again");
    expect(message).toContain("linking");
  });

  it("uses a generic message for other errors and never echoes the raw one", () => {
    const message = linkErrorMessage({ code: "SOMETHING_ELSE", message: "<b>raw</b>" });
    expect(message).toBe("Failed to start linking Google. Please try again.");
    expect(message).not.toContain("raw");
  });
});

describe("linkedAccountEmail", () => {
  const at = new Date("2026-10-07T03:04:05Z");

  it("names the provider and the time, and says what to do if it was not the user", () => {
    const email = linkedAccountEmail("google", at);
    expect(email.subject).toBe("A sign-in method was added to your account");
    expect(email.text).toContain("A Google account was linked");
    expect(email.text).toContain("Wed, 07 Oct 2026 03:04:05 GMT");
    expect(email.text).toContain("unlink it from your profile page");
    expect(email.html).toContain("A Google account was linked");
  });

  it("does not put an unknown provider id into the email", () => {
    const email = linkedAccountEmail("<script>alert(1)</script>", at);
    expect(email.text).toContain("A new sign-in method was linked");
    expect(email.text).not.toContain("script");
    expect(email.html).not.toContain("script");
  });
});
