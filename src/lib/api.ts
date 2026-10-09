// Calls to the Go API. The caller supplies the Better Auth JWT; the API trusts only its `sub`.
// Server code should use `callApi` (api-server.ts), which issues the token itself.

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API request failed with status ${status}`);
    this.name = "ApiError";
  }
}

export type Profile = { user_id: string; bio: string };

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Options = {
  method?: Method;
  /** Sent as JSON when given. */
  body?: unknown;
  baseURL?: string;
  fetch?: typeof fetch;
};

const TIMEOUT_MS = 5000;

function resolveBaseURL(explicit?: string): string {
  const url =
    explicit ||
    process.env.API_BASE_URL ||
    (process.env.NODE_ENV === "production" ? undefined : "http://localhost:8080");
  if (!url) throw new Error("API_BASE_URL is required in production");
  // The Bearer JWT and the profile travel on this URL; in production it must be encrypted.
  if (process.env.NODE_ENV === "production" && !url.startsWith("https://")) {
    throw new Error("API_BASE_URL must be https in production");
  }
  return url;
}

export async function apiRequest<T>(
  path: string,
  token: string,
  options: Options = {},
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await (options.fetch ?? fetch)(
    new URL(path, resolveBaseURL(options.baseURL)),
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      // A down or hanging API must not hang the page.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new ApiError(res.status);
  // 204 has no body (DELETE /me); callers of such endpoints use T = void.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
