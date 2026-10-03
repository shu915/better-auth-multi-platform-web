import { createAuthClient } from "better-auth/react";
import { jwtClient, magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [magicLinkClient(), jwtClient()],
});
