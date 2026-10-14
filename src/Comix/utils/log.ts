/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// A short log of what happened when opening chapters (page list, images), shown
// under Settings → Reading Log so a screenshot tells which step went wrong.

export interface LogEntry {
  at: number;
  what: string;
  detail: string;
}

const KEY = "comix_reading_log";
const MAX_ENTRIES = 30;

export function logEvent(what: string, detail: string): void {
  console.log(`[Comix] ${what}: ${detail}`);
  try {
    const entries = getLog();
    entries.unshift({ at: Date.now(), what, detail: detail.slice(0, 300) });
    Application.setState(entries.slice(0, MAX_ENTRIES), KEY);
  } catch {
    // logging must never break reading
  }
}

export function getLog(): LogEntry[] {
  const stored = Application.getState(KEY);
  return Array.isArray(stored) ? (stored as LogEntry[]) : [];
}

export function clearLog(): void {
  Application.setState([], KEY);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
