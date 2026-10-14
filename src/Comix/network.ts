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

export class ComixInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    return {
      ...request,
      headers: {
        ...request.headers,
        "user-agent": await Application.getDefaultUserAgent(),
      },
    };
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    if (response.headers?.["cf-mitigated"] === "challenge") {
      throw new CloudflareError({
        url: DOMAIN,
        method: "GET",
        headers: {
          "user-agent": await Application.getDefaultUserAgent(),
        },
      });
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
  const [response, buffer] = await Application.scheduleRequest({ url, method: "GET" });
  const text = Application.arrayBufferToUTF8String(buffer);
  // Cloudflare's firewall block page (the site blocks IPs that send bursts).
  if (response.status === 403 && /you have been blocked/i.test(text)) {
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
