"use client";

import { toast } from "sonner";

/**
 * Thrown when an API response is not OK (status >= 400).
 * Carries the parsed error body (if JSON) and the HTTP status code.
 */
export class ApiError extends Error {
  status: number;
  data: unknown;
  code?: string;

  constructor(message: string, status: number, data?: unknown, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.code = code;
  }
}

export type ApiClientOptions = Omit<RequestInit, "body"> & {
  /**
   * Body. If a plain object/array is passed, it's JSON-serialized and the
   * Content-Type header is set automatically. FormData/Blob/string are passed
   * through as-is.
   */
  body?: unknown;
  /**
   * Query parameters to append. Values are coerced to strings. Undefined/null
   * entries are skipped.
   */
  query?: Record<string, string | number | boolean | undefined | null>;
  /**
   * If true, do not automatically redirect to /login on a 401. Defaults to
   * false (redirect on 401).
   */
  skipAuthRedirect?: boolean;
  /**
   * If true, do not show a toast on error. Defaults to false.
   */
  silent?: boolean;
};

const isJsonResponse = (res: Response): boolean => {
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") || ct.includes("+json");
};

const buildUrl = (
  path: string,
  query?: ApiClientOptions["query"],
): string => {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return path;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
};

const redirectToLogin = (): void => {
  if (typeof window === "undefined") return;
  // Preserve the post-login destination so we can bounce back.
  const next = encodeURIComponent(
    window.location.pathname + window.location.search,
  );
  window.location.assign(`/login?next=${next}`);
};

const extractMessage = (data: unknown, fallback: string): string => {
  if (data && typeof data === "object") {
    const maybe = data as { message?: unknown; error?: unknown };
    if (typeof maybe.message === "string" && maybe.message.length > 0) {
      return maybe.message;
    }
    if (typeof maybe.error === "string" && maybe.error.length > 0) {
      return maybe.error;
    }
  }
  return fallback;
};

const extractCode = (data: unknown): string | undefined => {
  if (data && typeof data === "object") {
    const maybe = data as { code?: unknown };
    if (typeof maybe.code === "string") return maybe.code;
  }
  return undefined;
};

/**
 * Core request function.
 *
 * Behavior:
 *  - Automatically JSON-encodes object bodies and parses JSON responses.
 *  - On a 401 response, redirects the browser to `/login` (unless
 *    `skipAuthRedirect` is set) and rejects with an ApiError so callers can
 *    bail.
 *  - On any non-OK response, raises an ApiError. A user-friendly toast is
 *    displayed automatically (unless `silent` is set).
 *  - On network/parse failures, raises an ApiError with status 0 and shows a
 *    generic toast.
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: ApiClientOptions = {},
): Promise<T> {
  const {
    body,
    query,
    headers,
    skipAuthRedirect,
    silent,
    ...rest
  } = options;

  const finalHeaders = new Headers(headers);
  let finalBody: BodyInit | undefined;

  if (body !== undefined) {
    const isFormData =
      typeof FormData !== "undefined" && body instanceof FormData;
    const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
    const isString = typeof body === "string";
    const isUrlSearchParams = body instanceof URLSearchParams;

    if (isFormData || isBlob || isUrlSearchParams) {
      finalBody = body as BodyInit;
    } else if (isString) {
      finalBody = body;
    } else {
      finalBody = JSON.stringify(body);
      if (!finalHeaders.has("Content-Type")) {
        finalHeaders.set("Content-Type", "application/json");
      }
    }
  }

  if (!finalHeaders.has("Accept")) {
    finalHeaders.set("Accept", "application/json");
  }

  const url = buildUrl(path, query);

  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: finalHeaders,
      body: finalBody,
      credentials: rest.credentials ?? "same-origin",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Network request failed";
    if (!silent) {
      toast.error("Network error", {
        description: "Unable to reach the server. Check your connection.",
      });
    }
    throw new ApiError(message, 0);
  }

  // Parse response body (JSON if the server says so, text otherwise).
  let data: unknown = undefined;
  if (response.status !== 204 && response.status !== 205) {
    try {
      if (isJsonResponse(response)) {
        // Empty bodies on JSON endpoints can throw — guard for that.
        const text = await response.text();
        data = text ? JSON.parse(text) : undefined;
      } else {
        data = await response.text();
      }
    } catch {
      data = undefined;
    }
  }

  if (response.status === 401) {
    if (!skipAuthRedirect) {
      redirectToLogin();
    } else if (!silent) {
      toast.error("Session expired", {
        description: "Please sign in again.",
      });
    }
    throw new ApiError(
      extractMessage(data, "Your session has expired"),
      401,
      data,
      extractCode(data),
    );
  }

  if (!response.ok) {
    const fallback =
      response.status >= 500
        ? "Something went wrong on our end. Please try again."
        : "Request failed";
    const message = extractMessage(data, fallback);
    if (!silent) {
      toast.error(
        response.status >= 500 ? "Server error" : "Request failed",
        { description: message },
      );
    }
    throw new ApiError(message, response.status, data, extractCode(data));
  }

  return data as T;
}

/** Convenience method shortcuts. */
export const apiClient = {
  get<T = unknown>(path: string, options: ApiClientOptions = {}) {
    return apiRequest<T>(path, { ...options, method: "GET" });
  },
  post<T = unknown>(
    path: string,
    body?: unknown,
    options: ApiClientOptions = {},
  ) {
    return apiRequest<T>(path, { ...options, method: "POST", body });
  },
  put<T = unknown>(
    path: string,
    body?: unknown,
    options: ApiClientOptions = {},
  ) {
    return apiRequest<T>(path, { ...options, method: "PUT", body });
  },
  patch<T = unknown>(
    path: string,
    body?: unknown,
    options: ApiClientOptions = {},
  ) {
    return apiRequest<T>(path, { ...options, method: "PATCH", body });
  },
  delete<T = unknown>(path: string, options: ApiClientOptions = {}) {
    return apiRequest<T>(path, { ...options, method: "DELETE" });
  },
};

export default apiClient;
