// Runs a Paperback 0.8 source inside the Paperback 0.9 app.
//
// scripts/crossport.mjs bundles this file (with cheerio 1.0.0-rc.12, the
// version 0.8 sources were written against) and puts the untouched 0.8
// `source.js` after it, so the result is an ordinary 0.9 extension:
//
//   - `App` (the 0.8 runtime: requests, state, settings rows, ...) is
//     rebuilt on 0.9's `Application`, given to the 0.8 code as a local
//     variable rather than a global
//   - `makeExtension()` wraps the 0.8 source in the 0.9 interfaces
//     (discover sections, search with filters, chapters, settings,
//     Cloudflare check)
//
// It starts from the compatibility layer that ships in @paperback/types
// (compat/0.8), with fixes: the 0.8 response interceptor runs (Cloudflare
// errors, image changes), home sections aren't listed twice, manga details
// keep authors, tags and covers, 0.8 select and stepper settings work, and
// cookies from the Cloudflare check are kept.

import {
  BasicRateLimiter,
  ButtonRow,
  closureSelector,
  CloudflareError,
  ContentRating,
  CookieStorageInterceptor,
  DiscoverSectionType,
  EndOfPageResults,
  Form,
  InputRow,
  LabelRow,
  NavigationRow,
  OAuthButtonRow,
  PaperbackInterceptor,
  Section,
  SelectRow,
  StepperRow,
  ToggleRow,
} from "@paperback/types";
import { SearchFilterForm } from "@paperback/types/lib/compat/0.8/searchFilters.js";
import * as cheerioModule from "cheerio-08";

const cheerio = cheerioModule.default ?? cheerioModule;

// ── Small helpers ────────────────────────────────────────────────────────

const log = (...parts) => {
  try {
    console.log(`[0.8 port] ${parts.join(" ")}`);
  } catch {
    // no console
  }
};

function utf8Encode(text) {
  const str = String(text);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        i++;
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

const isArrayBuffer = (value) => Object.prototype.toString.call(value) === "[object ArrayBuffer]";

function toArrayBuffer(value) {
  if (isArrayBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value).buffer;
  if (value && typeof value === "object" && typeof value.length === "number") {
    return Uint8Array.from(value).buffer;
  }
  return utf8Encode(value ?? "").buffer;
}

const utf8Decode = (buffer) => Application.arrayBufferToUTF8String(toArrayBuffer(buffer));

// 0.8's RawData: bytes you can index, with toString() giving the text.
function rawData(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(toArrayBuffer(bytes));
  Object.defineProperty(array, "toString", {
    value: () => utf8Decode(array),
    enumerable: false,
    configurable: true,
  });
  return array;
}

const hostOf = (url) =>
  (/^[a-z]+:\/\/([^/?#:]+)/i.exec(String(url ?? ""))?.[1] ?? "").toLowerCase();
const originOf = (url) => /^[a-z]+:\/\/[^/?#]+/i.exec(String(url ?? ""))?.[0] ?? "";

function toDate(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function fixCookie(cookie) {
  const copy = { ...cookie, value: String(cookie?.value ?? "") };
  if (copy.expires !== undefined && !(copy.expires instanceof Date)) {
    const date = toDate(copy.expires);
    if (date) copy.expires = date;
    else delete copy.expires;
  }
  if (!copy.domain) copy.domain = "";
  return copy;
}

// Header lookup without caring about case.
function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === wanted) return String(headers[key]);
  }
  return undefined;
}

const IMAGE_URL = /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:[?#]|$)/i;

// Flags some 0.8 sources use as language codes → ISO codes 0.9 expects.
const FLAG_LANGUAGES = {
  GB: "en",
  US: "en",
  FR: "fr",
  ES: "es",
  MX: "es",
  AR: "es",
  BR: "pt-br",
  PT: "pt",
  DE: "de",
  IT: "it",
  RU: "ru",
  JP: "ja",
  KR: "ko",
  CN: "zh",
  TW: "zh-hk",
  HK: "zh-hk",
  ID: "id",
  VN: "vi",
  TH: "th",
  TR: "tr",
  PL: "pl",
  SA: "ar",
  PH: "fil",
  NL: "nl",
  UA: "uk",
};
function languageCode(value) {
  const text = String(value ?? "").trim();
  if (!text) return "en";
  const points = Array.from(text, (ch) => ch.codePointAt(0));
  if (points.length === 2 && points.every((p) => p >= 0x1f1e6 && p <= 0x1f1ff)) {
    const country = String.fromCharCode(...points.map((p) => p - 0x1f1e6 + 65));
    return FLAG_LANGUAGES[country] ?? country.toLowerCase();
  }
  if (text === "_unknown" || text === "unknown") return "en";
  return text;
}

const CONTENT_RATINGS = {
  EVERYONE: ContentRating.EVERYONE,
  SAFE: ContentRating.EVERYONE,
  MATURE: ContentRating.MATURE,
  ADULT: ContentRating.ADULT,
};

// ── Requests ─────────────────────────────────────────────────────────────

function encodeBody(data, headers) {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string" || isArrayBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return toArrayBuffer(data);
  if (typeof data === "object") {
    const type = header(headers, "content-type") ?? "";
    if (type.includes("application/x-www-form-urlencoded")) {
      return Object.keys(data)
        .map((key) => `${key}=${data[key]}`)
        .join("&");
    }
    return JSON.stringify(data);
  }
  return String(data);
}

// 0.8 request → 0.9 request
function to09(request) {
  const cookies = {};
  for (const cookie of request?.cookies ?? []) {
    if (cookie?.name) cookies[cookie.name] = String(cookie.value ?? "");
  }
  const headers = { ...request?.headers };
  return {
    url: `${request?.url ?? ""}${request?.param ?? ""}`,
    method: String(request?.method ?? "GET").toUpperCase(),
    headers,
    body: encodeBody(request?.data, headers),
    cookies,
  };
}

// 0.9 request → 0.8 request
function to08(request) {
  const domain = hostOf(request.url);
  return {
    url: request.url,
    method: request.method ?? "GET",
    headers: { ...request.headers },
    data: request.body,
    cookies: Object.keys(request.cookies ?? {}).map((name) => ({
      name,
      value: request.cookies[name],
      domain,
    })),
  };
}

// A 0.8 Response whose text and bytes are made only when read, noting
// whether the 0.8 code replaced either.
function response08(request08, response, data) {
  let text;
  let raw;
  const state = { textSet: false, rawSet: false };
  const headers = { ...response.headers };
  for (const key of Object.keys(response.headers ?? {}))
    headers[key.toLowerCase()] = response.headers[key];
  const result = {
    status: response.status,
    headers,
    request: request08,
    get data() {
      if (text === undefined) text = utf8Decode(data);
      return text;
    },
    set data(value) {
      text = value;
      state.textSet = true;
    },
    get rawData() {
      if (raw === undefined) raw = rawData(new Uint8Array(data));
      return raw;
    },
    set rawData(value) {
      raw = value;
      state.rawSet = true;
    },
  };
  Object.defineProperty(result, "__changes", { value: state, enumerable: false });
  return result;
}

function changedData(result, original) {
  const state = result?.__changes;
  if (!state) {
    // A response the 0.8 code made itself
    if (result?.rawData) return toArrayBuffer(result.rawData);
    if (typeof result?.data === "string") return utf8Encode(result.data).buffer;
    return original;
  }
  if (state.rawSet) return toArrayBuffer(result.rawData);
  if (state.textSet) return utf8Encode(result.data).buffer;
  return original;
}

let cloudflareSource;

async function bypassRequest(request) {
  const legacy = cloudflareSource;
  try {
    if (legacy?.getCloudflareBypassRequestAsync) {
      return to09(await legacy.getCloudflareBypassRequestAsync());
    }
    if (legacy?.getCloudflareBypassRequest) return to09(legacy.getCloudflareBypassRequest());
  } catch (error) {
    log("couldn't get the Cloudflare check page:", error?.message ?? error);
  }
  return { url: `${originOf(request?.url)}/`, method: "GET" };
}

function looksLikeCloudflare(response) {
  const server = header(response.headers, "server") ?? "";
  return (
    /cloudflare/i.test(server) ||
    header(response.headers, "cf-mitigated") !== undefined ||
    (header(response.headers, "cf-ray") !== undefined &&
      /text\/html/i.test(header(response.headers, "content-type") ?? ""))
  );
}

const managers = [];

class LegacyBridge extends PaperbackInterceptor {
  constructor(id, legacyInterceptor) {
    super(id);
    this.legacyInterceptor = legacyInterceptor;
  }

  async interceptRequest(request) {
    if (!this.legacyInterceptor?.interceptRequest) return request;
    const before = to08(request);
    const after = to09((await this.legacyInterceptor.interceptRequest(before)) ?? before);
    // Changed in place as well as returned: some runtimes hand the next
    // interceptor the object they gave this one.
    request.url = after.url;
    request.method = after.method;
    request.headers = after.headers;
    request.body = after.body;
    request.cookies = after.cookies;
    return request;
  }

  async interceptResponse(request, response, data) {
    const isImage =
      IMAGE_URL.test(request.url) ||
      /^image\//i.test(header(response.headers, "content-type") ?? "");
    if (
      cloudflareSource &&
      !isImage &&
      (response.status === 403 || response.status === 503) &&
      looksLikeCloudflare(response)
    ) {
      throw new CloudflareError(await bypassRequest(request));
    }
    if (!this.legacyInterceptor?.interceptResponse) return data;
    const wrapped = response08(to08(request), response, data);
    let result;
    try {
      result = await this.legacyInterceptor.interceptResponse(wrapped);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (cloudflareSource && /cloudflare|bypass/i.test(message)) {
        throw new CloudflareError(await bypassRequest(request), message);
      }
      throw error;
    }
    return changedData(result ?? wrapped, data);
  }
}

function createRequestManager(info = {}) {
  const n = managers.length;
  const suffix = n === 0 ? "" : `_${n}`;
  const bridge = new LegacyBridge(`legacy${suffix}`, info.interceptor);
  const cookieStore = new CookieStorageInterceptor({ storage: "stateManager" });
  if (suffix) cookieStore.id = `cookie_store${suffix}`;
  const rateLimiter = new BasicRateLimiter(`rateLimit${suffix}`, {
    numberOfRequests: Math.max(1, Math.round(info.requestsPerSecond ?? 3)),
    bufferInterval: 1,
    ignoreImages: true,
  });
  // Requests pass these in order, responses in reverse: the 0.8 interceptor
  // sees the request first and the response last, as in 0.8.
  bridge.registerInterceptor();
  cookieStore.registerInterceptor();
  rateLimiter.registerInterceptor();

  const manager = {
    interceptor: info.interceptor,
    requestsPerSecond: info.requestsPerSecond ?? 3,
    requestTimeout: info.requestTimeout ?? 20_000,
    cookieStore: {
      getAllCookies: () => [...cookieStore.cookies],
      addCookie: (cookie) => cookieStore.setCookie(fixCookie(cookie)),
      removeCookie: (cookie) => cookieStore.deleteCookie(fixCookie(cookie)),
    },
    // The app only holds interceptors weakly, so they live here.
    __cookieStore: cookieStore,
    __bridge: bridge,
    __rateLimiter: rateLimiter,
    getDefaultUserAgent: () => Application.getDefaultUserAgent(),
    async schedule(request, retries = 1) {
      const outgoing = to09(request);
      let attempt = 0;
      for (;;) {
        try {
          const [response, data] = await Application.scheduleRequest(outgoing);
          return response08(request, response, data);
        } catch (error) {
          if (error?.type === "cloudflareError" || attempt >= Math.min(Number(retries) || 0, 2)) {
            throw error;
          }
          attempt++;
        }
      }
    },
  };
  managers.push(manager);
  return manager;
}

// ── App: the 0.8 runtime ─────────────────────────────────────────────────

const DUI_ALIASES = {
  createSection: "DUISection",
  createButton: "DUIButton",
  createHeader: "DUIHeader",
  createInputField: "DUIInputField",
  createLabel: "DUILabel",
  createLink: "DUILink",
  createMultilineLabel: "DUIMultilineLabel",
  createNavigationButton: "DUINavigationButton",
  createOAuthButton: "DUIOAuthButton",
  createSecureInputField: "DUISecureInputField",
  createSelect: "DUISelect",
  createStepper: "DUIStepper",
  createSwitch: "DUISwitch",
};

function typed(info, type) {
  const object = info ?? {};
  Object.defineProperty(object, "type", {
    value: type,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return object;
}

const notAvailable = (what) => () => {
  throw new Error(`${what} isn't available to 0.8 sources on Paperback 0.9`);
};

const appBase = {
  createRequestManager,
  createSourceStateManager() {
    return {
      keychain: {
        async store(key, value) {
          Application.setSecureState(value, key);
        },
        async retrieve(key) {
          return Application.getSecureState(key);
        },
      },
      async store(key, value) {
        Application.setState(value, key);
      },
      async retrieve(key) {
        return Application.getState(key);
      },
    };
  },
  createRawData: (info) => rawData(info?.byteArray ?? []),
  createByteArray: (raw) => (raw instanceof Uint8Array ? raw : new Uint8Array(toArrayBuffer(raw))),
  createRequest: (info) => ({
    ...info,
    method: info?.method ?? "GET",
    headers: info?.headers ?? {},
    cookies: info?.cookies ?? [],
  }),
  createCookie: (info) => fixCookie(info),
  createHomeSection: (info) => ({ ...info, items: info?.items ?? [] }),
  createPagedResults: (info) => ({ ...info, results: info?.results ?? [] }),
  createTagSection: (info) => ({ ...info, tags: info?.tags ?? [] }),
  createMangaInfo: (info) => ({ titles: [], tags: [], ...info }),
  createPBCanvas: notAvailable("Image editing (PBCanvas)"),
  createPBImage: notAvailable("Image editing (PBImage)"),
};

export const App = new Proxy(appBase, {
  get(target, name) {
    if (name in target) return target[name];
    if (typeof name !== "string") return undefined;
    if (DUI_ALIASES[name]) return (info) => typed(info, DUI_ALIASES[name]);
    if (name.startsWith("createDUI")) return (info) => typed(info, name.slice(6));
    if (name.startsWith("create")) return (info) => info ?? {};
    return undefined;
  },
});

// ── Settings: 0.8 DUI forms shown as 0.9 forms ──────────────────────────

class DuiForm extends Form {
  constructor(duiForm) {
    super();
    this.dui = duiForm;
    this.sections = undefined;
    this.error = undefined;
    this.values = {};
    this.labels = {};
    this.requiresExplicitSubmission = typeof duiForm?.onSubmit === "function";
  }

  formWillAppear() {
    this.refresh();
  }

  refresh() {
    Promise.resolve()
      .then(() => this.dui.sections())
      .then(async (sections) => {
        const built = [];
        for (const section of sections ?? []) {
          const rows =
            typeof section?._rows === "function" ? await section._rows() : await section.rows();
          built.push({
            id: section.id,
            header: section.header,
            footer: section.footer,
            isHidden: section.isHidden,
            rows: (rows ?? []).filter(Boolean),
          });
        }
        for (const section of built) {
          for (const row of section.rows) {
            if (row.value && typeof row.value.get === "function") {
              try {
                this.values[row.id] = await row.value.get();
              } catch (error) {
                log(`setting ${row.id}:`, error?.message ?? error);
              }
            }
            if (row.type === "DUISelect" && typeof row.labelResolver === "function") {
              this.labels[row.id] = await Promise.all(
                (row.options ?? []).map((option) =>
                  Promise.resolve(row.labelResolver(option)).catch(() => option),
                ),
              );
            }
          }
        }
        this.sections = built;
        this.error = undefined;
        this.reloadForm();
      })
      .catch((error) => {
        this.error = error;
        this.reloadForm();
      });
  }

  getSections() {
    if (!this.sections) {
      return [
        Section("loading", [
          LabelRow("loading", {
            title: this.error ? "Couldn't load these settings" : "Loading…",
            subtitle: this.error ? String(this.error?.message ?? this.error) : undefined,
          }),
        ]),
      ];
    }
    return this.sections
      .filter((section) => !section.isHidden)
      .map((section) =>
        Section(
          { id: section.id, header: section.header, footer: section.footer },
          section.rows.map((row) => this.row(row)),
        ),
      );
  }

  setter(row, key, after) {
    return closureSelector(this, `${key}_${row.id}`, async (value) => {
      this.values[row.id] = value;
      await row.value.set(value);
      if (after) after();
      this.reloadForm();
    });
  }

  row(row) {
    const id = String(row.id ?? "row");
    switch (row.type) {
      case "DUIHeader":
        return LabelRow(id, { title: row.title ?? "", subtitle: row.subtitle });
      case "DUILabel":
      case "DUIMultilineLabel":
      case "DUILink":
        return LabelRow(id, { title: row.label ?? "", subtitle: row.value });
      case "DUIButton":
        return ButtonRow(id, {
          title: row.label ?? "",
          onSelect: closureSelector(this, `tap_${id}`, async () => {
            await row.onTap?.();
            this.refresh();
          }),
        });
      case "DUIInputField":
      case "DUISecureInputField":
        return InputRow(id, {
          title: row.label ?? "",
          value: String(this.values[id] ?? ""),
          isSecureEntry: row.type === "DUISecureInputField",
          onValueChange: this.setter(row, "input"),
        });
      case "DUISwitch":
        return ToggleRow(id, {
          title: row.label ?? "",
          value: Boolean(this.values[id]),
          onValueChange: this.setter(row, "toggle"),
        });
      case "DUIStepper":
        return StepperRow(id, {
          title: row.label ?? "",
          value: Number(this.values[id] ?? row.min ?? 0),
          minValue: row.min ?? 0,
          maxValue: row.max ?? 100,
          stepValue: row.step ?? 1,
          loopOver: false,
          onValueChange: this.setter(row, "stepper"),
        });
      case "DUISelect": {
        const options = (row.options ?? []).map((option, i) => ({
          id: String(option),
          title: String(this.labels[id]?.[i] ?? option),
        }));
        const current = [].concat(this.values[id] ?? []).map(String);
        const value = current.filter((v) => options.some((o) => o.id === v));
        const multi = Boolean(row.allowsMultiselect) && options.length > 1;
        return SelectRow(id, {
          title: row.label ?? "",
          value,
          minItemCount: multi || value.length === 0 ? 0 : 1,
          maxItemCount: multi ? options.length : 1,
          options,
          onValueChange: this.setter(row, "select"),
        });
      }
      case "DUINavigationButton":
        return NavigationRow(id, { title: row.label ?? "", form: new DuiForm(row.form) });
      case "DUIOAuthButton":
        return OAuthButtonRow(id, {
          title: row.label ?? "",
          authorizeEndpoint: row.authorizeEndpoint,
          clientId: row.clientId,
          responseType: row.responseType,
          redirectUri: row.redirectUri,
          scopes: row.scopes,
          onSuccess: closureSelector(this, `oauth_${id}`, async (first, second) => {
            await row.successHandler?.(first, second);
            this.refresh();
          }),
        });
      default:
        return LabelRow(id, {
          title: "Setting not available on 0.9",
          subtitle: String(row.type ?? ""),
        });
    }
  }

  async formDidSubmit() {
    await this.dui.onSubmit?.(this.values);
  }
}

// ── The 0.9 extension ────────────────────────────────────────────────────

const SECTION_TYPES = {
  featured: [DiscoverSectionType.featured, "featuredCarouselItem"],
  singleRowLarge: [DiscoverSectionType.prominentCarousel, "prominentCarouselItem"],
};
const sectionType = (type) =>
  SECTION_TYPES[type] ?? [DiscoverSectionType.simpleCarousel, "simpleCarouselItem"];

const HOME_KEEP_MS = 5 * 60_000;

class PortedExtension {
  constructor(loadSources, meta) {
    this.loadSources = loadSources;
    this.meta = meta;
    this.home = undefined;
    this.tagLabels = new Map();
    this.sections = new Map();
  }

  get legacy() {
    if (!this._legacy) {
      const sources = this.loadSources();
      const LegacySource =
        sources?.[this.meta.id] ??
        Object.values(sources ?? {}).find((value) => typeof value === "function");
      if (typeof LegacySource !== "function") {
        throw new Error(`0.8 source ${this.meta.id} not found in its bundle`);
      }
      this._legacy = new LegacySource(cheerio);
      if (
        this.meta.cloudflare ||
        typeof this._legacy.getCloudflareBypassRequestAsync === "function" ||
        typeof this._legacy.getCloudflareBypassRequest === "function"
      ) {
        cloudflareSource = this._legacy;
      }
    }
    return this._legacy;
  }

  // Build-time check (scripts/crossport.mjs): which 0.8 methods exist.
  __describe() {
    const methods = new Set();
    for (
      let proto = this.legacy;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (typeof this.legacy[name] === "function") methods.add(name);
      }
    }
    return [...methods];
  }

  async initialise() {
    void this.legacy;
  }

  // ── Manga ──

  async getMangaDetails(mangaId) {
    const manga = await this.legacy.getMangaDetails(mangaId);
    const info = manga?.mangaInfo ?? {};
    const titles = (info.titles ?? []).map((title) => String(title ?? "")).filter(Boolean);
    let shareUrl;
    try {
      shareUrl = this.legacy.getMangaShareUrl?.(mangaId);
    } catch {
      shareUrl = undefined;
    }
    const tagGroups = (info.tags ?? [])
      .filter((group) => group && (group.tags ?? []).length > 0)
      .map((group) => ({
        id: String(group.id ?? group.label ?? "tags"),
        title: String(group.label ?? group.id ?? "Tags"),
        tags: group.tags.map((tag) => ({ id: String(tag.id), title: String(tag.label ?? tag.id) })),
      }));
    return {
      mangaId,
      mangaInfo: {
        primaryTitle: titles[0] ?? mangaId,
        secondaryTitles: titles.slice(1),
        thumbnailUrl: info.image ?? "",
        synopsis: info.desc ?? "",
        status: info.status,
        author: info.author || undefined,
        artist: info.artist || undefined,
        bannerUrl: info.banner || undefined,
        rating: typeof info.rating === "number" ? info.rating : undefined,
        tagGroups,
        artworkUrls: info.covers?.length ? info.covers : undefined,
        additionalInfo: info.additionalInfo,
        contentRating: info.hentai
          ? ContentRating.ADULT
          : (CONTENT_RATINGS[this.meta.contentRating] ?? ContentRating.EVERYONE),
        shareUrl: shareUrl || undefined,
      },
    };
  }

  async getChapters(sourceManga) {
    const chapters = await this.legacy.getChapters(sourceManga.mangaId);
    return (chapters ?? []).filter(Boolean).map((chapter) => {
      const number = Number(chapter.chapNum);
      const volume = Number(chapter.volume);
      return {
        chapterId: String(chapter.id),
        sourceManga,
        langCode: languageCode(chapter.langCode),
        chapNum: Number.isFinite(number) ? number : 0,
        title: chapter.name ? String(chapter.name) : undefined,
        version: chapter.group ? String(chapter.group) : undefined,
        volume: Number.isFinite(volume) && volume > 0 ? volume : undefined,
        publishDate: toDate(chapter.time),
        sortingIndex: chapter.sortingIndex,
      };
    });
  }

  async getChapterDetails(chapter) {
    const details = await this.legacy.getChapterDetails(
      chapter.sourceManga.mangaId,
      chapter.chapterId,
    );
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: (details?.pages ?? []).map(String),
    };
  }

  // ── Discover ──

  // The 0.8 app shows home sections as they come in, so some 0.8 sources
  // never finish getHomePageSections (the MangaStream template awaits
  // promises that never resolve). Done when it finishes, when every section
  // it announced has items, or when nothing new came for a few seconds.
  loadHome() {
    if (this.home && Date.now() - this.home.at < HOME_KEEP_MS) return this.home.promise;
    const sections = new Map();
    let lastNews = Date.now();
    let finish;
    const allFilled = () =>
      sections.size > 0 &&
      [...sections.values()].every((section) => (section.items ?? []).length > 0);
    const done = new Promise((resolve, reject) => {
      finish = { resolve, reject };
    });
    let settled = false;
    const end = (error) => {
      if (settled) return;
      settled = true;
      // An error (Cloudflare's check, say) after the sections were announced
      // but before any had manga is still an error: the app shows it.
      const anyItems = [...sections.values()].some((section) => (section.items ?? []).length > 0);
      if (error && !anyItems) finish.reject(error);
      else finish.resolve(sections);
    };
    Promise.resolve()
      .then(() =>
        this.legacy.getHomePageSections((section) => {
          if (!section?.id) return;
          const before = sections.get(section.id);
          sections.set(section.id, {
            ...before,
            ...section,
            items: section.items?.length ? [...section.items] : (before?.items ?? []),
          });
          lastNews = Date.now();
          if (allFilled()) void Promise.resolve().then(() => end());
        }),
      )
      .then(
        () => end(),
        (error) => end(error),
      );
    void (async () => {
      const started = Date.now();
      while (!settled) {
        await Application.sleep(0.5);
        const quiet = Date.now() - lastNews;
        if ((sections.size > 0 && quiet > 4000) || Date.now() - started > 90_000) end();
      }
    })();
    const promise = done;
    const entry = { at: Date.now(), promise };
    this.home = entry;
    promise.catch(() => {
      if (this.home === entry) this.home = undefined;
    });
    return promise;
  }

  async getDiscoverSections() {
    if (typeof this.legacy.getHomePageSections !== "function") return [];
    const sections = await this.loadHome();
    return [...sections.values()].map((section) => {
      this.sections.set(section.id, section.type);
      return {
        id: section.id,
        title: String(section.title ?? section.id),
        type: sectionType(section.type)[0],
      };
    });
  }

  item(manga, kind) {
    return {
      type: kind,
      mangaId: String(manga.mangaId ?? manga.id),
      title: String(manga.title ?? ""),
      subtitle: manga.subtitle,
      imageUrl: manga.image ?? "",
    };
  }

  async getDiscoverSectionItems(section, metadata) {
    const kind = sectionType(this.sections.get(section.id))[1];
    const canPage = typeof this.legacy.getViewMoreItems === "function";
    if (metadata && typeof metadata === "object" && metadata.__v8home) {
      const seen = new Set(metadata.seen ?? []);
      const page = await this.legacy.getViewMoreItems(section.id, metadata.page ?? null);
      const results = (page?.results ?? []).filter(
        (manga) => manga && !seen.has(String(manga.mangaId)),
      );
      const more =
        (page?.results?.length ?? 0) > 0 && page?.metadata !== undefined && page?.metadata !== null;
      return {
        items: results.map((manga) => this.item(manga, kind)),
        metadata: more ? { __v8home: 1, page: page.metadata, seen: metadata.seen } : undefined,
      };
    }
    const sections = await this.loadHome();
    const cached = sections.get(section.id);
    if (!cached || (cached.items ?? []).length === 0) {
      if (!canPage) return EndOfPageResults;
      return this.getDiscoverSectionItems(section, { __v8home: 1, page: null, seen: [] });
    }
    const items = cached.items.filter(Boolean).map((manga) => this.item(manga, kind));
    return {
      items,
      metadata:
        cached.containsMoreItems && canPage
          ? { __v8home: 1, page: null, seen: items.map((item) => item.mangaId).slice(0, 300) }
          : undefined,
    };
  }

  // ── Search ──

  async getSearchFilters() {
    const filters = [];
    const tagSections = this.legacy.getSearchTags
      ? await this.legacy.getSearchTags()
      : this.legacy.getTags
        ? await this.legacy.getTags()
        : [];
    const excludes = this.legacy.supportsTagExclusion
      ? Boolean(await this.legacy.supportsTagExclusion().catch(() => false))
      : false;
    for (const group of tagSections ?? []) {
      if (!group || !(group.tags ?? []).length) continue;
      for (const tag of group.tags) this.tagLabels.set(String(tag.id), String(tag.label ?? tag.id));
      filters.push({
        id: String(group.id),
        title: String(group.label ?? group.id),
        type: "multiselect",
        options: group.tags.map((tag) => ({
          id: String(tag.id),
          value: String(tag.label ?? tag.id),
        })),
        value: {},
        allowExclusion: excludes,
        allowEmptySelection: true,
        maximum: undefined,
      });
    }
    const fields = this.legacy.getSearchFields ? await this.legacy.getSearchFields() : [];
    for (const field of fields ?? []) {
      filters.push({
        id: String(field.id),
        title: String(field.name ?? field.id),
        type: "input",
        placeholder: String(field.placeholder ?? ""),
        value: "",
      });
    }
    return filters;
  }

  async getAdvancedSearchForm(query) {
    return new SearchFilterForm(query.metadata, this.getSearchFilters());
  }

  async getSearchResults(query, metadata) {
    const legacyQuery = {
      title: query?.title ?? "",
      includedTags: [],
      excludedTags: [],
      includeOperator: "AND",
      excludeOperator: "OR",
      parameters: {},
    };
    for (const filter of Array.isArray(query?.metadata) ? query.metadata : []) {
      if (typeof filter?.value === "string") {
        if (filter.value) legacyQuery.parameters[filter.id] = filter.value;
      } else if (filter?.value && typeof filter.value === "object") {
        for (const [id, state] of Object.entries(filter.value)) {
          const tag = { id, label: this.tagLabels.get(id) ?? id };
          (state === "excluded" ? legacyQuery.excludedTags : legacyQuery.includedTags).push(tag);
        }
      }
    }
    const search = this.legacy.getSearchResults ?? this.legacy.searchRequest;
    const page = await search.call(this.legacy, legacyQuery, metadata ?? {});
    const items = (page?.results ?? []).filter(Boolean).map((manga) => ({
      mangaId: String(manga.mangaId ?? manga.id),
      title: String(manga.title ?? ""),
      subtitle: manga.subtitle,
      imageUrl: manga.image ?? "",
    }));
    const more = items.length > 0 && page?.metadata !== undefined && page?.metadata !== null;
    return { items, metadata: more ? page.metadata : undefined };
  }

  // ── Settings ──

  async getSettingsForm() {
    if (typeof this.legacy.getSourceMenu !== "function") {
      throw new Error("This source has no settings");
    }
    const section = await this.legacy.getSourceMenu();
    return new DuiForm({ sections: async () => [section] });
  }

  // ── Cloudflare ──

  async saveCloudflareBypassCookies(cookies) {
    for (const manager of managers) {
      for (const cookie of cookies ?? []) manager.__cookieStore.setCookie(fixCookie(cookie));
    }
  }

  async cloudflareBypassCompleted(_request, cookies) {
    await this.saveCloudflareBypassCookies(cookies);
  }
}

export function makeExtension(loadSources, meta) {
  return new PortedExtension(loadSources, meta);
}

// Browser bits some 0.8 bundles reach for, in case the 0.9 app has none.
const root = typeof globalThis === "object" && globalThis ? globalThis : {};
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

class TextDecoderPolyfill {
  constructor(label = "utf-8") {
    this.encoding = String(label).toLowerCase();
  }
  decode(input) {
    if (input === undefined) return "";
    return utf8Decode(input);
  }
}

class TextEncoderPolyfill {
  get encoding() {
    return "utf-8";
  }
  encode(text = "") {
    return utf8Encode(text);
  }
}

function safeConsole(native) {
  const out = {};
  for (const method of ["log", "info", "warn", "error", "debug", "trace"]) {
    out[method] = (...parts) => {
      try {
        const fn = typeof native?.[method] === "function" ? native[method] : native?.log;
        fn?.apply(native, parts);
      } catch {
        // nowhere to log
      }
    };
  }
  return out;
}

export const globals = {
  console: safeConsole(root.console),
  TextDecoder: typeof root.TextDecoder === "function" ? root.TextDecoder : TextDecoderPolyfill,
  TextEncoder: typeof root.TextEncoder === "function" ? root.TextEncoder : TextEncoderPolyfill,
  atob:
    typeof root.atob === "function"
      ? root.atob
      : (text) => {
          const clean = String(text).replace(/[\s=]/g, "");
          let bits = 0;
          let value = 0;
          let out = "";
          for (const ch of clean) {
            const v = B64.indexOf(ch);
            if (v < 0) continue;
            value = (value << 6) | v;
            bits += 6;
            if (bits >= 8) {
              bits -= 8;
              out += String.fromCharCode((value >> bits) & 255);
            }
          }
          return out;
        },
  btoa:
    typeof root.btoa === "function"
      ? root.btoa
      : (text) => {
          const s = String(text);
          let out = "";
          for (let i = 0; i < s.length; i += 3) {
            const a = s.charCodeAt(i) & 255;
            const b = i + 1 < s.length ? s.charCodeAt(i + 1) & 255 : 0;
            const c = i + 2 < s.length ? s.charCodeAt(i + 2) & 255 : 0;
            const n = (a << 16) | (b << 8) | c;
            out +=
              B64[(n >> 18) & 63] +
              B64[(n >> 12) & 63] +
              (i + 1 < s.length ? B64[(n >> 6) & 63] : "=") +
              (i + 2 < s.length ? B64[n & 63] : "=");
          }
          return out;
        },
  setTimeout:
    typeof root.setTimeout === "function"
      ? root.setTimeout
      : (fn, ms, ...args) => {
          void Application.sleep(Math.max(0, Number(ms) || 0) / 1000).then(() => fn(...args));
          return 0;
        },
  clearTimeout: typeof root.clearTimeout === "function" ? root.clearTimeout : () => {},
};
