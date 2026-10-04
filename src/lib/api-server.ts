import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { apiRequest, type Method, type Profile } from "@/lib/api";

// Server-side calls to the Go API on behalf of the signed-in user. The JWT is issued per call
// from the current request's session, so callers never see, store or pass a token.
export async function callApi<T>(
  path: string,
  options?: { method?: Method; body?: unknown },
): Promise<T> {
  const { token } = await auth.api.getToken({ headers: await headers() });
  return apiRequest<T>(path, token, options);
}

export const getMyProfile = () => callApi<Profile>("/me/profile");
