import { symmetricDecrypt } from "better-auth/crypto";
import { auth } from "@/lib/auth";
import { exchangeFromRequest } from "@/lib/mobile-exchange";

// POST /api/mobile/exchange for the native app. See mobile-exchange.ts and mobile-code.ts.
export async function POST(request: Request): Promise<Response> {
  const { internalAdapter, secretConfig } = await auth.$context;
  const { status, body } = await exchangeFromRequest(request, {
    consume: (identifier) => internalAdapter.consumeVerificationValue(identifier),
    open: (sealed) => symmetricDecrypt({ key: secretConfig, data: sealed }),
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
