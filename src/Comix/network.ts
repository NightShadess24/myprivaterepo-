/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  CloudflareError,
  PaperbackInterceptor,
  URL,
  type Request,
  type Response,
} from "@paperback/types";

import { DOMAIN } from "./models";
import { decryptImage, readEncHeaders, sniffImageMime } from "./utils/decryptImage";
import { descrambleImage, readScrambleHeaders } from "./utils/descramble";
import { loadClearance, logEvent } from "./utils/session";

// Once Cloudflare challenges, every further request only digs the hole deeper
// (a library refresh would keep firing title after title). So after a
// challenge, requests fail fast with the same bypass banner until the reader
// completes it (or a few minutes pass).
const CHALLENGE_HOLD_MS = 5 * 60 * 1000;
let challengedUntil = 0;

export function markCloudflareChallenged(): void {
  challengedUntil = Date.now() + CHALLENGE_HOLD_MS;
}

export function clearCloudflareChallenge(): void {
  challengedUntil = 0;
}

export async function cloudflareChallenge(url: string = DOMAIN): Promise<CloudflareError> {
  return new CloudflareError(
    { url, method: "GET", headers: { "user-agent": await Application.getDefaultUserAgent() } },
    "Comix needs a Cloudflare check. Tap the banner, complete it, then try again.",
  );
}

export async function throwIfChallenged(): Promise<void> {
  if (Date.now() < challengedUntil) throw await cloudflareChallenge();
}

const header = (headers: Record<string, string> | undefined, name: string) => {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
};

const isSiteUrl = (url: string) => /^https?:\/\/([^/]+\.)?comix\.to(?=[/:?#]|$)/i.test(url);
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/i, "").split("?")[0] || "/";

export class ComixInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    // Send the newest Cloudflare pass from state (see utils/session.ts), over
    // whatever the cookie store's in-memory copy holds. (alpha.54 also replayed
    // the site's other cookies from the check screen here; that put stale copies
    // over the browser's fresh ones and made the human check loop.)
    const headers = { ...request.headers, "user-agent": await Application.getDefaultUserAgent() };
    if (!isSiteUrl(request.url)) return { ...request, headers };
    const clearance = loadClearance();
    if (!clearance) return { ...request, headers };
    return { ...request, headers, cookies: { ...request.cookies, cf_clearance: clearance.value } };
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (header(response.headers, "cf-mitigated") === "challenge") {
      logEvent(
        "challenge",
        `${pathOf(request.url)} (HTTP ${response.status}, ${
          request.cookies?.cf_clearance ? "pass was sent" : "no pass sent"
        })`,
      );
      markCloudflareChallenged();
      throw await cloudflareChallenge();
    }

    // Page images may be byte-XOR'd (X-Enc-*), tile-shuffled (X-Scramble-*), or
    // both. Key off headers (an encrypted prefix defeats mime-sniffing) and undo
    // them in the order the site's reader does: decrypt first, then descramble.
    let bytes = data;
    const encParams = readEncHeaders(response.headers);
    if (encParams) {
      try {
        bytes = decryptImage(bytes, encParams);
      } catch (error) {
        console.log(
          `[Comix] image decrypt failed for ${request.url}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return data;
      }
    }

    const scrambleParams = readScrambleHeaders(response.headers);
    if (scrambleParams) {
      try {
        return await descrambleImage(
          bytes,
          scrambleParams,
          sniffImageMime(bytes) ?? response.mimeType ?? "image/webp",
        );
      } catch (error) {
        console.log(
          `[Comix] descramble failed for ${request.url} (algo=${scrambleParams.algo} seed=${scrambleParams.seed}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return bytes;
      }
    }

    return bytes;
  }
}

export async function fetchText(url: string): Promise<string> {
  await throwIfChallenged();
  const [response, buffer] = await Application.scheduleRequest({ url, method: "GET" });
  const text = Application.arrayBufferToUTF8String(buffer);
  // A challenge page whose cf-mitigated header didn't come through.
  if (
    (response.status === 403 || response.status === 503) &&
    /challenge-platform|<title>Just a moment/i.test(text)
  ) {
    logEvent("challenge", `${pathOf(url)} (HTTP ${response.status}, challenge page)`);
    markCloudflareChallenged();
    throw await cloudflareChallenge();
  }
  // Cloudflare's firewall block page (the site blocks IPs that send bursts).
  if (response.status === 403 && /you have been blocked/i.test(text)) {
    logEvent("blocked", `${pathOf(url)} (HTTP 403, IP blocked)`);
    throw new Error(
      "Comix has blocked your network for now (usually after too many requests). Wait a while, then try again.",
    );
  }
  return text;
}

export function browseUrl(query: Record<string, string | string[]>): string {
  const url = new URL(DOMAIN).addPathComponent("browse");
  for (const [key, value] of Object.entries(query)) {
    url.setQueryItem(key, value);
  }
  return url.toString();
}
