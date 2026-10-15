/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */
/* Adapted from the Paperback 0.8 MyAnimeList tracker (Paperback-iOS/extensions, GPL-3.0) */

// MyAnimeList tracker for Paperback 0.9: sign in (settings), link a manga
// (search), and reading a chapter updates your MyAnimeList list.

import {
  BasicRateLimiter,
  ContentRating,
  type Chapter,
  type ChapterReadActionQueueProcessingResult,
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
import { accessToken, API, CLIENT_ID, formBody, isLoggedIn, setUser, type User } from "./session";

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
        contentRating:
          manga.nsfw === "black"
            ? ContentRating.ADULT
            : manga.nsfw === "gray"
              ? ContentRating.MATURE
              : ContentRating.EVERYONE,
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
    const result: ChapterReadActionQueueProcessingResult = { successfulItems: [], failedItems: [] };
    if (!isLoggedIn()) return result;
    const byManga = new Map<string, TrackedMangaChapterReadAction[]>();
    for (const action of actions) {
      byManga.set(action.sourceManga.mangaId, [
        ...(byManga.get(action.sourceManga.mangaId) ?? []),
        action,
      ]);
    }
    for (const [mangaId, mangaActions] of byManga) {
      const ids = mangaActions.map((action) => action.id);
      try {
        const chapter = Math.max(...mangaActions.map((action) => Math.floor(action.chapterNum)));
        const volume = Math.max(
          0,
          ...mangaActions.map((action) => Math.floor(action.chapterVolume ?? 0)),
        );
        const manga = await this.fetchManga(mangaId, "id,num_chapters,my_list_status");
        if (!manga) {
          result.failedItems.push(...ids);
          continue;
        }
        const list: MalListStatus = manga.my_list_status ?? {};
        if ((list.num_chapters_read ?? 0) >= chapter) {
          result.successfulItems.push(...ids);
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
        const { status } = await this.api(
          `/manga/${manga.id}/my_list_status`,
          { method: "PUT", body },
          true,
        );
        (status < 400 ? result.successfulItems : result.failedItems).push(...ids);
      } catch {
        result.failedItems.push(...ids);
      }
    }
    return result;
  }
}

export const MyAnimeList = new MyAnimeListExtension();
