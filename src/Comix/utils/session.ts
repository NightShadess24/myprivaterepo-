/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import type { Cookie } from "@paperback/types";

// ---------------------------------------------------------------------------
// Cloudflare pass (cf_clearance)
//
// Kept in the extension's state and read back fresh for every request, rather
// than only in the cookie store's in-memory copy. A library refresh can run in a
// different instance of the extension than the one the reader passed the check
// in; reading state each time means every instance sends the newest pass, and
// none of them writes an older one back over it.
// ---------------------------------------------------------------------------

const CLEARANCE_KEY = "comix_cf_clearance";

export interface StoredClearance {
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  savedAt: number;
  source: string;
}

export function saveClearance(cookie: Cookie, source: string): void {
  const expires = cookie.expires instanceof Date ? cookie.expires.getTime() : undefined;
  const current = loadClearance();
  if (current?.value === cookie.value) return;
  Application.setState(
    {
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires,
      savedAt: Date.now(),
      source,
    } satisfies StoredClearance,
    CLEARANCE_KEY,
  );
  logEvent("pass", `new Cloudflare pass saved (${source})`);
}

export function loadClearance(): StoredClearance | undefined {
  const stored = Application.getState(CLEARANCE_KEY) as StoredClearance | undefined;
  if (!stored || typeof stored.value !== "string" || !stored.value) return undefined;
  if (stored.expires !== undefined && stored.expires <= Date.now()) return undefined;
  return stored;
}

export function clearanceCookie(): Cookie | undefined {
  const stored = loadClearance();
  if (!stored) return undefined;
  return {
    name: "cf_clearance",
    value: stored.value,
    domain: stored.domain || ".comix.to",
    path: stored.path ?? "/",
    expires: stored.expires !== undefined ? new Date(stored.expires) : undefined,
  };
}

// ---------------------------------------------------------------------------
// The site's own passes: cookies and localStorage the site sets once its human
// check (`/@waf/challenge`) is solved, captured from the check screen and from
// page loads. Kept in state and handed to every request and WebView run, since a
// library refresh may not share the browser storage the reader solved it in.
//
// Cloudflare's own fingerprint cookies (__cf_bm, _cfuvid, cf_chl_*, …) are left
// out: they belong to the browser that made them.
// ---------------------------------------------------------------------------

const SITE_COOKIES_KEY = "comix_site_cookies";
const SITE_STORAGE_KEY = "comix_site_storage";

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
}

export const isSiteDomain = (domain: string) => {
  const host = domain.replace(/^\./, "").toLowerCase();
  return host === "comix.to" || host.endsWith(".comix.to");
};

export const isBrowserBoundCookie = (name: string) =>
  /^(__cf_bm|_cfuvid|__cflb|__cfruid|__cfseq.*|cf_chl_.*|cf_ob_info|cf_use_ob)$/i.test(name);

function storedSiteCookies(): Record<string, StoredCookie> {
  const stored = Application.getState(SITE_COOKIES_KEY) as Record<string, StoredCookie> | undefined;
  return stored && typeof stored === "object" ? stored : {};
}

// Saves the site's own cookies (not cf_clearance, not Cloudflare's fingerprint
// cookies). Returns the names that were new or changed.
export function saveSiteCookies(cookies: readonly Cookie[], source: string): string[] {
  const stored = storedSiteCookies();
  const changed: string[] = [];
  for (const cookie of cookies) {
    if (!cookie.value || !cookie.domain || !isSiteDomain(cookie.domain)) continue;
    if (cookie.name === "cf_clearance" || isBrowserBoundCookie(cookie.name)) continue;
    if (stored[cookie.name]?.value === cookie.value) continue;
    stored[cookie.name] = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires instanceof Date ? cookie.expires.getTime() : undefined,
    };
    changed.push(cookie.name);
  }
  if (changed.length > 0) {
    Application.setState(stored, SITE_COOKIES_KEY);
    logEvent("site pass", `saved ${changed.join(", ")} (${source})`);
  }
  return changed;
}

export function loadSiteCookies(): Cookie[] {
  const now = Date.now();
  return Object.values(storedSiteCookies())
    .filter((cookie) => cookie.expires === undefined || cookie.expires > now)
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? "/",
      expires: cookie.expires !== undefined ? new Date(cookie.expires) : undefined,
    }));
}

export function saveSiteStorage(storage: Record<string, string> | undefined, source: string): void {
  const entries = Object.entries(storage ?? {}).filter(
    ([key, value]) => typeof key === "string" && typeof value === "string",
  );
  if (entries.length === 0) return;
  Application.setState(Object.fromEntries(entries), SITE_STORAGE_KEY);
  logEvent("site pass", `saved ${entries.length} site storage keys (${source})`);
}

export const siteCookieNames = () => loadSiteCookies().map((cookie) => cookie.name);

// ---------------------------------------------------------------------------
// The site's human-check pass. The API answers `captcha_required` until the
// request carries the site cookies (in practice its `session`) of a browser
// that solved /@waf/challenge. Cookies are only kept as the pass once a probe
// request with them got past the check, so an unsolved copy is never replayed.
// ---------------------------------------------------------------------------

const WAF_PASS_KEY = "comix_waf_pass";
const LAST_CAPTCHA_KEY = "comix_last_captcha_title";

interface StoredPass {
  cookies: StoredCookie[];
  savedAt: number;
  source: string;
}

const toStored = (cookie: Cookie): StoredCookie => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain,
  path: cookie.path,
  expires: cookie.expires instanceof Date ? cookie.expires.getTime() : undefined,
});

const fromStored = (cookie: StoredCookie): Cookie => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain,
  path: cookie.path ?? "/",
  expires: cookie.expires !== undefined ? new Date(cookie.expires) : undefined,
});

// Candidates for the pass: the site's own cookies, not Cloudflare's.
export const passCandidates = (cookies: readonly Cookie[]): Cookie[] =>
  cookies.filter(
    (cookie) =>
      cookie.value &&
      cookie.domain &&
      isSiteDomain(cookie.domain) &&
      cookie.name !== "cf_clearance" &&
      !isBrowserBoundCookie(cookie.name),
  );

export function saveWafPass(cookies: readonly Cookie[], source: string): void {
  Application.setState(
    { cookies: cookies.map(toStored), savedAt: Date.now(), source } satisfies StoredPass,
    WAF_PASS_KEY,
  );
  logEvent("site pass", `kept ${describeCookies(cookies)} (${source})`);
}

export function loadWafPassInfo(): StoredPass | undefined {
  const stored = Application.getState(WAF_PASS_KEY) as StoredPass | undefined;
  return stored && Array.isArray(stored.cookies) && stored.cookies.length > 0 ? stored : undefined;
}

export function loadWafPass(): Cookie[] {
  const now = Date.now();
  return (loadWafPassInfo()?.cookies ?? [])
    .filter((cookie) => cookie.expires === undefined || cookie.expires > now)
    .map(fromStored);
}

export function clearWafPass(reason: string): void {
  if (!loadWafPassInfo()) return;
  Application.setState(undefined, WAF_PASS_KEY);
  logEvent("site pass", `dropped (${reason})`);
}

export const setLastCaptchaTitle = (hid: string) => Application.setState(hid, LAST_CAPTCHA_KEY);
export const getLastCaptchaTitle = () =>
  Application.getState(LAST_CAPTCHA_KEY) as string | undefined;

// A short, non-reversible tag for a cookie value, so Diagnostics can show
// whether two cookies are the same without showing either.
export function fingerprint(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) hash = (Math.imul(hash, 33) ^ value.charCodeAt(i)) >>> 0;
  return hash.toString(36).slice(0, 5);
}

export const describeCookies = (cookies: readonly Cookie[]) =>
  cookies.map((cookie) => `${cookie.name}#${fingerprint(cookie.value)}`).join(", ") || "no cookies";

export function loadSiteStorage(): Record<string, string> {
  const stored = Application.getState(SITE_STORAGE_KEY) as Record<string, string> | undefined;
  return stored && typeof stored === "object" ? stored : {};
}

// ---------------------------------------------------------------------------
// Diagnostics: the last few things that went wrong (or worth knowing), shown
// under Settings → Diagnostics so a failing refresh can be described exactly.
// ---------------------------------------------------------------------------

const LOG_KEY = "comix_diagnostics";
const LOG_SIZE = 12;

export interface LogEntry {
  at: number;
  what: string;
  message: string;
}

export function getLog(): LogEntry[] {
  const log = Application.getState(LOG_KEY) as LogEntry[] | undefined;
  return Array.isArray(log) ? log : [];
}

export function clearLog(): void {
  Application.setState([], LOG_KEY);
}

export function logEvent(what: string, message: string): void {
  try {
    const log = [{ at: Date.now(), what, message: message.slice(0, 300) }, ...getLog()];
    Application.setState(log.slice(0, LOG_SIZE), LOG_KEY);
  } catch {
    // Diagnostics must never break the extension.
  }
}

export async function withDiagnostics<T>(what: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    const type =
      typeof error === "object" && error !== null && "type" in error
        ? String((error as { type: unknown }).type)
        : "";
    const message = error instanceof Error ? error.message : String(error);
    logEvent(what, `${type ? `[${type}] ` : ""}${message}`);
    throw error;
  }
}

export function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// Quick library refresh: use the site's latest-updates list to skip titles
// with no new chapters. On by default; can be turned off in Settings.
export const useQuickRefresh = () =>
  (Application.getState("quick_refresh") as boolean | undefined) ?? true;

// How fast a library refresh loads titles (each one is a full site page in a
// WebView): how many at once, and the gap between starting them.
export interface RefreshPace {
  id: string;
  title: string;
  concurrency: number;
  gapMs: number;
}

export const REFRESH_PACES: RefreshPace[] = [
  { id: "fast", title: "Fast (3 at a time)", concurrency: 3, gapMs: 250 },
  { id: "normal", title: "Normal (1 per second)", concurrency: 1, gapMs: 1000 },
  { id: "safe", title: "Safe (1 every 2.5 s)", concurrency: 1, gapMs: 2500 },
];

export function getRefreshPace(): RefreshPace {
  const id = Application.getState("refresh_speed") as string | undefined;
  return REFRESH_PACES.find((pace) => pace.id === id) ?? REFRESH_PACES[0];
}
