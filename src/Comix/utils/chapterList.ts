/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import type { CookieStorageInterceptor } from "@paperback/types";

import type { ChapterItem } from "../models";
import {
  loadChapters,
  mergeChapters,
  saveChapters,
  toStored,
  type StoredChapter,
} from "./chapterCache";
import { errorText, logEvent } from "./log";
import {
  CaptchaRequired,
  fetchChapterPage,
  markSigningOutdated,
  signedApiEnabled,
  signedCheckError,
  SigningOutdated,
} from "./signedApi";
import { chapterGapMs, chapterListViaWebView, type ChapterListResult } from "./webView";

// comix only lets chapter lists be read 20 at a time, a few seconds apart, so a
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

// Settings → Chapter Lists: wait for the whole list before showing it (the
// default), or show the newest chapters first and read the rest in the
// background.
export interface ChapterListMode {
  id: string;
  title: string;
}

export const CHAPTER_LIST_MODES: ChapterListMode[] = [
  { id: "all", title: "Wait for the whole list" },
  { id: "fast", title: "Newest first, rest in the background" },
];

export function getChapterListMode(): ChapterListMode {
  const id = Application.getState("chapter_list_mode") as string | undefined;
  return CHAPTER_LIST_MODES.find((mode) => mode.id === id) ?? CHAPTER_LIST_MODES[0]!;
}

// Waiting for a whole list: up to this long of paging (about 1,500 entries).
const ALL_BUDGET_MS = 240_000;

const seconds = (since: number) => Math.round((Date.now() - since) / 1000);

export async function getChapterItems(
  mangaId: string,
  store: CookieStorageInterceptor,
  refresh: boolean,
): Promise<StoredChapter[]> {
  const started = Date.now();
  const cached = loadChapters(mangaId);
  const complete = cached !== null && cached.nextPage === null;
  const waitForAll = !refresh && getChapterListMode().id === "all";
  // A list only partly read so far: read on from where it stopped (a page
  // early, in case new chapters moved the pages along), or, when not waiting,
  // just the newest page now and the rest in the background.
  const resumeFrom = !complete && cached?.nextPage ? Math.max(2, cached.nextPage - 1) : null;
  const resume = waitForAll && resumeFrom !== null;
  const quick = refresh || (cached !== null && !complete && !resume);
  const result = await listChapters(mangaId, store, {
    refresh: quick,
    known: complete ? cached.items.map((item) => item.id) : [],
    startPage: resume ? resumeFrom : null,
    budgetMs: waitForAll ? ALL_BUDGET_MS : complete ? KNOWN_BUDGET_MS : FIRST_BUDGET_MS,
  });
  const fresh = toStored(result.items);

  let items: StoredChapter[];
  let nextPage: number | null;
  if (resume) {
    items = mergeChapters(fresh, cached?.items ?? []);
    nextPage = result.stopped ? result.stopped.page : result.nextPage;
  } else if (quick) {
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
  // comix counts more entries than before plus the new ones read (older
  // uploads added in between): read it all again in the background, merging.
  if (nextPage === null && complete && result.total !== null) {
    const knownIds = new Set(cached.items.map((item) => item.id));
    const added = fresh.filter((item) => !knownIds.has(item.id)).length;
    if (result.total > cached.total + added) nextPage = 2;
  }
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
      `${mangaId}: showing the newest ${items.length} of ${total} chapters after ${seconds(started)}s; the rest loads in the background (about ${Math.ceil(((total - items.length) / 20) * (chapterGapMs() / 1000)) + 10}s), then pull down on the manga's chapter list to see them${frame}`,
    );
    // Pick up a page early: new chapters since may have moved the pages along.
    const from = quick ? Math.max(2, nextPage - 1) : nextPage;
    continueInBackground(mangaId, store, from);
  } else {
    const how = resume
      ? `read on from page ${resumeFrom}, ${result.pages - (resumeFrom ?? 1) + 1} pages`
      : quick
        ? "newest page, the rest remembered"
        : result.reachedKnown
          ? `${fresh.length} read, the rest remembered`
          : result.via === "signed"
            ? `fast loading, ${result.requests} request${result.requests === 1 ? "" : "s"}`
            : result.via === "page" && result.pages <= 1
              ? "from the title page"
              : `${result.pages} of ${result.lastPage} pages of 20, ${chapterGapMs() / 1000} s apart`;
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
        const result = await listChapters(mangaId, store, {
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
            `${mangaId}: all ${items.length} chapters loaded in the background in ${seconds(started)}s. Pull down on the manga's chapter list to see them.`,
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

type ListOptions = Parameters<typeof chapterListViaWebView>[2];

// Fast Loading (signed API calls) when it's on and working, else the title
// page in a hidden browser. Same results either way, in pages of 20.
async function listChapters(
  mangaId: string,
  store: CookieStorageInterceptor,
  opts: ListOptions,
): Promise<ChapterListResult> {
  if (signedApiEnabled()) {
    try {
      return await chapterListSigned(mangaId, opts);
    } catch (error) {
      if (error instanceof CaptchaRequired) {
        throw await signedCheckError(`chapter list of ${mangaId}`, error.message);
      }
      if (!(error instanceof SigningOutdated)) throw error;
      markSigningOutdated(error.message);
    }
  }
  return chapterListViaWebView(mangaId, store, opts);
}

let lastSignedRequest = 0;
// comix refused a page of 100 past the first: pages of 20 from then on.
let bigPagesRefused = false;

// The chapter list through the API: pages of 100 where it can (5 pages of 20
// in one request), else 20, spaced by Chapter List Speed. Positions and
// `nextPage` are counted in pages of 20, like the hidden-page method, so
// remembered lists carry over between the two.
async function chapterListSigned(mangaId: string, opts: ListOptions): Promise<ChapterListResult> {
  const known = new Set(opts.known);
  const stopAt = Date.now() + opts.budgetMs;
  const items: ChapterItem[] = [];
  let total: number | null = null;
  let unit = opts.startPage ?? 1;
  let lastPage = unit;
  let requests = 0;
  const result = (extra: Partial<ChapterListResult>): ChapterListResult => ({
    items,
    via: "signed",
    pages: unit - 1,
    lastPage,
    total,
    nextPage: unit <= lastPage ? unit : null,
    requests,
    ...extra,
  });

  for (;;) {
    if (requests > 0 && unit > lastPage) return result({ nextPage: null });
    if (requests > 0 && opts.refresh) return result({});
    if (requests > 0 && Date.now() > stopAt) return result({});
    const big = !bigPagesRefused && (unit - 1) % 5 === 0 && (opts.startPage === null || unit > 1);
    const limit = big ? 100 : 20;
    const page = big ? (unit - 1) / 5 + 1 : unit;
    const wait = lastSignedRequest + chapterGapMs() - Date.now();
    if (wait > 0) await Application.sleep(wait / 1000);
    lastSignedRequest = Date.now();
    requests++;
    let answer;
    try {
      answer = await fetchChapterPage(mangaId, page, limit);
    } catch (error) {
      if (error instanceof CaptchaRequired && big && page > 1) {
        bigPagesRefused = true;
        logEvent("chapter list", `${mangaId}: comix refused a page of 100; going on 20 at a time`);
        continue;
      }
      if (items.length > 0 && !(error instanceof SigningOutdated)) {
        const reason =
          error instanceof CaptchaRequired ? "comix wanted its check" : errorText(error);
        return result({ stopped: { page: unit, reason } });
      }
      throw error;
    }
    const pageItems = answer?.items ?? [];
    items.push(...pageItems);
    const meta = answer?.meta ?? {};
    if (typeof meta.total === "number") total = meta.total;
    lastPage =
      total !== null
        ? Math.max(1, Math.ceil(total / 20))
        : Math.max(unit, (meta.lastPage ?? page) * (big ? 5 : 1));
    unit += big ? 5 : 1;
    if (pageItems.some((item) => known.has(item.id))) return result({ reachedKnown: true });
    if (pageItems.length === 0) return result({ nextPage: null });
  }
}
