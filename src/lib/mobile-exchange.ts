import { exchangeCode, exchangeState, type ExchangeDeps } from "@/lib/mobile-code";
import type { RateLimitResult } from "@/lib/rate-limit";
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

// The body of POST /api/mobile/exchange-state: { "state": "...", "verifier": "..." }. The same trade
// as above, for an app whose browser did not hand it the code (see mobile-code.ts): the app asks
// every few seconds while the browser is open.
//   200 { cookie }       the session
//   202 { pending: true }  nothing yet (the sign-in is not finished; nothing is used up)
//   400 { error }        malformed, or the verifier is wrong (then the record is used up)
//   429 { error, retryAfterSeconds }  too many asks from this client (the app waits and asks again)
// It is asked every few seconds and needs no session, so each ask is counted first (`allow`), before
// anything is read or looked up.
export async function exchangeStateFromRequest(
  request: Request,
  deps: ExchangeDeps & { allow?: () => Promise<RateLimitResult> },
): Promise<MobileResponse> {
  const allowed = deps.allow ? await deps.allow() : ({ allowed: true } as const);
  if (!allowed.allowed) {
    return respond(429, { error: "rate_limited", retryAfterSeconds: allowed.retryAfterSeconds });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const raw = body.value;
  const fields = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const result = await exchangeState({ state: fields.state, verifier: fields.verifier }, deps);
  if (result.ok) return respond(200, { cookie: result.cookie });
  if (result.pending) return respond(202, { pending: true });
  console.warn(`[mobile-exchange-state] refused: ${result.why}`);
  return respond(400, { error: "invalid_state" });
}
