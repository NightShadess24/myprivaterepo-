/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  BasicRateLimiter,
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
  type UpdateManager,
} from "@paperback/types";

import { ComixAdvancedSearchForm } from "./forms/search";
import { ComixSettingsForm, getDiscoverySectionsOrder } from "./forms/settings";
import { DOMAIN, type Metadata, type SearchMetadata } from "./models";
import { browseUrl, clearCloudflareChallenge, ComixInterceptor, fetchText } from "./network";
import {
  chapterPath,
  chapterUpdatedAtMs,
  parseChapterDetails,
  parseChapters,
  parseMangaDetails,
  parseMangaList,
} from "./parsers";
import type ComixConfig from "./pbconfig";
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
import {
  describeCookies,
  loadClearance,
  logEvent,
  passCandidates,
  saveClearance,
  saveSiteCookies,
  saveWafPass,
  timeAgo,
  useQuickRefresh,
  withDiagnostics,
} from "./utils/session";
import {
  browseViaWebView,
  chapterListViaWebView,
  isKeptCookie,
  isSiteCookie,
  pageListViaWebView,
  storeSiteCookies,
} from "./utils/webView";

const ALL_CONTENT_RATINGS = "safe,suggestive,erotica,pornographic";
// Upload times are often only relative text ("3 days ago"), so scan a bit past
// the last update.
const UPDATE_SCAN_MARGIN_MS = 24 * 60 * 60 * 1000;
const UPDATE_SCAN_MAX_PAGES = 20;

class ComixExtension implements ExtensionImpl<typeof ComixConfig> {
  // Page fetches (images are served from other hosts and not limited). The
  // WebView pace for library refreshes is set under Settings → Refresh Speed.
  private globalRateLimiter = new BasicRateLimiter("rateLimiter", {
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
    // The settings page builds its puzzle browser synchronously; give it the
    // app's user agent, which Cloudflare's and comix's passes are tied to.
    Application.setState(await Application.getDefaultUserAgent(), "comix_user_agent");

    // Drop Cloudflare's leftover in-progress challenge cookies (cf_chl_*). Move
    // the Cloudflare pass into state, where every instance reads it.
    const stored = this.cookieStorageInterceptor.cookies;
    const kept = stored.filter((cookie) => !isSiteCookie(cookie.domain) || isKeptCookie(cookie));
    if (kept.length !== stored.length) this.cookieStorageInterceptor.cookies = kept;
    const clearance = kept.find((cookie) => cookie.name === "cf_clearance");
    if (clearance && !loadClearance()) saveClearance(clearance, "cookie store");
    saveSiteCookies(
      kept.filter((cookie) => isSiteCookie(cookie.domain)),
      "cookie store",
    );
  }

  // Called after the reader completes a check (Cloudflare's, or the site's own
  // human check). Keep the Cloudflare pass, the site's own cookies and its
  // localStorage — whatever the check left behind — so every later request,
  // including a library refresh, carries them.
  async cloudflareBypassCompleted(
    request: Request,
    cookies: Cookie[],
    siteStorage: Record<string, string>,
  ): Promise<void> {
    const site = cookies.filter((cookie) => isSiteCookie(cookie.domain));
    const page = request?.url?.replace(DOMAIN, "") || "?";
    const storageKeys = Object.keys(siteStorage ?? {});
    logEvent(
      "check done",
      `on ${page}: got ${describeCookies(site)}; storage keys: ${storageKeys.join(", ") || "none"}`,
    );
    storeSiteCookies(this.cookieStorageInterceptor, site, "check");
    const strayPass = cookies.find(
      (cookie) => cookie.name === "cf_clearance" && !isSiteCookie(cookie.domain),
    );
    if (strayPass) this.cookieStorageInterceptor.setCookie(strayPass);
    clearCloudflareChallenge();

    // Hand the check screen's site cookies (its `session`, and `waf_pass` once
    // comix's puzzle is solved) to every page. If the site still asks for its
    // puzzle, the page drops them again, so a bad set is never replayed.
    const candidates = passCandidates(site);
    if (candidates.length > 0) saveWafPass(candidates, "check");
  }

  async getSettingsForm(): Promise<Form> {
    await ensureFilters();
    return new ComixSettingsForm();
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
    return withDiagnostics(`details ${mangaId}`, async () =>
      parseMangaDetails(mangaId, await fetchText(`${DOMAIN}/title/${mangaId}`)),
    );
  }

  // With `sinceDate` (a library refresh) only the newest chapter-list pages are
  // read; the app merges them into the chapters it already has.
  async getChapters(sourceManga: SourceManga, sinceDate?: Date): Promise<Chapter[]> {
    const label = `${sinceDate ? "refresh" : "chapters"} ${sourceManga.mangaId}`;
    return withDiagnostics(label, async () => {
      const items = await chapterListViaWebView(
        sourceManga.mangaId,
        this.cookieStorageInterceptor,
        sinceDate,
      );
      return parseChapters(sourceManga, items);
    });
  }

  // Runs once before a library refresh asks for each title.
  //
  // Instead of loading every title's page (a WebView each, which is what trips
  // Cloudflare), read the site's "latest updates" list back to the last refresh
  // and only refresh the titles that appear in it; the rest are skipped. That is
  // usually a handful of page loads instead of one per title.
  //
  // It falls back to refreshing everything (no skips) when there is no previous
  // refresh to compare with, or the list couldn't be read back far enough.
  // Adult titles are never skipped, in case the list leaves them out. The first
  // request also surfaces a Cloudflare check once, up front.
  async processTitlesForUpdates(
    updateManager: UpdateManager,
    lastUpdateDate?: Date,
  ): Promise<void> {
    return withDiagnostics("refresh scan", () =>
      this.scanForUpdates(updateManager, lastUpdateDate),
    );
  }

  private async scanForUpdates(updateManager: UpdateManager, lastUpdateDate?: Date): Promise<void> {
    const queued = updateManager.getQueuedItems();
    if (queued.length === 0) return;
    const pass = loadClearance();
    logEvent(
      "refresh",
      `${queued.length} titles, last refresh ${lastUpdateDate ? timeAgo(lastUpdateDate.getTime()) : "never"}, pass ${
        pass ? `from ${pass.source} ${timeAgo(pass.savedAt)}` : "missing"
      }`,
    );
    if (!lastUpdateDate || !useQuickRefresh()) {
      await fetchText(`${DOMAIN}/`);
      return;
    }

    const hidOf = (mangaId: string) => mangaId.split("-")[0];
    const wanted = new Set(queued.map((manga) => hidOf(manga.mangaId)));
    const updated = new Set<string>();
    const scanUntil = lastUpdateDate.getTime() - UPDATE_SCAN_MARGIN_MS;
    const maxPages = Math.min(UPDATE_SCAN_MAX_PAGES, Math.ceil(queued.length / 2));
    let complete = false;

    for (let page = 1; page <= maxPages && !complete; page++) {
      const result = await browseViaWebView(
        browseUrl({
          page: page.toString(),
          "order[chapter_updated_at]": "desc",
          content_rating: ALL_CONTENT_RATINGS,
        }),
        this.cookieStorageInterceptor,
        { queued: true },
      );
      for (const item of result.items) {
        const updatedAt = chapterUpdatedAtMs(item);
        if (updatedAt !== null && updatedAt < scanUntil) {
          complete = true;
          break;
        }
        if (wanted.has(item.hid)) updated.add(item.hid);
      }
      const hasNext = result.meta?.hasNext ?? result.items.length > 0;
      if (!hasNext) complete = true;
    }

    let skipped = 0;
    await Promise.all(
      queued.map((manga) => {
        if (updated.has(hidOf(manga.mangaId))) {
          return updateManager.setUpdatePriority(manga.mangaId, "high");
        }
        if (complete && manga.mangaInfo.contentRating !== ContentRating.ADULT) {
          skipped++;
          return updateManager.setUpdatePriority(manga.mangaId, "skip");
        }
        return Promise.resolve();
      }),
    );
    logEvent(
      "refresh scan",
      `${updated.size} with new chapters, ${skipped} skipped${complete ? "" : " (list not read back far enough, nothing skipped)"}`,
    );
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return withDiagnostics(`read ${chapter.sourceManga.mangaId}`, async () => {
      const url = chapter.additionalInfo?.url;
      if (typeof url !== "string" || !url) {
        throw new Error(`Comix: missing page url for chapter ${chapter.chapterId}`);
      }
      const pages = await pageListViaWebView(chapterPath(url), this.cookieStorageInterceptor);
      return parseChapterDetails(chapter.chapterId, chapter.sourceManga.mangaId, pages);
    });
  }
}

export const Comix = new ComixExtension();
