// Runs a Paperback 0.9 extension inside the Paperback 0.8 app.
//
// scripts/crossport.mjs bundles this file and puts the untouched 0.9
// `index.js` after it, so the result is an ordinary 0.8 `source.js`:
//
//   - `Application` (the 0.9 runtime: requests, interceptors, state,
//     selectors, ...) is rebuilt on 0.8's `App`, given to the 0.9 code as a
//     local variable, with `crypto`, `TextDecoder`, `atob` and friends where
//     the 0.8 app has none
//   - `makeSourceClass()` is the 0.8 Source class that forwards to the 0.9
//     extension: home sections, search with tags, chapters, settings (0.9
//     forms shown as 0.8 rows) and the Cloudflare check
//
// 0.9 state is synchronous (`Application.getState`), 0.8's is not, so the
// saved state is read first and the 0.9 code only starts after that.

import { cbc, ctr, gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { decodeHTML } from "entities";

const root = typeof globalThis === "object" && globalThis ? globalThis : {};

const nativeConsole = root.console;
const log = (...parts) => {
  try {
    nativeConsole?.log?.(`[0.9 port] ${parts.join(" ")}`);
  } catch {
    // no console
  }
};

// ── Bytes and text ───────────────────────────────────────────────────────

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

function utf8Decode(bytes, fatal = false) {
  const b = bytes;
  let out = "";
  let chunk = [];
  const flush = () => {
    out += String.fromCharCode.apply(null, chunk);
    chunk = [];
  };
  for (let i = 0; i < b.length;) {
    const c = b[i];
    let cp = 0xfffd;
    let size = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c < 0xe0 && i + 1 < b.length && (b[i + 1] & 0xc0) === 0x80) {
      cp = ((c & 0x1f) << 6) | (b[i + 1] & 0x3f);
      size = 2;
    } else if (
      c >= 0xe0 &&
      c < 0xf0 &&
      i + 2 < b.length &&
      (b[i + 1] & 0xc0) === 0x80 &&
      (b[i + 2] & 0xc0) === 0x80
    ) {
      cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
      size = 3;
      if (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000)) cp = 0xfffd;
    } else if (
      c >= 0xf0 &&
      c < 0xf5 &&
      i + 3 < b.length &&
      (b[i + 1] & 0xc0) === 0x80 &&
      (b[i + 2] & 0xc0) === 0x80 &&
      (b[i + 3] & 0xc0) === 0x80
    ) {
      cp =
        ((c & 0x07) << 18) |
        ((b[i + 1] & 0x3f) << 12) |
        ((b[i + 2] & 0x3f) << 6) |
        (b[i + 3] & 0x3f);
      size = 4;
      if (cp < 0x10000 || cp > 0x10ffff) cp = 0xfffd;
    }
    if (cp === 0xfffd && fatal && !(c === 0xef && b[i + 1] === 0xbf && b[i + 2] === 0xbd)) {
      throw new TypeError("invalid utf-8");
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else chunk.push(cp);
    if (chunk.length > 8000) flush();
    i += size;
  }
  flush();
  return out;
}

const isArrayBuffer = (value) => Object.prototype.toString.call(value) === "[object ArrayBuffer]";

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (isArrayBuffer(value)) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === "object" && typeof value.length === "number")
    return Uint8Array.from(value);
  return utf8Encode(value ?? "");
}

const bufferOf = (value) => {
  const bytes = bytesOf(value);
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64FromBytes(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      B64[(n >> 18) & 63] +
      B64[(n >> 12) & 63] +
      (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") +
      (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}
function bytesFromBase64(text) {
  const clean = String(text).replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let j = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >> bits) & 255;
    }
  }
  return out.subarray(0, j);
}

// Strings the 0.8 app already decoded, so the 0.9 code reading the same
// bytes back as text doesn't decode them twice.
const knownText = typeof WeakMap === "function" ? new WeakMap() : undefined;

// ── Globals the 0.8 app may not have ─────────────────────────────────────

class TextDecoderPolyfill {
  constructor(label = "utf-8", options = {}) {
    this.encoding = String(label).toLowerCase();
    this.fatal = Boolean(options.fatal);
  }
  decode(input) {
    if (input === undefined) return "";
    const bytes = bytesOf(input);
    if (this.encoding === "ascii" || this.encoding === "latin1" || this.encoding === "iso-8859-1") {
      let out = "";
      for (let i = 0; i < bytes.length; i += 8000) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8000));
      }
      return out;
    }
    return utf8Decode(bytes, this.fatal);
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

function randomBytes(length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

const HASHES = { "SHA-1": sha1, "SHA-256": sha256, "SHA-384": sha384, "SHA-512": sha512, MD5: md5 };
const hashOf = (name) => {
  const fn = HASHES[String(typeof name === "object" ? name?.name : name).toUpperCase()];
  if (!fn) throw new Error(`Unsupported hash: ${String(name?.name ?? name)}`);
  return fn;
};
const algorithmName = (algorithm) =>
  String(typeof algorithm === "string" ? algorithm : algorithm?.name).toUpperCase();

class CryptoKeyPolyfill {
  constructor(raw, algorithm, extractable, usages) {
    this.type = "secret";
    this.algorithm = typeof algorithm === "string" ? { name: algorithm } : { ...algorithm };
    this.extractable = Boolean(extractable);
    this.usages = [...(usages ?? [])];
    Object.defineProperty(this, "_raw", { value: raw, enumerable: false });
  }
}

const subtle = {
  async digest(algorithm, data) {
    return bufferOf(hashOf(algorithmName(algorithm))(bytesOf(data)));
  },
  async importKey(format, keyData, algorithm, extractable, usages) {
    const raw = format === "jwk" ? bytesFromBase64(keyData.k ?? "") : bytesOf(keyData);
    return new CryptoKeyPolyfill(raw, algorithm, extractable, usages);
  },
  async exportKey(format, key) {
    if (format === "jwk") {
      return {
        kty: "oct",
        k: base64FromBytes(key._raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      };
    }
    return bufferOf(key._raw);
  },
  async generateKey(algorithm, extractable, usages) {
    const length = algorithm?.length ? algorithm.length / 8 : 32;
    return new CryptoKeyPolyfill(randomBytes(length), algorithm, extractable, usages);
  },
  async sign(algorithm, key, data) {
    const hash = hashOf(key.algorithm?.hash ?? algorithm?.hash ?? "SHA-256");
    return bufferOf(hmac(hash, key._raw, bytesOf(data)));
  },
  async verify(algorithm, key, signature, data) {
    const expected = bytesOf(await subtle.sign(algorithm, key, data));
    const given = bytesOf(signature);
    return expected.length === given.length && expected.every((b, i) => b === given[i]);
  },
  async encrypt(algorithm, key, data) {
    return bufferOf(cipherFor(algorithm, key).encrypt(bytesOf(data)));
  },
  async decrypt(algorithm, key, data) {
    return bufferOf(cipherFor(algorithm, key).decrypt(bytesOf(data)));
  },
  async deriveBits(algorithm, key, length) {
    const name = algorithmName(algorithm);
    const bytes = length / 8;
    if (name === "PBKDF2") {
      return bufferOf(
        pbkdf2(hashOf(algorithm.hash), key._raw, bytesOf(algorithm.salt), {
          c: algorithm.iterations,
          dkLen: bytes,
        }),
      );
    }
    if (name === "HKDF") {
      return bufferOf(
        hkdf(
          hashOf(algorithm.hash),
          key._raw,
          bytesOf(algorithm.salt ?? []),
          bytesOf(algorithm.info ?? []),
          bytes,
        ),
      );
    }
    throw new Error(`Unsupported key derivation: ${name}`);
  },
  async deriveKey(algorithm, key, derivedAlgorithm, extractable, usages) {
    const length = derivedAlgorithm?.length ?? 256;
    const bits = await subtle.deriveBits(algorithm, key, length);
    return new CryptoKeyPolyfill(new Uint8Array(bits), derivedAlgorithm, extractable, usages);
  },
};

function cipherFor(algorithm, key) {
  switch (algorithmName(algorithm)) {
    case "AES-GCM":
      return gcm(
        key._raw,
        bytesOf(algorithm.iv),
        algorithm.additionalData ? bytesOf(algorithm.additionalData) : undefined,
      );
    case "AES-CBC":
      return cbc(key._raw, bytesOf(algorithm.iv));
    case "AES-CTR":
      return ctr(key._raw, bytesOf(algorithm.counter));
    default:
      throw new Error(`Unsupported cipher: ${algorithmName(algorithm)}`);
  }
}

const cryptoPolyfill = {
  subtle,
  getRandomValues(array) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    bytes.set(randomBytes(bytes.length));
    return array;
  },
  randomUUID() {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
  },
};

// A console with every method, whatever the app gives (0.8 may only have log).
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

// Timers: 0.8 has none, so a wait ends straight away (the 0.8 app spaces
// requests out itself).
const fallbackSetTimeout = (fn, _ms, ...args) => {
  void Promise.resolve().then(() => fn(...args));
  return 0;
};
const fallbackClearTimeout = () => {};

export const globals = {
  TextDecoder: typeof root.TextDecoder === "function" ? root.TextDecoder : TextDecoderPolyfill,
  TextEncoder: typeof root.TextEncoder === "function" ? root.TextEncoder : TextEncoderPolyfill,
  crypto: root.crypto?.subtle ? root.crypto : cryptoPolyfill,
  atob:
    typeof root.atob === "function"
      ? root.atob
      : (text) => String.fromCharCode(...bytesFromBase64(text)),
  btoa:
    typeof root.btoa === "function"
      ? root.btoa
      : (text) => base64FromBytes(Uint8Array.from(String(text), (ch) => ch.charCodeAt(0) & 255)),
  setTimeout: typeof root.setTimeout === "function" ? root.setTimeout : fallbackSetTimeout,
  clearTimeout: typeof root.clearTimeout === "function" ? root.clearTimeout : fallbackClearTimeout,
  console: safeConsole(nativeConsole),
};
for (const name of ["TextDecoder", "TextEncoder", "crypto", "atob", "btoa"]) {
  if (root[name] === undefined) {
    try {
      root[name] = globals[name];
    } catch {
      // read-only global
    }
  }
}

// ── State (0.8 keeps it asynchronously; 0.9 reads it synchronously) ──────

const STATE_KEY = "pb09_state";
const SECURE_KEY = "pb09_secure";
const store = { data: {}, secure: {} };
let stateManager;
const getStateManager = () => (stateManager ??= App.createSourceStateManager());

function serialize(value) {
  return JSON.stringify(value, function (key, item) {
    const raw = this[key];
    if (Object.prototype.toString.call(raw) === "[object Date]") {
      return Number.isNaN(raw.getTime()) ? null : { $date: raw.toISOString() };
    }
    if (isArrayBuffer(raw)) return { $bytes: base64FromBytes(new Uint8Array(raw)) };
    return item;
  });
}
function deserialize(text) {
  if (typeof text !== "string" || !text) return {};
  try {
    return JSON.parse(text, (_key, item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const keys = Object.keys(item);
        if (keys.length === 1 && typeof item.$date === "string") return new Date(item.$date);
        if (keys.length === 1 && typeof item.$bytes === "string")
          return bufferOf(bytesFromBase64(item.$bytes));
      }
      return item;
    });
  } catch {
    return {};
  }
}

let loadPromise;
function loadState() {
  loadPromise ??= (async () => {
    const manager = getStateManager();
    try {
      store.data = deserialize(await manager.retrieve(STATE_KEY)) ?? {};
    } catch (error) {
      log("couldn't read saved settings:", error?.message ?? error);
    }
    try {
      store.secure = deserialize(await manager.keychain?.retrieve(SECURE_KEY)) ?? {};
    } catch {
      store.secure = {};
    }
  })();
  return loadPromise;
}

function persister(key, secure) {
  let running;
  let dirty = false;
  return () => {
    dirty = true;
    if (running) return;
    running = (async () => {
      while (dirty) {
        dirty = false;
        try {
          const manager = getStateManager();
          const text = serialize(secure ? store.secure : store.data);
          await (secure ? manager.keychain.store(key, text) : manager.store(key, text));
        } catch (error) {
          log("couldn't save settings:", error?.message ?? error);
        }
      }
      running = undefined;
    })();
  };
}
const saveState = persister(STATE_KEY, false);
const saveSecure = persister(SECURE_KEY, true);

// ── Selectors ────────────────────────────────────────────────────────────

const selectors = {};
const selectorIds = typeof WeakMap === "function" ? new WeakMap() : new Map();
let selectorCount = 0;

const SelectorRegistry = {
  registerSelector(id, obj, key) {
    selectors[id] = { obj, key };
  },
  unregisterSelector(id) {
    delete selectors[id];
  },
  selector(id) {
    if (typeof id === "function") return id;
    const entry = selectors[id];
    if (!entry) return undefined;
    const value = entry.obj[entry.key];
    return typeof value === "function" ? value.bind(entry.obj) : value;
  },
};

function Selector(obj, key) {
  let ids = selectorIds.get(obj);
  if (!ids) {
    ids = {};
    selectorIds.set(obj, ids);
  }
  const id = (ids[key] ??= `selector-${++selectorCount}-${String(key)}`);
  selectors[id] = { obj, key };
  return id;
}
const call = (selector, ...args) => {
  const fn = SelectorRegistry.selector(selector);
  if (typeof fn !== "function") throw new Error("Setting action not found");
  return fn(...args);
};

// ── Requests ─────────────────────────────────────────────────────────────

const interceptors = [];
const IMAGE_URL = /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:[?#]|$)/i;
const hostOf = (url) =>
  (/^[a-z]+:\/\/([^/?#:]+)/i.exec(String(url ?? ""))?.[1] ?? "").toLowerCase();
const originOf = (url) => /^[a-z]+:\/\/[^/?#]+/i.exec(String(url ?? ""))?.[0] ?? "";
let lastOrigin = "";

function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function withLowercase(headers) {
  const out = {};
  for (const key of Object.keys(headers ?? {})) {
    const value = Array.isArray(headers[key]) ? headers[key].join(", ") : String(headers[key]);
    out[key] = value;
    out[key.toLowerCase()] = value;
  }
  return out;
}

function parseCookies(headers, url) {
  const raw = header(headers, "set-cookie");
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/,(?=\s*[^;,=\s]+=)/);
  const cookies = [];
  for (const line of list) {
    const parts = String(line).split(";");
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const cookie = {
      name: first.slice(0, eq).trim(),
      value: first.slice(eq + 1).trim(),
      domain: hostOf(url),
      path: "/",
    };
    for (const part of parts) {
      const at = part.indexOf("=");
      const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
      const value = at < 0 ? "" : part.slice(at + 1).trim();
      if (key === "domain" && value) cookie.domain = value;
      else if (key === "path" && value) cookie.path = value;
      else if (key === "expires") {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) cookie.expires = date;
      } else if (key === "max-age") {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) cookie.expires = new Date(Date.now() + seconds * 1000);
      }
    }
    cookies.push(cookie);
  }
  return cookies;
}

function encodeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (isArrayBuffer(body) || ArrayBuffer.isView(body)) return utf8Decode(bytesOf(body));
  return body;
}

// 0.9 request → 0.8 request
function to08(request) {
  const url = String(request.url);
  const domain = hostOf(url);
  const headers = { ...request.headers };
  let data = encodeBody(request.body);
  if (data && typeof data === "object" && !header(headers, "content-type")) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  return App.createRequest({
    url,
    method: String(request.method ?? "GET").toUpperCase(),
    headers,
    data,
    cookies: Object.keys(request.cookies ?? {}).map((name) =>
      App.createCookie({ name, value: String(request.cookies[name]), domain }),
    ),
  });
}

// 0.8 request → 0.9 request
function to09(request) {
  const cookies = {};
  for (const cookie of request?.cookies ?? []) {
    if (cookie?.name) cookies[cookie.name] = String(cookie.value ?? "");
  }
  return {
    url: `${request?.url ?? ""}${request?.param ?? ""}`,
    method: String(request?.method ?? "GET").toUpperCase(),
    headers: { ...request?.headers },
    body: request?.data,
    cookies,
  };
}

function responseBytes(response) {
  if (response?.rawData) {
    try {
      const bytes = App.createByteArray(response.rawData);
      const buffer = bufferOf(bytes);
      if (typeof response.data === "string") knownText?.set(buffer, response.data);
      return buffer;
    } catch (error) {
      log("couldn't read response bytes:", error?.message ?? error);
    }
  }
  const text = typeof response?.data === "string" ? response.data : "";
  const buffer = bufferOf(utf8Encode(text));
  knownText?.set(buffer, text);
  return buffer;
}

function response09(request, response) {
  const headers = withLowercase(response?.headers);
  return {
    url: request.url,
    headers,
    status: response?.status ?? 0,
    mimeType:
      String(headers["content-type"] ?? "")
        .split(";")[0]
        .trim() || undefined,
    cookies: parseCookies(headers, request.url),
  };
}

// The 0.8 request manager's interceptor runs the 0.9 interceptors, so they
// also see the images the 0.8 app loads for this source.
const legacyInterceptor = {
  async interceptRequest(request) {
    if (interceptors.length === 0) return request;
    let current = to09(request);
    for (const entry of interceptors.slice()) {
      current = (await call(entry.request, current)) ?? current;
    }
    return to08(current);
  },
  async interceptResponse(response) {
    if (interceptors.length === 0) return response;
    const request = to09(response.request ?? {});
    const type = String(header(response.headers, "content-type") ?? "");
    if (/^image\//i.test(type) || IMAGE_URL.test(request.url)) return response;
    const meta = response09(request, response);
    const original = responseBytes(response);
    let data = original;
    for (const entry of [...interceptors].reverse()) {
      data = (await call(entry.response, request, meta, data)) ?? data;
    }
    if (data === original) return response;
    const bytes = bytesOf(data);
    return {
      request: response.request,
      status: response.status,
      headers: response.headers,
      data: utf8Decode(bytes),
      rawData: App.createRawData({ byteArray: bytes }),
    };
  },
};

let requestManager;
const getRequestManager = () =>
  (requestManager ??= App.createRequestManager({
    requestsPerSecond: 6,
    requestTimeout: 30_000,
    interceptor: legacyInterceptor,
  }));

async function scheduleRequest(request) {
  const outgoing = to08(request);
  if (!IMAGE_URL.test(outgoing.url)) lastOrigin = originOf(outgoing.url) || lastOrigin;
  const response = await getRequestManager().schedule(outgoing, 1);
  return [response09({ url: outgoing.url }, response), responseBytes(response)];
}

// ── Application ──────────────────────────────────────────────────────────

const discoverSections = [];

export const Application = {
  isResourceLimited: false,
  filterAdultTitles: false,
  filterMatureTitles: false,
  decodeHTMLEntities: (text) => decodeHTML(String(text ?? "")),
  sleep: (seconds) =>
    new Promise((resolve) => globals.setTimeout(resolve, Math.max(0, Number(seconds) || 0) * 1000)),
  registerDiscoverSection(section, selector) {
    Application.unregisterDiscoverSection(section.id);
    discoverSections.push({ section, selector });
  },
  unregisterDiscoverSection(id) {
    const at = discoverSections.findIndex((entry) => entry.section.id === id);
    if (at >= 0) discoverSections.splice(at, 1);
  },
  registeredDiscoverSections: () => discoverSections.map((entry) => entry.section),
  invalidateDiscoverSections() {},
  registerInterceptor(id, request, response) {
    Application.unregisterInterceptor(id);
    interceptors.push({ id, request, response });
  },
  unregisterInterceptor(id) {
    const at = interceptors.findIndex((entry) => entry.id === id);
    if (at >= 0) interceptors.splice(at, 1);
  },
  setRedirectHandler() {},
  getDefaultUserAgent: () => getRequestManager().getDefaultUserAgent(),
  scheduleRequest,
  arrayBufferToUTF8String: (buffer) => knownText?.get(buffer) ?? utf8Decode(bytesOf(buffer)),
  arrayBufferToASCIIString: (buffer) => new TextDecoderPolyfill("ascii").decode(buffer),
  arrayBufferToUTF16String(buffer) {
    const bytes = bytesOf(buffer);
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return out;
  },
  base64Encode: (value) => base64FromBytes(bytesOf(value)),
  base64Decode(value) {
    const bytes = bytesFromBase64(typeof value === "string" ? value : utf8Decode(bytesOf(value)));
    try {
      return utf8Decode(bytes, true);
    } catch {
      return bufferOf(bytes);
    }
  },
  crypto_md5Hash: (value) =>
    Array.from(md5(bytesOf(value)), (b) => b.toString(16).padStart(2, "0")).join(""),
  getState: (key) => store.data[key],
  setState(value, key) {
    if (value === undefined) delete store.data[key];
    else store.data[key] = value;
    saveState();
  },
  getSecureState: (key) => store.secure[key],
  setSecureState(value, key) {
    if (value === undefined) delete store.secure[key];
    else store.secure[key] = value;
    saveSecure();
  },
  resetAllState() {
    store.data = {};
    saveState();
  },
  executeInWebView() {
    return Promise.reject(new Error("This needs Paperback 0.9 (it runs a hidden web page)."));
  },
  formDidChange(id) {
    formWaiters.get(id)?.();
  },
  console_log: (msg) => nativeConsole?.log?.(...[].concat(msg)),
  console_warn: (msg) => nativeConsole?.log?.(...[].concat(msg)),
  console_error: (msg) => nativeConsole?.log?.(...[].concat(msg)),
  Selector,
  SelectorRegistry,
};

// ── Settings: 0.9 forms shown as 0.8 rows ────────────────────────────────

function findItem(form, id) {
  for (const section of form.getSections() ?? []) {
    for (const item of section.items ?? []) if (item?.id === id) return item;
  }
  return undefined;
}

const textOf = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (value.text) return String(value.text);
  if (value.symbol === "checkmark") return "✓";
  if (value.symbol === "xmark") return "✗";
  return undefined;
};

function binding(get, set) {
  return App.createDUIBinding({ get: async () => get(), set: async (value) => set(value) });
}

function isSelectForm(form) {
  const params = form?.params;
  return Boolean(params && ("items" in params || "options" in params) && params.onValueChange);
}

function itemToRow(form, item) {
  const id = String(item.id);
  const current = () => findItem(form, id) ?? item;
  switch (item.type) {
    case "labelRow": {
      if (item.onSelect) {
        return App.createDUIButton({
          id,
          label: item.title ?? "",
          onTap: async () => call(current().onSelect),
        });
      }
      return App.createDUILabel({
        id,
        label: item.title ?? "",
        value: textOf(item.value) ?? item.subtitle,
      });
    }
    case "inputRow": {
      const make = item.isSecureEntry ? App.createDUISecureInputField : App.createDUIInputField;
      return make({
        id,
        label: item.title ?? "",
        value: binding(
          () => current().value ?? "",
          (value) => call(current().onValueChange, String(value ?? "")),
        ),
      });
    }
    case "toggleRow":
      return App.createDUISwitch({
        id,
        label: item.title ?? "",
        value: binding(
          () => Boolean(current().value),
          (value) => call(current().onValueChange, Boolean(value)),
        ),
      });
    case "stepperRow":
      return App.createDUIStepper({
        id,
        label: item.title ?? "",
        min: item.minValue,
        max: item.maxValue,
        step: item.stepValue,
        value: binding(
          () => Number(current().value ?? 0),
          (value) => call(current().onValueChange, Number(value)),
        ),
      });
    case "buttonRow":
      return App.createDUIButton({
        id,
        label: item.title ?? "",
        onTap: async () => call(current().onSelect),
      });
    case "navigationRow": {
      const target = item.form;
      if (isSelectForm(target)) {
        const params = target.params;
        const options = ("items" in params ? params.items : params.options) ?? [];
        const tristate = !Array.isArray(params.value);
        return App.createDUISelect({
          id,
          label: item.title ?? params.title ?? "",
          options: options.map((option) => String(option.id)),
          allowsMultiselect: tristate || (params.maxItemCount ?? 1) > 1,
          labelResolver: async (option) =>
            String(options.find((candidate) => String(candidate.id) === option)?.title ?? option),
          value: binding(
            () => {
              const value = current().form?.params?.value ?? params.value;
              return Array.isArray(value)
                ? value.map(String)
                : Object.keys(value ?? {}).filter((key) => value[key] === "included");
            },
            (value) => {
              const list = [].concat(value ?? []).map(String);
              const next = tristate
                ? Object.fromEntries(list.map((key) => [key, "included"]))
                : list;
              return call(current().form?.params?.onValueChange ?? params.onValueChange, next);
            },
          ),
        });
      }
      return App.createDUINavigationButton({
        id,
        label: item.title ?? "",
        form: toDUIForm(target),
      });
    }
    case "oauthButtonRow":
      return App.createDUIOAuthButton({
        id,
        label: item.title ?? "",
        authorizeEndpoint: item.authorizeEndpoint,
        clientId: item.clientId,
        responseType: item.responseType,
        redirectUri: item.redirectUri,
        scopes: item.scopes,
        successHandler: async (first, second) => call(current().onSuccess, first, second),
      });
    case "webViewRow":
      return App.createDUILabel({ id, label: item.title ?? "", value: "Needs Paperback 0.9" });
    default:
      return item.title
        ? App.createDUILabel({ id, label: String(item.title), value: "" })
        : undefined;
  }
}

function sectionRows(form, sectionId) {
  return async () => {
    const section = (form.getSections() ?? []).find((candidate) => candidate.id === sectionId);
    return (section?.items ?? [])
      .filter((item) => item && !item.isHidden)
      .map((item) => itemToRow(form, item))
      .filter(Boolean);
  };
}

// 0.9 forms tell the app to redraw with Application.formDidChange(id).
const formWaiters = new Map();
let formCount = 0;

function looksLoading(form) {
  const sections = form.getSections() ?? [];
  const first = sections[0]?.items ?? [];
  return (
    sections.length === 1 &&
    first.length <= 1 &&
    /loading/i.test(`${sections[0].id} ${first[0]?.id ?? ""} ${first[0]?.title ?? ""}`)
  );
}

// Opens the form; one that first shows "Loading…" is waited for (until it
// redraws, at most 10 seconds where the app has timers).
async function openForm(form) {
  if (!form.__underlying_formId) {
    Object.defineProperty(form, "__underlying_formId", {
      value: `form-${++formCount}`,
      configurable: true,
      writable: true,
    });
  }
  const id = form.__underlying_formId;
  let redrawn;
  const redraw = new Promise((resolve) => {
    redrawn = resolve;
  });
  formWaiters.set(id, () => redrawn());
  try {
    form.formWillAppear?.();
  } catch (error) {
    log("settings:", error?.message ?? error);
  }
  for (let round = 0; round < 5 && looksLoading(form); round++) {
    const limit =
      typeof root.setTimeout === "function"
        ? new Promise((resolve) => root.setTimeout(resolve, 10_000))
        : redraw;
    await Promise.race([redraw, limit]);
    if (typeof root.setTimeout !== "function") break;
  }
}

async function toDUISections(form) {
  await openForm(form);
  return (form.getSections() ?? []).map((section, index) =>
    App.createDUISection({
      id: String(section.id ?? `section${index}`),
      header: section.header,
      footer: section.footer,
      isHidden: false,
      rows: sectionRows(form, section.id),
    }),
  );
}

function toDUIForm(form) {
  return App.createDUIForm({
    sections: () => toDUISections(form),
    onSubmit: form.requiresExplicitSubmission ? async () => form.formDidSubmit?.() : undefined,
  });
}

// ── The 0.8 source ───────────────────────────────────────────────────────

const SECTION_TYPES = { 0: "featured", 2: "singleRowLarge" };
const TAG_SEPARATOR = "␟";

const plainMetadata = (metadata) =>
  metadata === undefined ||
  metadata === null ||
  (typeof metadata === "object" && !Array.isArray(metadata) && Object.keys(metadata).length === 0)
    ? undefined
    : metadata;

function partial(item) {
  return App.createPartialSourceManga({
    mangaId: String(item.mangaId),
    title: String(item.title ?? ""),
    image: item.imageUrl ?? "",
    subtitle: item.subtitle ?? item.supertitle ?? undefined,
  });
}

export function makeSourceClass(loadExtension, meta) {
  let extension;
  let ready;
  let cloudflareRequest;
  let bypassOpened = false;
  let sections = [];
  let filters;
  let sortingOption;
  const mangaCache = new Map();
  const chapterCache = new Map();

  const remember = (map, key, value, limit) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > limit) map.delete(map.keys().next().value);
  };

  async function start() {
    if (!ready) {
      ready = (async () => {
        await loadState();
        const exported = loadExtension();
        extension =
          exported?.[meta.id] ??
          Object.values(exported ?? {}).find(
            (value) => value && typeof value.getMangaDetails === "function",
          );
        if (!extension) throw new Error(`0.9 extension ${meta.id} not found in its bundle`);
        await extension.initialise?.();
      })();
      ready.catch(() => {
        ready = undefined;
      });
    }
    await ready;
    if (bypassOpened) {
      bypassOpened = false;
      const cookies = (getRequestManager().cookieStore?.getAllCookies?.() ?? [])
        .filter((cookie) => cookie?.name)
        .map((cookie) => {
          const expires =
            cookie.expires === undefined || cookie.expires === null
              ? undefined
              : new Date(cookie.expires);
          return {
            name: String(cookie.name),
            value: String(cookie.value ?? ""),
            domain: String(cookie.domain ?? hostOf(lastOrigin)),
            path: cookie.path ?? "/",
            ...(expires && !Number.isNaN(expires.getTime()) ? { expires } : {}),
          };
        });
      try {
        if (extension.cloudflareBypassCompleted) {
          await extension.cloudflareBypassCompleted(
            cloudflareRequest ?? { url: lastOrigin, method: "GET" },
            cookies,
            {},
          );
        } else {
          await extension.saveCloudflareBypassCookies?.(cookies);
        }
      } catch (error) {
        log("after the Cloudflare check:", error?.message ?? error);
      }
    }
    return extension;
  }

  function failure(error) {
    if (error?.type === "cloudflareError" || error?.resolutionRequest) {
      cloudflareRequest = error.resolutionRequest ?? cloudflareRequest;
      return new Error(
        `CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${meta.name}> and press the cloud icon.`,
      );
    }
    return error instanceof Error ? error : new Error(String(error?.message ?? error));
  }

  const run = async (work) => {
    try {
      return await work(await start());
    } catch (error) {
      throw failure(error);
    }
  };

  async function loadFilters(ext) {
    if (filters === undefined) {
      try {
        filters =
          typeof ext.getSearchFilters === "function" ? ((await ext.getSearchFilters()) ?? []) : [];
      } catch (error) {
        log("search filters:", error?.message ?? error);
        filters = [];
      }
    }
    return filters;
  }

  function mangaStub(mangaId) {
    return (
      mangaCache.get(mangaId) ?? {
        mangaId,
        mangaInfo: {
          primaryTitle: "",
          secondaryTitles: [],
          thumbnailUrl: "",
          synopsis: "",
          contentRating: meta.contentRating ?? "SAFE",
        },
      }
    );
  }

  class PortedSource {
    constructor(cheerio) {
      this.cheerio = cheerio;
      this.requestManager = getRequestManager();
      this.stateManager = getStateManager();
    }

    async getMangaDetails(mangaId) {
      return run(async (ext) => {
        const manga = await ext.getMangaDetails(mangaId);
        remember(mangaCache, mangaId, manga, 200);
        const info = manga?.mangaInfo ?? {};
        return App.createSourceManga({
          id: mangaId,
          mangaInfo: App.createMangaInfo({
            image: info.thumbnailUrl ?? "",
            artist: info.artist ?? "",
            author: info.author ?? "",
            desc: info.synopsis ?? "",
            status: info.status ?? "Unknown",
            hentai: info.contentRating === "ADULT",
            titles: [info.primaryTitle, ...(info.secondaryTitles ?? [])]
              .filter(Boolean)
              .map(String),
            banner: info.bannerUrl,
            rating: info.rating,
            covers: info.artworkUrls,
            additionalInfo: info.additionalInfo,
            tags: (info.tagGroups ?? []).map((group) =>
              App.createTagSection({
                id: String(group.id),
                label: String(group.title ?? group.id),
                tags: (group.tags ?? []).map((tag) =>
                  App.createTag({ id: String(tag.id), label: String(tag.title ?? tag.id) }),
                ),
              }),
            ),
          }),
        });
      });
    }

    getMangaShareUrl(mangaId) {
      return mangaCache.get(mangaId)?.mangaInfo?.shareUrl;
    }

    async getChapters(mangaId) {
      return run(async (ext) => {
        const chapters = await ext.getChapters(mangaStub(mangaId));
        return (chapters ?? []).filter(Boolean).map((chapter) => {
          remember(chapterCache, String(chapter.chapterId), chapter, 5000);
          const time = chapter.publishDate ?? chapter.creationDate;
          return App.createChapter({
            id: String(chapter.chapterId),
            chapNum: Number(chapter.chapNum) || 0,
            volume: chapter.volume,
            name: chapter.title ?? "",
            group: chapter.version,
            langCode: chapter.langCode ?? "en",
            time: time ? new Date(time) : undefined,
            sortingIndex: chapter.sortingIndex,
          });
        });
      });
    }

    async getChapterDetails(mangaId, chapterId) {
      return run(async (ext) => {
        const chapter = chapterCache.get(String(chapterId)) ?? {
          chapterId: String(chapterId),
          sourceManga: mangaStub(mangaId),
          langCode: "en",
          chapNum: 0,
        };
        const details = await ext.getChapterDetails(chapter);
        if (details?.type && details.type !== "images") {
          throw new Error("This chapter is text, which Paperback 0.8 can't show. Open it on 0.9.");
        }
        return App.createChapterDetails({
          id: String(chapterId),
          mangaId,
          pages: (details?.pages ?? []).map(String),
        });
      });
    }

    async getSearchTags() {
      return run(async (ext) =>
        (await loadFilters(ext))
          .filter((filter) => filter.type === "multiselect" || filter.type === "dropdown")
          .map((filter) =>
            App.createTagSection({
              id: String(filter.id),
              label: String(filter.title ?? filter.id),
              tags: (filter.options ?? []).map((option) =>
                App.createTag({
                  id: `${filter.id}${TAG_SEPARATOR}${option.id}`,
                  label: String(option.value ?? option.id),
                }),
              ),
            }),
          ),
      );
    }

    async getTags() {
      return this.getSearchTags();
    }

    async getSearchFields() {
      return run(async (ext) =>
        (await loadFilters(ext))
          .filter((filter) => filter.type === "input")
          .map((filter) =>
            App.createSearchField({
              id: String(filter.id),
              name: String(filter.title ?? filter.id),
              placeholder: String(filter.placeholder ?? ""),
            }),
          ),
      );
    }

    async supportsTagExclusion() {
      return run(async (ext) => (await loadFilters(ext)).some((filter) => filter.allowExclusion));
    }

    async getSearchResults(query, metadata) {
      return run(async (ext) => {
        if (typeof ext.getSearchResults !== "function")
          return App.createPagedResults({ results: [] });
        const defined = await loadFilters(ext);
        const picked = (tags, state) => {
          const out = {};
          for (const tag of tags ?? []) {
            const at = String(tag.id).indexOf(TAG_SEPARATOR);
            if (at < 0) continue;
            const filterId = String(tag.id).slice(0, at);
            (out[filterId] ??= []).push([String(tag.id).slice(at + TAG_SEPARATOR.length), state]);
          }
          return out;
        };
        const included = picked(query?.includedTags, "included");
        const excluded = picked(query?.excludedTags, "excluded");
        const values = defined.map((filter) => {
          const chosen = [...(included[filter.id] ?? []), ...(excluded[filter.id] ?? [])];
          if (filter.type === "multiselect") {
            return {
              id: filter.id,
              value: chosen.length ? Object.fromEntries(chosen) : (filter.value ?? {}),
            };
          }
          if (filter.type === "dropdown") {
            const first = (included[filter.id] ?? [])[0];
            return { id: filter.id, value: first ? first[0] : filter.value };
          }
          return { id: filter.id, value: query?.parameters?.[filter.id] ?? filter.value ?? "" };
        });
        const search = { title: query?.title ?? "", metadata: defined.length ? values : undefined };
        if (sortingOption === undefined && typeof ext.getSortingOptions === "function") {
          try {
            sortingOption = ((await ext.getSortingOptions(search)) ?? [])[0] ?? null;
          } catch {
            sortingOption = null;
          }
        }
        const page = await ext.getSearchResults(
          search,
          plainMetadata(metadata),
          sortingOption ?? undefined,
        );
        const items = (page?.items ?? []).filter((item) => item?.mangaId);
        return App.createPagedResults({
          results: items.map(partial),
          metadata: items.length ? page?.metadata : undefined,
        });
      });
    }

    async searchRequest(query, metadata) {
      return this.getSearchResults(query, metadata);
    }

    async getHomePageSections(sectionCallback) {
      return run(async (ext) => {
        const list = [
          ...(typeof ext.getDiscoverSections === "function"
            ? ((await ext.getDiscoverSections()) ?? [])
            : []),
        ];
        for (const section of Application.registeredDiscoverSections()) {
          if (!list.some((candidate) => candidate.id === section.id)) list.push(section);
        }
        sections = list.filter((section) => section.type !== 4);
        for (const section of sections) {
          sectionCallback(
            App.createHomeSection({
              id: section.id,
              title: section.title,
              type: SECTION_TYPES[section.type] ?? "singleRowNormal",
              items: [],
              containsMoreItems: true,
            }),
          );
        }
        let failures = 0;
        let lastError;
        await Promise.all(
          sections.map(async (section) => {
            try {
              const page = await this.discoverPage(ext, section, undefined);
              sectionCallback(
                App.createHomeSection({
                  id: section.id,
                  title: section.title,
                  type: SECTION_TYPES[section.type] ?? "singleRowNormal",
                  items: page.results,
                  containsMoreItems: page.metadata !== undefined,
                }),
              );
            } catch (error) {
              failures++;
              lastError = error;
              log(`home section ${section.id}:`, error?.message ?? error);
            }
          }),
        );
        if (sections.length > 0 && failures === sections.length) throw lastError;
      });
    }

    async discoverPage(ext, section, metadata) {
      const registered = discoverSections.find((entry) => entry.section.id === section.id);
      const page =
        registered?.selector !== undefined
          ? await call(registered.selector, section, metadata)
          : await ext.getDiscoverSectionItems(section, metadata);
      const items = (page?.items ?? []).filter((item) => item?.mangaId);
      return App.createPagedResults({
        results: items.map(partial),
        metadata: items.length ? page?.metadata : undefined,
      });
    }

    async getViewMoreItems(sectionId, metadata) {
      return run(async (ext) => {
        let section = sections.find((candidate) => candidate.id === sectionId);
        if (!section && typeof ext.getDiscoverSections === "function") {
          sections = (await ext.getDiscoverSections()) ?? [];
          section = sections.find((candidate) => candidate.id === sectionId);
        }
        if (!section) return App.createPagedResults({ results: [] });
        return this.discoverPage(ext, section, plainMetadata(metadata));
      });
    }

    async getSourceMenu() {
      return run(async (ext) => {
        const form = await ext.getSettingsForm();
        const parts = await toDUISections(form);
        if (parts.length === 1) return parts[0];
        return App.createDUISection({
          id: "settings",
          header: "Settings",
          isHidden: false,
          rows: async () => [
            App.createDUINavigationButton({
              id: "settings_form",
              label: "Settings",
              form: toDUIForm(form),
            }),
          ],
        });
      });
    }

    async getCloudflareBypassRequestAsync() {
      await start().catch(() => undefined);
      bypassOpened = true;
      const request = cloudflareRequest ?? { url: meta.website || `${lastOrigin}/`, method: "GET" };
      const userAgent = await getRequestManager()
        .getDefaultUserAgent()
        .catch(() => undefined);
      const outgoing = to08(request);
      if (userAgent && !header(outgoing.headers, "user-agent"))
        outgoing.headers["user-agent"] = userAgent;
      return outgoing;
    }
  }

  const proto = PortedSource.prototype;
  if (!meta.discover) {
    delete proto.getHomePageSections;
    delete proto.getViewMoreItems;
  }
  if (!meta.settings) delete proto.getSourceMenu;
  if (!meta.cloudflare) delete proto.getCloudflareBypassRequestAsync;
  if (!meta.filters) {
    delete proto.getSearchTags;
    delete proto.getTags;
    delete proto.getSearchFields;
    delete proto.supportsTagExclusion;
  }
  return PortedSource;
}
