import { symmetricDecrypt } from "better-auth/crypto";
import { auth } from "@/lib/auth";
import { exchangeStateFromRequest } from "@/lib/mobile-exchange";
import { clientKey, exchangeStateLimiter } from "@/lib/rate-limits";

// POST /api/mobile/exchange-state for the native app. See mobile-exchange.ts and mobile-code.ts.
export async function POST(request: Request): Promise<Response> {
  const { internalAdapter, secretConfig } = await auth.$context;
  const { status, body } = await exchangeStateFromRequest(request, {
    allow: () => exchangeStateLimiter.check(clientKey(request)),
    consume: (identifier) => internalAdapter.consumeVerificationValue(identifier),
    open: (sealed) => symmetricDecrypt({ key: secretConfig, data: sealed }),
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
