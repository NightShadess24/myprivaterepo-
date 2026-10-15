// `npm run bundle`: builds this branch's repository into bundles/.
//
//   0.9 branches: the sources in src/ (paperback-cli), then the other
//   repositories' sources and the 0.8-only ones ported (scripts/aggregate.mjs)
//   0.8 branches: the 0.8 repositories' sources, then this repository's own
//   sources and the other 0.9-only ones, ported
//
// then the homepage. The branch is BUILD_REF (set by scheduled runs, which
// build more than one branch), else GITHUB_REF_NAME, else the checked-out one.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function branchName() {
  if (process.env.BUILD_REF) return process.env.BUILD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  try {
    return execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const branch = branchName();
const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit", env: { ...process.env, BUILD_REF: branch } });

if (branch.startsWith("0.8/")) {
  // This repository's own sources, built for 0.9 (paperback-cli writes into
  // bundles/<folder>) and set aside, to be ported first
  run("npx", ["paperback-cli", "bundle", "--folder", "own"]);
  fs.rmSync("bundles-own", { recursive: true, force: true });
  fs.renameSync(path.join("bundles", "own"), "bundles-own");
  run("node", ["scripts/aggregate.mjs", "bundles", "--version", "0.8", "--own", "bundles-own"]);
} else {
  run("npx", ["paperback-cli", "bundle"]);
  run("node", ["scripts/aggregate.mjs", "bundles", "--version", "0.9"]);
}
// Source stats (works-check, website popularity); checked on daily runs.
run("node", ["scripts/stats.mjs", "bundles"]);
run("node", ["scripts/homepage.mjs", "bundles"]);
