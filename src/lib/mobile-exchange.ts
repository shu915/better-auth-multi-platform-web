import { exchangeCode, type ExchangeDeps } from "@/lib/mobile-code";
import { readJsonBody, respond, type MobileResponse } from "@/lib/mobile-request";

// The body of POST /api/mobile/exchange: { "code": "...", "verifier": "..." } -> { "cookie": "..." }.
// Trades the one-time code from the sign-in link for the session. No session is needed (this is how
// the app gets one); the verifier is the proof. See mobile-code.ts.
export async function exchangeFromRequest(
  request: Request,
  deps: ExchangeDeps,
): Promise<MobileResponse> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const raw = body.value;
  const fields = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const result = await exchangeCode({ code: fields.code, verifier: fields.verifier }, deps);
  // One answer for every failure: wrong, used, expired and malformed look the same to the caller.
  if (!result.ok) {
    // Which check refused goes to the log only (no code, no verifier, no cookie in it).
    console.warn(`[mobile-exchange] refused: ${result.why}`);
    return respond(400, { error: "invalid_code" });
  }
  return respond(200, { cookie: result.cookie });
}
