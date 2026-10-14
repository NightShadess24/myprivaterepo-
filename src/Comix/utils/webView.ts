/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import { CloudflareError, type CookieStorageInterceptor } from "@paperback/types";
import * as cheerio from "cheerio";

import { DOMAIN, type ChapterItem, type ChapterPageItems, type ResultManga } from "../models";
import { fetchText } from "../network";
import { logEvent } from "./log";
import { scheduleBrowse, scheduleComix, withTimeout } from "./queue";

// comix signs its API requests and encrypts `{e:"..."}` responses inside its own
// secure bundle, so we never reimplement the rotating cipher: we capture the
// site's own axios instance (which signs + decrypts) to fetch chapter lists, hook
// `Object.prototype.items` to read a chapter's decoded page list, and hook
// `JSON.parse` for browse/search. Every request therefore flows through the
// site's own code, so it looks like normal app traffic and survives its frequent
// bundle rotations.

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
    const cookies = cookieInterceptor.cookiesForUrl(`${DOMAIN}/`);
    const userAgent = await Application.getDefaultUserAgent();
    const $ = cheerio.load(await fetchText(pageUrl));

    $("head").prepend(`<script>${bootstrap}</script>`);

    const raw = await Application.executeInWebView({
      source: { html: $.html(), baseUrl: pageUrl, loadCSS: false, loadImages: false, userAgent },
      inject,
      storage: { cookies },
    });

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
// and note whether the site asked for its own check (/@waf/) along the way.
const PAGES_BOOTSTRAP = `
(function () {
  window.__comixPages__ = null;
  window.__comixNet__ = { waf: false, chapterStatus: null };

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
        var u = String(url);
        if (u.indexOf("/@waf/") !== -1) window.__comixNet__.waf = true;
        if (/\\/chapters\\/[^/?#]+/.test(u)) {
          this.addEventListener("loadend", function () {
            window.__comixNet__.chapterStatus = this.status;
          });
        }
      } catch (e) {}
      return open.apply(this, arguments);
    };
  } catch (e) {}
  try {
    var originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function (input) {
        try {
          var u = typeof input === "string" ? input : (input && input.url) || "";
          if (String(u).indexOf("/@waf/") !== -1) window.__comixNet__.waf = true;
        } catch (e) {}
        return originalFetch.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
`;

// Wait for the reader's own pages; if it hasn't got them after a few seconds,
// ask the API for them through the site's own client (it signs + decrypts),
// the same way chapter lists are read.
function buildPagesInject(chapterId: string): string {
  const id = JSON.stringify(chapterId);
  return `
return (async function () {
  var started = Date.now();
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var net = window.__comixNet__ || {};
  var wafSeen = function () {
    return !!net.waf || !!document.querySelector('iframe[src*="/@waf/"]');
  };
  var found = function (via) {
    return JSON.stringify({ ok: true, via: via, holder: window.__comixPages__ });
  };

  // comix's own check (a Turnstile box in /@waf/challenge) normally clears by
  // itself in a few seconds and the site then retries, so it means "wait".
  var checkSeen = false;
  while (Date.now() - started < (checkSeen ? 20000 : 8000)) {
    if (window.__comixPages__) return found("reader");
    if (wafSeen()) checkSeen = true;
    else if (!checkSeen && net.chapterStatus >= 400) break;
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
  while (!window.__comixAxios && Date.now() - started < 13000) await sleep(100);
  var axios = window.__comixAxios;
  if (window.__comixPages__) return found("reader");
  if (axios) {
    try {
      var resp = await axios.get("/chapters/" + ${id});
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

  // The API said no: give the reader (and any check in progress) a bit longer.
  var until = axios ? 25000 : 30000;
  while (Date.now() - started < until) {
    if (window.__comixPages__) return found("reader");
    await sleep(150);
  }
  return JSON.stringify({
    ok: false,
    status: apiStatus || net.chapterStatus || null,
    waf: checkSeen || wafSeen(),
    error: apiError || "the reader never got its pages",
  });
})();
`;
}

// Capture a chapter's decoded pages object (from the reader, or the API).
export async function pageListViaWebView(
  chapterPagePath: string,
  chapterId: string,
  cookieInterceptor: CookieStorageInterceptor,
): Promise<ChapterPageItems> {
  const raw = await runProxiedWebView<unknown>(
    `${DOMAIN}${chapterPagePath}`,
    BOOTSTRAP_AXIOS + PAGES_BOOTSTRAP,
    cookieInterceptor,
    {
      urgent: true,
      inject: buildPagesInject(chapterId),
      timeoutSeconds: 60,
      what: "opening the chapter",
    },
  );
  if (typeof raw !== "string") {
    throw new Error(`Comix WebView returned unexpected result: ${JSON.stringify(raw)}`);
  }
  const result = JSON.parse(raw) as
    | { ok: true; via: string; holder: string }
    | { ok: false; status: number | null; waf: boolean; error: string };

  if (!result.ok) {
    logEvent(
      "page list failed",
      `${chapterPagePath}: ${result.error}` +
        (result.status ? ` (HTTP ${result.status})` : "") +
        (result.waf ? " — comix asked for its own check" : ""),
    );
    if (result.waf) {
      throw new Error(
        "Comix: comix.to's own human check didn't clear this time, try again in a moment",
      );
    }
    if (result.status === 403 || result.status === 429 || result.status === 503) {
      throw new CloudflareError({
        url: DOMAIN,
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

function buildChapterListInject(mangaId: string): string {
  const id = JSON.stringify(mangaId);
  return `
return (async function () {
  var deadline = Date.now() + 45000;
  while (!window.__comixAxios && Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  var axios = window.__comixAxios;
  if (!axios) return JSON.stringify({ ok: false, status: 503, error: "axios instance not found" });

  var path = "/manga/" + ${id} + "/chapters";
  var chapters = [];
  var page = 1;
  var lastPage = 1;
  try {
    while (page <= lastPage && page <= 1000) {
      var resp = await axios.get(path, { params: { page: page, limit: 100, "order[number]": "desc" } });
      var data = resp.data || {};
      chapters = chapters.concat(data.items || []);
      var meta = data.meta || {};
      lastPage = meta.lastPage || page;
      page = page + 1;
    }
    return JSON.stringify({ ok: true, items: chapters });
  } catch (e) {
    var resp2 = e && e.response;
    return JSON.stringify({
      ok: false,
      status: resp2 && resp2.status,
      error: String((e && e.message) || e),
    });
  }
})();
`;
}

// Load a manga's full chapter list by driving the site's own axios instance
// directly (limit 100 per page), which is far fewer requests than the app's own
// `?page=` UI pagination (20 per page) that the WebView capture relied on.
export async function chapterListViaWebView(
  mangaId: string,
  cookieInterceptor: CookieStorageInterceptor,
): Promise<ChapterItem[]> {
  return scheduleComix(() =>
    withTimeout(loadChapterList(mangaId, cookieInterceptor), 120, "loading the chapter list"),
  );
}

async function loadChapterList(
  mangaId: string,
  cookieInterceptor: CookieStorageInterceptor,
): Promise<ChapterItem[]> {
  const cookies = cookieInterceptor.cookiesForUrl(`${DOMAIN}/`);
  const userAgent = await Application.getDefaultUserAgent();
  const pageUrl = `${DOMAIN}/title/${mangaId}`;

  const $ = cheerio.load(await fetchText(pageUrl));
  $("head").prepend(`<script>${BOOTSTRAP_AXIOS}</script>`);

  const raw = await Application.executeInWebView({
    source: { html: $.html(), baseUrl: pageUrl, loadCSS: false, loadImages: false, userAgent },
    inject: buildChapterListInject(mangaId),
    storage: { cookies },
  });

  const text = raw.result;
  if (typeof text !== "string") {
    throw new Error(`Comix WebView returned unexpected result: ${JSON.stringify(text)}`);
  }
  const result = JSON.parse(text) as
    | { ok: true; items: ChapterItem[] }
    | { ok: false; status?: number; error: string };

  if (!result.ok) {
    const status = result.status;
    console.log(
      `[Comix] chapter list failed for ${mangaId} (HTTP ${status ?? "?"}): ${result.error}`,
    );
    if (status === 403 || status === 404 || status === 429 || status === 503) {
      throw new CloudflareError({
        url: DOMAIN,
        method: "GET",
        headers: { "user-agent": await Application.getDefaultUserAgent() },
      });
    }
    throw new Error(`Comix chapter list failed for ${mangaId}: ${result.error}`);
  }

  console.log(`[Comix] chapter list for ${mangaId}: ${result.items.length} chapters`);
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
      setTimeout(function () {
        finish(null);
      }, 20000);
    })();
  `;
  const result = await runProxiedWebView<ResultManga | null>(
    browseUrl,
    bootstrap,
    cookieInterceptor,
    { browse: true, timeoutSeconds: 45, what: "loading the list" },
  );
  if (!result) {
    console.log(`[Comix] browse timed out for ${browseUrl}`);
    throw new Error("Comix browseViaWebView: timed out waiting for browse JSON");
  }
  return result;
}
