/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  CloudflareError,
  ContentRating,
  CookieStorageInterceptor,
  DiscoverSectionType,
  type AdvancedSearchForm,
  type Chapter,
  type ChapterDetails,
  type Cookie,
  type DiscoverSection,
  type DiscoverSectionItem,
  type ExtensionImpl,
  type Form,
  type PagedResults,
  type Request,
  type SearchQuery,
  type SearchResultItem,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";

import { ComixAdvancedSearchForm } from "./forms/search";
import { ComixSettingsForm, getDiscoverySectionsOrder } from "./forms/settings";
import { DOMAIN, type Metadata, type SearchMetadata } from "./models";
import { browseUrl, ComixInterceptor, fetchText, SiteRateLimiter, startImageLog } from "./network";
import { parseChapterDetails, parseChapters, parseMangaDetails, parseMangaList } from "./parsers";
import type ComixConfig from "./pbconfig";
import { keepSiteCookies } from "./utils/cookies";
import {
  defaultSearchMetadata,
  ensureFilters,
  filters,
  getContentRating,
  getHiddenDemographics,
  getHiddenGenres,
  getShowOnlyTypes,
  getYear,
  horizontalChapterSections,
  horizontalRecentSection,
  horizontalTrendingSections,
  pickTags,
  useYearFilter,
} from "./utils/filters";
import { errorText, logEvent } from "./utils/log";
import { browseViaWebView, chapterListViaWebView, pageListViaWebView } from "./utils/webView";

class ComixExtension implements ExtensionImpl<typeof ComixConfig> {
  private globalRateLimiter = new SiteRateLimiter("rateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 1,
    ignoreImages: true,
  });
  private mainInterceptor = new ComixInterceptor("main");
  private cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });

  async initialise(): Promise<void> {
    this.globalRateLimiter.registerInterceptor();
    this.cookieStorageInterceptor.registerInterceptor();
    this.mainInterceptor.registerInterceptor();
    this.clearOldCookies();
  }

  // Once, on updating from alpha.49–61 of this repo: those versions saved extra
  // comix.to cookies (the site's session, waf_pass, …) and their own state.
  // Start clean like a fresh install of comix-capture, keeping only the
  // Cloudflare pass; the site sets its own cookies again on the next request.
  private clearOldCookies(): void {
    if (Application.getState("comix_capture_migrated")) return;
    const isSite = (domain: string) => /(^|\.)comix\.to$/i.test(domain.replace(/^\./, ""));
    const stored = this.cookieStorageInterceptor.cookies;
    const kept = stored.filter(
      (cookie) => !isSite(cookie.domain) || cookie.name === "cf_clearance",
    );
    if (kept.length !== stored.length) this.cookieStorageInterceptor.cookies = kept;
    for (const key of [
      "comix_cf_clearance",
      "comix_site_cookies",
      "comix_site_storage",
      "comix_waf_pass",
      "comix_last_captcha_title",
      "comix_user_agent",
    ]) {
      Application.setState(undefined, key);
    }
    Application.setState(true, "comix_capture_migrated");
  }

  // Keep everything comix.to left in the check browser (Cloudflare's pass, the
  // site's session and, if its own check showed, its pass), like a browser
  // would, so the hidden pages carry on as the same visitor.
  async cloudflareBypassCompleted(
    request: Request,
    cookies: Cookie[],
    _localStorage: Record<string, string>,
  ): Promise<void> {
    const kept = keepSiteCookies(this.cookieStorageInterceptor, cookies);
    logEvent(
      "check browser",
      `${request.url.replace(/^https?:\/\//, "")}: kept ${kept.length ? kept.join(", ") : "nothing"}`,
    );
  }

  async getSettingsForm(): Promise<Form> {
    await ensureFilters();
    return new ComixSettingsForm(
      this.cookieStorageInterceptor,
      await Application.getDefaultUserAgent(),
    );
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    const chapterType = (horizontal: boolean) =>
      horizontal ? DiscoverSectionType.simpleCarousel : DiscoverSectionType.chapterUpdates;
    const yearSuffix = useYearFilter() ? ` of ${getYear()}` : "";
    const sections: Record<string, DiscoverSection> = {
      popular: { id: "popular", title: "Popular", type: DiscoverSectionType.featured },
      follow: {
        id: "follow",
        title: "Most Follows New Comics",
        type: DiscoverSectionType.prominentCarousel,
      },
      recent: {
        id: "recent",
        title: "Recently Added",
        type: chapterType(horizontalRecentSection()),
      },
      trending_manga: {
        id: "trending_manga",
        title: `Trending Manga${yearSuffix}`,
        type: chapterType(horizontalTrendingSections()),
      },
      trending_wt: {
        id: "trending_wt",
        title: `Trending WebToons${yearSuffix}`,
        type: chapterType(horizontalTrendingSections()),
      },
      completed: { id: "completed", title: "Completed", type: DiscoverSectionType.simpleCarousel },
      updatesHot: {
        id: "updatesHot",
        title: "Latest Updates (HOT)",
        type: chapterType(horizontalChapterSections()),
      },
      updatesNew: {
        id: "updatesNew",
        title: "Latest Updates (NEW)",
        type: chapterType(horizontalChapterSections()),
      },
      genresSection: {
        id: "genresSection",
        title: "Best of genres",
        type: DiscoverSectionType.genres,
      },
    };
    return getDiscoverySectionsOrder()
      .map((section) => sections[section.id])
      .filter((section) => section !== undefined);
  }

  // `/api/v1/manga/top` (trending/follows + days window) is now 403 and has no
  // `/browse` HTML equivalent, so popular/follow map to the closest browse orderings.
  private browseQuery(sectionId: string, page: number) {
    const hidden = [...getHiddenGenres(), ...getHiddenDemographics()];
    const types = getShowOnlyTypes();
    const common = {
      page: page.toString(),
      ...(hidden.length > 0 && { "genres_ex[]": hidden }),
      ...(types.length > 0 && { "types[]": types }),
    };
    const trending = {
      "order[views_30d]": "desc",
      ...(useYearFilter() && { "release_year[from]": getYear().toString() }),
    };
    const sections: Record<string, Record<string, string | string[]>> = {
      popular: { "order[score]": "desc" },
      follow: { "order[follows_total]": "desc" },
      recent: { "order[created_at]": "desc" },
      completed: { "order[chapter_updated_at]": "desc", "statuses[]": "finished" },
      updatesHot: { "order[chapter_updated_at]": "desc", scope: "hot" },
      updatesNew: { "order[chapter_updated_at]": "desc" },
      trending_manga: { ...trending, "types[]": "manga" },
      trending_wt: { ...trending, "types[]": ["manhwa", "manhua"] },
    };
    const section = sections[sectionId];
    return section && { ...common, ...section };
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === "genresSection") {
      await ensureFilters();
      const hidden = getHiddenGenres();
      return {
        items: filters.genres
          .filter((genre) => !hidden.includes(genre.id))
          .map((genre) => ({
            type: "genresCarouselItem",
            name: genre.title,
            searchQuery: { title: "", metadata: defaultSearchMetadata(genre.id) },
            contentRating: genre.title === "Adult" ? ContentRating.ADULT : ContentRating.EVERYONE,
          })),
      };
    }
    const page = metadata?.page ?? 1;
    const query = this.browseQuery(section.id, page);
    if (!query) return { items: [] };
    const result = await browseViaWebView(browseUrl(query), this.cookieStorageInterceptor);
    const items = parseMangaList(result).map((item): DiscoverSectionItem => {
      const { publishDate, subtitle, supertitle, summary, infoItems, metadata: _, ...base } = item;
      switch (section.type) {
        case DiscoverSectionType.featured:
          return { type: "featuredCarouselItem", ...base, supertitle, summary, infoItems };
        case DiscoverSectionType.prominentCarousel:
          return { type: "prominentCarouselItem", ...base, subtitle };
        case DiscoverSectionType.chapterUpdates:
          return {
            type: "chapterUpdatesCarouselItem",
            ...base,
            chapterId: base.mangaId,
            subtitle,
            publishDate,
          };
        default:
          return { type: "simpleCarouselItem", ...base, subtitle };
      }
    });
    const hasNext = result.meta?.hasNext ?? items.length > 0;
    return { items, metadata: hasNext ? { page: page + 1 } : undefined };
  }

  async getSearchResults(
    searchQuery: SearchQuery<SearchMetadata>,
    metadata: Metadata | undefined,
    sortingOption: SortingOption,
  ): Promise<PagedResults<SearchResultItem>> {
    const meta = searchQuery.metadata ?? defaultSearchMetadata();
    const page = metadata?.page ?? 1;
    const [sortBy, orderBy] = sortingOption.id.split("#")[0].split("$");
    const query: Record<string, string | string[]> = {
      page: page.toString(),
      [`order[${sortBy}]`]: orderBy,
      genres_mode: meta.mode ?? ["and"],
      content_rating: (meta.contentRating ?? getContentRating()).join(","),
    };
    if (meta.minChap) {
      query.min_chap = meta.minChap.toString();
    }
    if (searchQuery.title.length > 1) {
      query.keyword = searchQuery.title;
    }
    const tagQueries = {
      "genres_in[]": pickTags("included", meta.genres, meta.formats),
      "genres_ex[]": pickTags("excluded", meta.genres, meta.formats),
      "types[]": pickTags("included", meta.types),
      "demographics[]": pickTags("included", meta.demographic),
      "statuses[]": pickTags("included", meta.status),
    };
    for (const [key, values] of Object.entries(tagQueries)) {
      if (values.length > 0) query[key] = values;
    }
    const result = await browseViaWebView(browseUrl(query), this.cookieStorageInterceptor);
    const items = parseMangaList(result).map(({ publishDate: _, ...item }) => item);
    const hasNext = result.meta?.hasNext ?? items.length > 0;
    return { items, metadata: hasNext ? { page: page + 1 } : undefined };
  }

  async getAdvancedSearchForm(
    searchQuery: SearchQuery<SearchMetadata>,
  ): Promise<AdvancedSearchForm> {
    await ensureFilters();
    searchQuery.metadata ??= defaultSearchMetadata();
    return new ComixAdvancedSearchForm(searchQuery);
  }

  // Ids carry a #title/#empty suffix so a remembered selection from the other
  // mode never matches; getSearchResults strips everything after "#".
  async getSortingOptions(query: SearchQuery<SearchMetadata>): Promise<SortingOption[]> {
    const idSuffix = query.title.length > 1 ? "#title" : "";
    const sortingOptions: SortingOption[] = [
      { id: "chapter_updated_at$asc" + idSuffix, label: "Update Date ↑" },
      { id: "chapter_updated_at$desc" + idSuffix, label: "Update Date ↓" },
      { id: "created_at$asc" + idSuffix, label: "Created Date ↑" },
      { id: "created_at$desc" + idSuffix, label: "Created Date ↓" },
      { id: "title$asc" + idSuffix, label: "Title ↑" },
      { id: "title$desc" + idSuffix, label: "Title ↓" },
      { id: "year$asc" + idSuffix, label: "Year ↑" },
      { id: "year$desc" + idSuffix, label: "Year ↓" },
      { id: "score$asc" + idSuffix, label: "Average Score ↑" },
      { id: "score$desc" + idSuffix, label: "Average Score ↓" },
      { id: "views_total$asc" + idSuffix, label: "Total Views ↑" },
      { id: "views_total$desc" + idSuffix, label: "Total Views ↓" },
      { id: "follows_total$asc" + idSuffix, label: "Most Follows ↑" },
      { id: "follows_total$desc" + idSuffix, label: "Most Follows ↓" },
      { id: "views_7d$asc" + idSuffix, label: "Most Views 7 Days ↑" },
      { id: "views_7d$desc" + idSuffix, label: "Most Views 7 Days ↓" },
      { id: "views_30d$asc" + idSuffix, label: "Most Views 1 Month ↑" },
      { id: "views_30d$desc" + idSuffix, label: "Most Views 1 Month ↓" },
      { id: "views_90d$asc" + idSuffix, label: "Most Views 3 Month ↑" },
      { id: "views_90d$desc" + idSuffix, label: "Most Views 3 Month ↓" },
    ];
    if (query.title.length > 1) {
      sortingOptions.unshift({ id: "relevance$desc" + idSuffix, label: "Best Match" });
    } else {
      sortingOptions.unshift({ id: "chapter_updated_at$desc#empty", label: "Any" });
    }
    return sortingOptions;
  }

  // Details still server-render their data into `<script id="initial-data">`, so
  // fetch the HTML and let the parser extract it (the JSON API is now 403).
  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return parseMangaDetails(mangaId, await fetchText(`${DOMAIN}/title/${mangaId}`));
  }

  // `sinceDate` is set for library updates: then only the newest 100 chapters
  // are read (the app merges them into what it has), one request per title.
  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const items = await chapterListViaWebView(sourceManga.mangaId, this.cookieStorageInterceptor, {
      refresh: sinceDate !== undefined,
    });
    return parseChapters(sourceManga, items);
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const raw = chapter.additionalInfo?.url;
    // Like the Mihon extension: keep the `/title/...` part of the chapter's url
    // (it may come as a full link), or build it when the site gave none.
    const titleIndex = typeof raw === "string" ? raw.indexOf("/title/") : -1;
    const url =
      titleIndex !== -1
        ? (raw as string).slice(titleIndex)
        : `/title/${chapter.sourceManga.mangaId}/${chapter.chapterId}-chapter-${chapter.chapNum}`;
    let pages;
    try {
      pages = await pageListViaWebView(url, chapter.chapterId, this.cookieStorageInterceptor);
    } catch (error) {
      if (!(error instanceof CloudflareError))
        logEvent("chapter failed", `${url}: ${errorText(error)}`);
      throw error;
    }
    startImageLog();
    return parseChapterDetails(chapter.chapterId, chapter.sourceManga.mangaId, pages);
  }
}

export const Comix = new ComixExtension();
