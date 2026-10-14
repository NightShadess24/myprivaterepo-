/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import type { CookieStorageInterceptor } from "@paperback/types";

import {
  loadChapters,
  mergeChapters,
  saveChapters,
  toStored,
  type StoredChapter,
} from "./chapterCache";
import { errorText, logEvent } from "./log";
import { chapterListViaWebView } from "./webView";

// comix only lets chapter lists be read 20 at a time, 3 seconds apart, so a
// long list (600+ entries) takes minutes. Instead:
// - first open: the newest chapters within about 20 s of paging; the rest is
//   read in the background, a few pages at a time, and remembered
// - opening again: only what's new (usually the title page's own first page),
//   added to the remembered list
// - library updates: only the title page's own first page
const FIRST_BUDGET_MS = 20_000;
const KNOWN_BUDGET_MS = 45_000;
// Short, so opening a chapter (which goes first) never waits long behind one.
const CHUNK_BUDGET_MS = 15_000;
const MAX_CHUNKS = 60;

const continuing = new Set<string>();

const seconds = (since: number) => Math.round((Date.now() - since) / 1000);

export async function getChapterItems(
  mangaId: string,
  store: CookieStorageInterceptor,
  refresh: boolean,
): Promise<StoredChapter[]> {
  const started = Date.now();
  const cached = loadChapters(mangaId);
  const complete = cached !== null && cached.nextPage === null;
  // A list still being read: just the newest page now, the rest goes on in
  // the background.
  const quick = refresh || (cached !== null && !complete);
  const result = await chapterListViaWebView(mangaId, store, {
    refresh: quick,
    known: complete ? cached.items.map((item) => item.id) : [],
    startPage: null,
    budgetMs: complete ? KNOWN_BUDGET_MS : FIRST_BUDGET_MS,
  });
  const fresh = toStored(result.items);

  let items: StoredChapter[];
  let nextPage: number | null;
  if (quick) {
    items = mergeChapters(fresh, cached?.items ?? []);
    nextPage = cached ? cached.nextPage : result.nextPage;
  } else if (complete && result.reachedKnown) {
    items = mergeChapters(fresh, cached.items);
    nextPage = null;
  } else if (result.nextPage === null && !result.stopped) {
    // Read it all: the list as comix has it now.
    items = mergeChapters(fresh, []);
    nextPage = null;
  } else {
    items = mergeChapters(fresh, cached?.items ?? []);
    nextPage = result.nextPage ?? result.stopped?.page ?? null;
  }
  const total = result.total ?? cached?.total ?? items.length;
  // comix counts more entries than are remembered (older uploads added since,
  // or a list that only ever had its newest page read): read it all again in
  // the background, merging as it goes.
  if (nextPage === null && result.total !== null && items.length < result.total) nextPage = 2;
  saveChapters(mangaId, items, { total, nextPage });

  if (refresh) return items;

  const frame = result.frame ? ", comix showed its check frame (carried on)" : "";
  if (result.stopped) {
    logEvent(
      "chapter list cut short",
      `${mangaId}: showing ${items.length} chapters; page ${result.stopped.page} of ${result.lastPage} failed (${result.stopped.reason}). Open the manga again later for the rest.`,
    );
  } else if (nextPage !== null) {
    logEvent(
      "chapter list",
      `${mangaId}: showing the newest ${items.length} of ${total} chapters after ${seconds(started)}s; the rest loads in the background (about ${Math.ceil((total - items.length) / 20) * 3 + 10}s), then open the manga again${frame}`,
    );
    // Pick up a page early: new chapters since may have moved the pages along.
    const from = quick ? Math.max(2, nextPage - 1) : nextPage;
    continueInBackground(mangaId, store, from);
  } else {
    const how = quick
      ? "newest page, the rest remembered"
      : result.reachedKnown
        ? `${fresh.length} read, the rest remembered`
        : result.via === "page" && result.pages <= 1
          ? "from the title page"
          : `${result.pages} of ${result.lastPage} pages of 20, 3 s apart`;
    logEvent(
      "chapter list",
      `${mangaId}: ${items.length} chapters (${how}) in ${seconds(started)}s${frame}`,
    );
  }
  return items;
}

// Reads the rest of a long list a few pages at a time, remembering it as it
// goes, so the next open shows all of it.
function continueInBackground(
  mangaId: string,
  store: CookieStorageInterceptor,
  fromPage: number,
): void {
  if (continuing.has(mangaId)) return;
  continuing.add(mangaId);
  const started = Date.now();
  void (async () => {
    try {
      let next: number | null = fromPage;
      for (let chunk = 0; next !== null && chunk < MAX_CHUNKS; chunk++) {
        const result = await chapterListViaWebView(mangaId, store, {
          refresh: false,
          known: [],
          startPage: next,
          budgetMs: CHUNK_BUDGET_MS,
        });
        const cached = loadChapters(mangaId);
        const items = mergeChapters(toStored(result.items), cached?.items ?? []);
        const total = result.total ?? cached?.total ?? items.length;
        if (result.stopped) {
          saveChapters(mangaId, items, { total, nextPage: result.stopped.page });
          logEvent(
            "chapter list paused",
            `${mangaId}: ${items.length} of ${total} chapters so far; page ${result.stopped.page} failed (${result.stopped.reason}). It carries on next time you open the manga.`,
          );
          return;
        }
        next = result.nextPage;
        saveChapters(mangaId, items, { total, nextPage: next });
        if (next === null) {
          logEvent(
            "chapter list",
            `${mangaId}: all ${items.length} chapters loaded in the background in ${seconds(started)}s. Open the manga again to see them.`,
          );
        }
      }
    } catch (error) {
      logEvent(
        "chapter list paused",
        `${mangaId}: ${errorText(error)}. It carries on next time you open the manga.`,
      );
    } finally {
      continuing.delete(mangaId);
    }
  })();
}
