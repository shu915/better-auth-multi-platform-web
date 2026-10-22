import { auth } from "@/lib/auth";
import { exchangeCode } from "@/lib/mobile-code";
import { MAX_BODY_BYTES } from "@/lib/mobile-request";

// POST /api/mobile/exchange  { "code": "...", "verifier": "..." }  ->  { "cookie": "..." }
// Trades the one-time code from the sign-in link for the session. No session is needed (this is
// how the app gets one); the verifier is the proof. See mobile-code.ts.
export async function POST(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  // Refuse a body that says it is too large before reading it.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
    return Response.json({ error: "too large" }, { status: 413, headers });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "too large" }, { status: 413, headers });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400, headers });
  }
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const { internalAdapter } = await auth.$context;
  const result = await exchangeCode(
    { code: body.code, verifier: body.verifier },
    { consume: (identifier) => internalAdapter.consumeVerificationValue(identifier) },
  );
  // One answer for every failure: wrong, used, expired and malformed look the same.
  if (!result.ok) return Response.json({ error: "invalid_code" }, { status: 400, headers });
  return Response.json({ cookie: result.cookie }, { status: 200, headers });
}
