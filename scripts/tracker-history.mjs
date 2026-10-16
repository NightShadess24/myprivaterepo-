// Puts a layer around trackers from other repositories when the Trackers
// repositories are built: the original bundle, unchanged, then
// scripts/tracker-history/layer.js (0.9) or layer08.js (0.8), which add an
// "Automatic updates" page (time since the last update, and the history of
// what was sent) to the tracker's settings. The version's last number gets
// two more digits (1.0.0-alpha.19 → 1.0.0-alpha.1901, 1.0.1 → 1.0.101), so
// the app offers it as an update.
//
// Used by scripts/aggregate.mjs.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { build } from "esbuild";

// Raised when the layers change, so the app offers the trackers again.
export const HISTORY_REVISION = 1;

const layers = new Map();

function layerCode(file, globalName, target) {
  if (!layers.has(file)) {
    layers.set(
      file,
      build({
        entryPoints: [path.join(import.meta.dirname, "tracker-history", file)],
        bundle: true,
        format: "iife",
        globalName,
        platform: "browser",
        target,
        minify: true,
        legalComments: "none",
        write: false,
        logLevel: "silent",
      }).then((result) => result.outputFiles[0].text),
    );
  }
  return layers.get(file);
}

export function historyVersion(version) {
  const text = String(version ?? "1.0.0").trim() || "1.0.0";
  const match = /(\d+)(?!.*\d)/.exec(text);
  if (!match) return `${text}.${HISTORY_REVISION}`;
  const bumped = String(Number(match[1]) * 100 + HISTORY_REVISION);
  return text.slice(0, match.index) + bumped + text.slice(match.index + match[1].length);
}

const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
const basics = {
  console: quiet,
  TextDecoder,
  TextEncoder,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
  URL,
};

// Loads a 0.9 bundle the way the app does and checks the tracker is there.
async function loads09(code, id) {
  const { ApplicationPolyfill } = await import("@paperback/runtime-polyfills");
  const context = vm.createContext({ Application: ApplicationPolyfill(), ...basics });
  try {
    const source = vm.runInContext(`${code}\n;source`, context, { timeout: 10000 });
    return typeof source?.[id]?.processChapterReadActionQueue === "function";
  } catch {
    return false;
  }
}

// Loads a 0.8 bundle (it only needs `App` once the tracker is made) and checks
// the layer took and the tracker reports the new version.
function loads08(code, id, version) {
  const context = vm.createContext({ App: {}, ...basics });
  try {
    vm.runInContext(code, context, { timeout: 10000 });
    const Sources = vm.runInContext(
      "typeof Sources === 'undefined' ? undefined : Sources",
      context,
    );
    return (
      Sources?.[id]?.prototype?.__pbsync === true &&
      (!Sources[`${id}Info`] || Sources[`${id}Info`].version === version)
    );
  } catch {
    return false;
  }
}

/**
 * `dir` is the copied tracker, `entry` its versioning.json entry, whose
 * version is raised; `app` is "0.9" or "0.8". Returns false (and leaves the
 * tracker as it was) when the layer can't be added.
 */
export async function addTrackerHistory({ dir, id, entry, app = "0.9" }) {
  const name = String(entry.name ?? id);
  const version = historyVersion(entry.version);
  let file;
  let code;
  if (app === "0.8") {
    file = path.join(dir, "source.js");
    if (!fs.existsSync(file)) return false;
    const original = fs.readFileSync(file, "utf8");
    code =
      `${original}\n;${await layerCode("layer08.js", "__trackerHistory08", "es2017")}\n` +
      `;(function(){if(typeof Sources!=="undefined")__trackerHistory08.wrap(Sources,${JSON.stringify(id)},${JSON.stringify(name)},${JSON.stringify(version)})})();\n`;
    if (!loads08(code, id, version)) return false;
  } else {
    file = path.join(dir, "index.js");
    if (!fs.existsSync(file)) return false;
    const original = fs.readFileSync(file, "utf8");
    if (!/^\s*var source\s*=/.test(original)) return false;
    code =
      `${original}\n;${await layerCode("layer.js", "__trackerHistory", "es2020")}\n` +
      `;source=__trackerHistory.wrap(source,${JSON.stringify(id)},${JSON.stringify(name)});\n`;
    if (!(await loads09(code, id))) return false;
  }
  fs.writeFileSync(file, code);
  entry.version = version;
  const infoFile = path.join(dir, "info.json");
  if (fs.existsSync(infoFile)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
      fs.writeFileSync(infoFile, JSON.stringify({ ...info, version }));
    } catch {
      fs.writeFileSync(infoFile, JSON.stringify(entry));
    }
  }
  return true;
}
