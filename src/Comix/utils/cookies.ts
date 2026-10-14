/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import type { Cookie, CookieStorageInterceptor } from "@paperback/types";

// comix.to's cookies are kept the way a browser keeps them: whatever the site
// (or Cloudflare, on comix.to) leaves after a page, or after the check browser,
// is sent back next time. A real visitor carries the same session from page to
// page; starting every hidden page with an empty browser is what made comix
// ask for its own check. Cloudflare's in-progress challenge cookies (cf_chl_*)
// are left out.

const isSiteDomain = (domain: string): boolean =>
  /(^|\.)comix\.to$/i.test(String(domain ?? "").replace(/^\./, ""));

function normalized(cookie: Cookie): Cookie | null {
  if (!cookie || typeof cookie.name !== "string" || !cookie.name) return null;
  if (typeof cookie.domain !== "string" || !isSiteDomain(cookie.domain)) return null;
  if (cookie.name.startsWith("cf_chl")) return null;
  const copy: Cookie = { ...cookie, value: String(cookie.value ?? "") };
  const expires = cookie.expires as unknown;
  if (expires !== undefined && !(expires instanceof Date)) {
    const date = new Date(expires as string | number);
    if (Number.isNaN(date.getTime())) delete copy.expires;
    else copy.expires = date;
  }
  return copy;
}

// Saves comix.to cookies into the store; returns the names kept.
export function keepSiteCookies(
  store: CookieStorageInterceptor,
  cookies: readonly Cookie[] | undefined | null,
): string[] {
  const kept: string[] = [];
  for (const cookie of cookies ?? []) {
    const copy = normalized(cookie);
    if (!copy) continue;
    store.setCookie(copy);
    kept.push(copy.name);
  }
  return kept;
}
