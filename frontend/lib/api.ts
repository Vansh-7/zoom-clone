import type {
  Admission,
  CreatedMeeting,
  Meeting,
  RtcConfig,
  ScheduleInput,
  User,
} from "@/types";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "development") return "http://127.0.0.1:8000";
  throw new ApiError(
    "CONFIGURATION_ERROR",
    "The API URL is missing. Set NEXT_PUBLIC_API_BASE_URL and rebuild the frontend.",
  );
}

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  binary = false,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.ok && binary) return (await response.blob()) as T;
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(
        data.error?.code ?? "REQUEST_FAILED",
        data.error?.message ?? "Something went wrong. Please try again.",
        data.error?.fields,
      );
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "NETWORK_ERROR",
      "We couldn't reach the meeting server. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  health: () => request<{ status: string }>("/api/health"),
  calendar: (code: string) =>
    request<Blob>(
      `/api/meetings/${code}/calendar`,
      "GET",
      undefined,
      undefined,
      true,
    ),
  user: () => request<User>("/api/user"),
  upcoming: () => request<Meeting[]>("/api/meetings/upcoming"),
  recent: () => request<Meeting[]>("/api/meetings/recent"),
  meeting: (code: string) => request<Meeting>(`/api/meetings/${code}`),
  instant: () => request<CreatedMeeting>("/api/meetings/instant", "POST"),
  schedule: (body: ScheduleInput) =>
    request<CreatedMeeting>("/api/meetings/schedule", "POST", body),
  claim: (code: string) =>
    request<CreatedMeeting>(`/api/meetings/${code}/claim`, "POST"),
  start: (code: string, token: string) =>
    request<Meeting>(`/api/meetings/${code}/start`, "POST", undefined, token),
  join: (code: string, display_name: string, token?: string) =>
    request<Admission>(
      `/api/meetings/${code}/join`,
      "POST",
      { display_name },
      token,
    ),
  leave: (code: string, token: string) =>
    request(`/api/meetings/${code}/leave`, "POST", undefined, token),
  end: (code: string, token: string) =>
    request(`/api/meetings/${code}/end`, "POST", undefined, token),
  rtc: () => request<RtcConfig>("/api/rtc-config"),
};

export function websocketUrl(code: string): string {
  const url = new URL(apiBase());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/meetings/${code}`;
  return url.toString();
}
