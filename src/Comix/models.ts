/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import type { SearchResultItem } from "@paperback/types";

export const DOMAIN = "https://comix.to";
export const NO_IMAGE = `${DOMAIN}/images/no-poster.png`;

export type SectionEntry = { id: string; title: string };

export const DISCOVERY_SECTIONS: SectionEntry[] = [
  { id: "popular", title: "Popular" },
  { id: "follow", title: "Most Follows New Comics" },
  { id: "recent", title: "Recent Comics" },
  { id: "trending_manga", title: "Trending Manga" },
  { id: "trending_wt", title: "Trending WebToons" },
  { id: "updatesHot", title: "Latest Updates HOT" },
  { id: "updatesNew", title: "Latest Updates NEW" },
  { id: "completed", title: "Completed" },
  { id: "genresSection", title: "Best of Genres" },
];

export type TagMap = Record<string, "included" | "excluded">;

export interface ApiResponse<T> {
  status: string;
  result: T;
}

export interface ResultManga {
  items: MangaItem[];
  meta?: { hasNext: boolean };
}

export interface MangaItem {
  hid: string;
  title: string;
  altTitles: string[];
  synopsis: string;
  poster: { medium?: string; large?: string } | null;
  type: string;
  year: number;
  status: string;
  latestChapter: number;
  finalChapter: number;
  chapterUpdatedAtFormatted: string;
  ratedAvg: number;
  followsTotal: number;
  contentRating: string;
  url: string;
  authors?: { title: string }[];
  artists?: { title: string }[];
  genres: { id: number; title: string }[];
  demographics: { id: number; title: string }[];
}

// Extras beyond SearchResultItem feed FeaturedCarouselItem; other item types strip them
export type MangaListItem = SearchResultItem & {
  publishDate: Date;
  supertitle: string;
  summary: string;
  infoItems: [{ symbol: string; text: string }, { symbol: string; text: string }];
};

// Fields beyond id/number/url are optional: the decoded chapter list has dropped
// some of them before (e.g. `mangaId`), so parse defensively.
export interface ChapterItem {
  id: number;
  number: number;
  url: string;
  mangaId?: number;
  isOfficial?: boolean;
  name?: string | null;
  language?: string | null;
  volume?: number | null;
  votes?: number | null;
  createdAtFormatted?: string | null;
  group?: { id?: number; name: string } | null;
}

// The reader's decoded page list. `s: 1` marks a V3 page, which needs `?v3` on its
// URL for the server to send the X-Scramble-* headers. `alt`/`node` name the
// fallback image hosts the site's reader retries a failed page on.
export interface ChapterPages {
  baseUrl?: string;
  items: { url: string; s?: number }[];
  alt?: string[];
  node?: string | null;
}

export interface OptionItem {
  id: string;
  title: string;
}

export type Metadata = {
  page: number;
};

export type SearchMetadata = {
  genres?: TagMap;
  formats?: TagMap;
  types?: TagMap;
  demographic?: TagMap;
  status?: TagMap;
  mode?: string[];
  minChap?: number;
  contentRating?: string[];
};
