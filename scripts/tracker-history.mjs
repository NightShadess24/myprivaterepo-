// Puts scripts/tracker-history/layer.js around a 0.9 tracker from another
// repository: the original bundle, unchanged, then the layer, which adds an
// "Automatic updates" page (timer and history) to the tracker's settings.
// The version's last number gets two more digits (1.0.0-alpha.19 →
// 1.0.0-alpha.1901), so the app offers it as an update.
//
// Used by scripts/aggregate.mjs for the 0.9 Trackers repository.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { build } from "esbuild";

// Raised when layer.js changes, so the app offers the trackers again.
export const HISTORY_REVISION = 1;

let layer;

function layerCode() {
  layer ??= build({
    entryPoints: [path.join(import.meta.dirname, "tracker-history", "layer.js")],
    bundle: true,
    format: "iife",
    globalName: "__trackerHistory",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    write: false,
    logLevel: "silent",
  }).then((result) => result.outputFiles[0].text);
  return layer;
}

export function historyVersion(version) {
  const text = String(version ?? "1.0.0").trim() || "1.0.0";
  const match = /(\d+)(?!.*\d)/.exec(text);
  if (!match) return `${text}.${HISTORY_REVISION}`;
  const bumped = String(Number(match[1]) * 100 + HISTORY_REVISION);
  return text.slice(0, match.index) + bumped + text.slice(match.index + match[1].length);
}

// Loads the bundle the way the app does and checks the tracker is still there.
async function loads(code, id) {
  const { ApplicationPolyfill } = await import("@paperback/runtime-polyfills");
  const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  const context = vm.createContext({
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
  try {
    const source = vm.runInContext(`${code}\n;source`, context, { timeout: 10000 });
    return typeof source?.[id]?.processChapterReadActionQueue === "function";
  } catch {
    return false;
  }
}

/**
 * `dir` is the copied tracker (index.js, info.json), `entry` its versioning.json
 * entry, whose version is raised. Returns false (and leaves the tracker as it
 * was) when the layer can't be added.
 */
export async function addTrackerHistory({ dir, id, entry }) {
  const file = path.join(dir, "index.js");
  if (!fs.existsSync(file)) return false;
  const original = fs.readFileSync(file, "utf8");
  if (!/^\s*var source\s*=/.test(original)) return false;
  const code =
    `${original}\n;${await layerCode()}\n` +
    `;source=__trackerHistory.wrap(source,${JSON.stringify(id)},${JSON.stringify(entry.name ?? id)});\n`;
  if (!(await loads(code, id))) return false;
  fs.writeFileSync(file, code);
  entry.version = historyVersion(entry.version);
  const infoFile = path.join(dir, "info.json");
  if (fs.existsSync(infoFile)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
      fs.writeFileSync(infoFile, JSON.stringify({ ...info, version: entry.version }));
    } catch {
      fs.writeFileSync(infoFile, JSON.stringify(entry));
    }
  }
  return true;
}
