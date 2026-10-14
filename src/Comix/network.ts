/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  CloudflareError,
  PaperbackInterceptor,
  URL,
  type Cookie,
  type Request,
  type Response,
} from "@paperback/types";

import { DOMAIN } from "./models";
import { decryptImage, readEncHeaders, sniffImageMime } from "./utils/decryptImage";
import { descrambleImage, readScrambleHeaders } from "./utils/descramble";
import { loadClearance, loadWafPass, logEvent } from "./utils/session";

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
const PROBE_COOKIES_HEADER = "x-comix-probe-cookies";

export type SiteCheckResult = "passed" | "check" | "cloudflare" | "unknown";

// Asks the chapters API once, without a signature, carrying exactly `cookies`
// (plus the Cloudflare pass). The site answers `captcha_required` before it
// looks at anything else, so any other answer means those cookies got past
// its human check.
export async function probeSiteCheck(
  hid: string,
  cookies: readonly Cookie[],
): Promise<{ result: SiteCheckResult; detail: string }> {
  try {
    const [response, buffer] = await Application.scheduleRequest({
      url: `${DOMAIN}/api/v1/manga/${hid}/chapters?page=1`,
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
        [PROBE_COOKIES_HEADER]: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      },
    });
    const text = Application.arrayBufferToUTF8String(buffer).slice(0, 120);
    const detail = `HTTP ${response.status} ${text.replace(/\s+/g, " ")}`;
    if (/captcha_required/i.test(text)) return { result: "check", detail };
    if (/challenge-platform|Just a moment/i.test(text)) return { result: "cloudflare", detail };
    return { result: response.status === 0 ? "unknown" : "passed", detail };
  } catch (error) {
    const type =
      typeof error === "object" && error !== null && "type" in error
        ? String((error as { type: unknown }).type)
        : "";
    return {
      result: type === "cloudflareError" ? "cloudflare" : "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/i, "").split("?")[0] || "/";

export class ComixInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    // Send the newest Cloudflare pass and the site's human-check pass from state
    // (see utils/session.ts), over whatever the cookie store's in-memory copy
    // holds. A probe (probeSiteCheck) sends only the cookies it names in
    // PROBE_COOKIES_HEADER, plus the Cloudflare pass.
    const { [PROBE_COOKIES_HEADER]: probeCookies, ...rest } = request.headers ?? {};
    const headers = { ...rest, "user-agent": await Application.getDefaultUserAgent() };
    if (!isSiteUrl(request.url)) return { ...request, headers };
    const cookies: Record<string, string> =
      probeCookies !== undefined ? {} : { ...request.cookies };
    if (probeCookies !== undefined) {
      for (const pair of probeCookies.split("; ")) {
        const at = pair.indexOf("=");
        if (at > 0) cookies[pair.slice(0, at)] = pair.slice(at + 1);
      }
    } else {
      for (const cookie of loadWafPass()) cookies[cookie.name] = cookie.value;
    }
    const clearance = loadClearance();
    if (clearance) cookies.cf_clearance = clearance.value;
    return { ...request, headers, cookies };
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
