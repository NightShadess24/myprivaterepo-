/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import { CloudflareError, type Cookie, type CookieStorageInterceptor } from "@paperback/types";
import * as cheerio from "cheerio";

import { type ChapterItem, type ChapterPages, type ResultManga, DOMAIN } from "../models";
import {
  cloudflareChallenge,
  fetchText,
  markCloudflareChallenged,
  throwIfChallenged,
} from "../network";
import {
  clearanceCookie,
  clearWafPass,
  describeCookies,
  getRefreshPace,
  isChallengeCookie,
  isSiteDomain,
  loadWafPass,
  logEvent,
  passCandidates,
  saveClearance,
  saveSiteCookies,
  saveWafPass,
  setLastCaptchaTitle,
} from "./session";

// A bootstrap resolves `window.__comixResult__` with this instead of data when it
// gives up, so the extension can tell a captcha apart from a timeout.
type WebViewError = { __comixError: string; detail?: string };

const CAPTCHA = "captcha";
const CLOUDFLARE = "cloudflare";

const isWebViewError = (value: unknown): value is WebViewError =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<WebViewError>).__comixError === "string";

// Each WebView run loads a whole site page: the HTML, the site's scripts and its
// API calls. Background work (chapter lists, the update scan) goes through this
// queue at the pace picked under Settings → Refresh Speed: how many runs at once
// and the gap between starting them (with a little jitter). Reading and browsing
// don't wait in this queue.
let running = 0;
let nextStartAt = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  const pace = getRefreshPace();
  while (running >= pace.concurrency) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  const now = Date.now();
  const startAt = Math.max(now, nextStartAt);
  nextStartAt = startAt + pace.gapMs * (0.8 + Math.random() * 0.4);
  if (startAt > now) await Application.sleep((startAt - now) / 1000);
}

function releaseSlot(): void {
  running--;
  waiting.shift()?.();
}

async function inWebViewQueue<T>(task: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await task();
  } finally {
    releaseSlot();
  }
}

export const isSiteCookie = isSiteDomain;

// Cookies the extension keeps for comix.to: everything except Cloudflare's own
// fingerprint cookies (__cf_bm, _cfuvid, cf_chl_*), which belong to the browser
// that made them.
export const isKeptCookie = (cookie: Cookie) => !isChallengeCookie(cookie.name);

// Saves cookies from the check screen or a page load: cf_clearance goes to
// state (read fresh for every request). The site's other cookies are only
// recorded by name for Diagnostics — sending saved copies of them overrode the
// browser's fresh ones and made the human check loop (alpha.54).
export function storeSiteCookies(
  cookieInterceptor: CookieStorageInterceptor,
  cookies: readonly Cookie[],
  source: string,
): void {
  const site = cookies.filter(
    (cookie) =>
      cookie.value && cookie.domain && isSiteCookie(cookie.domain) && isKeptCookie(cookie),
  );
  const clearance = site.find((cookie) => cookie.name === "cf_clearance");
  if (clearance) {
    saveClearance(clearance, source);
    cookieInterceptor.setCookie(clearance);
  }
  saveSiteCookies(site, source);
}

// Cookies for a WebView run: the newest Cloudflare pass and, once one has been
// confirmed, the site's human-check pass. Nothing unconfirmed is handed over:
// replaying unverified copies made the check loop in alpha.54.
function webViewCookies(): Cookie[] {
  const clearance = clearanceCookie();
  return [...loadWafPass(), ...(clearance ? [clearance] : [])];
}

const hidOfPage = (pageUrl: string) => /\/title\/([^/?#-]+)/.exec(pageUrl)?.[1];

// Loads a Comix page in a WebView and lets the site's own JS run end-to-end:
// the bundle signs API requests and decodes the answers internally, and the
// injected bootstrap reads the decoded data back out, so the rotating signer and
// cipher never need reimplementing. The WebView runs under the app's default UA
// (source.userAgent), the same UA cf_clearance is bound to, so the page's own
// loads + same-origin API XHRs all pass Cloudflare.
function runProxiedWebView<T>(
  pageUrl: string,
  bootstrap: string,
  cookieInterceptor: CookieStorageInterceptor,
): Promise<T> {
  return inWebViewQueue(() => runWebViewNow<T>(pageUrl, bootstrap, cookieInterceptor));
}

async function runWebViewNow<T>(
  pageUrl: string,
  bootstrap: string,
  cookieInterceptor: CookieStorageInterceptor,
): Promise<T> {
  await throwIfChallenged();
  const userAgent = await Application.getDefaultUserAgent();
  const $ = cheerio.load(await fetchText(pageUrl));
  // Read after the page fetch, which may have refreshed them.
  const cookies = webViewCookies();

  $("head").prepend(`<script>${bootstrap}</script>`);

  const raw = await Application.executeInWebView({
    source: { html: $.html(), baseUrl: pageUrl, loadCSS: false, loadImages: false, userAgent },
    inject: `return window.__comixResult__`,
    storage: { cookies },
  });

  // Keep a Cloudflare pass the run renewed; note the site's cookie names.
  storeSiteCookies(cookieInterceptor, raw.storage?.cookies ?? [], "page load");
  const pageCookies = passCandidates(raw.storage?.cookies ?? []);

  const result = raw.result;
  const page = pageUrl.replace(DOMAIN, "").split("?")[0] || "/";
  if (result === undefined || result === null) {
    throw new Error("Comix WebView returned no result");
  }
  if (!isWebViewError(result) && pageCookies.length > 0) {
    // The site answered, so the cookies this page ended with got past its
    // human check: keep them as the pass (refreshes and other instances use it).
    const kept = loadWafPass();
    const same =
      kept.length === pageCookies.length &&
      pageCookies.every((c) => kept.some((k) => k.name === c.name && k.value === c.value));
    if (!same) saveWafPass(pageCookies, "page that loaded");
  }
  if (isWebViewError(result)) {
    if (result.__comixError === CLOUDFLARE) {
      // The page's own API calls were challenged: stop here (and hold back the
      // rest of a refresh) rather than keep sending requests into the challenge.
      logEvent(
        "challenge",
        `inside page ${page}: ${result.detail || "?"} (${cookies.some((c) => c.name === "cf_clearance") ? "pass was sent" : "no pass sent"})`,
      );
      markCloudflareChallenged();
      throw await cloudflareChallenge();
    }
    if (result.__comixError === CAPTCHA) {
      logEvent(
        "captcha",
        `on ${page}: ${result.detail || "?"}; gave ${describeCookies(cookies)}; page had ${describeCookies(pageCookies)}`,
      );
      const hid = hidOfPage(pageUrl);
      if (hid) setLastCaptchaTitle(hid);
      if (cookies.some((c) => c.name !== "cf_clearance")) {
        clearWafPass("the site asked for the check again");
      }
      // The site's own human check (`403 captcha_required` → `/@waf/challenge`).
      // The bypass banner opens the page in a browser so the reader can solve it.
      throw new CloudflareError(
        { url: pageUrl, method: "GET", headers: { "user-agent": userAgent } },
        "Comix wants a human check. Open the page from the banner, solve it, then try again.",
      );
    }
    throw new Error(`Comix: ${result.__comixError}`);
  }
  return result as T;
}

// Shared bootstrap for the chapter list and the chapter pages.
//
// Since 10–11 Oct 2026 the site decodes these API answers inside an obfuscated
// `secure-*.js` that no longer goes through JSON.parse, so a JSON.parse hook alone
// sees nothing. The decoder still assigns `items` onto plain objects, so a setter
// on Object.prototype (plus a hook on Object.defineProperty) sees each decoded
// holder. JSON.parse stays hooked too, for plain-JSON answers and the
// server-rendered `initial-data` cache. Holders are handed over on the next tick,
// once the decoder has finished filling in their other fields (`meta`, `baseUrl`).
//
// `handlerFactory` is the source of a `(finish, fail, armIdle) => (holder) => void`
// function; `finish(value)` resolves the run, `fail(message)` gives up.
function captureBootstrap(handlerFactory: string): string {
  return `
    (function () {
      var settled = false;
      var resolveResult;
      window.__comixResult__ = new Promise(function (r) {
        resolveResult = r;
      });
      function finish(value) {
        if (settled) return;
        settled = true;
        resolveResult(value);
      }
      function fail(message, detail) {
        finish({ __comixError: String(message), detail: detail ? String(detail).slice(0, 240) : "" });
      }
      var idleTimer;
      function armIdle(ms) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
          fail("timed out waiting for the site's data");
        }, ms);
      }

      var handle = (${handlerFactory})(finish, fail, armIdle);
      function capture(holder) {
        setTimeout(function () {
          if (settled || !holder || typeof holder !== "object") return;
          try {
            handle(holder);
          } catch (e) {}
        });
      }

      var defineProperty = Object.defineProperty;
      defineProperty(Object.prototype, "items", {
        configurable: true,
        set: function (value) {
          defineProperty(this, "items", {
            value: value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          capture(this);
        },
      });
      Object.defineProperty = function (target, key, descriptor) {
        var result = defineProperty.apply(this, arguments);
        if (key === "items" && descriptor && "value" in descriptor) capture(target);
        return result;
      };

      function captureParsed(value, depth) {
        if (!value || typeof value !== "object" || depth > 4) return;
        if (Array.isArray(value.items)) capture(value);
        if (value.result && typeof value.result === "object") captureParsed(value.result, depth + 1);
        if (value.pages && typeof value.pages === "object") captureParsed(value.pages, depth + 1);
        if (value.queries && typeof value.queries === "object") {
          for (var key in value.queries) captureParsed(value.queries[key], depth + 1);
        }
      }
      JSON.parse = new Proxy(JSON.parse, {
        apply: function (target, thisArg, args) {
          var parsed = Reflect.apply(target, thisArg, args);
          try {
            captureParsed(parsed, 0);
          } catch (e) {}
          return parsed;
        },
      });

      // The site's own captcha: the API answers 403 captcha_required and the
      // reader opens /@waf/challenge in an iframe. Nobody can solve it in this
      // hidden WebView, so report it instead of waiting for the timeout.
      // A Cloudflare challenge on the page's own requests is reported the same way.
      function where(url) {
        return String(url).replace(new RegExp("^https?://[^/]+"), "").split("?")[0];
      }
      function checkCaptcha(status, url, body, mitigated) {
        if (String(mitigated).toLowerCase() === "challenge") {
          fail("${CLOUDFLARE}", "HTTP " + status + " " + where(url));
          return;
        }
        if (status === 403 && String(url).indexOf("/api/") !== -1 && /captcha/i.test(String(body))) {
          fail("${CAPTCHA}", "API said HTTP 403 on " + where(url) + ": " + String(body).slice(0, 140));
        }
      }
      var xhrProto = XMLHttpRequest.prototype;
      xhrProto.open = new Proxy(xhrProto.open, {
        apply: function (target, xhr, args) {
          try {
            xhr.__comixUrl = String(args[1] || "");
          } catch (e) {}
          return Reflect.apply(target, xhr, args);
        },
      });
      xhrProto.send = new Proxy(xhrProto.send, {
        apply: function (target, xhr, args) {
          try {
            xhr.addEventListener("loadend", function () {
              try {
                var body =
                  xhr.responseType === "" || xhr.responseType === "text"
                    ? xhr.responseText
                    : JSON.stringify(xhr.response);
                checkCaptcha(xhr.status, xhr.__comixUrl, body, xhr.getResponseHeader("cf-mitigated"));
              } catch (e) {}
            });
          } catch (e) {}
          return Reflect.apply(target, xhr, args);
        },
      });
      if (typeof window.fetch === "function") {
        window.fetch = new Proxy(window.fetch, {
          apply: function (target, thisArg, args) {
            return Reflect.apply(target, thisArg, args).then(function (response) {
              try {
                if (response && (response.status === 403 || response.status === 503)) {
                  var mitigated = response.headers.get("cf-mitigated");
                  response
                    .clone()
                    .text()
                    .then(function (text) {
                      checkCaptcha(response.status, response.url, text, mitigated);
                    })
                    .catch(function () {});
                }
              } catch (e) {}
              return response;
            });
          },
        });
      }
      var wafPoll = setInterval(function () {
        if (settled) {
          clearInterval(wafPoll);
          return;
        }
        var waf = document.querySelector('iframe[src*="/@waf/"]');
        if (waf) fail("${CAPTCHA}", "site opened " + where(waf.getAttribute("src")));
      }, 500);
    })();
  `;
}

// Mirrors the site's chapter list one page at a time: the title page loads page 1
// on its own, and every later page is asked for through the site's `?page=` state
// (pushState + popstate), falling back to clicking the pager. Requests are never
// rebuilt by hand — each carries a per-request signature. Pages are walked one at
// a time, 500 ms apart, because the site's firewall blocks IPs on bursts.
const CHAPTER_LIST_HANDLER = `
  function (finish, fail, armIdle) {
    var chapterPaths = __CHAPTER_PATHS__;
    var stopBeforeMs = __STOP_BEFORE_MS__;
    var MAX_PAGES = 1000;
    var PAGE_DELAY_MS = 500;
    var PAGER_FALLBACK_MS = 3000;
    var IDLE_MS = 30000;
    var chapters = [];
    var seen = {};
    var page = 1;
    armIdle(IDLE_MS);

    function isChapter(item) {
      if (!item || typeof item.id !== "number" || typeof item.number !== "number") return false;
      if (typeof item.url !== "string") return false;
      for (var i = 0; i < chapterPaths.length; i++) {
        if (item.url.indexOf(chapterPaths[i]) !== -1) return true;
      }
      return false;
    }

    // A chapter's upload time in ms: an epoch/ISO field when the API sends one,
    // else the relative "3 days ago" text. null when unknown.
    function itemTime(item) {
      var raw = item.createdAt !== undefined ? item.createdAt : item.created_at;
      if (typeof raw === "number" && raw > 0) return raw < 1e12 ? raw * 1000 : raw;
      if (typeof raw === "string") {
        var parsed = Date.parse(raw);
        if (!isNaN(parsed)) return parsed;
      }
      var text = typeof item.createdAtFormatted === "string" ? item.createdAtFormatted.trim() : "";
      var m = /^(\\d+)\\s*(mo|mon|month|yr|year|min|sec|hr|hour|day|week|[smhdwy])s?(\\s+ago)?$/i.exec(text);
      if (!m) return null;
      var unit = m[2].toLowerCase();
      var ms = { s: 1e3, sec: 1e3, m: 6e4, min: 6e4, h: 36e5, hr: 36e5, hour: 36e5, d: 864e5, day: 864e5,
        w: 6048e5, week: 6048e5, mo: 2592e6, mon: 2592e6, month: 2592e6, y: 31536e6, yr: 31536e6, year: 31536e6 }[unit];
      return ms ? Date.now() - Number(m[1]) * ms : null;
    }

    function pagerButtons() {
      return Array.prototype.slice
        .call(document.querySelectorAll("nav.npager button, .mchap-foot button"))
        .filter(function (button) {
          return !button.disabled;
        });
    }

    function clickPage(target, tries) {
      if (page !== target) return;
      var buttons = pagerButtons();
      var button =
        buttons.find(function (b) {
          return b.textContent && b.textContent.trim() === String(target);
        }) ||
        buttons.find(function (b) {
          var label = [b.getAttribute("aria-label"), b.getAttribute("title"), b.textContent]
            .filter(Boolean)
            .join(" ");
          return /\\bnext\\b/i.test(label);
        });
      if (button) {
        button.click();
      } else if (tries > 0) {
        setTimeout(function () {
          clickPage(target, tries - 1);
        }, 200);
      } else {
        fail("chapter list pager has no page " + target);
      }
    }

    function goTo(target) {
      setTimeout(function () {
        if (page !== target) return;
        try {
          var url = new URL(location.href);
          url.searchParams.set("page", String(target));
          history.pushState(history.state, "", url);
          dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        } catch (e) {}
        setTimeout(function () {
          clickPage(target, 25);
        }, PAGER_FALLBACK_MS);
      }, PAGE_DELAY_MS);
    }

    return function (holder) {
      var items = holder.items;
      var meta = holder.meta || holder.pagination;
      if (!meta || !Array.isArray(items) || !items.every(isChapter)) return;
      if (items.length === 0 && meta.total !== 0) return;
      var current = meta.page !== undefined ? meta.page : meta.currentPage;
      var lastPage = meta.lastPage !== undefined ? meta.lastPage : meta.last_page;
      if (typeof current !== "number") {
        fail("chapter list has no page numbers");
        return;
      }
      if (current !== page) return;
      for (var i = 0; i < items.length; i++) {
        if (seen[items[i].id]) continue;
        seen[items[i].id] = true;
        chapters.push(items[i]);
      }
      // Library refresh: once a newest-first page ends on a chapter older than
      // the last update, every later page is older still, so stop here.
      if (stopBeforeMs !== null && items.length > 1) {
        var newestFirst = items[0].number >= items[items.length - 1].number;
        var oldestOnPage = itemTime(items[items.length - 1]);
        if (newestFirst && oldestOnPage !== null && oldestOnPage < stopBeforeMs) {
          finish(JSON.stringify(chapters));
          return;
        }
      }
      var hasNext = meta.hasNext !== undefined ? !!meta.hasNext : typeof lastPage === "number" && page < lastPage;
      if (!hasNext || page >= Math.min(typeof lastPage === "number" ? lastPage : MAX_PAGES, MAX_PAGES)) {
        var count = chapters.length;
        if (typeof meta.total === "number" && count < meta.total) {
          fail("got " + count + " of " + meta.total + " chapters");
        } else {
          finish(JSON.stringify(chapters));
        }
        return;
      }
      page++;
      armIdle(IDLE_MS);
      goTo(page);
    };
  }
`;

// How far before the last update to keep reading, since upload times are often
// only known as relative text ("3 days ago").
const SINCE_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

export async function chapterListViaWebView(
  mangaId: string,
  cookieInterceptor: CookieStorageInterceptor,
  sinceDate?: Date,
): Promise<ChapterItem[]> {
  // Chapter URLs look like `/title/{hid}-{slug}/{id}-chapter-{n}`.
  const hid = mangaId.split("-")[0];
  const chapterPaths = JSON.stringify([`/title/${hid}-`, `/title/${hid}/`]);
  const stopBeforeMs = sinceDate ? String(sinceDate.getTime() - SINCE_MARGIN_MS) : "null";
  const payload = await runProxiedWebView<string>(
    `${DOMAIN}/title/${mangaId}`,
    captureBootstrap(
      CHAPTER_LIST_HANDLER.replace("__CHAPTER_PATHS__", chapterPaths).replace(
        "__STOP_BEFORE_MS__",
        stopBeforeMs,
      ),
    ),
    cookieInterceptor,
  );
  return JSON.parse(payload) as ChapterItem[];
}

// The reader's page list is the decoded holder `{ baseUrl, items: [{ url, s }], alt, node }`.
// Chapter lists (which carry `meta`) and manga lists (`hid`) also have `items`
// with `url`s, so those are skipped.
const PAGE_LIST_HANDLER = `
  function (finish, fail, armIdle) {
    armIdle(30000);
    return function (holder) {
      var items = holder.items;
      if (holder.meta || holder.pagination || !Array.isArray(items) || items.length === 0) return;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item || typeof item.url !== "string") return;
        if (item.hid !== undefined || typeof item.number === "number") return;
      }
      finish(
        JSON.stringify({
          baseUrl: typeof holder.baseUrl === "string" ? holder.baseUrl : "",
          items: items.map(function (item) {
            return { url: item.url, s: typeof item.s === "number" ? item.s : 0 };
          }),
          alt: Array.isArray(holder.alt) ? holder.alt : [],
          node: typeof holder.node === "string" ? holder.node : null,
        }),
      );
    };
  }
`;

export async function pageListViaWebView(
  chapterPagePath: string,
  cookieInterceptor: CookieStorageInterceptor,
): Promise<ChapterPages> {
  // Not queued: opening a chapter shouldn't wait behind a library refresh.
  const payload = await runWebViewNow<string>(
    `${DOMAIN}${chapterPagePath}`,
    captureBootstrap(PAGE_LIST_HANDLER),
    cookieInterceptor,
  );
  return JSON.parse(payload) as ChapterPages;
}

// `/browse` serves an empty shell and loads its list via an encrypted XHR, so
// run the bundle and capture the decrypted `{result:{items,meta}}` off
// JSON.parse. `&page=N` in the URL selects the page; one capture per call.
// `queued` puts the run in the background queue (the library update scan);
// Discover and search run right away.
export async function browseViaWebView(
  browseUrl: string,
  cookieInterceptor: CookieStorageInterceptor,
  { queued = false }: { queued?: boolean } = {},
): Promise<ResultManga> {
  const bootstrap = `
    (function () {
      var doneResolve;
      window.__comixResult__ = new Promise(function (r) {
        doneResolve = r;
      });
      var done = false;
      function finish(val) {
        if (done) return;
        done = true;
        doneResolve(val);
      }
      var orig = JSON.parse;
      JSON.parse = new Proxy(orig, {
        apply: function (t, a, args) {
          var parsed = Reflect.apply(t, a, args);
          try {
            var result = parsed && parsed.result;
            if (
              result &&
              Array.isArray(result.items) &&
              result.items.length > 0 &&
              result.items[0] &&
              result.items[0].hid !== undefined
            ) {
              finish({ items: result.items, meta: result.meta || result.pagination || null });
            }
          } catch {}
          return parsed;
        },
      });
      setTimeout(function () {
        finish(null);
      }, 20000);
    })();
  `;
  const run = queued ? runProxiedWebView : runWebViewNow;
  const result = await run<ResultManga | null>(browseUrl, bootstrap, cookieInterceptor);
  if (!result) throw new Error("Comix browseViaWebView: timed out waiting for browse JSON");
  return result;
}
