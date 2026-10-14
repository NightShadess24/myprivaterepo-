/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type SourceManga,
  type Tag,
} from "@paperback/types";
import * as cheerio from "cheerio";

import {
  DOMAIN,
  NO_IMAGE,
  type ChapterItem,
  type ChapterPages,
  type MangaItem,
  type MangaListItem,
  type ResultManga,
} from "./models";

// Comix server-renders page state into
// `<script type="application/json" id="initial-data">` as a React-Query cache:
// `{ page, queries: { '["manga","detail","{hid}"]': <payload>, ... } }`. Detail
// pages embed the manga here because the JSON API itself is now 403.
//
// The `["manga","detail","{hid}"]` query value is the Manga object directly
// (unwrapped); guard for a future `{ result }` wrapper too, keying off `hid`.
function extractDetailManga(html: string): MangaItem | undefined {
  const $ = cheerio.load(html);
  // Script content is raw text (htmlparser2 does not entity-decode rawtext nodes),
  // so `.text()` returns the JSON verbatim.
  const raw = $("script#initial-data").text();
  if (!raw) return undefined;
  let queries: Record<string, unknown> | undefined;
  try {
    queries = (JSON.parse(raw) as { queries?: Record<string, unknown> }).queries;
  } catch {
    return undefined;
  }
  if (!queries) return undefined;
  const key = Object.keys(queries).find((k) => k.includes('"detail"'));
  if (key === undefined) return undefined;
  const value = queries[key] as MangaItem & { result?: MangaItem };
  const manga = value?.result ?? value;
  return manga?.hid !== undefined ? manga : undefined;
}

export const parseMangaList = (result: ResultManga): MangaListItem[] =>
  result.items.map((item) => ({
    mangaId: item.hid,
    title: item.title,
    imageUrl: getPoster(item),
    subtitle: `Chapter ${item.latestChapter || item.finalChapter}`,
    contentRating: toContentRating(item.contentRating),
    publishDate: parseRelativeDate(item.chapterUpdatedAtFormatted),
    supertitle: [item.type.toUpperCase(), item.year].filter(Boolean).join(" · "),
    summary: item.synopsis,
    infoItems: [
      { symbol: "star.fill", text: item.ratedAvg.toFixed(1) },
      { symbol: "heart.fill", text: formatCount(item.followsTotal) },
    ],
  }));

const formatCount = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toString();

export function parseMangaDetails(mangaId: string, html: string): SourceManga {
  const manga = extractDetailManga(html);
  if (!manga) {
    throw new Error(`Comix: could not find detail data for ${mangaId}`);
  }
  const toTags = (items: { id: number; title: string }[]): Tag[] =>
    items.map((item) => ({ id: item.id.toString(), title: item.title }));
  return {
    mangaId,
    mangaInfo: {
      thumbnailUrl: getPoster(manga),
      bannerUrl: getPoster(manga),
      synopsis: manga.synopsis,
      primaryTitle: manga.title,
      secondaryTitles: manga.altTitles,
      contentRating: toContentRating(manga.contentRating),
      status: manga.status,
      artist: manga.artists?.map((artist) => artist.title).join(" ") ?? "",
      author: manga.authors?.map((author) => author.title).join(" ") ?? "",
      rating: manga.ratedAvg / 10,
      tagGroups: [
        { id: "demographic", title: "demographic", tags: toTags(manga.demographics) },
        { id: "genres", title: "genres", tags: toTags(manga.genres) },
      ],
      shareUrl: `${DOMAIN}${manga.url}`,
    },
  };
}

export const parseChapters = (sourceManga: SourceManga, items: ChapterItem[]): Chapter[] =>
  items.map((chapter) => ({
    chapterId: chapter.id.toString(),
    sourceManga,
    langCode: chapter.language || "en",
    chapNum: chapter.number,
    title: chapter.name || undefined,
    volume: chapter.volume ?? undefined,
    version: chapter.isOfficial
      ? `★ ${chapter.group?.name ?? "Official"}`
      : (chapter.group?.name ?? "Unknown"),
    sortingIndex: chapter.number,
    publishDate: parseRelativeDate(chapter.createdAtFormatted ?? ""),
    additionalInfo: { vote: String(chapter.votes ?? 0), url: chapterPath(chapter.url) },
  }));

// Chapter URLs have come both site-relative and absolute; the reader page is
// always loaded from DOMAIN, so keep only the path.
export function chapterPath(url: string): string {
  const titleAt = url.indexOf("/title/");
  if (titleAt > 0) return url.slice(titleAt);
  return url.startsWith("/") ? url : `/${url}`;
}

export function parseChapterDetails(
  chapterId: string,
  mangaId: string,
  pages: ChapterPages,
): ChapterDetails {
  const base = (pages.baseUrl ?? "").replace(/\/$/, "");
  return {
    id: chapterId,
    mangaId,
    pages: pages.items.map((img) => {
      const url = img.url.startsWith("http") ? img.url : `${base}/${img.url.replace(/^\//, "")}`;
      return img.s === 1 ? withV3Flag(url) : url;
    }),
  };
}

// V3 pages are only served with their X-Scramble-* headers when `v3` is in the query.
function withV3Flag(url: string): string {
  const hashAt = url.indexOf("#");
  const path = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const query = path.split("?")[1] ?? "";
  if (query.split("&").some((param) => param.split("=")[0] === "v3")) return url;
  return `${path}${path.includes("?") ? "&" : "?"}v3${hash}`;
}

function toContentRating(content: string): ContentRating {
  switch (content) {
    case "suggestive":
      return ContentRating.MATURE;
    case "erotica":
    case "pornographic":
      return ContentRating.ADULT;
    default:
      return ContentRating.EVERYONE;
  }
}

function parseRelativeDate(value: string): Date {
  const now = new Date();
  const match = value
    .trim()
    .match(/^(\d+)\s*(mo|mon|month|yr|year|min|sec|hr|hour|day|week|[smhdwy])s?(\s+ago)?$/i);
  if (!match) {
    return now;
  }
  const amount = Number(match[1]);
  switch (match[2].toLowerCase()) {
    case "s":
    case "sec":
      now.setSeconds(now.getSeconds() - amount);
      break;
    case "m":
    case "min":
      now.setMinutes(now.getMinutes() - amount);
      break;
    case "h":
    case "hr":
    case "hour":
      now.setHours(now.getHours() - amount);
      break;
    case "d":
    case "day":
      now.setDate(now.getDate() - amount);
      break;
    case "w":
    case "week":
      now.setDate(now.getDate() - amount * 7);
      break;
    case "mo":
    case "mon":
    case "month":
      now.setMonth(now.getMonth() - amount);
      break;
    case "yr":
    case "y":
    case "year":
      now.setFullYear(now.getFullYear() - amount);
      break;
  }
  return now;
}

function getPoster(item: MangaItem): string {
  return item.poster?.large || item.poster?.medium || NO_IMAGE;
}
