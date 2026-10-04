import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "@/lib/api";

const baseURL = "http://api.test";

function fakeFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apiRequest", () => {
  it("sends a JSON body with the given method", async () => {
    const fetch = fakeFetch({ ok: true });
    await apiRequest("/me/profile", "t", { method: "PUT", body: { bio: "hi" }, baseURL, fetch });

    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"bio":"hi"}');
    expect(init.headers).toEqual({
      Authorization: "Bearer t",
      "Content-Type": "application/json",
    });
  });

  it("defaults to GET with no body and no Content-Type", async () => {
    const fetch = fakeFetch({});
    await apiRequest("/me", "t", { baseURL, fetch });

    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: "Bearer t" });
  });

  it("sends the token as a Bearer header to the API URL", async () => {
    const fetch = fakeFetch({ ok: true });
    await apiRequest("/me", "tok123", { baseURL, fetch });

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("http://api.test/me");
    expect(init.headers).toEqual({ Authorization: "Bearer tok123" });
    expect(init.cache).toBe("no-store");
  });

  it("returns the parsed JSON body", async () => {
    const fetch = fakeFetch({ user_id: "u1", bio: "hello" });
    await expect(apiRequest("/me/profile", "t", { baseURL, fetch })).resolves.toEqual({
      user_id: "u1",
      bio: "hello",
    });
  });

  it.each([401, 500, 503])("throws ApiError carrying status %i", async (status) => {
    const fetch = fakeFetch({ error: "nope" }, status);
    const err = await apiRequest("/me", "t", { baseURL, fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
  });

  it("never puts the token in an error message", async () => {
    const fetch = fakeFetch({}, 401);
    const err = await apiRequest("/me", "secret-token", { baseURL, fetch }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).not.toContain("secret-token");
  });

  it("passes on a network failure instead of swallowing it", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(apiRequest("/me", "t", { baseURL, fetch })).rejects.toThrow("fetch failed");
  });

  it("gives every request a live timeout signal so a hanging API cannot hang the page", async () => {
    const fetch = fakeFetch({});
    await apiRequest("/me", "t", { baseURL, fetch });

    const { signal } = fetch.mock.calls[0][1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("rejects a 200 whose body is not JSON", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    await expect(apiRequest("/me", "t", { baseURL, fetch })).rejects.toThrow();
  });

  it("uses API_BASE_URL when no baseURL is given", async () => {
    vi.stubEnv("API_BASE_URL", "http://from-env.test");
    const fetch = fakeFetch({});
    await apiRequest("/me", "t", { fetch });
    expect(String(fetch.mock.calls[0][0])).toBe("http://from-env.test/me");
  });

  it("requires API_BASE_URL in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_BASE_URL", "");
    await expect(apiRequest("/me", "t", { fetch: fakeFetch({}) })).rejects.toThrow(
      "API_BASE_URL is required",
    );
  });
});
