// Makes Paperback 0.8 sources usable on 0.9 and 0.9 sources usable on 0.8.
//
// Each ported source is the original, unchanged bundle with a small runtime
// in front of it (scripts/crossport/v8on9.js or v9on8.js) that gives it the
// app it was written for. Before a port is kept it is loaded once here, under
// the official Paperback 0.9 test runtime, to read what it can do; a bundle
// that doesn't load is left out.
//
// Used by scripts/aggregate.mjs.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { build, transform } from "esbuild";

// Raised when the runtimes in scripts/crossport/ change, so the app offers
// every ported source again as an update.
export const PORT_REVISION = 2;

const shimDir = path.join(import.meta.dirname, "crossport");
const shims = new Map();

function shim(file, globalName) {
  if (!shims.has(file)) {
    shims.set(
      file,
      build({
        entryPoints: [path.join(shimDir, file)],
        bundle: true,
        format: "iife",
        globalName,
        platform: "browser",
        target: "es2020",
        minify: true,
        legalComments: "none",
        write: false,
        logLevel: "silent",
      }).then((result) => result.outputFiles[0].text),
    );
  }
  return shims.get(file);
}

// The last number of the version gets two digits for the port revision, so
// both an upstream update and a runtime fix count as a newer version:
// 1.2.3 → 1.2.301, 1.0.0-alpha.90 → 1.0.0-alpha.9001.
export function portVersion(version) {
  const text = String(version ?? "1.0.0").trim() || "1.0.0";
  const match = /(\d+)(?!.*\d)/.exec(text);
  if (!match) return `${text}.${PORT_REVISION}`;
  const bumped = String(Number(match[1]) * 100 + PORT_REVISION);
  return text.slice(0, match.index) + bumped + text.slice(match.index + match[1].length);
}

export function capabilityList(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  const bits = Number(value) || 0;
  return [1, 2, 4, 8, 16, 32, 64].filter((bit) => bits & bit);
}

const LANGUAGES = {
  indonesian: "id",
  vietnamese: "vi",
  french: "fr",
  spanish: "es",
  arabic: "ar",
  portuguese: "pt",
  turkish: "tr",
  italian: "it",
  german: "de",
  russian: "ru",
  thai: "th",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  polish: "pl",
  english: "en",
};

const CONTENT_RATING_09 = { EVERYONE: "SAFE", SAFE: "SAFE", MATURE: "MATURE", ADULT: "ADULT" };
const CONTENT_RATING_08 = {
  SAFE: "EVERYONE",
  EVERYONE: "EVERYONE",
  MATURE: "MATURE",
  ADULT: "ADULT",
};
const BADGE_COLORS = {
  default: "#1E40AF",
  success: "#15803d",
  info: "#1F2937",
  warning: "#EAB308",
  danger: "#991B1B",
};

// A sandbox like the 0.9 app's, with the official test runtime as
// `Application`.
async function sandbox09() {
  const { ApplicationPolyfill } = await import("@paperback/runtime-polyfills");
  const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  return vm.createContext({
    Application: ApplicationPolyfill(),
    console: quiet,
    TextDecoder,
    TextEncoder,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    URL,
  });
}

function copyIcon(from, toDir, icon) {
  fs.mkdirSync(toDir, { recursive: true });
  const source = path.join(from, icon);
  if (!fs.existsSync(source)) return false;
  fs.copyFileSync(source, path.join(toDir, path.basename(icon)));
  return true;
}

// ── 0.8 → 0.9 ────────────────────────────────────────────────────────────

// `dir` holds the 0.8 build of one source (source.js, includes/), `entry` is
// its versioning.json entry. Returns the 0.9 info.json written to
// `outDir/<id>`, or { skipped } with the reason.
export async function portToV9({ id, dir, entry, outDir }) {
  let original = fs.readFileSync(path.join(dir, "source.js"), "utf8");
  // The 0.8 toolchain didn't minify. Spaces and syntax only: names stay.
  try {
    original = (
      await transform(original, {
        minifyWhitespace: true,
        minifySyntax: true,
        legalComments: "none",
        target: "es2020",
        logLevel: "silent",
      })
    ).code;
  } catch {
    // keep it as it was
  }
  const icon = String(entry.icon ?? "icon.png");
  const meta = {
    id,
    contentRating: String(entry.contentRating ?? "EVERYONE").toUpperCase(),
    cloudflare: Boolean((Number(entry.intents) || 0) & 16),
  };
  const runtime = await shim("v8on9.js", "__pbV8");
  const bundle = [
    "var source = (function () {",
    // The runtime's "use strict" stays in its own function: the 0.8 code runs
    // as the 0.8 app ran it.
    "var __pbV8 = (function () {",
    runtime,
    ";return __pbV8;",
    "})();",
    "return (function (App, TextDecoder, TextEncoder, atob, btoa, setTimeout, clearTimeout, console) {",
    "var __load = function () {",
    // esbuild bundles (0.8 toolchain) leave `_Sources`; browserify ones
    // (older toolchain) fill `module.exports`.
    "var module = { exports: {} };",
    "var exports = module.exports;",
    "return (function () {",
    original,
    ';return typeof _Sources !== "undefined" ? _Sources : module.exports.Sources || module.exports;',
    "}).call({});",
    "};",
    "var exported = {};",
    `exported[${JSON.stringify(id)}] = __pbV8.makeExtension(__load, ${JSON.stringify(meta)});`,
    "return exported;",
    "})(__pbV8.App, __pbV8.globals.TextDecoder, __pbV8.globals.TextEncoder, __pbV8.globals.atob, __pbV8.globals.btoa, __pbV8.globals.setTimeout, __pbV8.globals.clearTimeout, __pbV8.globals.console);",
    "})();",
    "",
  ].join("\n");

  let methods;
  try {
    const context = await sandbox09();
    const exported = vm.runInContext(`${bundle}\n;source`, context, { timeout: 20_000 });
    methods = new Set(exported[id].__describe());
  } catch (error) {
    return { skipped: `doesn't load (${String(error?.message ?? error).split("\n")[0]})` };
  }
  if (!methods.has("getChapters") || !methods.has("getChapterDetails")) {
    return { skipped: "not a manga source (tracker or other)" };
  }

  const capabilities = [1];
  if (methods.has("getSearchResults") || methods.has("searchRequest")) capabilities.push(64);
  if (methods.has("getHomePageSections")) capabilities.push(4);
  if (
    meta.cloudflare ||
    methods.has("getCloudflareBypassRequestAsync") ||
    methods.has("getCloudflareBypassRequest")
  ) {
    capabilities.push(16);
  }
  if (methods.has("getSourceMenu")) capabilities.push(32);

  const tags = entry.tags ?? [];
  const language =
    entry.language ??
    tags.map((tag) => LANGUAGES[String(tag?.text ?? "").toLowerCase()]).find(Boolean) ??
    "en";
  const info = {
    name: String(entry.name ?? id),
    description: String(entry.desc ?? entry.description ?? ""),
    version: portVersion(entry.version),
    icon: path.basename(icon),
    language,
    contentRating: CONTENT_RATING_09[String(entry.contentRating ?? "").toUpperCase()] ?? "MATURE",
    capabilities,
    badges: [
      { label: "0.8 port", textColor: "#ffffff", backgroundColor: "#6b7280" },
      ...tags
        .filter((tag) => tag?.text)
        .map((tag) => ({
          label: String(tag.text),
          textColor: tag.type === "warning" ? "#000000" : "#ffffff",
          backgroundColor: BADGE_COLORS[tag.type] ?? BADGE_COLORS.default,
        })),
    ],
    developers: [
      {
        name: String(entry.author ?? "Unknown"),
        ...(entry.website ? { website: String(entry.website) } : {}),
      },
    ],
    id,
  };

  const target = path.join(outDir, id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "index.js"), bundle);
  if (!copyIcon(path.join(dir, "includes"), path.join(target, "static"), icon)) {
    fs.rmSync(target, { recursive: true, force: true });
    return { skipped: "no icon" };
  }
  fs.writeFileSync(path.join(target, "info.json"), JSON.stringify(info));
  return { info };
}

// ── 0.9 → 0.8 ────────────────────────────────────────────────────────────

const NOVEL = /type:\s*(?:`html`|"html"|'html')/;

// `dir` holds the 0.9 build of one source (index.js, static/), `info` its
// info.json. Returns the 0.8 versioning.json entry for `outDir/<id>`, or
// { skipped } with the reason.
export async function portToV8({ id, dir, info, outDir, website = "" }) {
  const original = fs.readFileSync(path.join(dir, "index.js"), "utf8");
  // Text chapters can't be shown on 0.8. A source that only has those is left
  // out; one that also has image chapters is ported (its text chapters say so).
  if (NOVEL.test(original) && !/\bpages\s*:/.test(original)) {
    return { skipped: "novels (text chapters) can't be shown on 0.8" };
  }
  if (original.includes("executeInWebView")) {
    return { skipped: "needs 0.9's hidden web page (executeInWebView)" };
  }

  let has;
  try {
    const context = await sandbox09();
    const exported = vm.runInContext(`${original}\n;source`, context, { timeout: 20_000 });
    const extension = exported?.[id];
    if (!extension) return { skipped: "doesn't export its extension" };
    has = (name) => typeof extension[name] === "function";
  } catch (error) {
    return { skipped: `doesn't load (${String(error?.message ?? error).split("\n")[0]})` };
  }
  if (!has("getChapters") || !has("getChapterDetails") || !has("getMangaDetails")) {
    return { skipped: "not a manga source (tracker or other)" };
  }

  const capabilities = new Set(capabilityList(info.capabilities));
  const developers = info.developers ?? [];
  const meta = {
    id,
    name: String(info.name ?? id),
    website,
    contentRating: String(info.contentRating ?? "SAFE"),
    discover: capabilities.has(4) || has("getDiscoverSections"),
    settings: capabilities.has(32) && has("getSettingsForm"),
    cloudflare: capabilities.has(16),
    filters: has("getSearchFilters"),
  };
  const intents =
    1 | (meta.discover ? 4 : 0) | (meta.cloudflare ? 16 : 0) | (meta.settings ? 32 : 0);
  const icon = path.basename(String(info.icon ?? "icon.png"));
  const sourceInfo = {
    version: portVersion(info.version),
    name: meta.name,
    icon,
    author:
      developers
        .map((developer) => developer?.name)
        .filter(Boolean)
        .join(", ") || "Unknown",
    authorWebsite: String(developers[0]?.website ?? developers[0]?.github ?? ""),
    description: String(info.description ?? ""),
    contentRating: CONTENT_RATING_08[String(info.contentRating ?? "").toUpperCase()] ?? "MATURE",
    websiteBaseURL: website,
    sourceTags: [
      { text: "0.9 port", type: "info" },
      ...(info.badges ?? [])
        .filter((badge) => badge?.label)
        .map((badge) => ({ text: String(badge.label), type: "default" })),
    ],
    intents,
    ...(info.language ? { language: String(info.language) } : {}),
  };

  const runtime = await shim("v9on8.js", "__pbV9");
  const bundle = [
    "var _Sources = (function () {",
    "var __pbV9 = (function () {",
    runtime,
    ";return __pbV9;",
    "})();",
    "return (function (Application, TextDecoder, TextEncoder, crypto, atob, btoa, setTimeout, clearTimeout, console) {",
    "var __load = function () {",
    original,
    ";return source;",
    "};",
    "var exported = {};",
    `exported[${JSON.stringify(`${id}Info`)}] = ${JSON.stringify(sourceInfo)};`,
    `exported[${JSON.stringify(id)}] = __pbV9.makeSourceClass(__load, ${JSON.stringify(meta)});`,
    "return exported;",
    "})(__pbV9.Application, __pbV9.globals.TextDecoder, __pbV9.globals.TextEncoder, __pbV9.globals.crypto, __pbV9.globals.atob, __pbV9.globals.btoa, __pbV9.globals.setTimeout, __pbV9.globals.clearTimeout, __pbV9.globals.console);",
    "})();",
    "this.Sources = _Sources; if (typeof exports === 'object' && typeof module !== 'undefined') {module.exports.Sources = this.Sources;}",
    "",
  ].join("\n");

  // Loads like the 0.8 app would: the class has to build with a bare `App`.
  try {
    const stubApp = new Proxy(
      {
        createRequestManager: () => ({
          getDefaultUserAgent: async () => "",
          schedule: async () => ({}),
        }),
        createSourceStateManager: () => ({
          store: async () => {},
          retrieve: async () => undefined,
        }),
      },
      { get: (target, name) => target[name] ?? ((value) => value) },
    );
    const holder = {};
    const context = vm.createContext({ App: stubApp });
    vm.runInContext(`(function () {${bundle}}).call(holder)`, Object.assign(context, { holder }), {
      timeout: 20_000,
    });
    const LegacySource = holder.Sources?.[id];
    if (typeof LegacySource !== "function") throw new Error("no source class");
    void new LegacySource({});
  } catch (error) {
    return {
      skipped: `0.8 build doesn't load (${String(error?.message ?? error).split("\n")[0]})`,
    };
  }

  const target = path.join(outDir, id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "source.js"), bundle);
  if (!copyIcon(path.join(dir, "static"), path.join(target, "includes"), icon)) {
    fs.rmSync(target, { recursive: true, force: true });
    return { skipped: "no icon" };
  }
  return {
    entry: {
      id,
      name: sourceInfo.name,
      author: sourceInfo.author,
      desc: sourceInfo.description,
      website: sourceInfo.authorWebsite,
      contentRating: sourceInfo.contentRating,
      version: sourceInfo.version,
      icon,
      tags: sourceInfo.sourceTags,
      websiteBaseURL: website,
      intents,
    },
  };
}

// ── Reading a 0.8 source's SourceInfo ───────────────────────────────────

// The 0.8 versioning.json leaves out some SourceInfo fields (language);
// this loads the bundle (without running the source) to read them.
export function read08Info(dir, id) {
  try {
    const stubApp = new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name === "string" && name.startsWith("create")
            ? (value) => value ?? {}
            : undefined,
      },
    );
    const module = { exports: {} };
    const holder = {};
    const context = vm.createContext({ App: stubApp, module, exports: module.exports, holder });
    vm.runInContext(
      `(function () {${fs.readFileSync(path.join(dir, "source.js"), "utf8")}\n;holder.sources = typeof _Sources !== "undefined" ? _Sources : module.exports.Sources || module.exports;}).call({})`,
      context,
      { timeout: 20_000 },
    );
    return holder.sources?.[`${id}Info`];
  } catch {
    return undefined;
  }
}
