import { ApiError } from "./api";

export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3, 7)} ${code.slice(7)}`;
}
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
export function hostToken(code: string): string | undefined {
  try {
    return localStorage.getItem(`zoom:host:${code}`) ?? undefined;
  } catch {
    return undefined;
  }
}
export function saveHostToken(code: string, token: string): void {
  try {
    localStorage.setItem(`zoom:host:${code}`, token);
  } catch {
    throw new ApiError(
      "STORAGE_DISABLED",
      "Enable browser storage to retain host access. Your meeting was created, but this browser couldn't save its host key.",
    );
  }
}
export function parseMeetingInput(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[\s-]/g, "");
  if (/^\d{11}$/.test(normalized)) return normalized;
  try {
    const url = new URL(trimmed);
    const allowedOrigin = new URL(window.location.origin).origin;
    const path = url.pathname.match(/^\/meeting\/(\d{11})\/?$/);
    if (url.origin === allowedOrigin && path && !url.username && !url.password)
      return path[1];
  } catch {
    /* Continue with the friendly input error below. */
  }
  throw new ApiError(
    "INVALID_INVITE",
    "Enter an 11-digit meeting ID or a meeting invitation from this app.",
  );
}
export function localSchedule(date: string, time: string): string {
  const value = new Date(`${date}T${time}:00`);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (
    !Number.isFinite(value.getTime()) ||
    value.getFullYear() !== year ||
    value.getMonth() + 1 !== month ||
    value.getDate() !== day ||
    value.getHours() !== hour ||
    value.getMinutes() !== minute
  )
    throw new ApiError(
      "INVALID_DATE",
      "That local time doesn't exist. Choose another date and time.",
    );
  if (value.getTime() <= Date.now())
    throw new ApiError("INVALID_DATE", "Choose a meeting time in the future.");
  return value.toISOString();
}
export function friendlyTimezone(
  timezone: string,
  date: string,
  time: string,
): string {
  if (!timezone) return "Detecting timezone…";
  const scheduled = new Date(`${date}T${time}:00`);
  const at = Number.isFinite(scheduled.getTime()) ? scheduled : new Date();
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const region = ["Asia/Calcutta", "Asia/Kolkata"].includes(timezone)
    ? "India"
    : timezone.split("/").pop()!.replaceAll("_", " ");
  return `(${offset === "GMT" ? "GMT+00:00" : offset}) ${region}`;
}
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard)
    throw new Error(
      "Copy isn't available here. Select and copy the invitation text instead.",
    );
  await navigator.clipboard.writeText(text);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
