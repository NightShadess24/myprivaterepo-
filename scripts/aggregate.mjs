// Brings the sources of other public Paperback repositories into this one, so
// a single repository URL offers all of them, and makes the ones that exist
// for only one app version usable on the other.
//
// The same script builds both repositories on this site; the branch decides:
//
//   0.9 (0.9/stable): after `paperback-cli bundle`,
//     1. copies every source of the 0.9 repositories in `upstreams`
//     2. adds every source of the 0.8 repositories in `upstreams08` that
//        isn't here yet, ported to 0.9 (scripts/crossport.mjs)
//
//   0.8 (0.8/stable): from an empty folder,
//     1. copies every source of the 0.8 repositories in `upstreams08`
//     2. adds every source of the 0.9 repositories in `upstreams` that isn't
//        here yet, ported to 0.8
//
// Each app version has three repositories, by each source's own content
// rating and language (scripts/languages.mjs):
//   stable     English (or multi-language) sources for everyone or mature readers
//   languages  sources in other languages, for everyone or mature readers
//   nsfw       sources rated 18+, in any language
//
// Repositories are listed in scripts/aggregate.config.json; only ones under an
// open-source license that allows it are. A source counts as already here when
// its id or name matches one that is (ignoring case and punctuation) or it
// reads the same website. Earlier repositories win. third-party.json records
// what came from where, at which commit; the license texts go next to the
// bundles. A repository that can't be fetched is skipped with a warning so
// the deploy still goes out.
//
// Usage: node scripts/aggregate.mjs [bundleFolder] [--version 0.8|0.9]
//          [--flavor stable|languages|nsfw]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { portToV8, portToV9, read08Info } from "./crossport.mjs";
import { domainLanguage, isEnglish, languageCode } from "./languages.mjs";

const args = process.argv.slice(2);
const versionFlag = args.indexOf("--version");
const flavorFlag = args.indexOf("--flavor");
const folder =
  args.find((arg, i) => !arg.startsWith("--") && i !== versionFlag + 1 && i !== flavorFlag + 1) ??
  "bundles";

function branchName() {
  if (process.env.BUILD_REF) return process.env.BUILD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  try {
    return execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const version =
  versionFlag >= 0 ? args[versionFlag + 1] : branchName().startsWith("0.8/") ? "0.8" : "0.9";
// stable, languages or nsfw (anything else: every source).
const flavor = flavorFlag >= 0 ? args[flavorFlag + 1] : (branchName().split("/")[1] ?? "");
const isAdult = (entry) => String(entry?.contentRating ?? "").toUpperCase() === "ADULT";
// Which of the three repositories a source goes in.
const placeOf = (entry, language) =>
  isAdult(entry) ? "nsfw" : isEnglish(language) ? "stable" : "languages";
const belongsHere = (entry, language) =>
  !["stable", "languages", "nsfw"].includes(flavor) || placeOf(entry, language) === flavor;
const PLACES = {
  stable: "in the Stable repository",
  languages: "not English (in the Languages repository)",
  nsfw: "18+ (in the NSFW repository)",
};

const configPath = path.join(import.meta.dirname, "aggregate.config.json");
const licensesDir = path.join(import.meta.dirname, "..", "third-party", "licenses");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const versioningPath = path.join(folder, "versioning.json");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Sources not brought in (aggregate.config.json `leaveOut`): sites for a
// single series.
const LEAVE_OUT = new Set((config.leaveOut?.ids ?? []).map((id) => id.toLowerCase()));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-"));

function git(gitArgs) {
  return execFileSync("git", gitArgs, { stdio: "pipe", timeout: 300_000 }).toString().trim();
}

// ── What's already here ──────────────────────────────────────────────────

const ALIASES = { paperback: "komga", kavya: "kavita", comixto: "comix" };
const norm = (value) => {
  const key = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return ALIASES[key] ?? key;
};
const hostOf = (url) =>
  (/^[a-z]+:\/\/([^/?#:]+)/i.exec(String(url ?? ""))?.[1] ?? "")
    .toLowerCase()
    .replace(/^www\./, "");
// 0.9 sources name their website in the description ("… from mangadex.org.")
const hostInText = (text) =>
  (
    /\b((?:[a-z0-9-]+\.)+(?:[a-z]{2,}))\b/i.exec(
      String(text ?? "").replace(/https?:\/\//gi, ""),
    )?.[1] ?? ""
  )
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");

const describe08 = (entry) => ({
  id: entry.id,
  name: entry.name,
  host: hostOf(entry.websiteBaseURL),
});
const describe09 = (info) => ({ id: info.id, name: info.name, host: hostInText(info.description) });

class Catalog {
  ids = new Map();
  names = new Map();
  hosts = new Map();
  add({ id, name, host }, owner) {
    this.ids.set(norm(id), owner);
    if (name && !this.names.has(norm(name))) this.names.set(norm(name), { owner, host });
    if (host && !this.hosts.has(host)) this.hosts.set(host, owner);
  }
  // Who already has this source, or undefined.
  find({ id, name, host }) {
    if (this.ids.has(norm(id))) return this.ids.get(norm(id));
    if (host && this.hosts.has(host)) return this.hosts.get(host);
    const named = name ? this.names.get(norm(name)) : undefined;
    if (named && (!named.host || !host || named.host === host)) return named.owner;
    return undefined;
  }
}

// ── Fetching a repository ────────────────────────────────────────────────

const clones = new Map();
function clone(repo, branch) {
  const key = `${repo}@${branch}`;
  if (!clones.has(key)) {
    const dir = path.join(work, key.replace(/[^A-Za-z0-9._-]/g, "_"));
    try {
      git([
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        branch,
        `https://github.com/${repo}.git`,
        dir,
      ]);
      clones.set(key, { dir, commit: git(["-C", dir, "rev-parse", "HEAD"]) });
    } catch (error) {
      clones.set(key, { error: error.message.split("\n")[0] });
    }
  }
  return clones.get(key);
}

// A repository only published on GitHub Pages (no branch with the build):
// its versioning.json and each source's files are downloaded (0.8 layout).
async function download(pages) {
  const base = pages.endsWith("/") ? pages : `${pages}/`;
  const dir = path.join(work, base.replace(/[^A-Za-z0-9._-]/g, "_"));
  const get = async (file) => {
    const response = await fetch(base + file, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const versioningFile = await get("versioning.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "versioning.json"), versioningFile);
  const theirs = JSON.parse(versioningFile.toString("utf8"));
  for (const source of theirs.sources ?? []) {
    if (!SAFE_ID.test(String(source?.id ?? ""))) continue;
    const icon = path.basename(String(source.icon ?? "icon.png"));
    try {
      fs.mkdirSync(path.join(dir, source.id, "includes"), { recursive: true });
      fs.writeFileSync(path.join(dir, source.id, "source.js"), await get(`${source.id}/source.js`));
      fs.writeFileSync(
        path.join(dir, source.id, "includes", icon),
        await get(`${source.id}/includes/${icon}`),
      );
    } catch (error) {
      console.warn(`[aggregate] ${base}${source.id}: ${error.message}`);
    }
  }
  return { dir, commit: String(theirs.buildTime ?? "") };
}

// The sources one upstream offers: [{ id, entry, dir }], in its order.
async function sourcesOf(upstream, record) {
  let base;
  if (upstream.pages) {
    try {
      const fetched = await download(upstream.pages);
      base = fetched.dir;
      record.commit = fetched.commit;
    } catch (error) {
      record.error = "couldn't be fetched";
      console.warn(`[aggregate] ${upstream.pages}: ${error.message}`);
      return [];
    }
  } else {
    const fetched = clone(upstream.repo, upstream.branch);
    if (fetched.error) {
      record.error = "couldn't be fetched";
      console.warn(`[aggregate] ${upstream.repo}: ${fetched.error}`);
      return [];
    }
    record.commit = fetched.commit;
    base = path.join(fetched.dir, upstream.path ?? "");
  }

  if (upstream.layout === "info") {
    // 0.9 bundles without a versioning.json: each source has its info.json.
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, "info.json")))
      .map((d) => {
        const entry = JSON.parse(fs.readFileSync(path.join(base, d.name, "info.json"), "utf8"));
        entry.id ??= d.name;
        return { id: String(entry.id), entry, dir: path.join(base, d.name) };
      });
  }
  let theirs;
  try {
    theirs = JSON.parse(fs.readFileSync(path.join(base, "versioning.json"), "utf8"));
  } catch {
    record.error = "no versioning.json";
    console.warn(
      `[aggregate] ${upstream.repo ?? upstream.pages}: no versioning.json at ${upstream.path || "/"}`,
    );
    return [];
  }
  return (theirs.sources ?? []).filter(Boolean).map((entry) => ({
    id: String(entry.id ?? ""),
    entry,
    dir: path.join(base, String(entry.id ?? "")),
  }));
}

function recordFor(upstream, kind) {
  return {
    repo: upstream.repo ?? hostOf(upstream.pages),
    label: upstream.label,
    license: upstream.license,
    licenseFile: upstream.licenseFile,
    sourceCode: upstream.sourceCode,
    url: upstream.repo ? `https://github.com/${upstream.repo}` : upstream.pages,
    appVersion: kind,
    added: [],
    ported: [],
    skipped: [],
  };
}

// ── Build ────────────────────────────────────────────────────────────────

const records = [];
const catalog = new Catalog();
const taken = new Set();
const languages = {};
// Each source's website (for the homepage's popularity ranking).
const hosts = {};
let versioning;

const native = version === "0.8" ? config.upstreams08 : config.upstreams;
const foreign = version === "0.8" ? config.upstreams : config.upstreams08;
const nativeFile = version === "0.8" ? "source.js" : "index.js";
const describeNative = version === "0.8" ? describe08 : describe09;
const describeForeign = version === "0.8" ? describe09 : describe08;
const otherVersion = version === "0.8" ? "0.9" : "0.8";

// Every repository's list first: 0.8 sources take their language from the
// same site's 0.9 source when there is one.
const nativeLists = [];
for (const upstream of native ?? []) {
  const record = recordFor(upstream, version);
  nativeLists.push({ upstream, record, list: await sourcesOf(upstream, record) });
}
const foreignLists = [];
for (const upstream of foreign ?? []) {
  const record = recordFor(upstream, otherVersion);
  foreignLists.push({ upstream, record, list: await sourcesOf(upstream, record) });
}
records.push(...nativeLists.map((x) => x.record), ...foreignLists.map((x) => x.record));

if (version === "0.9") versioning = JSON.parse(fs.readFileSync(versioningPath, "utf8"));
const lists09 = version === "0.9" ? nativeLists : foreignLists;
const lists08 = version === "0.8" ? nativeLists : foreignLists;
const overrides = config.languageOverrides ?? {};

// What a 0.8 source itself says: its SourceInfo, else a language tag.
const said08 = new Map();
function said08Of(entry, dir) {
  if (!said08.has(entry.id)) {
    let code = languageCode(read08Info(dir, entry.id)?.language);
    for (const tag of entry.tags ?? []) {
      if (code) break;
      code = languageCode(tag?.text);
    }
    said08.set(entry.id, code);
  }
  return said08.get(entry.id);
}

// The same site's language as the other app version's source has it.
function hintMap(items, describe, said) {
  const map = new Map();
  for (const { entry, dir } of items) {
    const code = said(entry, dir);
    if (!code) continue;
    const about = describe(entry);
    if (!map.has(`id:${norm(about.id)}`)) map.set(`id:${norm(about.id)}`, code);
    if (about.host && !map.has(`host:${about.host}`)) map.set(`host:${about.host}`, code);
  }
  return map;
}
const hints09 = hintMap(
  [...(versioning?.sources ?? []).map((entry) => ({ entry })), ...lists09.flatMap((x) => x.list)],
  describe09,
  (info) => languageCode(info.language),
);
const hints08 = hintMap(
  lists08.flatMap((x) => x.list),
  describe08,
  said08Of,
);
const hint = (map, about) =>
  map.get(`id:${norm(about.id)}`) ?? (about.host ? map.get(`host:${about.host}`) : undefined);

// A language other than English, said by either version's source, wins over
// "en" (often just left at the template's default).
function language09(info) {
  if (overrides[info.id]) return overrides[info.id];
  const own = languageCode(info.language);
  if (own && !isEnglish(own)) return own;
  const about = describe09(info);
  const other = hint(hints08, about);
  if (other && !isEnglish(other)) return other;
  return own || domainLanguage(about.host) || "en";
}
function language08(entry, dir) {
  if (overrides[entry.id]) return overrides[entry.id];
  const own = said08Of(entry, dir);
  if (own && !isEnglish(own)) return own;
  const about = describe08(entry);
  const other = hint(hints09, about);
  if (other && !isEnglish(other)) return other;
  return own || other || domainLanguage(about.host) || "en";
}
const languageNative = version === "0.8" ? language08 : language09;
const languageForeign = version === "0.8" ? language09 : language08;

const repository =
  config.repositories?.[`${version}/${flavor}`] ?? config.repositories?.[`${version}/stable`];
const leftOut = [];
if (version === "0.8") {
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  versioning = {
    buildTime: new Date(),
    builtWith: { toolchain: "0.8.7", types: "0.8.7" },
    repository,
    sources: [],
  };
} else {
  if (repository) versioning.repository = repository;
  const kept = [];
  for (const source of versioning.sources) {
    catalog.add(describe09(source), "here");
    taken.add(source.id.toLowerCase());
    const language = language09(source);
    if (belongsHere(source, language)) {
      kept.push(source);
      if (!isEnglish(language)) languages[source.id] = language;
      if (describe09(source).host) hosts[source.id] = describe09(source).host;
    } else {
      fs.rmSync(path.join(folder, source.id), { recursive: true, force: true });
      leftOut.push(`${source.id} (${PLACES[placeOf(source, language)]})`);
    }
  }
  versioning.sources = kept;
}

// 1. Sources made for this app version, copied as they are.
for (const { upstream, record, list } of nativeLists) {
  for (const { id, entry, dir } of list) {
    if (!SAFE_ID.test(id)) {
      record.skipped.push({ id, why: "unusual id" });
      continue;
    }
    if (LEAVE_OUT.has(id.toLowerCase())) {
      record.skipped.push({ id, why: "a site for a single series" });
      continue;
    }
    if (taken.has(id.toLowerCase())) {
      const owner = catalog.find({ id });
      record.skipped.push({ id, why: owner === "here" ? "already here" : `taken from ${owner}` });
      continue;
    }
    if (!fs.existsSync(path.join(dir, nativeFile))) {
      record.skipped.push({ id, why: "no bundle" });
      continue;
    }
    // Counts as here even when it goes in another of the three repositories.
    taken.add(id.toLowerCase());
    catalog.add(describeNative(entry), upstream.label);
    const language = languageNative(entry, dir);
    if (!belongsHere(entry, language)) {
      record.skipped.push({ id, why: PLACES[placeOf(entry, language)] });
      continue;
    }
    fs.cpSync(dir, path.join(folder, id), { recursive: true });
    versioning.sources.push(entry);
    if (!isEnglish(language)) languages[id] = language;
    if (describeNative(entry).host) hosts[id] = describeNative(entry).host;
    record.added.push(id);
  }
  console.log(
    `[aggregate] ${record.repo}@${String(record.commit ?? "").slice(0, 7)}: +${record.added.length}` +
      (record.skipped.length ? `, skipped ${record.skipped.length}` : ""),
  );
}

// 2. Sources only the other app version has, ported.
for (const { upstream, record, list } of foreignLists) {
  for (const { id, entry, dir } of list) {
    if (!SAFE_ID.test(id)) {
      record.skipped.push({ id, why: "unusual id" });
      continue;
    }
    if (LEAVE_OUT.has(id.toLowerCase())) {
      record.skipped.push({ id, why: "a site for a single series" });
      continue;
    }
    const about = describeForeign(entry);
    const owner = taken.has(id.toLowerCase())
      ? (catalog.find({ id }) ?? "here")
      : catalog.find(about);
    if (owner) {
      record.skipped.push({ id, why: owner === "here" ? "already here" : `already from ${owner}` });
      continue;
    }
    taken.add(id.toLowerCase());
    catalog.add(about, upstream.label);
    const language = languageForeign(entry, dir);
    if (!belongsHere(entry, language)) {
      record.skipped.push({ id, why: PLACES[placeOf(entry, language)] });
      continue;
    }
    const port =
      version === "0.8"
        ? await portToV8({
            id,
            dir,
            info: entry,
            outDir: folder,
            website: about.host ? `https://${about.host}` : "",
          })
        : await portToV9({ id, dir, entry: { ...entry, language }, outDir: folder });
    if (port.skipped) {
      record.skipped.push({ id, why: port.skipped });
      continue;
    }
    versioning.sources.push(version === "0.8" ? port.entry : port.info);
    if (!isEnglish(language)) languages[id] = language;
    if (about.host) hosts[id] = about.host;
    record.ported.push(id);
  }
  console.log(
    `[aggregate] ${record.repo}: ported ${record.ported.length} to ${version}` +
      (record.skipped.length ? `, skipped ${record.skipped.length}` : ""),
  );
}

fs.writeFileSync(versioningPath, JSON.stringify(versioning));
fs.cpSync(licensesDir, path.join(folder, "licenses"), { recursive: true });
fs.writeFileSync(
  path.join(folder, "third-party.json"),
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      appVersion: version,
      languages,
      hosts,
      upstreams: records,
    },
    null,
    2,
  ),
);
fs.rmSync(work, { recursive: true, force: true });

const added = records.reduce((sum, r) => sum + r.added.length, 0);
const ported = records.reduce((sum, r) => sum + r.ported.length, 0);
if (leftOut.length) console.log(`[aggregate] own sources left out: ${leftOut.join(", ")}`);
console.log(
  `[aggregate] ${version}${flavor ? ` ${flavor}` : ""}: ${versioning.sources.length} sources (${added} from other repositories, ${ported} ported from ${otherVersion})`,
);
