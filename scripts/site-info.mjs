// What a source's website has, for the homepage (scripts/stats.mjs):
//
//   titles  roughly how many titles: counted from the site's sitemap, the list
//           of its pages a site publishes for search engines
//   since   when the site's address was first registered (RDAP, the public
//           domain registration records, asked of the registry IANA lists)
//   kind    what it mostly has (manga, manhwa, manhua, Western comics or
//           novels): a sample of its titles from the daily check, looked up
//           on AniList (https://anilist.co)
//
// Each is a few requests per site and is kept for days (titles 7, kind 30,
// since until the address changes), so a daily run only looks up what's due.

import zlib from "node:zlib";

const BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Titles, from the sitemap ─────────────────────────────────────────────

async function getText(url, seconds = 25) {
  const response = await fetch(url, {
    headers: { "user-agent": BROWSER, accept: "application/xml,text/xml,text/plain,*/*" },
    signal: AbortSignal.timeout(seconds * 1000),
  });
  if (!response.ok) return null;
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  return bytes.toString("utf8");
}

const locsOf = (xml) =>
  [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) =>
    m[1].replace(/&amp;/g, "&"),
  );
const isIndex = (xml) => /<sitemapindex[\s>]/i.test(xml);
const isSitemap = (xml) => /<(urlset|sitemapindex)[\s>]/i.test(xml);

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname) + parsed.search;
  } catch {
    return "";
  }
}

// Sitemaps of titles, and sitemaps of anything else
const TITLE_MAP = /(manga|manhwa|manhua|series|comic|webtoon|title|book|novel|project)/i;
const OTHER_MAP =
  /(chapter|episode|categor|genre|tag|author|artist|page-sitemap|post-sitemap|news|blog|user|team|taxonom|release|status|type|year|format|local)/i;
// A title's page: /manga/<slug>, /series/<slug>, … (optionally under /en/)
const TITLE_PATH =
  /^\/(?:[a-z]{2}\/)?(?:manga|manhwa|manhua|series|serie|comics?|webtoons?|titles?|books?|novels?|read)\/[^/?#]+\/?$/i;
const ARCHIVE_PATH =
  /^\/?(?:[a-z]{2}\/)?(?:manga|manhwa|manhua|series|serie|comics?|webtoons?|titles?|books?|novels?|read)?\/?$/i;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function countIn(xml, pattern, budget, depth = 0) {
  if (!isIndex(xml)) {
    const urls = locsOf(xml).map(pathOf);
    return {
      matched: urls.filter((p) => pattern.test(p)).length,
      titles: urls.filter((p) => !ARCHIVE_PATH.test(p)).length,
    };
  }
  const children = locsOf(xml);
  const named = children.filter(
    (url) => TITLE_MAP.test(pathOf(url)) && !OTHER_MAP.test(pathOf(url)),
  );
  const total = { matched: 0, titles: 0 };
  // Sitemaps named for titles count whole; otherwise only pages that look
  // like a title's.
  const wanted = named.length ? named : children.filter((url) => !OTHER_MAP.test(pathOf(url)));
  let read = 0;
  let tried = 0;
  for (const child of wanted.slice(0, 40)) {
    if (budget.left-- <= 0) break;
    tried++;
    const text = await getText(child).catch(() => null);
    if (!text || !isSitemap(text)) continue;
    if (isIndex(text) && depth >= 1) continue;
    const part = await countIn(text, pattern, budget, depth + 1);
    read++;
    total.matched += part.matched;
    total.titles += named.length ? part.titles : part.matched;
  }
  // Big sites split their list over more sitemaps than are read: the rest
  // are taken to be like the ones read.
  if (read && wanted.length > tried) {
    const scale = wanted.length / tried;
    total.matched = Math.round(total.matched * scale);
    total.titles = Math.round(total.titles * scale);
  }
  return total;
}

// Sites with a public count instead of a sitemap
const COUNTS = {
  "mangadex.org": async () => {
    const response = await fetch("https://api.mangadex.org/manga?limit=1", {
      signal: AbortSignal.timeout(20_000),
    });
    return response.ok ? (await response.json()).total : null;
  },
};

// Roughly how many titles a site has, or null. `titlePath` is where the
// source opened a title ("/manga/"), when the check saw it.
export async function countTitles(host, titlePath) {
  const domain = host.replace(/^www\./, "");
  if (COUNTS[domain]) return (await COUNTS[domain]().catch(() => null)) ?? null;
  const base = `https://${host}`;
  const patterns = [];
  if (titlePath && titlePath.length > 1)
    patterns.push(new RegExp(`^${escapeRegExp(titlePath)}[^/?#]+/?$`, "i"));
  patterns.push(TITLE_PATH);
  const starts = [];
  const robots = await getText(`${base}/robots.txt`, 15).catch(() => null);
  for (const match of (robots ?? "").matchAll(/^\s*sitemap:\s*(\S+)/gim)) starts.push(match[1]);
  starts.push(`${base}/sitemap_index.xml`, `${base}/sitemap.xml`, `${base}/wp-sitemap.xml`);
  for (const start of [...new Set(starts)].slice(0, 5)) {
    const xml = await getText(start).catch(() => null);
    if (!xml || !isSitemap(xml)) continue;
    for (const pattern of patterns) {
      const counted = await countIn(xml, pattern, { left: 45 });
      const best = isIndex(xml) ? counted.titles : counted.matched;
      if (best >= 5) return best;
    }
  }
  return null;
}

// ── When the address was registered (RDAP) ────────────────────────────────

// The registered domain: example.com for www.example.com, example.co.uk
export function registeredDomain(host) {
  const labels = String(host ?? "")
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".")
    .filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const two = labels.slice(-2).join(".");
  return /^(co|com|net|org|ac|or|ne|go)\.[a-z]{2}$/.test(two) ? labels.slice(-3).join(".") : two;
}

// Which registry answers for each top-level domain (IANA's RDAP list)
let registries;
async function registryFor(domain) {
  registries ??= fetch("https://data.iana.org/rdap/dns.json", {
    signal: AbortSignal.timeout(30_000),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      const map = new Map();
      for (const [tlds, urls] of data.services ?? []) {
        const url = (urls ?? []).find((u) => u.startsWith("https://")) ?? urls?.[0];
        for (const tld of tlds ?? [])
          if (url) map.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
      }
      return map;
    })
    .catch(() => {
      registries = undefined;
      return new Map();
    });
  const labels = domain.split(".");
  const map = await registries;
  // co.jp-style names are under the last label's registry
  return map.get(labels.slice(-2).join(".")) ?? map.get(labels.at(-1));
}

// "YYYY-MM-DD", null when the registry doesn't say (or there's no public
// registry for the name), undefined when it couldn't be asked (try again
// next time).
export async function registeredOn(domain) {
  try {
    const base = await registryFor(domain);
    if (!base) return registries ? null : undefined;
    const response = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
      headers: { accept: "application/rdap+json, application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) return undefined;
    const data = await response.json();
    const event = (data.events ?? []).find(
      (e) => String(e.eventAction).toLowerCase() === "registration",
    );
    const date = String(event?.eventDate ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    return undefined;
  }
}

// ── What it mostly has (AniList) ──────────────────────────────────────────

export const KINDS = ["manga", "manhwa", "manhua", "comic", "novel"];
// Bumped when how a sample is read changes, so the next run reads them again
export const KIND_VERSION = 2;

const normalize = (text) =>
  String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// The same title, give or take punctuation, a subtitle or a word or two
export function sameTitle(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  if (short.length >= 8 && long.includes(short)) return true;
  const one = new Set(x.split(" "));
  const two = new Set(y.split(" "));
  const shared = [...one].filter((word) => two.has(word)).length;
  return shared / new Set([...one, ...two]).size >= 0.6;
}

function kindOfMedia(media) {
  if (media.format === "NOVEL") return "novel";
  switch (media.countryOfOrigin) {
    case "JP":
      return "manga";
    case "KR":
      return "manhwa";
    case "CN":
    case "TW":
    case "HK":
      return "manhua";
    default:
      return "comic";
  }
}

// Western comics' titles: "Batman (2016)", "Saga #12"
const WESTERN_TITLE = /\(\d{4}(?:\s*-\s*\d{4})?\)\s*$|\s#\d+\b/;
const TAG_KINDS = [
  [/^(manhwa|korean)$/i, "manhwa"],
  [/^(manhua|chinese)$/i, "manhua"],
  [/^(manga|japanese)$/i, "manga"],
  [/^(western|comics?|american)$/i, "comic"],
  [/^(novel|web novel|light novel)$/i, "novel"],
];

let lastAniList = 0;
let lastAniListStatus = 0;

// Up to three AniList entries for each title. A list per title, so a title
// it doesn't know is just an empty list (asking for one entry would make
// the whole answer an error).
async function askAniList(titles) {
  const query = `query (${titles.map((_, i) => `$s${i}: String`).join(", ")}) { ${titles
    .map(
      (_, i) =>
        `q${i}: Page(perPage: 3) { media(search: $s${i}, type: MANGA) { countryOfOrigin format title { romaji english native } synonyms } }`,
    )
    .join(" ")} }`;
  const variables = Object.fromEntries(titles.map((title, i) => [`s${i}`, title]));
  for (let attempt = 0; attempt < 3; attempt++) {
    // About 30 requests a minute, AniList's limit
    const wait = lastAniList + 2100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastAniList = Date.now();
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 || response.status >= 500) {
      await sleep(Math.min(Number(response.headers.get("retry-after")) || 60, 90) * 1000);
      continue;
    }
    lastAniListStatus = response.status;
    const body = await response.json().catch(() => null);
    if (!body?.data) {
      console.warn(
        `[stats] AniList: HTTP ${response.status} ${JSON.stringify(body?.errors ?? body)?.slice(0, 200)}`,
      );
      return null;
    }
    return titles.map((_, i) => body.data[`q${i}`]?.media ?? []);
  }
  return null;
}

const namesOf = (media) => [
  media.title?.romaji,
  media.title?.english,
  media.title?.native,
  ...(media.synonyms ?? []),
];

// What a sample of titles is: counts per kind, or null when too few were
// recognised. `sample` is { titles: [...], tags: { title: [tag, ...] } }.
export async function kindOf(sample) {
  const titles = [
    ...new Set((sample?.titles ?? []).map((t) => String(t).trim()).filter(Boolean)),
  ].slice(0, 10);
  if (!titles.length) return null;
  let found = await askAniList(titles).catch(() => null);
  // Too big a question for AniList: ask in two halves
  if (!found && lastAniListStatus === 400 && titles.length > 3) {
    const half = Math.ceil(titles.length / 2);
    const first = await askAniList(titles.slice(0, half)).catch(() => null);
    const second = first && (await askAniList(titles.slice(half)).catch(() => null));
    found = first && second ? [...first, ...second] : null;
  }
  if (!found) return null;
  const counts = {};
  titles.forEach((title, i) => {
    const media = (found[i] ?? []).find((entry) =>
      namesOf(entry).some((name) => sameTitle(name, title)),
    );
    let kind;
    if (media) {
      kind = kindOfMedia(media);
    } else if (WESTERN_TITLE.test(title)) {
      kind = "comic";
    } else {
      for (const tag of sample.tags?.[title] ?? []) {
        const hit = TAG_KINDS.find(([pattern]) => pattern.test(String(tag).trim()));
        if (hit) {
          kind = hit[1];
          break;
        }
      }
    }
    if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
  });
  const recognised = Object.values(counts).reduce((a, b) => a + b, 0);
  // Three titles, or all of a small sample (sites for a single series)
  return recognised >= Math.min(3, titles.length) ? counts : null;
}

// Novel sources are novels whatever AniList matched (it lists adaptations).
export function isNovelSource(source, host) {
  const description = String(source.description ?? source.desc ?? "");
  return (
    /novel/i.test(source.name ?? "") ||
    /royalroad|scribblehub|novel/i.test(host ?? "") ||
    (/\bnovels?\b/i.test(description) && !/manga|manhwa|manhua|comic|webtoon/i.test(description))
  );
}

// What a source's name says it is, when there's no sample: only clear cases.
export function kindFromName(source, host) {
  if (isNovelSource(source, host)) return { novel: 1 };
  if (/manhwa|toon/i.test(source.name ?? "")) return { manhwa: 1 };
  if (/manhua/i.test(source.name ?? "")) return { manhua: 1 };
  return null;
}
