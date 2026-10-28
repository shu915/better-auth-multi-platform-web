import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { challengeOf, identifierOf, stateIdentifierOf } from "@/lib/mobile-code";
import { exchangeFromRequest, exchangeStateFromRequest } from "@/lib/mobile-exchange";
import { MAX_BODY_BYTES, readLimitedText } from "@/lib/mobile-request";

const verifier = randomBytes(32).toString("base64url");
const code = randomBytes(32).toString("base64url");

// A store with one code in it, used once like the real one.
function store() {
  const records = new Map([
    [identifierOf(code), { value: JSON.stringify({ sealed: "SEALED", challenge: challengeOf(verifier) }) }],
  ]);
  return {
    consume: async (id: string) => {
      const record = records.get(id) ?? null;
      records.delete(id);
      return record;
    },
    open: async (sealed: string) => (sealed === "SEALED" ? "better-auth.session_token=abc" : ""),
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/mobile/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("exchangeFromRequest", () => {
  it("gives the cookie for the right code and verifier", async () => {
    expect(await exchangeFromRequest(post({ code, verifier }), store())).toEqual({
      status: 200,
      body: { cookie: "better-auth.session_token=abc" },
    });
  });

  it("answers every refusal the same, and shows nothing about which check refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrongVerifier = randomBytes(32).toString("base64url");
    const answers = await Promise.all([
      exchangeFromRequest(post({ code, verifier: wrongVerifier }), store()), // wrong verifier
      exchangeFromRequest(post({ code: randomBytes(32).toString("base64url"), verifier }), store()), // unknown code
      exchangeFromRequest(post({ code: "short", verifier }), store()), // malformed
      exchangeFromRequest(post({}), store()), // nothing
      exchangeFromRequest(post([]), store()), // not an object
    ]);
    for (const answer of answers) expect(answer).toEqual({ status: 400, body: { error: "invalid_code" } });
    expect(JSON.stringify(answers)).not.toMatch(/mismatch|unknown|malformed|expired|used/);
    vi.restoreAllMocks();
  });

  it("logs which check refused, without the code or the verifier", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await exchangeFromRequest(post({ code, verifier: randomBytes(32).toString("base64url") }), store());
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    warn.mockRestore();
    expect(logged).toContain("[mobile-exchange] refused: verifier-mismatch");
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(verifier);
  });

  it("refuses a body that is not JSON (400) and one that is too large (413)", async () => {
    expect((await exchangeFromRequest(post("not json"), store())).status).toBe(400);
    expect((await exchangeFromRequest(post({ code: "a".repeat(5000), verifier }), store())).status).toBe(413);
    const declared = post({ code, verifier }, { "content-length": "999999" });
    expect((await exchangeFromRequest(declared, store())).status).toBe(413);
  });

  it("uses the code up on the first try, whatever the verifier", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = store();
    await exchangeFromRequest(post({ code, verifier: randomBytes(32).toString("base64url") }), deps);
    expect((await exchangeFromRequest(post({ code, verifier }), deps)).status).toBe(400);
    vi.restoreAllMocks();
  });
});

describe("readLimitedText", () => {
  // Only the body matters to readLimitedText, so a streamed one is given on its own (a streamed
  // Request needs a Node-only option that the types do not know).
  const streamOf = (...chunks: string[]) => ({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  });

  it("reads a body within the limit", async () => {
    expect(await readLimitedText(streamOf("hel", "lo"), 10)).toBe("hello");
  });

  it("stops at the limit in bytes, when there is no Content-Length", async () => {
    expect(await readLimitedText(streamOf("a".repeat(6), "a".repeat(6)), 10)).toBeNull();
  });

  it("counts bytes, not characters", async () => {
    // "あ" is 3 bytes: 4 of them are 12 bytes in 4 characters.
    expect(await readLimitedText(streamOf("ああああ"), 10)).toBeNull();
    expect(await readLimitedText(streamOf("あああ"), 10)).toBe("あああ");
  });

  it("allows a body of exactly MAX_BODY_BYTES", async () => {
    expect(await readLimitedText(streamOf("a".repeat(MAX_BODY_BYTES)), MAX_BODY_BYTES)).toHaveLength(MAX_BODY_BYTES);
  });
});

describe("exchangeStateFromRequest", () => {
  const state = randomBytes(16).toString("hex");
  const stateStore = () => {
    const records = new Map([
      [stateIdentifierOf(state), { value: JSON.stringify({ sealed: "SEALED", challenge: challengeOf(verifier) }) }],
    ]);
    return {
      consume: async (id: string) => {
        const record = records.get(id) ?? null;
        records.delete(id);
        return record;
      },
      open: async (sealed: string) => (sealed === "SEALED" ? "better-auth.session_token=abc" : ""),
    };
  };

  it("gives the cookie for the right state and verifier", async () => {
    expect(await exchangeStateFromRequest(post({ state, verifier }), stateStore())).toEqual({
      status: 200,
      body: { cookie: "better-auth.session_token=abc" },
    });
  });

  it("answers 202 'not yet' when nothing is stored, and uses nothing up", async () => {
    const deps = stateStore();
    const other = randomBytes(16).toString("hex");
    expect(await exchangeStateFromRequest(post({ state: other, verifier }), deps)).toEqual({
      status: 202,
      body: { pending: true },
    });
    expect((await exchangeStateFromRequest(post({ state, verifier }), deps)).status).toBe(200);
  });

  it("answers 400 without details for a malformed body and for a wrong verifier", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answers = await Promise.all([
      exchangeStateFromRequest(post({ state, verifier: randomBytes(32).toString("base64url") }), stateStore()),
      exchangeStateFromRequest(post({ state: "short", verifier }), stateStore()),
      exchangeStateFromRequest(post({}), stateStore()),
      exchangeStateFromRequest(post([]), stateStore()),
    ]);
    for (const answer of answers) expect(answer).toEqual({ status: 400, body: { error: "invalid_state" } });
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    warn.mockRestore();
    expect(logged).toContain("[mobile-exchange-state] refused: verifier-mismatch");
    expect(logged).not.toContain(state);
    expect(logged).not.toContain(verifier);
  });

  it("refuses a body that is not JSON (400) or too large (413)", async () => {
    expect((await exchangeStateFromRequest(post("not json"), stateStore())).status).toBe(400);
    const big = post({ state, verifier, pad: "x".repeat(MAX_BODY_BYTES + 1) });
    expect((await exchangeStateFromRequest(big, stateStore())).status).toBe(413);
  });

  it("answers 429 when this client asks too often, before it reads or looks up anything", async () => {
    const consume = vi.fn(async () => null);
    const answer = await exchangeStateFromRequest(post({ state, verifier }), {
      ...stateStore(),
      consume,
      allow: async () => ({ allowed: false, retryAfterSeconds: 7 }),
    });
    expect(answer).toEqual({ status: 429, body: { error: "rate_limited", retryAfterSeconds: 7 } });
    expect(consume).not.toHaveBeenCalled();
  });

  it("goes on when the client may ask", async () => {
    const answer = await exchangeStateFromRequest(post({ state, verifier }), {
      ...stateStore(),
      allow: async () => ({ allowed: true }),
    });
    expect(answer.status).toBe(200);
  });
});
