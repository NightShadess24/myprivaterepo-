/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import type { Cookie, CookieStorageInterceptor } from "@paperback/types";

// comix.to's cookies are kept the way a browser keeps them: whatever the site
// leaves after a page, or after the check browser, is sent back next time. A
// real visitor carries the same session from page to page; starting every
// hidden page with an empty browser is what made comix ask for its own check.
//
// Cloudflare's own cookies (its pass cf_clearance, and __cf_bm / _cfuvid) are
// only taken from the check browser, where they were earned: a hidden page
// can't earn a pass, and a copy of one from there (without its expiry date)
// would replace the real one and be lost when the app restarts. Cloudflare's
// in-progress challenge cookies (cf_chl_*) are never kept.

const isSiteDomain = (domain: string): boolean =>
  /(^|\.)comix\.to$/i.test(String(domain ?? "").replace(/^\./, ""));

const isCloudflareCookie = (name: string): boolean =>
  name === "cf_clearance" || name === "__cf_bm" || name === "_cfuvid";

const sameCookie = (a: Cookie, b: Cookie): boolean =>
  a.name === b.name &&
  a.domain.replace(/^(www)?\.?/i, "").toLowerCase() ===
    b.domain.replace(/^(www)?\.?/i, "").toLowerCase() &&
  (a.path ?? "/") === (b.path ?? "/");

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
// `fromCheckBrowser`: the cookies come from a check the user went through.
export function keepSiteCookies(
  store: CookieStorageInterceptor,
  cookies: readonly Cookie[] | undefined | null,
  { fromCheckBrowser = false }: { fromCheckBrowser?: boolean } = {},
): string[] {
  const kept: string[] = [];
  for (const cookie of cookies ?? []) {
    const copy = normalized(cookie);
    if (!copy) continue;
    if (!fromCheckBrowser && isCloudflareCookie(copy.name)) continue;
    // The same cookie without its expiry date: keep the one that has it.
    if (!copy.expires) {
      const stored = store.cookies.find((existing) => sameCookie(existing, copy));
      if (stored?.expires && stored.value === copy.value) continue;
    }
    store.setCookie(copy);
    kept.push(copy.name);
  }
  return kept;
}

// Every unexpired comix.to cookie, whatever its path, for a hidden page. Like
// a browser's cookie jar: the page sends each one only where it belongs, so a
// pass the site keeps under, say, /api still goes along with its API calls.
export function siteCookies(store: CookieStorageInterceptor): Cookie[] {
  const now = Date.now();
  return store.cookies.filter(
    (cookie) => isSiteDomain(cookie.domain) && (!cookie.expires || cookie.expires.getTime() > now),
  );
}
