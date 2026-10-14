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

// comix's own pass, set when its check ("Verify you're human", /@waf/challenge)
// is passed. The app forgets cookies without an expiry date when it restarts,
// so one earned in the check browser is kept for a day (comix asks again
// sooner if it wants to).
export const COMIX_PASS = "waf_pass";
const COMIX_PASS_KEEP_MS = 24 * 60 * 60 * 1000;

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
    if (fromCheckBrowser && copy.name === COMIX_PASS) {
      if (!copy.expires) copy.expires = new Date(Date.now() + COMIX_PASS_KEEP_MS);
      // A fresh pass replaces any older one, whatever its path.
      for (const old of store.cookies.filter(
        (c) => c.name === COMIX_PASS && isSiteDomain(c.domain),
      )) {
        store.deleteCookie(old);
      }
    }
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

// A short tag for a cookie's value (not the value itself), so the Reading Log
// can show whether the hidden pages carry the same pass and session the check
// browser ended with.
function tag(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 4);
}

// comix.to cookies for the Reading Log: names, plus a tag (and for comix's
// pass its domain, path and whether it has an expiry date).
export function describeCookies(cookies: readonly Cookie[] | undefined | null): string {
  const site = (cookies ?? []).filter(
    (cookie) =>
      cookie &&
      typeof cookie.domain === "string" &&
      isSiteDomain(cookie.domain) &&
      !String(cookie.name).startsWith("cf_chl"),
  );
  if (site.length === 0) return "none";
  return site
    .map((cookie) => {
      if (cookie.name !== COMIX_PASS && cookie.name !== "session") return cookie.name;
      const where =
        cookie.name === COMIX_PASS
          ? ` (${cookie.domain} ${cookie.path ?? "/"}${cookie.expires ? "" : ", no expiry"})`
          : "";
      return `${cookie.name}#${tag(String(cookie.value ?? ""))}${where}`;
    })
    .join(", ");
}

// A script for the top of a hidden page that puts the saved comix.to cookies
// in the page's own cookie jar (path / for comix's pass, so its API calls carry
// it), in case the app didn't hand them to the page. Cookies the page already
// has are left alone. `window.__comixJar` notes what was written.
export function pageCookieScript(cookies: readonly Cookie[]): string {
  const octets = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
  const jar = cookies
    .filter((cookie) => /^[\w.-]+$/.test(cookie.name) && octets.test(String(cookie.value ?? "")))
    .map((cookie) => [
      cookie.name,
      String(cookie.value ?? ""),
      cookie.name === COMIX_PASS ? "/" : (cookie.path ?? "/"),
      cookie.expires ? new Date(cookie.expires as Date | string).toUTCString() : "",
    ]);
  const data = JSON.stringify(jar).replace(/</g, "\\u003c");
  return `
(function () {
  var jar = ${data};
  var had = [];
  var wrote = [];
  try {
    var names = function () {
      return document.cookie.split(";").map(function (c) { return c.split("=")[0].trim(); });
    };
    var present = names();
    jar.forEach(function (c) {
      if (present.indexOf(c[0]) !== -1) { had.push(c[0]); return; }
      document.cookie = c[0] + "=" + c[1] + "; path=" + c[2] + (c[3] ? "; expires=" + c[3] : "") + "; secure; samesite=lax";
      if (names().indexOf(c[0]) !== -1) wrote.push(c[0]);
    });
  } catch (e) {}
  window.__comixJar = { had: had.join(", "), wrote: wrote.join(", ") };
})();
`;
}
