/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import type { ChapterPageItems } from "../models";
import { loadChapters } from "./chapterCache";
import { filterChapters } from "./groupFilter";
import { errorText, logEvent } from "./log";

// Chapters' page lists, kept for a while once read (opening a chapter again,
// or going back, needs no request), and the next chapter's fetched ahead
// while the current one is read, so moving on is instant. Kept in memory only:
// comix's image links are only good for a while.
const KEEP_MS = 10 * 60_000;
const MAX_KEPT = 40;

interface Entry {
  at: number;
  pages?: ChapterPageItems;
  pending?: Promise<ChapterPageItems | null>;
}

const kept = new Map<string, Entry>();

export function rememberPages(chapterId: string, pages: ChapterPageItems): void {
  kept.delete(chapterId);
  kept.set(chapterId, { at: Date.now(), pages });
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
}

// A kept (or still arriving) page list for this chapter, or null.
export async function keptPages(chapterId: string): Promise<ChapterPageItems | null> {
  const entry = kept.get(chapterId);
  if (!entry || Date.now() - entry.at > KEEP_MS) return null;
  if (entry.pages) return entry.pages;
  return entry.pending ? await entry.pending : null;
}

// The chapter after `current` in the remembered list: the next chapter number
// in the same language (after the group filter), from the same group if it
// has one, else the most voted upload.
export function nextChapterId(
  mangaId: string,
  chapterId: string,
  number: number,
  language: string | undefined,
): string | null {
  const list = loadChapters(mangaId);
  if (!list) return null;
  const items = filterChapters(list.items);
  const current = items.find((item) => String(item.id) === chapterId);
  const lang = current?.language ?? language;
  const later = items.filter((item) => item.number > number && (!lang || item.language === lang));
  if (later.length === 0) return null;
  const next = Math.min(...later.map((item) => item.number));
  const candidates = later.filter((item) => item.number === next);
  const sameGroup = candidates.find(
    (item) => current?.group?.name && item.group?.name === current.group.name,
  );
  const pick =
    sameGroup ?? candidates.sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0) || b.id - a.id)[0];
  return pick ? String(pick.id) : null;
}

// Fetch `chapterId`'s page list in the background (once), and keep it.
export function fetchAhead(chapterId: string, fetch: () => Promise<ChapterPageItems>): void {
  const entry = kept.get(chapterId);
  if (entry && Date.now() - entry.at <= KEEP_MS) return;
  const pending = (async () => {
    // Let the chapter being opened load its images first.
    await Application.sleep(1);
    try {
      const pages = await fetch();
      rememberPages(chapterId, pages);
      return pages;
    } catch (error) {
      kept.delete(chapterId);
      logEvent("fetch ahead skipped", `chapter ${chapterId}: ${errorText(error)}`);
      return null;
    }
  })();
  kept.set(chapterId, { at: Date.now(), pending });
}
