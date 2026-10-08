import { describe, expect, it } from "vitest";
import { resolveGoogleCredentials } from "@/lib/google-oauth";

describe("resolveGoogleCredentials", () => {
  it("is off when neither value is set", () => {
    expect(resolveGoogleCredentials({})).toBeNull();
  });

  it("treats blank values as unset", () => {
    expect(
      resolveGoogleCredentials({ GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: "" }),
    ).toBeNull();
  });

  it("returns the credentials when both are set", () => {
    expect(
      resolveGoogleCredentials({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("trims surrounding whitespace", () => {
    expect(
      resolveGoogleCredentials({ GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: " secret " }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("throws when only the client id is set", () => {
    expect(() => resolveGoogleCredentials({ GOOGLE_CLIENT_ID: "id" })).toThrow(
      "must be set together",
    );
  });

  it("throws when only the client secret is set", () => {
    expect(() => resolveGoogleCredentials({ GOOGLE_CLIENT_SECRET: "secret" })).toThrow(
      "must be set together",
    );
  });
});
