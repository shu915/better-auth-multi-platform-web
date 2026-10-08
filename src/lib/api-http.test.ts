import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, apiRequest, type Profile } from "@/lib/api";

// api.test.ts replaces fetch. These use the real fetch against a real HTTP server that answers
// the way the Go API does (see its cmd/server/profile.go), so the status codes, the empty 204
// body and the headers are checked over an actual connection.

type Seen = { method: string; url: string; authorization?: string; contentType?: string; body: string };

let server: Server | undefined;

async function startFakeGo(
  respond: (req: IncomingMessage, body: string) => { status: number; json?: unknown },
) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      });
      const { status, json } = respond(req, body);
      if (json === undefined) {
        res.writeHead(status).end();
      } else {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, seen };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("apiRequest over a real connection", () => {
  it("GET /me/profile sends the bearer token and reads the profile", async () => {
    const go = await startFakeGo(() => ({ status: 200, json: { user_id: "u1", bio: "hello" } }));

    const profile = await apiRequest<Profile>("/me/profile", "tok-123", { baseURL: go.baseURL });

    expect(profile).toEqual({ user_id: "u1", bio: "hello" });
    expect(go.seen).toHaveLength(1);
    expect(go.seen[0]).toMatchObject({
      method: "GET",
      url: "/me/profile",
      authorization: "Bearer tok-123",
      body: "",
    });
    expect(go.seen[0].contentType).toBeUndefined();
  });

  it("PUT /me/profile sends the bio as JSON", async () => {
    const go = await startFakeGo(() => ({ status: 200, json: { user_id: "u1", bio: "あ🙂" } }));

    await apiRequest("/me/profile", "t", { method: "PUT", body: { bio: "あ🙂" }, baseURL: go.baseURL });

    expect(go.seen[0].method).toBe("PUT");
    expect(go.seen[0].contentType).toBe("application/json");
    expect(JSON.parse(go.seen[0].body)).toEqual({ bio: "あ🙂" });
  });

  it("DELETE /me accepts the empty 204 body", async () => {
    const go = await startFakeGo(() => ({ status: 204 }));

    await expect(
      apiRequest<void>("/me", "t", { method: "DELETE", baseURL: go.baseURL }),
    ).resolves.toBeUndefined();
    expect(go.seen[0]).toMatchObject({ method: "DELETE", url: "/me" });
  });

  it("turns the Go API's error statuses into ApiError with that status", async () => {
    for (const status of [400, 401, 413, 422, 500, 503]) {
      const go = await startFakeGo(() => ({ status, json: { error: "nope" } }));
      await expect(apiRequest("/me/profile", "t", { baseURL: go.baseURL })).rejects.toMatchObject({
        name: "ApiError",
        status,
      });
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it("does not put the response body or the token into the error", async () => {
    const go = await startFakeGo(() => ({ status: 500, json: { error: "internal secret detail" } }));

    const err = await apiRequest("/me", "tok-secret", { baseURL: go.baseURL }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(String((err as Error).message)).not.toContain("secret");
  });

  it("fails when nothing is listening", async () => {
    const go = await startFakeGo(() => ({ status: 200, json: {} }));
    const { baseURL } = go;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    await expect(apiRequest("/me", "t", { baseURL })).rejects.toThrow();
  });
});
