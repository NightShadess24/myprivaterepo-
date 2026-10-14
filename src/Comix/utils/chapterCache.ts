/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import type { ChapterItem } from "../models";
import { parseRelativeDate } from "../parsers";

// Chapter lists are remembered per manga, so opening a manga again only asks
// comix for what's new (usually one request) instead of paging through the
// whole list again, 20 chapters and a few seconds at a time. Kept compact (one
// short row per chapter) for the most recently opened manga.

export interface StoredChapter extends ChapterItem {
  date: number; // upload time (ms), worked out when the chapter was first read
}

export interface ChapterCache {
  at: number; // when last updated
  total: number; // comix's count of chapter entries
  // Not every page has been read yet: the next one to read (null when done).
  nextPage: number | null;
  items: StoredChapter[];
}

// id, number, name, language, volume, votes, official, group, date, url
type Row = [number, number, string, string, number, number, number, string | null, number, string];

interface StoredEntry {
  at: number;
  total: number;
  nextPage: number | null;
  rows: Row[];
}

const INDEX_KEY = "comix_chapter_cache_index";
const MAX_MANGA = 60;
const keyFor = (mangaId: string) => `comix_chapters_${mangaId}`;

export function toStored(items: readonly ChapterItem[]): StoredChapter[] {
  return items.map((item) => ({
    ...item,
    date: parseRelativeDate(String(item.createdAtFormatted ?? "")).getTime(),
  }));
}

// Newer copies win; newest chapters first.
export function mergeChapters(
  newer: readonly StoredChapter[],
  older: readonly StoredChapter[],
): StoredChapter[] {
  const byId = new Map<number, StoredChapter>();
  for (const item of older) byId.set(item.id, item);
  for (const item of newer) {
    const known = byId.get(item.id);
    // Keep the upload time first worked out (comix only says "2 weeks ago").
    byId.set(item.id, known ? { ...item, date: known.date } : item);
  }
  return [...byId.values()].sort((a, b) => b.number - a.number || b.id - a.id);
}

export function loadChapters(mangaId: string): ChapterCache | null {
  try {
    const entry = Application.getState(keyFor(mangaId)) as StoredEntry | undefined;
    if (!entry || !Array.isArray(entry.rows)) return null;
    return {
      at: entry.at,
      total: entry.total,
      nextPage: entry.nextPage ?? null,
      items: entry.rows.map((row) => ({
        id: row[0],
        mangaId: 0,
        number: row[1],
        name: row[2],
        language: row[3],
        volume: row[4],
        votes: row[5],
        isOfficial: row[6] === 1,
        group: row[7] === null ? null : { name: row[7] },
        createdAtFormatted: "",
        date: row[8],
        url: row[9],
      })),
    };
  } catch {
    return null;
  }
}

export function saveChapters(
  mangaId: string,
  items: readonly StoredChapter[],
  { total, nextPage }: { total: number; nextPage: number | null },
): void {
  try {
    const entry: StoredEntry = {
      at: Date.now(),
      total,
      nextPage,
      rows: items.map((item) => [
        item.id,
        item.number,
        item.name ?? "",
        item.language ?? "",
        item.volume ?? 0,
        item.votes ?? 0,
        item.isOfficial ? 1 : 0,
        item.group?.name ?? null,
        item.date,
        item.url,
      ]),
    };
    Application.setState(entry, keyFor(mangaId));
    const index = ((Application.getState(INDEX_KEY) as string[] | undefined) ?? []).filter(
      (id) => id !== mangaId,
    );
    index.unshift(mangaId);
    for (const old of index.splice(MAX_MANGA)) Application.setState(undefined, keyFor(old));
    Application.setState(index, INDEX_KEY);
  } catch {
    // remembering is a speed-up only
  }
}
