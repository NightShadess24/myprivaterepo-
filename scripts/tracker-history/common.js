// What both tracker layers share (layer.js for 0.9, layer08.js for 0.8):
// dates and times, chapter numbers, and the update history's entries.

export const HISTORY_KEY = "pbsync-history";
export const LAST_KEY = "pbsync-last";
export const TITLES_KEY = "pbsync-titles";
export const HISTORY_SIZE = 100;
export const RECENT = 5;

export const MARKS = { saved: "✓", failed: "✕", waiting: "…" };

// ── Dates and times ───────────────────────────────────────────────────────

export function dateOf(value) {
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value?.getTime === "function") date = new Date(value.getTime());
  else if (typeof value === "number") date = new Date(value < 1e11 ? value * 1000 : value);
  else if (typeof value === "string" && value) date = new Date(value);
  else return undefined;
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export const seconds = (later, earlier) => (later.getTime() - earlier.getTime()) / 1000;

/** "45s", "2m 05s", "3h 12m", "2d 4h" */
export function durationText(value) {
  const s = Math.max(0, Math.round(value));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function timeOfDay(date) {
  if (!date) return "";
  try {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return date.toLocaleTimeString();
  }
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();

/** "Today", "Yesterday" or "Oct 14" */
export function dayOf(date) {
  const now = new Date();
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, new Date(now.getTime() - 86400000))) return "Yesterday";
  try {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return date.toLocaleDateString();
  }
}

export function lastUpdateText(last) {
  const at = dateOf(last?.at);
  return at ? `${durationText(seconds(new Date(), at))} ago` : "Not yet";
}

export function countsText(last) {
  return `${last?.saved ?? 0} sent, ${last?.failed ?? 0} failed, ${last?.waiting ?? 0} waiting`;
}

/** The history, newest first, by day: [{ day: "Today", entries }] */
export function byDay(history) {
  const days = [];
  for (const entry of history) {
    const when = dateOf(entry.at);
    const day = when ? dayOf(when) : "Earlier";
    let current = days[days.length - 1];
    if (current?.day !== day) days.push((current = { day, entries: [] }));
    current.entries.push(entry);
  }
  return days;
}

/** "5:09 AM · 1m 05s after you read it" */
export function entryDetail(entry, withDay) {
  const at = dateOf(entry.at);
  const read = dateOf(entry.readAt);
  return [
    at ? (withDay ? `${dayOf(at)} ${timeOfDay(at)}` : timeOfDay(at)) : undefined,
    at && read ? `${durationText(seconds(at, read))} after you read it` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export const entryTitle = (entry) => `${MARKS[entry.kind] ?? "•"} ${entry.text}`;

// ── Chapters ──────────────────────────────────────────────────────────────

const CHAPTER_IN_TEXT = /(?:^|[^a-z])(?:chapter|chap|ch)[\s._-]*(\d+(?:\.\d+)?)/i;

/** The first positive number, or the chapter number in one of the texts ("Chapter 12"). */
export function chapterNumberFrom(numbers, texts) {
  for (const value of numbers) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  for (const text of texts) {
    const match = CHAPTER_IN_TEXT.exec(String(text ?? ""));
    if (match) return Number(match[1]);
  }
  return 0;
}

// ── History entries ───────────────────────────────────────────────────────

/**
 * One entry per manga in a batch. `groups` is [{ mangaId, chapters: number[],
 * outcomes: ("saved"|"failed"|undefined)[], readTimes }]; `titles` maps ids to titles.
 */
export function entriesFor(groups, titles, name, at) {
  const counts = { saved: 0, failed: 0, waiting: 0 };
  const entries = groups.map(({ mangaId, chapters, outcomes, readTimes }) => {
    const chapter = Math.max(0, ...chapters.map((n) => Number(n) || 0));
    const kind = outcomes.includes("failed")
      ? "failed"
      : outcomes.length && outcomes.every((o) => o === "saved")
        ? "saved"
        : "waiting";
    counts[kind]++;
    const readAt = readTimes
      .map(dateOf)
      .reduce((newest, date) => (date && (!newest || date > newest) ? date : newest), undefined);
    const what = chapter > 0 ? `chapter ${chapter}` : "a chapter without a number";
    return {
      at: at.toISOString(),
      kind,
      readAt: readAt?.toISOString(),
      text: `${titles[mangaId] ?? `Manga ${mangaId}`}: ${what} ${
        kind === "saved"
          ? `sent to ${name}`
          : kind === "failed"
            ? `didn't reach ${name} (it will try again)`
            : "not sent yet (it will try again)"
      }`,
    };
  });
  return { entries, counts };
}

export const keyText = (name) =>
  `✓ sent · ✕ didn't reach ${name} · … not sent yet. The last ${HISTORY_SIZE} are kept.`;
