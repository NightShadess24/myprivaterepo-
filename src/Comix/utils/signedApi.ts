/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// Direct calls to comix's API, signed and decrypted the way comix's own page
// does it, with the signer and decryptor from the Paperback 0.8 ComixTo
// extension (acepilot147/pb-extensions, GPL-3.0; adapted from its
// ComixHash.ts). No hidden page has to load, so a call takes well under a
// second. comix's server still answers the same way it does to its own page:
// its check (captcha_required) and pacing rules apply unchanged.
//
// comix changes the signing keys now and then. Requests then start failing
// ("Missing token" / an unknown cipher), and SigningOutdated tells the caller
// to fall back to the hidden-page method until the keys are updated.

import { CloudflareError } from "@paperback/types";

import type { ChapterItem, ChapterPageItems } from "../models";
import { checkPage, siteUrl } from "../models";
import { fastDecryptComixPayload } from "../signed/ComixFastDecrypt";
import { fastGenerateHash } from "../signed/ComixFastSigner";
import { logEvent } from "./log";

export class SigningOutdated extends Error {}
export class CaptchaRequired extends Error {}

// Paths comix signs (from the 0.8 extension): /manga… and /chapters/{id}.
const SIGNED = [/^\/manga(?:\/|$)/, /^\/chapters\/[^/]+/];

function signed(url: string): string {
  const path = url
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/api\/v1/, "")
    .split("?")[0]!;
  if (!SIGNED.some((re) => re.test(path))) return url;
  const token = fastGenerateHash(url);
  return token ? `${url}${url.includes("?") ? "&" : "?"}_=${token}` : url;
}

let disabledReason: string | null = null;

// Settings → Fast Loading (on by default).
export function signedApiEnabled(): boolean {
  return Application.getState("signed_api") !== false && disabledReason === null;
}

// The keys stopped working: use the hidden-page method for the rest of the
// session (the app's next start tries again).
export function markSigningOutdated(reason: string): void {
  if (disabledReason !== null) return;
  disabledReason = reason;
  logEvent(
    "fast loading off",
    `comix didn't accept the signed request (${reason}); using the slower method until the signing keys are updated`,
  );
}

export async function fetchApi<T>(pathAndQuery: string): Promise<T> {
  const url = `${siteUrl()}/api/v1${pathAndQuery}`;
  const [response, buffer] = await Application.scheduleRequest({
    url: signed(url),
    method: "GET",
    headers: {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      referer: `${siteUrl()}/`,
    },
  });
  const text = Application.arrayBufferToUTF8String(buffer);
  const status = response.status;
  if (status === 403 && /captcha_required|@waf\/challenge/.test(text)) {
    throw new CaptchaRequired(`HTTP 403 on ${pathAndQuery.split("?")[0]}: ${text.slice(0, 80)}`);
  }
  if (status === 401 || (status === 403 && /token|sign/i.test(text))) {
    throw new SigningOutdated(`HTTP ${status}: ${text.slice(0, 60)}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} on ${pathAndQuery.split("?")[0]}: ${text.slice(0, 80)}`);
  }
  let json: { e?: unknown; status?: string; result?: unknown; message?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new SigningOutdated(`not JSON: ${text.slice(0, 40)}`);
  }
  if (json && typeof json.e === "string") {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) headers[key] = String(value);
    try {
      return fastDecryptComixPayload(pathAndQuery, json, headers) as T;
    } catch (error) {
      throw new SigningOutdated(`couldn't decrypt: ${String((error as Error)?.message ?? error)}`);
    }
  }
  if (json.status !== "ok") {
    throw new Error(`comix API ${json.status ?? "?"}: ${json.message ?? "no message"}`);
  }
  return json.result as T;
}

export interface ChapterPage {
  items: ChapterItem[];
  meta: { page?: number; lastPage?: number; total?: number };
}

export function fetchChapterPage(mangaId: string, page: number, limit: number) {
  return fetchApi<ChapterPage>(
    `/manga/${encodeURIComponent(mangaId)}/chapters?page=${page}&limit=${limit}&order[number]=desc`,
  );
}

// A chapter's pages: the first object in the answer holding `items` of urls.
function findHolder(value: unknown, depth = 0): ChapterPageItems | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  const record = value as Record<string, unknown>;
  const items = record.items;
  if (
    Array.isArray(items) &&
    items.length > 0 &&
    !record.meta &&
    items.every((item) => item && typeof (item as { url?: unknown }).url === "string")
  ) {
    return record as unknown as ChapterPageItems;
  }
  for (const inner of Object.values(record)) {
    const found = findHolder(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

export async function fetchChapterPages(chapterId: string): Promise<ChapterPageItems> {
  const result = await fetchApi<unknown>(`/chapters/${encodeURIComponent(chapterId)}`);
  const holder = findHolder(result);
  if (!holder) throw new SigningOutdated("no pages in the answer");
  return holder;
}

// comix wants its check before answering: open its check page (the pass it
// sets lasts about 5 minutes, and only for this app's browser identity).
export async function signedCheckError(what: string, reason: string): Promise<CloudflareError> {
  logEvent("comix check", `${what}: comix wants its check (${reason}); opening its check page`);
  return new CloudflareError(
    {
      url: checkPage(),
      method: "GET",
      headers: { "user-agent": await Application.getDefaultUserAgent() },
    },
    "comix wants its own check. Open it, complete the check (it may pass by itself), wait for comix's home page, then tap Done.",
  );
}
