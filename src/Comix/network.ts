/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  BasicRateLimiter,
  CloudflareError,
  PaperbackInterceptor,
  URL,
  type Request,
  type Response,
} from "@paperback/types";

import { DOMAIN } from "./models";
import { decryptImage, readEncHeaders, sniffImageMime } from "./utils/decryptImage";
import { descrambleImage, readScrambleHeaders } from "./utils/descramble";
import { errorText, logEvent } from "./utils/log";
import { withTimeout } from "./utils/queue";

// comix.to itself (pages, API), as opposed to its image hosts.
const isSiteUrl = (url: string): boolean => /^https?:\/\/(www\.)?comix\.to([/:?#]|$)/i.test(url);

// The basic limiter only lets images through unthrottled when their url ends in
// .webp/.jpg/…; comix's page images (and covers) have no extension, so every
// page was held to the same 5 requests a second as the site. Pace only comix.to.
export class SiteRateLimiter extends BasicRateLimiter {
  override async interceptRequest(request: Request): Promise<Request> {
    return isSiteUrl(request.url) ? super.interceptRequest(request) : request;
  }
}

const header = (headers: Record<string, string> | undefined, name: string): string | undefined => {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
};

// Backup image hosts per page (from the chapter's page list), keyed without the
// query so `?v3` / `&r=` variants match.
const altHostsByUrl = new Map<string, string[]>();
const urlKey = (url: string): string => url.split(/[?#]/)[0]!;

export function rememberAltHosts(url: string, hosts: string[]): void {
  if (hosts.length === 0) return;
  if (altHostsByUrl.size > 3000) altHostsByUrl.clear();
  altHostsByUrl.set(urlKey(url), hosts);
}

// A few image results per chapter go to the Reading Log (all failures do, up
// to a limit), so the log shows what the image server sent back.
let imageLogBudget = 0;
let imagesOk = 0;
let imagesFailed = 0;

export function startImageLog(): void {
  imageLogBudget = 6;
  imagesOk = 0;
  imagesFailed = 0;
}

function logImage(detail: string, failed: boolean): void {
  if (failed) imagesFailed++;
  else imagesOk++;
  const first = !failed && imagesOk === 1;
  if ((failed || first) && imageLogBudget > 0) {
    imageLogBudget--;
    if (failed)
      logEvent("image failed", `${detail} (${imagesFailed} failed, ${imagesOk} ok so far)`);
    else logEvent("first image", detail);
  }
}

const shortUrl = (url: string): string => url.replace(/^https?:\/\//, "").slice(0, 90);

// Cloudflare's "Just a moment…" / block page, for when its cf-mitigated
// header doesn't come through.
const CLOUDFLARE_PAGE =
  /<title>\s*(Just a moment|Attention Required)|cf_chl_opt|\/cdn-cgi\/challenge-platform\/|cf-error-details/i;

function isCloudflareBlock(status: number, data: ArrayBuffer): boolean {
  if (status !== 403 && status !== 429 && status !== 503) return false;
  try {
    const text = Application.arrayBufferToUTF8String(data.slice(0, 64 * 1024));
    return CLOUDFLARE_PAGE.test(text);
  } catch {
    return false;
  }
}

function withParam(url: string, key: string, value: string): string {
  const [beforeHash] = url.split("#");
  const re = new RegExp(`([?&])${key}=[^&]*`);
  if (re.test(beforeHash!)) return beforeHash!.replace(re, `$1${key}=${value}`);
  return `${beforeHash}${beforeHash!.includes("?") ? "&" : "?"}${key}=${value}`;
}

function swapHost(url: string, host: string): string {
  return url.replace(/^(https?:\/\/)[^/?#]+/i, `$1${host}`);
}

export class ComixInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    const headers: Record<string, string> = { ...request.headers };
    if (!isSiteUrl(request.url)) {
      // comix's image hosts refuse requests that carry a Referer/Origin.
      for (const key of Object.keys(headers)) {
        const lk = key.toLowerCase();
        if (lk === "referer" || lk === "origin") delete headers[key];
      }
    }
    headers["user-agent"] = await Application.getDefaultUserAgent();
    return { ...request, headers };
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const siteUrl = isSiteUrl(request.url);
    // Cloudflare's check page, recognised by its header or (when that's
    // missing) by its content: say so right away, opening the page that was
    // asked for, instead of loading the check page as if it were comix.
    if (
      header(response.headers, "cf-mitigated") === "challenge" ||
      (siteUrl && isCloudflareBlock(response.status, data))
    ) {
      const isPage = siteUrl && !/\/api\//.test(request.url);
      logEvent(
        "cloudflare",
        `${shortUrl(request.url)} answered with Cloudflare's check (HTTP ${response.status})`,
      );
      throw new CloudflareError(
        {
          url: isPage ? request.url : `${DOMAIN}/`,
          method: "GET",
          headers: {
            "user-agent": await Application.getDefaultUserAgent(),
          },
        },
        "Cloudflare wants a check. Open it, complete the check, wait for comix's page, then tap Done.",
      );
    }

    if (!siteUrl && response.status >= 400) {
      const recovered = await retryImage(request.url, response.status);
      if (recovered) return recovered;
      logImage(`HTTP ${response.status} from ${shortUrl(request.url)}`, true);
      return data;
    }

    return await decodeImage(request.url, response, data, siteUrl);
  }
}

// Like the site's reader: try a failed image on the backup hosts (no wait, it's
// another server), or once more on the same host after a second if there are
// none. Retries carry `r=N`, which also stops them from retrying again themselves.
async function retryImage(url: string, status: number): Promise<ArrayBuffer | null> {
  if (/[?&]r=\d+/.test(url)) return null;
  const altHosts = (altHostsByUrl.get(urlKey(url)) ?? []).slice(0, 3);
  const tries = altHosts.map((host, i) => withParam(swapHost(url, host), "r", String(i + 1)));
  if (tries.length === 0 && (status === 404 || status >= 500)) {
    await Application.sleep(1);
    tries.push(withParam(url, "r", "1"));
  }

  for (const next of tries) {
    try {
      const [retryResponse, buffer] = await Application.scheduleRequest({
        url: next,
        method: "GET",
      });
      if (retryResponse.status < 400) {
        if (imageLogBudget > 0) {
          imageLogBudget--;
          logEvent(
            "image retried",
            `HTTP ${status} from ${shortUrl(url)}, got it from ${shortUrl(next)}`,
          );
        }
        return buffer;
      }
    } catch {
      // try the next host
    }
  }
  return null;
}

// Page images can be byte-XOR'd (X-Enc-*), tile-shuffled (X-Scramble-*), or
// both. Undo the XOR first (the shuffle needs a decodable image), then the
// tiles — the same order as the Mihon extension.
async function decodeImage(
  url: string,
  response: Response,
  data: ArrayBuffer,
  siteUrl: boolean,
): Promise<ArrayBuffer> {
  const enc = readEncHeaders(response.headers);
  const scramble = readScrambleHeaders(response.headers);
  if (!enc && !scramble) {
    if (!siteUrl) {
      const mime = sniffImageMime(new Uint8Array(data));
      if (mime) logImage(`${mime.replace("image/", "")} from ${shortUrl(url)} (plain)`, false);
    }
    return data;
  }
  const steps: string[] = [];
  let bytes = data;

  if (enc) {
    try {
      bytes = decryptImage(bytes, enc);
      steps.push(`enc algo ${enc.algo}`);
    } catch (error) {
      logImage(`decrypt failed for ${shortUrl(url)}: ${errorText(error)}`, true);
      return data;
    }
  }

  const mime =
    sniffImageMime(new Uint8Array(bytes)) ??
    (response.mimeType?.startsWith("image/") ? response.mimeType : undefined);

  if (scramble) {
    try {
      // A picture the app can't decode may never call back, so don't wait forever.
      bytes = await withTimeout(
        descrambleImage(bytes, scramble, mime ?? "image/webp"),
        20,
        "descramble",
      );
      steps.push(`tiles ${scramble.cols}x${scramble.rows} algo ${scramble.algo}`);
    } catch (error) {
      logImage(
        `descramble failed for ${shortUrl(url)} (${mime ?? "unknown type"}): ${errorText(error)}`,
        true,
      );
      return bytes;
    }
  }

  if (!mime) {
    logImage(`not a picture from ${shortUrl(url)} (${steps.join(", ") || "as sent"})`, true);
    return bytes;
  }
  logImage(
    `${mime.replace("image/", "")} from ${shortUrl(url)} (${steps.join(", ") || "plain"})`,
    false,
  );
  return bytes;
}

export async function fetchText(url: string): Promise<string> {
  const [, buffer] = await Application.scheduleRequest({ url, method: "GET" });
  return Application.arrayBufferToUTF8String(buffer);
}

export function browseUrl(query: Record<string, string | string[]>): string {
  const url = new URL(DOMAIN).addPathComponent("browse");
  for (const [key, value] of Object.entries(query)) {
    url.setQueryItem(key, value);
  }
  return url.toString();
}
