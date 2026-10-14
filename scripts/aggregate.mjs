// Copies the sources of other public Paperback 0.9 repositories into this one,
// so a single repository URL offers all of them. Runs after
// `paperback-cli bundle`, before the homepage is written.
//
// For each upstream in scripts/aggregate.config.json (in order):
//   - shallow-clone the branch its built repository is published from
//   - copy every source folder whose id isn't taken yet (ids compared without
//     case; this repository's own sources and earlier upstreams win)
//   - add its entry to versioning.json unchanged
// Then write third-party.json (what came from where, at which commit) and the
// license texts next to the bundles. An upstream that can't be fetched is
// skipped with a warning so the deploy still goes out.
//
// Usage: node scripts/aggregate.mjs [bundleFolder]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const folder = process.argv[2] ?? "bundles";
const configPath = path.join(import.meta.dirname, "aggregate.config.json");
const licensesDir = path.join(import.meta.dirname, "..", "third-party", "licenses");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const versioningPath = path.join(folder, "versioning.json");
const versioning = JSON.parse(fs.readFileSync(versioningPath, "utf8"));

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const taken = new Map(versioning.sources.map((source) => [source.id.toLowerCase(), "own"]));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-"));
const upstreams = [];

function git(args, options = {}) {
  return execFileSync("git", args, { stdio: "pipe", timeout: 300_000, ...options })
    .toString()
    .trim();
}

for (const upstream of config.upstreams) {
  const dir = path.join(work, upstream.repo.replace(/[^A-Za-z0-9._-]/g, "_"));
  const entry = {
    repo: upstream.repo,
    label: upstream.label,
    license: upstream.license,
    licenseFile: upstream.licenseFile,
    sourceCode: upstream.sourceCode,
    url: `https://github.com/${upstream.repo}`,
    added: [],
    skipped: [],
  };
  upstreams.push(entry);
  try {
    git([
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      upstream.branch,
      `https://github.com/${upstream.repo}.git`,
      dir,
    ]);
    entry.commit = git(["-C", dir, "rev-parse", "HEAD"]);
  } catch (error) {
    entry.error = "couldn't be fetched";
    console.warn(`[aggregate] ${upstream.repo}: ${error.message.split("\n")[0]}`);
    continue;
  }

  const base = path.join(dir, upstream.path ?? "");
  let theirs;
  try {
    theirs = JSON.parse(fs.readFileSync(path.join(base, "versioning.json"), "utf8"));
  } catch {
    entry.error = "no versioning.json";
    console.warn(`[aggregate] ${upstream.repo}: no versioning.json at ${upstream.path || "/"}`);
    continue;
  }

  for (const source of theirs.sources ?? []) {
    const id = String(source?.id ?? "");
    const key = id.toLowerCase();
    if (!SAFE_ID.test(id)) {
      entry.skipped.push({ id, why: "unusual id" });
      continue;
    }
    if (taken.has(key)) {
      const owner = taken.get(key);
      entry.skipped.push({ id, why: owner === "own" ? "already here" : `taken from ${owner}` });
      continue;
    }
    const from = path.join(base, id);
    if (!fs.existsSync(path.join(from, "index.js"))) {
      entry.skipped.push({ id, why: "no bundle" });
      continue;
    }
    fs.cpSync(from, path.join(folder, id), { recursive: true });
    versioning.sources.push(source);
    taken.set(key, upstream.label);
    entry.added.push(id);
  }
  console.log(
    `[aggregate] ${upstream.repo}@${entry.commit.slice(0, 7)}: +${entry.added.length}` +
      (entry.skipped.length ? `, skipped ${entry.skipped.map((s) => s.id).join(", ")}` : ""),
  );
}

fs.writeFileSync(versioningPath, JSON.stringify(versioning));
fs.cpSync(licensesDir, path.join(folder, "licenses"), { recursive: true });
fs.writeFileSync(
  path.join(folder, "third-party.json"),
  JSON.stringify({ generated: new Date().toISOString(), upstreams }, null, 2),
);
fs.rmSync(work, { recursive: true, force: true });

const added = upstreams.reduce((sum, u) => sum + u.added.length, 0);
console.log(`[aggregate] ${versioning.sources.length} sources (${added} from other repositories)`);
