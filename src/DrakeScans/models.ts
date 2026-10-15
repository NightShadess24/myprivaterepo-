/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */

export const DOMAIN = "https://drakecomic.net";

// What drakecomic.net's pages carry as data (see flight.ts). Only the fields
// this source reads.

export interface DrakeGenre {
  name?: string;
  slug?: string;
  genre?: { name?: string; slug?: string };
}

export interface DrakeListChapter {
  number: number;
  title?: string;
  isLocked?: boolean;
  publishedAt?: string;
}

/** One series in a list (browse, search) */
export interface DrakeListItem {
  id: string;
  slug: string;
  urlSlug?: string;
  title: string;
  coverImage?: string | null;
  type?: string;
  status?: string;
  rating?: number;
  isMature?: boolean;
  genres?: DrakeGenre[];
  chapters?: DrakeListChapter[];
}

export interface DrakeSeries {
  id: string;
  title: string;
  slug: string;
  urlSlug?: string;
  altTitle?: string | null;
  originalTitle?: string | null;
  aliases?: string[];
  description?: string | null;
  coverImage?: string | null;
  bannerImage?: string | null;
  status?: string;
  type?: string;
  origin?: string;
  rating?: number;
  genres?: DrakeGenre[];
}

export interface DrakeChapterSummary {
  id: string;
  number: number;
  title?: string | null;
  isLocked?: boolean;
  coinPrice?: number;
  hasAccess?: boolean;
  publishedAt?: string | null;
  contentFormat?: string;
}

/** A series page: the series and one page of its chapters (100 a page) */
export interface DrakeSeriesPage {
  series: DrakeSeries;
  chapters: DrakeChapterSummary[];
  currentPage?: number;
  totalPages?: number;
}

export interface DrakeReaderPage {
  pageNumber?: number;
  kind?: string;
  isRedacted?: boolean;
  isEncrypted?: boolean;
  imageUrl?: string | null;
}

/** A chapter page */
export interface DrakeReader {
  chapter: {
    id: string;
    number: number;
    title?: string | null;
    pages?: DrakeReaderPage[];
  };
  isLocked?: boolean;
  isUnlocked?: boolean;
  coinPrice?: number;
}
