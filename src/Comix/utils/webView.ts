/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import { CloudflareError, type CookieStorageInterceptor } from "@paperback/types";
import * as cheerio from "cheerio";

import {
  CHECK_PAGE,
  DOMAIN,
  type ChapterItem,
  type ChapterPageItems,
  type ResultManga,
} from "../models";
import { fetchText } from "../network";
import { describeCookies, keepSiteCookies, pageCookieScript, siteCookies } from "./cookies";
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
// up in a hidden page before we stop and hand it to the user. A hidden page
// can't pass it (nobody can see it), so don't keep the reader waiting long.
const CHECK_WAIT_MS = 6000;

// Like the Mihon extension: comix blocks clients that page chapter lists
// faster than one request every 3 seconds. Every chapter-list request (the
// title page's own one included) is kept at least this far from the last one.
const CHAPTER_REQUEST_GAP_MS = 3000;

// Runs first in every hidden page, before the site's scripts:
// - notes when comix puts up its own check (a captcha_required answer, a
//   /@waf/ request or the /@waf/challenge frame) in `window.__comixCheck`
// - skips the same few requests the Mihon extension leaves out (error
//   reports, comment threads, uploaded images, and a third-party counter),
//   answering them with an empty `{}` so the site carries on. Everything else
//   (the account check included) goes out as on a normal visit.
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
  // What made comix ask, for the Reading Log: the request and its answer, and
  // which comix.to cookies the page could see at that moment (names only).
  function cookieNames() {
    try {
      return document.cookie.split(";").map(function (c) { return c.split("=")[0].trim(); }).filter(Boolean).join(", ");
    } catch (e) { return "?"; }
  }
  function shortPath(url) {
    return String(url || "").replace(/^https?:\\/\\/[^/]+/, "").split("?")[0].slice(0, 60);
  }
  // The page's last API answers (method, path, status), for the Reading Log.
  var netLog = (window.__comixNetLog = []);
  function noteNet(method, url, status) {
    if (!/\\/api\\/|\\/@waf\\//.test(String(url || ""))) return;
    netLog.push(String(method || "GET").toUpperCase() + " " + shortPath(url) + " " + status);
    if (netLog.length > 12) netLog.shift();
  }
  function bodyOf(xhr) {
    try {
      if (!xhr.responseType || xhr.responseType === "text") return String(xhr.responseText || "");
      if (xhr.responseType === "json") return JSON.stringify(xhr.response);
    } catch (e) {}
    return "";
  }
  // comix's check frame (or a request to /@waf/) on its own is not a refusal:
  // the site can put it up while its API keeps answering normally. Only an
  // API answer of 403 captcha_required counts as comix wanting its check.
  var frame = (window.__comixFrame = { seen: false, at: 0, how: "" });
  function sawFrame(how) {
    if (!frame.seen) { frame.seen = true; frame.at = Date.now(); frame.how = how; }
  }
  function sawCheck(why) {
    if (!check.seen) {
      check.seen = true;
      check.since = Date.now();
      window.__comixCheckWhy = {
        why: why,
        cookies: cookieNames(),
        net: netLog.slice(-6).join(", "),
        ua: String(navigator.userAgent || ""),
        visible: String(document.visibilityState || ""),
        frame: frame.seen ? frame.how : "",
      };
    }
  }
  window.__comixSawCheck = sawCheck;
  var SKIP = /\\/api\\/v1\\/(threads|client-errors)|\\/assets\\/uploads\\/|amung\\.us/;
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
      this.__comixMethod = String(method || "GET");
      if (this.__comixUrl.indexOf("/@waf/") !== -1) sawFrame("the page asked for " + shortPath(this.__comixUrl));
      return open.apply(this, arguments);
    };
    proto.send = function () {
      var xhr = this;
      if (skip(xhr.__comixUrl)) { answerEmpty(xhr); return; }
      try {
        xhr.addEventListener("loadend", function () {
          try {
            noteNet(xhr.__comixMethod, xhr.__comixUrl, xhr.status);
            if (xhr.getResponseHeader("cf-mitigated") === "challenge") sawCloudflare();
            else if (xhr.status === 403 && /captcha/i.test(bodyOf(xhr))) {
              sawCheck("HTTP 403 on " + shortPath(xhr.__comixUrl) + ": " + bodyOf(xhr).slice(0, 100));
            }
          } catch (e) {}
        });
      } catch (e) {}
      return send.apply(this, arguments);
    };
  } catch (e) {}

  try {
    var originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var method = (init && init.method) || (input && input.method) || "GET";
        if (String(url).indexOf("/@waf/") !== -1) sawFrame("the page asked for " + shortPath(url));
        if (skip(url)) {
          return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
        }
        return originalFetch.apply(this, arguments).then(function (response) {
          try {
            noteNet(method, url, response.status);
            if (response.headers.get("cf-mitigated") === "challenge") sawCloudflare();
            else if (response.status === 403) {
              response.clone().text().then(function (text) {
                if (/captcha/i.test(text)) sawCheck("HTTP 403 on " + shortPath(url) + ": " + text.slice(0, 100));
              }, function () {});
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
        if (doc.querySelector('iframe[src*="/@waf/"]')) { sawFrame("check frame shown"); observer.disconnect(); }
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
  // The site put up its check frame instead of loading (its own requests
  // wait for it): ask the API ourselves rather than wait for the site.
  var frame = window.__comixFrame || { seen: false, at: 0 };
  var gated = function () { return !check.seen && frame.seen && Date.now() - frame.at > 1500; };
  // Our own request answered 403 captcha_required: comix really wants its check.
  var refused = function (e) {
    var r = e && e.response;
    if (!r || r.status !== 403) return false;
    var text = "";
    try { text = typeof r.data === "string" ? r.data : JSON.stringify(r.data); } catch (x) {}
    if (!/captcha/i.test(text)) return false;
    if (window.__comixSawCheck) window.__comixSawCheck("HTTP 403 on our request: " + text.slice(0, 100));
    return true;
  };
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
  var checkResult = function () {
    return JSON.stringify({ ok: false, check: true, error: "comix's own check didn't clear", why: window.__comixCheckWhy || null });
  };
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

// comix wants its own check: open its check page in Paperback's check browser.
// Opening the page that asked for it doesn't work, because comix only puts up
// its check in hidden pages, so no pass was ever earned there. What the check
// browser ends with (comix's pass) is kept (see cloudflareBypassCompleted) and
// sent with every hidden page after that, for every manga.
export interface CheckWhy {
  why?: string;
  cookies?: string;
  net?: string;
  ua?: string;
  visible?: string;
  frame?: string;
}

export async function checkError(what: string, why?: CheckWhy | null): Promise<CloudflareError> {
  const appAgent = await Application.getDefaultUserAgent();
  const agent = !why?.ua
    ? "unknown"
    : why.ua === appAgent
      ? "same as the app's"
      : `"${why.ua}", the app's is "${appAgent}"`;
  logEvent(
    "comix check",
    `${what}: comix wanted its check, opening its check page. ` +
      `Asked because: ${why?.why ?? "unknown"}. Last answers: ${why?.net || "none"}. ` +
      `Page could see: ${why?.cookies || "no cookies"}. ` +
      `Page was given: ${lastRunCookies.sent}. Page ended with: ${lastRunCookies.ended}. ` +
      `Page's browser: ${agent}${why?.visible ? ` (${why.visible})` : ""}.` +
      (why?.frame ? ` Before that: ${why.frame}.` : ""),
  );
  return new CloudflareError(
    {
      url: CHECK_PAGE,
      method: "GET",
      headers: { "user-agent": await Application.getDefaultUserAgent() },
    },
    "comix.to wants its own check. Open it, complete the check (it may pass by itself), wait for comix's home page, then tap Done.",
  );
}

// `browse: true` uses the home page/search limit (Settings → Loading Speed)
// instead of the one-at-a-time queue, so Discover's sections can load side by
// side. Chapter lists and chapter pages stay in comix-capture's queue, where
// `urgent` (opening a chapter) goes ahead of chapter lists still waiting.
// Every run has a time limit: a WebView that never answers gives an error
// instead of loading forever, and the queue moves on.
// `paced` (chapter lists): starts no sooner than CHAPTER_REQUEST_GAP_MS after
// the last paced page ended, less the second or so the title page takes to
// make its own chapter request, so a library refresh doesn't fire them back
// to back.
interface RunOptions {
  browse?: boolean;
  urgent?: boolean;
  paced?: boolean;
  inject?: string;
  timeoutSeconds: number;
  what: string;
}

let lastPacedRunEnded = 0;
// The comix.to cookies the last hidden page was given and ended with, for the
// Reading Log when comix asks for its check.
let lastRunCookies = { sent: "none", ended: "none" };
const PAGE_START_MS = 1000;

async function runProxiedWebView<T>(
  pageUrl: string,
  bootstrap: string,
  cookieInterceptor: CookieStorageInterceptor,
  {
    browse = false,
    urgent = false,
    paced = false,
    inject = `return window.__comixResult__`,
    timeoutSeconds,
    what,
  }: RunOptions,
): Promise<T> {
  const run = async (): Promise<T> => {
    if (paced) {
      const wait = lastPacedRunEnded + CHAPTER_REQUEST_GAP_MS - PAGE_START_MS - Date.now();
      if (wait > 0) await Application.sleep(wait / 1000);
    }
    try {
      return await load();
    } finally {
      if (paced) lastPacedRunEnded = Date.now();
    }
  };
  const load = async (): Promise<T> => {
    const userAgent = await Application.getDefaultUserAgent();
    const $ = cheerio.load(await fetchText(pageUrl));
    // Read after the page fetch, so the session it was just given goes along.
    const cookies = siteCookies(cookieInterceptor);

    $("head").prepend(`<script>${pageCookieScript(cookies)}${SITE_BOOTSTRAP}${bootstrap}</script>`);

    const raw = await Application.executeInWebView({
      source: { html: $.html(), baseUrl: pageUrl, loadCSS: false, loadImages: false, userAgent },
      inject,
      storage: { cookies },
    });
    keepSiteCookies(cookieInterceptor, raw?.storage?.cookies);
    lastRunCookies = {
      sent: describeCookies(cookies),
      ended: describeCookies(raw?.storage?.cookies),
    };

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
    return JSON.stringify({ ok: true, via: via, holder: window.__comixPages__, frame: frame.seen });
  };

  while (check.seen || Date.now() - started < 8000) {
    if (window.__comixPages__) return found("reader");
    if (blocked()) return cloudflareResult();
    if (stuck()) return checkResult();
    if (!check.seen && net.chapterStatus >= 400) break;
    if (gated()) break;
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
        return JSON.stringify({ ok: true, via: "api", holder: JSON.stringify(holder), frame: frame.seen });
      }
      apiError = "no pages in the API answer (" +
        Object.keys((resp && resp.data) || {}).slice(0, 8).join(",") + ")";
    } catch (e) {
      if (refused(e)) return checkResult();
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
  | {
      ok: false;
      check?: boolean;
      cloudflare?: boolean;
      status?: number | null;
      error: string;
      why?: CheckWhy | null;
    };

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
  const result = parseInjectResult<{ via: string; holder: string; frame?: boolean }>(
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
    if (result.check) throw await checkError(`chapter ${chapterPagePath}`, result.why);
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
      (result.frame ? ", comix showed its check frame (carried on)" : "") +
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

// The title page asks for its newest chapters by itself (20, by number) as soon
// as it starts. Keep the decoded page it gets: a library refresh, and any manga
// with 20 chapters or fewer, then needs no request of ours at all.
const SITE_CHAPTERS_BOOTSTRAP = `
(function () {
  window.__comixSiteChapters = null;
  var __comixHandle = function (holder) {
    try {
      if (window.__comixSiteChapters) return;
      var items = holder.items;
      var meta = holder.meta;
      if (!meta || typeof meta !== "object" || !Array.isArray(items)) return;
      if (items.length === 0 && meta.total !== 0) return;
      var chapters = items.every(function (item) {
        return item && typeof item.id === "number" && typeof item.number === "number" &&
          typeof item.url === "string";
      });
      if (!chapters) return;
      window.__comixSiteChapters = { items: items.slice(), meta: meta, at: Date.now() };
    } catch (e) {}
  };

  ${CAPTURE_ITEMS}
})();
`;

// After the title page's own first page: pages of 100, newest first, each at
// least CHAPTER_REQUEST_GAP_MS after the one before (the page's own included).
// A library refresh (`refresh`) only needs the newest page: the app merges
// chapters.
function buildChapterListInject(mangaId: string, refresh: boolean): string {
  const id = JSON.stringify(mangaId);
  return `
return (async function () {
  ${CHECK_HELPERS}
  var started = Date.now();
  var GAP = ${CHAPTER_REQUEST_GAP_MS};
  var done = function (items, via, pages, lastPage) {
    return JSON.stringify({ ok: true, items: items, via: via, pages: pages, lastPage: lastPage, frame: frame.seen });
  };

  // The title page's own newest chapters.
  while (!window.__comixSiteChapters && Date.now() - started < 8000) {
    if (blocked()) return cloudflareResult();
    if (stuck()) return checkResult();
    if (gated() && window.__comixAxios) break;
    await sleep(100);
  }
  var site = window.__comixSiteChapters;
  if (site) {
    var siteMeta = site.meta || {};
    var whole = (siteMeta.lastPage || 1) <= 1 ||
      (typeof siteMeta.total === "number" && site.items.length >= siteMeta.total);
    if (${refresh} || whole) return done(site.items, "page", 0, 1);
  }

  var deadline = started + 15000;
  while (!window.__comixAxios && Date.now() < deadline) {
    if (blocked()) return cloudflareResult();
    if (stuck()) return checkResult();
    await sleep(100);
  }
  var axios = window.__comixAxios;
  if (!axios) {
    if (check.seen) return checkResult();
    return JSON.stringify({ ok: false, status: 503, error: "comix's page didn't start (no API client after 15 s)" });
  }

  var path = "/manga/" + ${id} + "/chapters";
  var maxPages = ${refresh ? 1 : 1000};
  var chapters = [];
  var page = 1;
  var lastPage = 1;
  // The page's own request was just before its answer arrived.
  var lastRequest = site ? site.at : Date.now() - GAP + 1000;
  try {
    while (page <= lastPage && page <= maxPages) {
      while (Date.now() < lastRequest + GAP) {
        if (blocked()) return cloudflareResult();
        if (stuck()) return checkResult();
        await sleep(100);
      }
      lastRequest = Date.now();
      var resp = await orCheck(axios.get(path, { params: { page: page, limit: 100, "order[number]": "desc" } }));
      if (stopper(resp)) return stopper(resp);
      var data = resp.data || {};
      chapters = chapters.concat(data.items || []);
      var meta = data.meta || {};
      lastPage = meta.lastPage || page;
      page = page + 1;
    }
    return done(chapters, "api", page - 1, lastPage);
  } catch (e) {
    if (refused(e)) return checkResult();
    var resp2 = e && e.response;
    return JSON.stringify({
      ok: false,
      cloudflare: blocked(),
      check: check.seen,
      why: window.__comixCheckWhy || null,
      status: resp2 && resp2.status,
      error: String((e && e.message) || e),
    });
  }
})();
`;
}

// Load a manga's chapter list from the title page: what the page loads by
// itself first, then (only when there's more) the site's own API client, paced.
// `refresh` (a library update) reads only the newest page.
export async function chapterListViaWebView(
  mangaId: string,
  cookieInterceptor: CookieStorageInterceptor,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<ChapterItem[]> {
  const pageUrl = `${DOMAIN}/title/${mangaId}`;
  const started = Date.now();
  const result = parseInjectResult<{
    items: ChapterItem[];
    via: string;
    pages: number;
    lastPage: number;
    frame?: boolean;
  }>(
    await runProxiedWebView<unknown>(
      pageUrl,
      BOOTSTRAP_AXIOS + SITE_CHAPTERS_BOOTSTRAP,
      cookieInterceptor,
      {
        paced: true,
        inject: buildChapterListInject(mangaId, refresh),
        timeoutSeconds: 150,
        what: "loading the chapter list",
      },
    ),
  );

  if (!result.ok) {
    if (result.cloudflare) throw await cloudflareError(pageUrl, `chapter list of ${mangaId}`);
    if (result.check) throw await checkError(`chapter list of ${mangaId}`, result.why);
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
    const how =
      result.via === "page"
        ? "from the title page"
        : `${result.pages} of ${result.lastPage} pages, 3 s apart`;
    logEvent(
      "chapter list",
      `${mangaId}: ${result.items.length} chapters (${how}) in ${Math.round(
        (Date.now() - started) / 1000,
      )}s` + (result.frame ? ", comix showed its check frame (carried on)" : ""),
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
          finish({ __comixCheck: true, why: window.__comixCheckWhy || null });
        }
      }, 250);
      setTimeout(function () {
        finish(null);
      }, 20000);
    })();
  `;
  const result = await runProxiedWebView<
    (ResultManga & { __comixCheck?: boolean; __comixCloudflare?: boolean; why?: CheckWhy }) | null
  >(browseUrl, bootstrap, cookieInterceptor, {
    browse: true,
    timeoutSeconds: 45,
    what: "loading the list",
  });
  if (result?.__comixCloudflare) throw await cloudflareError(browseUrl, "list");
  if (result?.__comixCheck) throw await checkError("list", result.why);
  if (!result) {
    console.log(`[Comix] browse timed out for ${browseUrl}`);
    throw new Error("Comix browseViaWebView: timed out waiting for browse JSON");
  }
  return result;
}
