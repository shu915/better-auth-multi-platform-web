import { describe, expect, it } from "vitest";
import { oauthErrorMessage } from "@/lib/oauth-errors";

describe("oauthErrorMessage", () => {
  it("returns null when there is no error", () => {
    expect(oauthErrorMessage(undefined)).toBeNull();
    expect(oauthErrorMessage("")).toBeNull();
  });

  it("explains that a Google account must be linked first", () => {
    for (const code of ["signup_disabled", "account_not_linked"]) {
      expect(oauthErrorMessage(code)).toContain("not linked to a user");
    }
  });

  it("explains an account that belongs to another user", () => {
    expect(oauthErrorMessage("account_already_linked_to_different_user")).toContain(
      "another user",
    );
  });

  it("uses a generic message for unknown codes and never echoes them", () => {
    const message = oauthErrorMessage("<script>alert(1)</script>");
    expect(message).toBe("Google sign-in failed. Please try again.");
    expect(message).not.toContain("script");
  });

  it("does not treat object prototype keys as known codes", () => {
    expect(oauthErrorMessage("constructor")).toBe("Google sign-in failed. Please try again.");
  });
});
