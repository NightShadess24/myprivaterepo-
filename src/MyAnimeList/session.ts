/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */

// The MyAnimeList login: tokens from the OAuth sign-in (settings), kept in the
// app's secure storage and renewed with the refresh token before they expire.

export const API = "https://api.myanimelist.net/v2";
export const AUTHORIZE_URL = "https://myanimelist.net/v1/oauth2/authorize";
export const TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
// Paperback's MyAnimeList app (the one its 0.8 tracker signs in with)
export const CLIENT_ID = "004e72f9c4d8f5e6e8737d320246c0e3";
export const REDIRECT_URI = "paperback://malAuth";

const TOKEN_KEY = "mal-token";
const USER_KEY = "mal-user";
const SIGNED_IN_KEY = "mal-signed-in";
const SYNC_KEY = "mal-last-sync";
const DAY = 24 * 60 * 60;

export interface Token {
  access: string;
  refresh?: string;
  /** seconds since 1970 */
  expires: number;
}

export interface User {
  id?: number;
  name?: string;
  picture?: string;
}

const now = () => Math.floor(Date.now() / 1000);

// Kept as text: the app's secure storage takes text most reliably.
export function getToken(): Token | undefined {
  let token = Application.getSecureState(TOKEN_KEY) as Token | string | null | undefined;
  if (typeof token === "string") {
    try {
      token = JSON.parse(token) as Token;
    } catch {
      token = undefined;
    }
  }
  return token && typeof token === "object" && typeof token.access === "string" ? token : undefined;
}

export function setToken(token: Token | undefined): void {
  Application.setSecureState(token ? JSON.stringify(token) : null, TOKEN_KEY);
  Application.setState(token ? true : null, SIGNED_IN_KEY);
}

/** Signed in, even when the secure storage can't be read just now (in the background). */
export const wasSignedIn = () =>
  Application.getState(SIGNED_IN_KEY) === true || getToken() !== undefined;

export interface SyncReport {
  /** ISO date of the last automatic update */
  at: string;
  updated: number;
  unchanged: number;
  failed: number;
  error?: string;
  /** What happened to each manga ("Berserk: chapter 12 saved"); text only in 1.0.1 */
  lines?: (string | SyncLine)[];
}

export interface SyncLine {
  text: string;
  /** ISO date of when the chapter was read in the app */
  readAt?: string;
  kind?: UpdateKind;
}

// ── History: the tracker's recent updates, newest first ──────────────────

const HISTORY_KEY = "mal-history";
const HISTORY_SIZE = 100;

/** saved, already up to date, MyAnimeList kept less, failed, or set by hand */
export type UpdateKind = "saved" | "same" | "capped" | "failed" | "manual";

export interface HistoryEntry {
  /** ISO date of the update */
  at: string;
  text: string;
  kind: UpdateKind;
  /** ISO date the chapter was read (automatic updates) */
  readAt?: string;
}

const kindOfText = (text: string): UpdateKind =>
  /already at/.test(text)
    ? "same"
    : /stopped at/.test(text)
      ? "capped"
      : /saved/.test(text)
        ? "saved"
        : "failed";

export function getHistory(): HistoryEntry[] {
  const history = Application.getState(HISTORY_KEY);
  if (Array.isArray(history)) return history as HistoryEntry[];
  // Before there was a history (1.0.1, 1.0.2): start it from the last update.
  const report = getSyncReport();
  return (report?.lines ?? []).map((line) => {
    const { text, readAt, kind } = typeof line === "string" ? { text: line } : line;
    return { at: report!.at, text, readAt, kind: kind ?? kindOfText(text) };
  });
}

export function addHistory(entries: HistoryEntry[]): void {
  if (!entries.length) return;
  Application.setState([...entries, ...getHistory()].slice(0, HISTORY_SIZE), HISTORY_KEY);
}

export function clearHistory(): void {
  Application.setState([], HISTORY_KEY);
}

/** "45s", "2m 05s", "3h 12m", "2d 4h" */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** A date the app hands over (a Date, text, or a number), if it's a real one. */
export function dateOf(value: unknown): Date | undefined {
  let date: Date;
  if (value instanceof Date) date = value;
  // A date made outside the extension isn't `instanceof Date` here.
  else if (typeof (value as Date | null)?.getTime === "function")
    date = new Date((value as Date).getTime());
  else if (typeof value === "number") date = new Date(value < 1e11 ? value * 1000 : value);
  else if (typeof value === "string" && value) date = new Date(value);
  else return undefined;
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function getSyncReport(): SyncReport | undefined {
  return (Application.getState(SYNC_KEY) as SyncReport | null | undefined) ?? undefined;
}

export function setSyncReport(report: SyncReport): void {
  Application.setState(report, SYNC_KEY);
}

export function getUser(): User | undefined {
  return (Application.getState(USER_KEY) as User | null | undefined) ?? undefined;
}

export function setUser(user: User | undefined): void {
  Application.setState(user ?? null, USER_KEY);
}

export const isLoggedIn = () => getToken() !== undefined;

const isJwt = (value: string | undefined) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value ?? "");

/** When a JWT expires (seconds since 1970), if it says. */
function expiryOf(jwt: string): number | undefined {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Application.base64Decode(part + "=".repeat((4 - (part.length % 4)) % 4));
    const payload = JSON.parse(
      typeof decoded === "string" ? decoded : Application.arrayBufferToUTF8String(decoded),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/** Tokens from the sign-in. The access token is the JWT one, whichever order they come in. */
export function tokensFromLogin(first: string, second: string): Token {
  const [access, refresh] = isJwt(first) || !isJwt(second) ? [first, second] : [second, first];
  return { access, refresh: refresh || undefined, expires: expiryOf(access) ?? now() + 30 * DAY };
}

function formBody(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

async function renew(token: Token): Promise<Token | undefined> {
  if (!token.refresh) return token;
  const [response, data] = await Application.scheduleRequest({
    url: TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: token.refresh,
      client_id: CLIENT_ID,
    }),
  });
  if (response.status === 400 || response.status === 401) {
    // The sign-in was revoked or ran out: sign in again in the settings.
    setToken(undefined);
    setUser(undefined);
    return undefined;
  }
  if (response.status >= 400) return token;
  const json = JSON.parse(Application.arrayBufferToUTF8String(data)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) return token;
  const renewed: Token = {
    access: json.access_token,
    refresh: json.refresh_token ?? token.refresh,
    expires: json.expires_in
      ? now() + json.expires_in
      : (expiryOf(json.access_token) ?? now() + 30 * DAY),
  };
  setToken(renewed);
  return renewed;
}

/** A current access token (renewed if it runs out within a day), or undefined when signed out. */
export async function accessToken(): Promise<string | undefined> {
  let token = getToken();
  if (token && token.expires - DAY < now()) token = await renew(token);
  return token?.access;
}

export { formBody };
