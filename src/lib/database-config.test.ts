import { describe, expect, it } from "vitest";
import { poolConfig, requireTls } from "@/lib/database-config";

const base = "postgres://app:s3cret@db.example.com:5432/app";

describe("requireTls", () => {
  it("accepts the sslmodes that always encrypt", () => {
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      expect(() => requireTls(`${base}?sslmode=${mode}`)).not.toThrow();
    }
  });

  it("refuses a URL that can fall back to plain text", () => {
    for (const url of [
      base, // sslmode omitted
      `${base}?sslmode=disable`,
      `${base}?sslmode=allow`,
      `${base}?sslmode=prefer`,
      `${base}?sslmode=`,
      `${base}?sslmode=REQUIRE`,
    ]) {
      expect(() => requireTls(url), url).toThrow(/sslmode/);
    }
  });

  it("never repeats the password", () => {
    for (const url of [base, `${base}?sslmode=disable`, "not a url but s3cret"]) {
      try {
        requireTls(url);
      } catch (err) {
        expect(String((err as Error).message)).not.toContain("s3cret");
      }
    }
  });

  it("refuses something that is not a URL", () => {
    expect(() => requireTls("not a url")).toThrow(/not a valid URL/);
  });
});

describe("poolConfig", () => {
  it("needs DATABASE_URL", () => {
    expect(() => poolConfig({})).toThrow(/DATABASE_URL is required/);
    expect(() => poolConfig({ DATABASE_URL: "" })).toThrow(/DATABASE_URL is required/);
  });

  it("allows a plain connection in development and test (the local database has no TLS)", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      expect(() => poolConfig({ DATABASE_URL: `${base}?sslmode=disable`, NODE_ENV })).not.toThrow();
    }
  });

  it("requires TLS in production", () => {
    expect(() => poolConfig({ DATABASE_URL: base, NODE_ENV: "production" })).toThrow(/sslmode/);
    expect(() =>
      poolConfig({ DATABASE_URL: `${base}?sslmode=require`, NODE_ENV: "production" }),
    ).not.toThrow();
  });

  it("does not check during next build, which only loads the app with placeholder settings", () => {
    expect(() =>
      poolConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
      }),
    ).not.toThrow();
    // ...but any other phase at runtime is checked.
    expect(() =>
      poolConfig({ DATABASE_URL: base, NODE_ENV: "production", NEXT_PHASE: "phase-production-server" }),
    ).toThrow(/sslmode/);
  });

  it("bounds the pool and the waiting, and sets no server-side startup parameter", () => {
    const config = poolConfig({ DATABASE_URL: `${base}?sslmode=require` });
    expect(config).toMatchObject({
      connectionString: `${base}?sslmode=require`,
      max: 10,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      idleTimeoutMillis: 30_000,
    });
    expect(config).not.toHaveProperty("statement_timeout");
  });

  it("takes the pool size from DATABASE_POOL_MAX and rejects nonsense", () => {
    expect(poolConfig({ DATABASE_URL: base, DATABASE_POOL_MAX: "3" }).max).toBe(3);
    for (const bad of ["0", "-1", "51", "abc", "2.5"]) {
      expect(() => poolConfig({ DATABASE_URL: base, DATABASE_POOL_MAX: bad }), bad).toThrow(
        /DATABASE_POOL_MAX/,
      );
    }
  });
});
