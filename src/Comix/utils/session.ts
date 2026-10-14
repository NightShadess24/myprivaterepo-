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
