/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */

// Drake Scans (drakecomic.net). Reads the data each page carries (flight.ts).
//
// Two kinds of chapter can't be read here:
//   - chapters sold for coins on the site are left out of the chapter list;
//   - chapters whose images the site encrypts (its copy protection, used on
//     the newest chapters of some series) open with a note to read them on
//     drakecomic.net. The protection is not worked around.

import {
  BasicRateLimiter,
  CloudflareError,
  ContentRating,
  CookieStorageInterceptor,
  DiscoverSectionType,
  PaperbackInterceptor,
  URL,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type DiscoverSection,
  type DiscoverSectionItem,
  type ExtensionImpl,
  type Metadata,
  type PagedResults,
  type Request,
  type Response,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
  type TagSection,
} from "@paperback/types";

import { objectStartingWith, pageData, valueOf } from "./flight";
import {
  DOMAIN,
  type DrakeChapterSummary,
  type DrakeGenre,
  type DrakeListItem,
  type DrakeReader,
  type DrakeSeriesPage,
} from "./models";
import type DrakeScansConfig from "./pbconfig";

const SORTS: SortingOption[] = [
  { id: "latest", label: "Recently updated" },
  { id: "trending", label: "Trending" },
  { id: "views", label: "Most viewed" },
  { id: "popular", label: "Most bookmarked" },
  { id: "rating", label: "Top rated" },
  { id: "newest", label: "Newest" },
];

const MATURE_GENRES = /^(mature|adult|ecchi|smut|harem)$/i;
const STATUS: Record<string, string> = {
  ONGOING: "Ongoing",
  COMPLETED: "Completed",
  HIATUS: "Hiatus",
  DROPPED: "Dropped",
  CANCELLED: "Cancelled",
};
const TYPE: Record<string, string> = {
  MANHWA: "Manhwa",
  MANHUA: "Manhua",
  MANGA: "Manga",
  WEBTOON: "Webtoon",
  COMIC: "Comic",
};

const imageUrl = (path: string | null | undefined) =>
  !path
    ? ""
    : /^https?:\/\//.test(path)
      ? path
      : `${DOMAIN}${path.startsWith("/") ? "" : "/"}${path}`;
const seriesUrl = (mangaId: string) =>
  new URL(DOMAIN).addPathComponent("series").addPathComponent("comic").addPathComponent(mangaId);
const genreName = (genre: DrakeGenre) => genre.name ?? genre.genre?.name ?? genre.genre?.slug ?? "";
// A date the site sent, or undefined when it's missing or unreadable
const dateOf = (value: string | null | undefined) => {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
};
// Which page of a list to fetch (`{ page }`, from the previous page)
const pageOf = (metadata: Metadata | undefined) =>
  metadata &&
  typeof metadata === "object" &&
  !Array.isArray(metadata) &&
  typeof metadata.page === "number"
    ? metadata.page
    : 1;
const genreSlug = (genre: DrakeGenre) => genre.slug ?? genre.genre?.slug ?? "";

class DrakeInterceptor extends PaperbackInterceptor {
  override async interceptRequest(request: Request): Promise<Request> {
    return {
      ...request,
      headers: {
        ...request.headers,
        referer: `${DOMAIN}/`,
        "user-agent": await Application.getDefaultUserAgent(),
      },
    };
  }

  override async interceptResponse(
    request: Request,
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const challenged =
      response.headers?.["cf-mitigated"] === "challenge" ||
      ((response.status === 403 || response.status === 503) &&
        /cloudflare/i.test(response.headers?.["server"] ?? "") &&
        /text\/html/i.test(response.headers?.["content-type"] ?? ""));
    if (challenged && !/\/uploads\//.test(request.url)) {
      throw new CloudflareError({
        url: `${DOMAIN}/`,
        method: "GET",
        headers: { "user-agent": await Application.getDefaultUserAgent() },
      });
    }
    return data;
  }
}

export class DrakeScansExtension implements ExtensionImpl<typeof DrakeScansConfig> {
  rateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 1,
    ignoreImages: true,
  });
  cookieStorageInterceptor = new CookieStorageInterceptor({ storage: "stateManager" });
  interceptor = new DrakeInterceptor("main");

  // getMangaDetails and getChapters both start from a series' first page.
  private lastSeries: { mangaId: string; page: DrakeSeriesPage; at: number } | undefined;

  async initialise(): Promise<void> {
    this.rateLimiter.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
    this.interceptor.registerInterceptor();
  }

  async cloudflareBypassCompleted(
    _request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    for (const cookie of cookies) this.cookieStorageInterceptor.setCookie(cookie);
  }

  // ── Pages ──────────────────────────────────────────────────────────────

  private async fetchData(url: string): Promise<string> {
    const [response, buffer] = await Application.scheduleRequest({ url, method: "GET" });
    if (response.status === 404) throw new Error("Drake Scans doesn't have this page any more");
    if (response.status >= 400) throw new Error(`Drake Scans answered ${response.status}`);
    const data = pageData(Application.arrayBufferToUTF8String(buffer));
    if (!data) throw new Error("Drake Scans sent a page this source can't read");
    return data;
  }

  private async fetchList(
    sort: string | undefined,
    page: number,
    query?: string,
  ): Promise<{ items: DrakeListItem[]; hasMore: boolean }> {
    const url = new URL(DOMAIN).addPathComponent("series");
    if (query) url.setQueryItem("q", query);
    if (sort && sort !== "latest") url.setQueryItem("sort", sort);
    if (page > 1) url.setQueryItem("page", String(page));
    const data = await this.fetchData(url.toString());
    const items = valueOf<DrakeListItem[]>(data, "initialSeries");
    if (!items) throw new Error("Drake Scans sent a list this source can't read");
    return { items, hasMore: valueOf<boolean>(data, "initialHasMore") === true };
  }

  private async fetchSeriesPage(mangaId: string, page: number): Promise<DrakeSeriesPage> {
    if (
      page === 1 &&
      this.lastSeries?.mangaId === mangaId &&
      Date.now() - this.lastSeries.at < 60_000
    ) {
      return this.lastSeries.page;
    }
    const url = seriesUrl(mangaId);
    if (page > 1) url.setQueryItem("page", String(page));
    const result = objectStartingWith<DrakeSeriesPage>(
      await this.fetchData(url.toString()),
      '{"series":',
    );
    if (!result?.series) throw new Error("Drake Scans sent a series page this source can't read");
    if (page === 1) this.lastSeries = { mangaId, page: result, at: Date.now() };
    return result;
  }

  private ratingOf(item: { isMature?: boolean; genres?: DrakeGenre[] }): ContentRating {
    return item.isMature || (item.genres ?? []).some((g) => MATURE_GENRES.test(genreName(g)))
      ? ContentRating.MATURE
      : ContentRating.EVERYONE;
  }

  private latestFree(item: DrakeListItem) {
    return (item.chapters ?? []).find((chapter) => !chapter.isLocked);
  }

  // ── Discover ───────────────────────────────────────────────────────────

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: "trending", title: "Trending", type: DiscoverSectionType.featured },
      { id: "latest", title: "Latest Updates", type: DiscoverSectionType.chapterUpdates },
      { id: "views", title: "Most Viewed", type: DiscoverSectionType.simpleCarousel },
      { id: "newest", title: "New Series", type: DiscoverSectionType.simpleCarousel },
      { id: "rating", title: "Top Rated", type: DiscoverSectionType.simpleCarousel },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const page = pageOf(metadata);
    const { items, hasMore } = await this.fetchList(section.id, page);
    const next = hasMore ? { page: page + 1 } : undefined;
    const result: DiscoverSectionItem[] = [];
    for (const item of items) {
      const mangaId = item.urlSlug ?? item.slug;
      const common = {
        mangaId,
        title: item.title,
        imageUrl: imageUrl(item.coverImage),
        contentRating: this.ratingOf(item),
      };
      const latest = this.latestFree(item);
      if (section.id === "trending") {
        result.push({
          ...common,
          type: "featuredCarouselItem",
          supertitle: TYPE[item.type ?? ""] ?? undefined,
        });
      } else if (section.id === "latest") {
        if (!latest) continue;
        result.push({
          ...common,
          type: "chapterUpdatesCarouselItem",
          chapterId: String(latest.number),
          subtitle: `Chapter ${latest.number}`,
          publishDate: dateOf(latest.publishedAt),
        });
      } else {
        result.push({
          ...common,
          type: "simpleCarouselItem",
          subtitle: latest ? `Chapter ${latest.number}` : undefined,
        });
      }
    }
    return { items: result, metadata: next };
  }

  // ── Search ─────────────────────────────────────────────────────────────

  async getSortingOptions(): Promise<SortingOption[]> {
    return SORTS;
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = pageOf(metadata);
    const { items, hasMore } = await this.fetchList(
      sortingOption?.id,
      page,
      (query.title ?? "").trim(),
    );
    return {
      items: items.map((item) => {
        const latest = this.latestFree(item);
        return {
          mangaId: item.urlSlug ?? item.slug,
          title: item.title,
          imageUrl: imageUrl(item.coverImage),
          subtitle: latest ? `Chapter ${latest.number}` : undefined,
          contentRating: this.ratingOf(item),
        };
      }),
      metadata: hasMore ? { page: page + 1 } : undefined,
    };
  }

  // ── A series ───────────────────────────────────────────────────────────

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const { series } = await this.fetchSeriesPage(mangaId, 1);
    const titles = [series.altTitle, series.originalTitle, ...(series.aliases ?? [])]
      .map((title) => String(title ?? "").trim())
      .filter((title, i, all) => title && title !== series.title && all.indexOf(title) === i);
    const genres: TagSection = {
      id: "genres",
      title: "Genres",
      tags: (series.genres ?? [])
        .map((genre) => ({ id: genreSlug(genre), title: genreName(genre) }))
        .filter((tag) => tag.id && tag.title),
    };
    return {
      mangaId,
      mangaInfo: {
        primaryTitle: series.title,
        secondaryTitles: titles,
        thumbnailUrl: imageUrl(series.coverImage),
        bannerUrl: series.bannerImage ? imageUrl(series.bannerImage) : undefined,
        synopsis: series.description ?? "",
        contentRating: this.ratingOf(series),
        status: STATUS[series.status ?? ""] ?? series.status,
        rating: typeof series.rating === "number" ? series.rating / 10 : undefined,
        tagGroups: genres.tags.length ? [genres] : [],
        additionalInfo: TYPE[series.type ?? ""] ? { type: TYPE[series.type ?? ""] } : undefined,
        shareUrl: seriesUrl(mangaId).toString(),
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const first = await this.fetchSeriesPage(sourceManga.mangaId, 1);
    const all: DrakeChapterSummary[] = [...first.chapters];
    for (let page = 2; page <= (first.totalPages ?? 1); page++) {
      all.push(...(await this.fetchSeriesPage(sourceManga.mangaId, page)).chapters);
    }
    return all
      .filter((chapter) => !(chapter.isLocked && !chapter.hasAccess))
      .filter((chapter) => !chapter.contentFormat || chapter.contentFormat === "IMAGES")
      .map((chapter) => {
        const title = String(chapter.title ?? "").trim();
        const plain =
          !title || title === String(chapter.number) || title === `Chapter ${chapter.number}`;
        return {
          chapterId: String(chapter.number),
          sourceManga,
          langCode: "🇬🇧",
          chapNum: chapter.number,
          title: plain ? undefined : title,
          publishDate: dateOf(chapter.publishedAt),
        };
      });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const url = seriesUrl(chapter.sourceManga.mangaId)
      .addPathComponent("chapter")
      .addPathComponent(chapter.chapterId);
    const reader = objectStartingWith<DrakeReader>(
      await this.fetchData(url.toString()),
      '{"chapter":',
    );
    if (!reader?.chapter) throw new Error("Drake Scans sent a chapter page this source can't read");
    if (reader.isLocked && !reader.isUnlocked) {
      throw new Error(
        `Chapter ${chapter.chapterId} is sold for coins on Drake Scans; read it on drakecomic.net`,
      );
    }
    const pages = (reader.chapter.pages ?? []).filter(
      (page) => (!page.kind || page.kind === "CONTENT") && !page.isRedacted && page.imageUrl,
    );
    if (pages.some((page) => page.isEncrypted)) {
      throw new Error(
        `Drake Scans protects the images of chapter ${chapter.chapterId}; read it on drakecomic.net`,
      );
    }
    if (!pages.length) throw new Error(`Chapter ${chapter.chapterId} has no pages on Drake Scans`);
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: pages
        .sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
        .map((page) => imageUrl(page.imageUrl)),
    };
  }
}

export const DrakeScans = new DrakeScansExtension();
