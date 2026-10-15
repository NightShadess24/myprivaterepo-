/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */
/* Adapted from the Paperback 0.8 MyAnimeList tracker (Paperback-iOS/extensions, GPL-3.0) */

// MyAnimeList tracker for Paperback 0.9: sign in (settings), link a manga
// (search), and reading a chapter updates your MyAnimeList list.

import {
  BasicRateLimiter,
  ContentRating,
  DiscoverSectionType,
  type Chapter,
  type ChapterReadActionQueueProcessingResult,
  type DiscoverSection,
  type DiscoverSectionItem,
  type ExtensionImpl,
  type Form,
  type MangaProgress,
  type Metadata,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SourceManga,
  type TrackedMangaChapterReadAction,
} from "@paperback/types";

import { MalProgressForm, MalSettingsForm, type ListStatusChange } from "./forms";
import type { MalListStatus, MalManga, MalPage } from "./models";
import type MyAnimeListConfig from "./pbconfig";
import {
  accessToken,
  API,
  CLIENT_ID,
  formBody,
  isLoggedIn,
  setSyncReport,
  setUser,
  wasSignedIn,
  type SyncReport,
  type User,
} from "./session";

const DETAIL_FIELDS =
  "id,title,main_picture,alternative_titles,synopsis,mean,status,nsfw,media_type,num_chapters,num_volumes,genres,authors{first_name,last_name},my_list_status";
const SEARCH_FIELDS = "id,title,main_picture,media_type,start_date";
const PAGE_SIZE = 30;

const STATUS: Record<string, string> = {
  finished: "Completed",
  currently_publishing: "Ongoing",
  not_yet_published: "Not yet published",
  on_hiatus: "Hiatus",
  discontinued: "Cancelled",
};
const MEDIA: Record<string, string> = {
  manga: "Manga",
  manhwa: "Manhwa",
  manhua: "Manhua",
  novel: "Novel",
  light_novel: "Light novel",
  one_shot: "One-shot",
  doujinshi: "Doujinshi",
  oel: "OEL",
};

const offsetOf = (metadata: Metadata | undefined) =>
  metadata &&
  typeof metadata === "object" &&
  !Array.isArray(metadata) &&
  typeof metadata.offset === "number"
    ? metadata.offset
    : 0;

const staffName = (node?: { first_name?: string; last_name?: string }) =>
  [node?.first_name, node?.last_name].filter(Boolean).join(" ").trim();

const LIST_SECTION = "list-reading";
const RANKINGS = [
  { id: "manga", title: "Top manga" },
  { id: "bypopularity", title: "Most popular" },
  { id: "manhwa", title: "Top manhwa" },
  { id: "manhua", title: "Top manhua" },
  { id: "favorite", title: "Most favorited" },
];
const CARD_FIELDS = "id,title,main_picture,media_type,mean,nsfw,list_status";

const ratingOf = (nsfw?: string) =>
  nsfw === "black"
    ? ContentRating.ADULT
    : nsfw === "gray"
      ? ContentRating.MATURE
      : ContentRating.EVERYONE;

/**
 * The number of the chapter that was read: the app's, or, when a source
 * doesn't number its chapters, read from the chapter's title or id
 * ("Chapter 12", "ch-12").
 */
export function chapterNumberOf(action: TrackedMangaChapterReadAction): number {
  for (const value of [action.chapterNum, action.readChapter?.chapNum]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  for (const text of [action.readChapter?.title, action.chapterId, action.chapterSourceId]) {
    const match = /(?:^|[^a-z])(?:chapter|chap|ch)[\s._-]*(\d+(?:\.\d+)?)/i.exec(
      String(text ?? ""),
    );
    if (match) return Number(match[1]);
  }
  return 0;
}

export class MyAnimeListExtension implements ExtensionImpl<typeof MyAnimeListConfig> {
  rateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 2,
    bufferInterval: 1,
    ignoreImages: true,
  });

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
  }

  // ── Requests ───────────────────────────────────────────────────────────

  /** A MyAnimeList API request: signed in when possible, else as the app. */
  private async api(
    path: string,
    init: { method?: string; body?: Record<string, string> } = {},
    needsLogin = false,
  ): Promise<{ status: number; json: unknown }> {
    const token = await accessToken();
    if (needsLogin && !token) throw new Error("Sign in to MyAnimeList in this tracker's settings");
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : { "x-mal-client-id": CLIENT_ID }),
    };
    if (init.body) headers["content-type"] = "application/x-www-form-urlencoded";
    const [response, data] = await Application.scheduleRequest({
      url: path.startsWith("http") ? path : `${API}${path}`,
      method: init.method ?? "GET",
      headers,
      body: init.body ? formBody(init.body) : undefined,
    });
    const text = Application.arrayBufferToUTF8String(data);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  }

  private async fetchManga(mangaId: string, fields = DETAIL_FIELDS): Promise<MalManga | undefined> {
    const id = Number.parseInt(mangaId, 10);
    if (!Number.isFinite(id)) return undefined;
    const { status, json } = await this.api(`/manga/${id}?fields=${encodeURIComponent(fields)}`);
    if (status === 404) return undefined;
    if (status >= 400) throw new Error(`MyAnimeList answered ${status}`);
    return json as MalManga;
  }

  private async refreshUser(): Promise<void> {
    const { status, json } = await this.api("/users/@me", {}, true);
    if (status < 400) setUser(json as User);
  }

  private async saveListStatus(mangaId: string, change: ListStatusChange): Promise<void> {
    const id = Number.parseInt(mangaId, 10);
    if (change.status === "remove") {
      const { status } = await this.api(`/manga/${id}/my_list_status`, { method: "DELETE" }, true);
      if (status >= 400 && status !== 404) throw new Error(`MyAnimeList answered ${status}`);
      return;
    }
    const { status } = await this.api(
      `/manga/${id}/my_list_status`,
      {
        method: "PUT",
        body: {
          status: change.status,
          num_chapters_read: String(Math.max(0, Math.floor(change.chapters))),
          num_volumes_read: String(Math.max(0, Math.floor(change.volumes))),
          score: String(Math.min(10, Math.max(0, Math.floor(change.score)))),
          num_times_reread: String(Math.max(0, Math.floor(change.rereads))),
          comments: change.notes,
        },
      },
      true,
    );
    if (status >= 400) throw new Error(`MyAnimeList didn't save the change (${status})`);
  }

  // ── Settings ───────────────────────────────────────────────────────────

  async getSettingsForm(): Promise<Form> {
    return new MalSettingsForm(() => this.refreshUser());
  }

  // ── Discover ───────────────────────────────────────────────────────────

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      ...(isLoggedIn()
        ? [
            {
              id: LIST_SECTION,
              title: "Your reading list",
              type: DiscoverSectionType.simpleCarousel,
            },
          ]
        : []),
      ...RANKINGS.map(({ id, title }) => ({
        id: `ranking-${id}`,
        title,
        type: DiscoverSectionType.simpleCarousel,
      })),
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const offset = offsetOf(metadata);
    const paging = `limit=${PAGE_SIZE}&offset=${offset}&fields=${encodeURIComponent(CARD_FIELDS)}`;
    const onList = section.id === LIST_SECTION;
    if (onList && !isLoggedIn()) return { items: [], metadata: undefined };
    const ranking = section.id.replace(/^ranking-/, "");
    const { status, json } = await this.api(
      onList
        ? `/users/@me/mangalist?status=reading&sort=list_updated_at&nsfw=true&${paging}`
        : `/manga/ranking?ranking_type=${encodeURIComponent(ranking)}&${paging}`,
      {},
      onList,
    );
    if (status >= 400) throw new Error(`MyAnimeList answered ${status}`);
    const page = json as MalPage;
    return {
      items: (page?.data ?? []).map(({ node, list_status, ranking: rank }) => ({
        type: "simpleCarouselItem" as const,
        mangaId: String(node.id),
        title: node.title,
        imageUrl: node.main_picture?.large ?? node.main_picture?.medium ?? "",
        subtitle: onList
          ? `Chapter ${(list_status ?? node.my_list_status)?.num_chapters_read ?? 0}`
          : [rank?.rank ? `#${rank.rank}` : undefined, MEDIA[node.media_type ?? ""]]
              .filter(Boolean)
              .join(" · "),
        contentRating: ratingOf(node.nsfw),
      })),
      metadata: page?.paging?.next ? { offset: offset + PAGE_SIZE } : undefined,
    };
  }

  // ── Linking a manga ────────────────────────────────────────────────────

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const title = (query.title ?? "").trim();
    // MyAnimeList searches need at least three letters.
    if (title.length < 3) return { items: [], metadata: undefined };
    const offset = offsetOf(metadata);
    const { status, json } = await this.api(
      `/manga?q=${encodeURIComponent(title.slice(0, 64))}&limit=${PAGE_SIZE}&offset=${offset}&nsfw=true&fields=${encodeURIComponent(SEARCH_FIELDS)}`,
    );
    if (status >= 400) throw new Error(`MyAnimeList answered ${status}`);
    const page = json as MalPage;
    return {
      items: (page?.data ?? []).map(({ node }) => ({
        mangaId: String(node.id),
        title: node.title,
        imageUrl: node.main_picture?.large ?? node.main_picture?.medium ?? "",
        subtitle: [MEDIA[node.media_type ?? ""], node.start_date?.slice(0, 4)]
          .filter(Boolean)
          .join(" · "),
      })),
      metadata: page?.paging?.next ? { offset: offset + PAGE_SIZE } : undefined,
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const manga = await this.fetchManga(mangaId);
    if (!manga) throw new Error(`MyAnimeList doesn't have manga ${mangaId}`);
    const titles = manga.alternative_titles;
    const author = manga.authors?.find((a) => /story/i.test(a.role ?? ""))?.node;
    const artist = manga.authors?.find((a) => /art/i.test(a.role ?? ""))?.node;
    return {
      mangaId: String(manga.id),
      mangaInfo: {
        primaryTitle: manga.title,
        secondaryTitles: [titles?.en, titles?.ja, ...(titles?.synonyms ?? [])].filter(
          (title): title is string => !!title && title !== manga.title,
        ),
        thumbnailUrl: manga.main_picture?.large ?? manga.main_picture?.medium ?? "",
        synopsis: manga.synopsis ?? "",
        contentRating: ratingOf(manga.nsfw),
        status: STATUS[manga.status ?? ""] ?? manga.status,
        author: staffName(author) || undefined,
        artist: staffName(artist) || undefined,
        rating: typeof manga.mean === "number" ? manga.mean / 10 : undefined,
        tagGroups: manga.genres?.length
          ? [
              {
                id: "genres",
                title: "Genres",
                tags: manga.genres.map((genre) => ({ id: String(genre.id), title: genre.name })),
              },
            ]
          : [],
        shareUrl: `https://myanimelist.net/manga/${manga.id}`,
      },
    };
  }

  // ── Progress ───────────────────────────────────────────────────────────

  async getMangaProgressManagementForm(sourceManga: SourceManga): Promise<Form> {
    if (!isLoggedIn()) return new MalProgressForm(undefined, async () => {});
    const manga = await this.fetchManga(sourceManga.mangaId);
    return new MalProgressForm(manga, (change) => this.saveListStatus(sourceManga.mangaId, change));
  }

  async getMangaProgress(sourceManga: SourceManga): Promise<MangaProgress | undefined> {
    if (!isLoggedIn()) return undefined;
    const manga = await this.fetchManga(sourceManga.mangaId, "id,my_list_status");
    const list = manga?.my_list_status;
    if (!list) return undefined;
    const read = list.num_chapters_read ?? 0;
    const lastReadChapter: Chapter = {
      chapterId: String(read),
      sourceManga,
      langCode: "unknown",
      chapNum: read,
      volume: list.num_volumes_read || undefined,
    };
    const updated = list.updated_at ? new Date(list.updated_at) : undefined;
    return {
      sourceManga,
      lastReadChapter,
      lastReadTime: updated && !Number.isNaN(updated.getTime()) ? updated : undefined,
      userRating: list.score || undefined,
    };
  }

  /** Reading a chapter moves your progress forward (never back). */
  async processChapterReadActionQueue(
    actions: TrackedMangaChapterReadAction[],
  ): Promise<ChapterReadActionQueueProcessingResult> {
    try {
      return await this.syncReadActions(actions);
    } catch (error) {
      // Never throw back at the app: leave everything queued for next time.
      console.log(`[MyAnimeList] reading updates stopped: ${String(error)}`);
      return { successfulItems: [], failedItems: [] };
    }
  }

  private async syncReadActions(
    actions: TrackedMangaChapterReadAction[],
  ): Promise<ChapterReadActionQueueProcessingResult> {
    const result: ChapterReadActionQueueProcessingResult = { successfulItems: [], failedItems: [] };
    const report: SyncReport = {
      at: new Date().toISOString(),
      updated: 0,
      unchanged: 0,
      failed: 0,
    };
    const lines: string[] = [];
    const log = (message: string) => {
      lines.push(message);
      console.log(`[MyAnimeList] ${message}`);
    };
    console.log(`[MyAnimeList] reading updates: ${actions.length}`);
    if (!isLoggedIn()) {
      if (wasSignedIn()) {
        // Signed in, but the sign-in can't be read right now (the phone is
        // locked, say): leave the updates queued so the app sends them again.
        report.error = "Couldn't read your MyAnimeList sign-in just now; will try again";
      } else {
        report.error = "Not signed in to MyAnimeList";
      }
      console.log(`[MyAnimeList] ${report.error}`);
      setSyncReport(report);
      return result;
    }
    const byManga = new Map<string, TrackedMangaChapterReadAction[]>();
    for (const action of actions) {
      const mangaId = String(action.sourceManga?.mangaId ?? "");
      byManga.set(mangaId, [...(byManga.get(mangaId) ?? []), action]);
    }
    for (const [mangaId, mangaActions] of byManga) {
      const ids = mangaActions.map((action) => action.id);
      try {
        const chapter = Math.floor(Math.max(0, ...mangaActions.map(chapterNumberOf)));
        const volume = Math.max(
          0,
          ...mangaActions.map((action) => Math.floor(Number(action.chapterVolume ?? 0)) || 0),
        );
        if (chapter <= 0) {
          // Nothing to count (a chapter 0, or one without a number).
          log(`Manga ${mangaId}: the chapter has no number, so there's nothing to count`);
          result.successfulItems.push(...ids);
          report.unchanged++;
          continue;
        }
        const manga = await this.fetchManga(mangaId, "id,title,num_chapters,my_list_status");
        if (!manga) {
          log(`Manga ${mangaId}: MyAnimeList doesn't have it (link it again)`);
          result.failedItems.push(...ids);
          report.failed++;
          report.error = `MyAnimeList doesn't have manga ${mangaId}`;
          continue;
        }
        const name = manga.title || `Manga ${mangaId}`;
        const list: MalListStatus = manga.my_list_status ?? {};
        if ((list.num_chapters_read ?? 0) >= chapter) {
          log(
            `${name}: read chapter ${chapter}, your list is already at ${list.num_chapters_read}`,
          );
          result.successfulItems.push(...ids);
          report.unchanged++;
          continue;
        }
        const finished =
          manga.num_chapters !== undefined &&
          manga.num_chapters > 0 &&
          chapter >= manga.num_chapters;
        const body: Record<string, string> = {
          status: finished ? "completed" : list.status === "completed" ? "completed" : "reading",
          num_chapters_read: String(chapter),
        };
        if (volume > (list.num_volumes_read ?? 0)) body.num_volumes_read = String(volume);
        const { status, json } = await this.api(
          `/manga/${manga.id}/my_list_status`,
          { method: "PUT", body },
          true,
        );
        if (status < 400) {
          log(`${name}: chapter ${chapter} saved`);
          result.successfulItems.push(...ids);
          report.updated++;
        } else {
          console.log(`[MyAnimeList] ${JSON.stringify(json ?? "").slice(0, 200)}`);
          log(`${name}: MyAnimeList didn't save chapter ${chapter} (${status})`);
          result.failedItems.push(...ids);
          report.failed++;
          report.error = `MyAnimeList answered ${status}`;
        }
      } catch (error) {
        log(`Manga ${mangaId}: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
        result.failedItems.push(...ids);
        report.failed++;
        report.error = String((error as Error)?.message ?? error).slice(0, 200);
      }
    }
    report.lines = lines.slice(0, 8);
    setSyncReport(report);
    return result;
  }
}

export const MyAnimeList = new MyAnimeListExtension();
