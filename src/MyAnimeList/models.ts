/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */

// What the MyAnimeList API (v2) sends; only the fields this tracker reads.

export interface MalListStatus {
  status?: string;
  num_chapters_read?: number;
  num_volumes_read?: number;
  score?: number;
  num_times_reread?: number;
  comments?: string;
  updated_at?: string;
}

export interface MalManga {
  id: number;
  title: string;
  main_picture?: { medium?: string; large?: string };
  alternative_titles?: { synonyms?: string[]; en?: string; ja?: string };
  synopsis?: string;
  mean?: number;
  status?: string;
  nsfw?: string;
  media_type?: string;
  start_date?: string;
  num_chapters?: number;
  num_volumes?: number;
  genres?: { id: number; name: string }[];
  authors?: { node: { first_name?: string; last_name?: string }; role?: string }[];
  my_list_status?: MalListStatus;
}

export interface MalPage {
  data: { node: MalManga; list_status?: MalListStatus; ranking?: { rank?: number } }[];
  paging?: { next?: string };
}
