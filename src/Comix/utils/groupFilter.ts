/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// Scanlation group filter, from the Paperback 0.8 ComixTo extension by
// acepilot147 (https://github.com/acepilot147/pb-extensions, GPL-3.0,
// Parser.parseChapters): hide the listed groups' uploads, or show only theirs,
// matching names exactly or by part. "One entry per chapter" keeps a single
// upload per chapter and language (official first, then the most votes, then
// the newest), so a list reads like comix's own chapter count.

import type { ChapterItem } from "../models";

const KEYS = {
  on: "group_filter_on",
  mode: "group_filter_mode",
  exact: "group_filter_exact",
  groups: "group_filter_groups",
  onePerChapter: "group_filter_one_per_chapter",
};

export const GROUP_FILTER_MODES = [
  { id: "hide", title: "Hide these groups" },
  { id: "only", title: "Show only these groups" },
];

export interface GroupFilterSettings {
  on: boolean;
  mode: "hide" | "only";
  exact: boolean;
  groups: string;
  onePerChapter: boolean;
}

export function getGroupFilter(): GroupFilterSettings {
  const read = (key: string) => Application.getState(key);
  return {
    on: read(KEYS.on) === true,
    mode: read(KEYS.mode) === "only" ? "only" : "hide",
    exact: read(KEYS.exact) === true,
    groups: typeof read(KEYS.groups) === "string" ? (read(KEYS.groups) as string) : "",
    onePerChapter: read(KEYS.onePerChapter) === true,
  };
}

export function setGroupFilter(key: keyof GroupFilterSettings, value: unknown): void {
  Application.setState(value, KEYS[key]);
}

// Case, accents and punctuation don't matter: "Asura Scans" = "asura-scans".
const normalized = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();

export function groupNames(list: string): string[] {
  return list
    .split(/[,\n]/)
    .map(normalized)
    .filter((name) => name.length > 0);
}

export function filterChapters<T extends ChapterItem>(
  items: readonly T[],
  settings: GroupFilterSettings = getGroupFilter(),
): T[] {
  let result = [...items];
  const names = settings.on ? groupNames(settings.groups) : [];
  if (names.length > 0) {
    result = result.filter((item) => {
      const group = normalized(item.group?.name ?? "");
      const listed = names.some((name) =>
        settings.exact ? group === name : group.length > 0 && group.includes(name),
      );
      return settings.mode === "only" ? listed : !listed;
    });
  }
  if (settings.onePerChapter) {
    const best = new Map<string, T>();
    const better = (a: T, b: T): boolean => {
      if (a.isOfficial !== b.isOfficial) return a.isOfficial;
      if ((a.votes ?? 0) !== (b.votes ?? 0)) return (a.votes ?? 0) > (b.votes ?? 0);
      return a.id > b.id;
    };
    for (const item of result) {
      const key = `${item.language}|${item.number}`;
      const kept = best.get(key);
      if (!kept || better(item, kept)) best.set(key, item);
    }
    result = result.filter((item) => best.get(`${item.language}|${item.number}`) === item);
  }
  return result;
}
