/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import { CloudflareError, type CookieStorageInterceptor } from "@paperback/types";
import * as cheerio from "cheerio";

import { DOMAIN, type ChapterItem, type ChapterPageItems, type ResultManga } from "../models";
import { fetchText } from "../network";
import { keepSiteCookies, siteCookies } from "./cookies";
import { logEvent } from "./log";
import { scheduleBrowse, scheduleComix, withTimeout } from "./queue";

// comix signs its API requests and encrypts `{e:"..."}` responses inside its own
// secure bundle, so we never reimplement the rotating cipher: we capture the
// site's own axios instance (which signs + decrypts) to fetch chapter lists, hook
// `Object.prototype.items` to read a chapter's decoded page list, and hook
// `JSON.parse` for browse/search. Every request therefore flows through the
// site's own code, so it looks like normal app traffic and survives its frequent
// bundle rotations.

// How long comix's own check ("Verify you're human", /@waf/challenge) may stay
// up in a hidden page before we stop and hand it to the user. When it clears by
// itself it takes a few seconds; when it doesn't, nobody can see it to solve it.
const CHECK_WAIT_MS = 12000;

// Runs first in every hidden page, before the site's scripts:
// - notes when comix puts up its own check (a captcha_required answer, a
//   /@waf/ request or the /@waf/challenge frame) in `window.__comixCheck`
// - skips requests a reader has no use for (account, comments, error reports,
//   analytics), answering them with an empty `{}` so the site carries on. Fewer
//   API calls per page is what keeps comix from treating the app as a bot.
const SITE_BOOTSTRAP = `
(function () {
  var check = (window.__comixCheck = { seen: false, since: 0 });
  // Cloudflare (not comix) refusing the page's own requests or scripts: the
  // Cloudflare pass is missing or expired, so only a check by hand helps.
  window.__comixCloudflare = false;
  window.__comixScriptFailedAt = 0;
  function sawCloudflare() { window.__comixCloudflare = true; }
  try {
    window.addEventListener("error", function (event) {
      var target = event && event.target;
      if (target && target.tagName === "SCRIPT" && /comix\\.to\\/|^\\//.test(target.getAttribute("src") || "")) {
        window.__comixScriptFailedAt = window.__comixScriptFailedAt || Date.now();
      }
    }, true);
  } catch (e) {}
  function sawCheck() {
    if (!check.seen) { check.seen = true; check.since = Date.now(); }
  }
  var SKIP = /\\/api\\/v1\\/(user|threads|client-errors|notifications)|\\/comments|\\/assets\\/uploads\\/|\\/cdn-cgi\\/rum|amung\\.us/;
  function skip(url) { return SKIP.test(String(url || "")); }

  function answerEmpty(xhr) {
    function define(key, value) {
      try { Object.defineProperty(xhr, key, { configurable: true, get: function () { return value; } }); } catch (e) {}
    }
    define("readyState", 4);
    define("status", 200);
    define("statusText", "OK");
    define("responseText", "{}");
    define("response", xhr.responseType === "json" ? {} : "{}");
    define("responseURL", xhr.__comixUrl);
    xhr.getAllResponseHeaders = function () { return "content-type: application/json\\r\\n"; };
    xhr.getResponseHeader = function (name) { return /content-type/i.test(name) ? "application/json" : null; };
    setTimeout(function () {
      ["readystatechange", "load", "loadend"].forEach(function (type) {
        try { xhr.dispatchEvent(new Event(type)); } catch (e) {}
      });
    }, 0);
  }

  try {
    var proto = XMLHttpRequest.prototype;
    var open = proto.open;
    var send = proto.send;
    proto.open = function (method, url) {
      this.__comixUrl = String(url);
      if (this.__comixUrl.indexOf("/@waf/") !== -1) sawCheck();
      return open.apply(this, arguments);
    };
    proto.send = function () {
      var xhr = this;
      if (skip(xhr.__comixUrl)) { answerEmpty(xhr); return; }
      try {
        xhr.addEventListener("loadend", function () {
          try {
            if (xhr.getResponseHeader("cf-mitigated") === "challenge") sawCloudflare();
            else if (xhr.status === 403 && /captcha/i.test(String(xhr.responseText || ""))) sawCheck();
          } catch (e) {}
        });
      } catch (e) {}
      return send.apply(this, arguments);
    };
  } catch (e) {}

  try {
    var originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function (input) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (String(url).indexOf("/@waf/") !== -1) sawCheck();
        if (skip(url)) {
          return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
        }
        return originalFetch.apply(this, arguments).then(function (response) {
          try {
            if (response.headers.get("cf-mitigated") === "challenge") sawCloudflare();
            else if (response.status === 403) {
              response.clone().text().then(function (text) { if (/captcha/i.test(text)) sawCheck(); }, function () {});
            }
          } catch (e) {}
          return response;
        });
      };
    }
  } catch (e) {}

  try {
    var doc = document;
    var observer = new MutationObserver(function () {
      try {
        if (doc.querySelector('iframe[src*="/@waf/"]')) { sawCheck(); observer.disconnect(); }
      } catch (e) {}
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();
`;

// Shared by the injects: `orCheck(work)` settles with `CHECK` once comix's
// check has been up for CHECK_WAIT_MS without the work finishing.
const CHECK_HELPERS = `
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var check = window.__comixCheck || { seen: false, since: 0 };
  var stuck = function () { return check.seen && Date.now() - check.since > ${CHECK_WAIT_MS}; };
  // Cloudflare refused a request outright, or comix's own scripts failed to
  // load and its code still hasn't started 3 s later.
  var blocked = function () {
    if (window.__comixCloudflare) return true;
    var failedAt = window.__comixScriptFailedAt;
    return !!failedAt && !window.__comixAxios && Date.now() - failedAt > 3000;
  };
  var CHECK = { check: true };
  var CLOUDFLARE = { cloudflare: true };
  var orCheck = function (work) {
    return Promise.race([
      work,
      new Promise(function (resolve) {
        var timer = setInterval(function () {
          if (blocked()) { clearInterval(timer); resolve(CLOUDFLARE); }
          else if (stuck()) { clearInterval(timer); resolve(CHECK); }
        }, 200);
        work.then(function () { clearInterval(timer); }, function () { clearInterval(timer); });
      }),
    ]);
  };
  var checkResult = function () { return JSON.stringify({ ok: false, check: true, error: "comix's own check didn't clear" }); };
  var cloudflareResult = function () { return JSON.stringify({ ok: false, cloudflare: true, error: "Cloudflare refused the page's requests" }); };
  var stopper = function (resp) { return resp === CLOUDFLARE ? cloudflareResult() : resp === CHECK ? checkResult() : null; };
`;

// Cloudflare refused what the hidden page asked for: its pass is missing or
// expired. Opens `pageUrl` in the check browser to get a new one by hand.
async function cloudflareError(pageUrl: string, what: string): Promise<CloudflareError> {
  logEvent(
    "cloudflare",
    `${what}: Cloudflare refused the page's requests, opening it to pass the check`,
  );
  return new CloudflareError(
    {
      url: pageUrl,
      method: "GET",
      headers: { "user-agent": await Application.getDefaultUserAgent() },
    },
    "Cloudflare wants a check. Open it, complete the check, wait for comix's page, then tap Done.",
  );
}

// The error that opens `pageUrl` in Paperback's check browser, where comix's own
// check (if it shows) can be passed by hand like on any visit. What that browser
// ends with is kept (see cloudflareBypassCompleted) and sent with later pages.
async function checkError(pageUrl: string, what: string): Promise<CloudflareError> {
  logEvent("comix check", `${what}: comix wanted its check, opening the page to pass it`);
  return new CloudflareError(
    {
      url: pageUrl,
      method: "GET",
      headers: { "user-agent": await Application.getDefaultUserAgent() },
    },
    "comix.to wants a check. Open it, pass the check if one shows, wait for the page, then tap Done.",
  );
}

// `browse: true` uses the home page/search limit (Settings → Loading Speed)
// instead of the one-at-a-time queue, so Discover's sections can load side by
// side. Chapter lists and chapter pages stay in comix-capture's queue, where
// `urgent` (opening a chapter) goes ahead of chapter lists still waiting.
// Every run has a time limit: a WebView that never answers gives an error
// instead of loading forever, and the queue moves on.
interface RunOptions {
  browse?: boolean;
  urgent?: boolean;
  inject?: string;
  timeoutSeconds: number;
  what: string;
}

async function runProxiedWebView<T>(
  pageUrl: string,
  bootstrap: string,
  cookieInterceptor: CookieStorageInterceptor,
  {
    browse = false,
    urgent = false,
    inject = `return window.__comixResult__`,
    timeoutSeconds,
    what,
  }: RunOptions,
): Promise<T> {
  const run = async (): Promise<T> => {
    const userAgent = await Application.getDefaultUserAgent();
    const $ = cheerio.load(await fetchText(pageUrl));
    // Read after the page fetch, so the session it was just given goes along.
    const cookies = siteCookies(cookieInterceptor);

    $("head").prepend(`<script>${SITE_BOOTSTRAP}${bootstrap}</script>`);

    const raw = await Application.executeInWebView({
      source: { html: $.html(), baseUrl: pageUrl, loadCSS: false, loadImages: false, userAgent },
      inject,
      storage: { cookies },
    });
    keepSiteCookies(cookieInterceptor, raw?.storage?.cookies);

    if (raw.result === undefined || raw.result === null) {
      throw new Error("Comix WebView returned no result");
    }
    return raw.result as T;
  };
  const task = () => withTimeout(run(), timeoutSeconds, what);
  return browse ? scheduleBrowse(task) : scheduleComix(task, { urgent });
}

// Hook `items` assignments, then run `handle(holder)` on the decoded object.
// Shared by the chapter-list and chapter-pages captures.
const CAPTURE_ITEMS = `
  var __comixDefineProperty = Object.defineProperty;
  var __comixCapture = function (holder) {
    setTimeout(function () { __comixHandle(holder); }, 0);
  };
  Object.defineProperty(Object.prototype, "items", {
    configurable: true,
    set: function (value) {
      __comixDefineProperty(this, "items", {
        value: value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      __comixCapture(this);
    },
  });
  Object.defineProperty = function (target, key, descriptor) {
    var result = __comixDefineProperty.apply(this, arguments);
    if (key === "items" && descriptor && "value" in descriptor) __comixCapture(target);
    return result;
  };
`;

// Reader page bootstrap: capture the decoded pages object the reader receives,
// and the status of the reader's own chapter request.
const PAGES_BOOTSTRAP = `
(function () {
  window.__comixPages__ = null;
  window.__comixNet__ = { chapterStatus: null };

  var __comixHandle = function (holder) {
    try {
      if (window.__comixPages__) return;
      var items = holder.items;
      if (holder.meta || !Array.isArray(items) || items.length === 0) return;
      if (!items.every(function (item) { return item && typeof item.url === "string"; })) return;
      window.__comixPages__ = JSON.stringify(holder);
    } catch (e) {}
  };

  ${CAPTURE_ITEMS}

  try {
    var open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (/\\/chapters\\/[^/?#]+/.test(String(url))) {
          this.addEventListener("loadend", function () {
            window.__comixNet__.chapterStatus = this.status;
          });
        }
      } catch (e) {}
      return open.apply(this, arguments);
    };
  } catch (e) {}
})();
`;

// Wait for the reader's own pages; if it hasn't got them after a few seconds,
// ask the API for them through the site's own client (it signs + decrypts),
// the same way chapter lists are read. If comix's check comes up and doesn't
// clear by itself, stop and say so.
function buildPagesInject(chapterId: string): string {
  const id = JSON.stringify(chapterId);
  return `
return (async function () {
  ${CHECK_HELPERS}
  var started = Date.now();
  var net = window.__comixNet__ || {};
  var found = function (via) {
    return JSON.stringify({ ok: true, via: via, holder: window.__comixPages__ });
  };

  while (check.seen || Date.now() - started < 8000) {
    if (window.__comixPages__) return found("reader");
    if (blocked()) return cloudflareResult();
    if (stuck()) return checkResult();
    if (!check.seen && net.chapterStatus >= 400) break;
    await sleep(100);
  }

  var findHolder = function (value, depth) {
    if (!value || typeof value !== "object" || depth > 4) return null;
    var items = value.items;
    if (
      Array.isArray(items) && items.length > 0 && !value.meta &&
      items.every(function (item) { return item && typeof item.url === "string"; })
    ) return value;
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        var inner = findHolder(value[key], depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  };

  var apiStatus = null;
  var apiError = null;
  while (!window.__comixAxios && Date.now() - started < 13000) {
    if (blocked()) return cloudflareResult();
    await sleep(100);
  }
  var axios = window.__comixAxios;
  if (window.__comixPages__) return found("reader");
  if (axios) {
    try {
      var resp = await orCheck(axios.get("/chapters/" + ${id}));
      if (stopper(resp)) return stopper(resp);
      var holder = findHolder(resp && resp.data, 0);
      if (holder) {
        return JSON.stringify({ ok: true, via: "api", holder: JSON.stringify(holder) });
      }
      apiError = "no pages in the API answer (" +
        Object.keys((resp && resp.data) || {}).slice(0, 8).join(",") + ")";
    } catch (e) {
      apiStatus = (e && e.response && e.response.status) || null;
      apiError = String((e && e.message) || e);
    }
  } else {
    apiError = "the site's API client never loaded";
  }

  // The API said no: give the reader a bit longer.
  var until = axios ? 25000 : 30000;
  while (Date.now() - started < until) {
    if (window.__comixPages__) return found("reader");
    if (blocked()) return cloudflareResult();
    if (stuck()) return checkResult();
    await sleep(150);
  }
  if (check.seen) return checkResult();
  return JSON.stringify({
    ok: false,
    status: apiStatus || net.chapterStatus || null,
    error: apiError || "the reader never got its pages",
  });
})();
`;
}

type InjectResult<T> =
  | ({ ok: true } & T)
  | { ok: false; check?: boolean; cloudflare?: boolean; status?: number | null; error: string };

function parseInjectResult<T>(raw: unknown): InjectResult<T> {
  if (typeof raw !== "string") {
    throw new Error(`Comix WebView returned unexpected result: ${JSON.stringify(raw)}`);
  }
  return JSON.parse(raw) as InjectResult<T>;
}

// Capture a chapter's decoded pages object (from the reader, or the API).
export async function pageListViaWebView(
  chapterPagePath: string,
  chapterId: string,
  cookieInterceptor: CookieStorageInterceptor,
): Promise<ChapterPageItems> {
  const pageUrl = `${DOMAIN}${chapterPagePath}`;
  const result = parseInjectResult<{ via: string; holder: string }>(
    await runProxiedWebView<unknown>(
      pageUrl,
      BOOTSTRAP_AXIOS + PAGES_BOOTSTRAP,
      cookieInterceptor,
      {
        urgent: true,
        inject: buildPagesInject(chapterId),
        timeoutSeconds: 60,
        what: "opening the chapter",
      },
    ),
  );

  if (!result.ok) {
    if (result.cloudflare) throw await cloudflareError(pageUrl, `chapter ${chapterPagePath}`);
    if (result.check) throw await checkError(pageUrl, `chapter ${chapterPagePath}`);
    logEvent(
      "page list failed",
      `${chapterPagePath}: ${result.error}` + (result.status ? ` (HTTP ${result.status})` : ""),
    );
    if (result.status === 403 || result.status === 429 || result.status === 503) {
      throw new CloudflareError({
        url: pageUrl,
        method: "GET",
        headers: { "user-agent": await Application.getDefaultUserAgent() },
      });
    }
    throw new Error(`Comix: couldn't get this chapter's pages (${result.error})`);
  }

  const pages = JSON.parse(result.holder) as ChapterPageItems;
  const v3 = pages.items.filter((item) => item.s === 1).length;
  logEvent(
    "page list",
    `${pages.items.length} pages via ${result.via}` +
      (v3 ? `, ${v3} v3` : "") +
      (pages.alt?.length ? `, ${pages.alt.length} backup hosts` : "") +
      `, first: ${(pages.items[0]?.url ?? "").replace(/^https?:\/\//, "").slice(0, 70)}`,
  );
  return pages;
}

// Capture the site's own `/api/v1` axios instance (it signs + decrypts for us)
// the moment it is constructed. Key off `defaults.baseURL` so the vendor's plain
// default axios instance (no baseURL) is ignored.
const BOOTSTRAP_AXIOS = `
(function () {
  var resolveAxios;
  window.__comixAxios = null;
  window.__comixAxiosReady = new Promise(function (resolve) { resolveAxios = resolve; });
  try {
    Object.defineProperty(Object.prototype, "interceptors", {
      configurable: true,
      get: function () { return this.__pbInterceptors; },
      set: function (value) {
        this.__pbInterceptors = value;
        if (
          this &&
          typeof this.get === "function" &&
          typeof this.post === "function" &&
          this.defaults &&
          typeof this.defaults.baseURL === "string" &&
          this.defaults.baseURL.indexOf("/api/v1") !== -1 &&
          !window.__comixAxios
        ) {
          window.__comixAxios = this;
          resolveAxios(this);
        }
      },
    });
  } catch (e) {}
})();
`;

// Pages of 100, newest first, a little apart like a person paging. A library
// refresh (`maxPages` 1) only needs the newest page: the app merges chapters.
function buildChapterListInject(mangaId: string, maxPages: number): string {
  const id = JSON.stringify(mangaId);
  return `
return (async function () {
  ${CHECK_HELPERS}
  var deadline = Date.now() + 15000;
  while (!window.__comixAxios && Date.now() < deadline) {
    if (blocked()) return cloudflareResult();
    if (stuck()) return checkResult();
    await sleep(100);
  }
  var axios = window.__comixAxios;
  if (!axios) return JSON.stringify({ ok: false, status: 503, error: "comix's page didn't start (no API client after 15 s)" });

  var path = "/manga/" + ${id} + "/chapters";
  var chapters = [];
  var page = 1;
  var lastPage = 1;
  try {
    while (page <= lastPage && page <= ${maxPages}) {
      if (page > 1) await sleep(700);
      var resp = await orCheck(axios.get(path, { params: { page: page, limit: 100, "order[number]": "desc" } }));
      if (stopper(resp)) return stopper(resp);
      var data = resp.data || {};
      chapters = chapters.concat(data.items || []);
      var meta = data.meta || {};
      lastPage = meta.lastPage || page;
      page = page + 1;
    }
    return JSON.stringify({ ok: true, items: chapters, pages: page - 1, lastPage: lastPage });
  } catch (e) {
    var resp2 = e && e.response;
    return JSON.stringify({
      ok: false,
      cloudflare: blocked(),
      check: check.seen,
      status: resp2 && resp2.status,
      error: String((e && e.message) || e),
    });
  }
})();
`;
}

// Load a manga's chapter list by driving the site's own axios instance directly
// (limit 100 per page), which is far fewer requests than the site's own `?page=`
// pager (20 per page). `refresh` (a library update) reads only the newest page.
export async function chapterListViaWebView(
  mangaId: string,
  cookieInterceptor: CookieStorageInterceptor,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<ChapterItem[]> {
  const pageUrl = `${DOMAIN}/title/${mangaId}`;
  const started = Date.now();
  const result = parseInjectResult<{ items: ChapterItem[]; pages: number; lastPage: number }>(
    await runProxiedWebView<unknown>(pageUrl, BOOTSTRAP_AXIOS, cookieInterceptor, {
      inject: buildChapterListInject(mangaId, refresh ? 1 : 1000),
      timeoutSeconds: 120,
      what: "loading the chapter list",
    }),
  );

  if (!result.ok) {
    if (result.cloudflare) throw await cloudflareError(pageUrl, `chapter list of ${mangaId}`);
    if (result.check) throw await checkError(pageUrl, `chapter list of ${mangaId}`);
    const status = result.status;
    logEvent(
      "chapter list failed",
      `${mangaId}: ${result.error}` + (status ? ` (HTTP ${status})` : ""),
    );
    if (status === 403 || status === 404 || status === 429 || status === 503) {
      throw new CloudflareError({
        url: pageUrl,
        method: "GET",
        headers: { "user-agent": await Application.getDefaultUserAgent() },
      });
    }
    throw new Error(`Comix chapter list failed for ${mangaId}: ${result.error}`);
  }

  if (!refresh) {
    logEvent(
      "chapter list",
      `${mangaId}: ${result.items.length} chapters (${result.pages} of ${result.lastPage} pages) in ${Math.round(
        (Date.now() - started) / 1000,
      )}s`,
    );
  }
  return result.items;
}

// `/browse` serves an empty shell and loads its list via an encrypted XHR, so
// run the bundle and capture the decrypted `{result:{items,meta}}` off
// JSON.parse. `&page=N` in the URL selects the page; one capture per call.
export async function browseViaWebView(
  browseUrl: string,
  cookieInterceptor: CookieStorageInterceptor,
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
      var watch = setInterval(function () {
        var check = window.__comixCheck;
        if (done) { clearInterval(watch); return; }
        var failedAt = window.__comixScriptFailedAt;
        if (window.__comixCloudflare || (failedAt && Date.now() - failedAt > 3000)) {
          clearInterval(watch);
          finish({ __comixCloudflare: true });
        } else if (check && check.seen && Date.now() - check.since > ${CHECK_WAIT_MS}) {
          clearInterval(watch);
          finish({ __comixCheck: true });
        }
      }, 250);
      setTimeout(function () {
        finish(null);
      }, 20000);
    })();
  `;
  const result = await runProxiedWebView<
    (ResultManga & { __comixCheck?: boolean; __comixCloudflare?: boolean }) | null
  >(browseUrl, bootstrap, cookieInterceptor, {
    browse: true,
    timeoutSeconds: 45,
    what: "loading the list",
  });
  if (result?.__comixCloudflare) throw await cloudflareError(browseUrl, "list");
  if (result?.__comixCheck) throw await checkError(browseUrl, "list");
  if (!result) {
    console.log(`[Comix] browse timed out for ${browseUrl}`);
    throw new Error("Comix browseViaWebView: timed out waiting for browse JSON");
  }
  return result;
}
