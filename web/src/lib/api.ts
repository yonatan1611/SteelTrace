export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

let authToken: string | null = null;

/** Called once by AuthContext on mount/login/logout — keeps every request authorized without each call site threading a token through. */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

type Json = Record<string, unknown> | unknown[];

async function request<T>(method: string, path: string, body?: Json): Promise<T> {
  const headers: Record<string, string> = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const err = data?.error ?? { code: "UNKNOWN", message: res.statusText };
    throw new ApiRequestError(res.status, err.code, err.message);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: Json) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: Json) => request<T>("PATCH", path, body ?? {}),
};

/** POST /api/bbs/import needs a raw multipart body — bypasses the JSON helper above entirely. */
export async function postMultipart<T>(path: string, fields: Record<string, string>, file: File): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", file);

  const headers: Record<string, string> = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  const res = await fetch(`/api${path}`, { method: "POST", headers, body: form });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = data?.error ?? { code: "UNKNOWN", message: res.statusText };
    throw new ApiRequestError(res.status, err.code, err.message);
  }
  return data as T;
}
