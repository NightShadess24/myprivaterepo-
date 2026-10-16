// A layer put around trackers from other repositories (AniList, MangaUpdates,
// …) when they're built for the 0.9 Trackers repository: it records what
// Paperback sends them and adds an "Automatic updates" page to their
// settings, with a timer since the last update and the history of updates,
// like this repository's MyAnimeList tracker. The tracker's own code is
// unchanged; scripts/tracker-history.mjs puts this after it.

import { ButtonRow, Form, LabelRow, NavigationRow, Section } from "@paperback/types";

const HISTORY_KEY = "pbsync-history";
const LAST_KEY = "pbsync-last";
const TITLES_KEY = "pbsync-titles";
const HISTORY_SIZE = 100;
const RECENT = 5;

// ── Storage (the tracker's own app storage, under keys of this layer) ─────

function read(key) {
  try {
    return Application.getState(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key, value) {
  try {
    Application.setState(value, key);
  } catch {
    // Not saved: the history is only a convenience.
  }
}

const getHistory = () => (Array.isArray(read(HISTORY_KEY)) ? read(HISTORY_KEY) : []);
const addHistory = (entries) =>
  entries.length && write(HISTORY_KEY, [...entries, ...getHistory()].slice(0, HISTORY_SIZE));

// ── Dates and times ───────────────────────────────────────────────────────

function dateOf(value) {
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value?.getTime === "function") date = new Date(value.getTime());
  else if (typeof value === "number") date = new Date(value < 1e11 ? value * 1000 : value);
  else if (typeof value === "string" && value) date = new Date(value);
  else return undefined;
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const seconds = (later, earlier) => (later.getTime() - earlier.getTime()) / 1000;

/** "45s", "2m 05s", "3h 12m", "2d 4h" */
function durationText(value) {
  const s = Math.max(0, Math.round(value));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function timeOfDay(date) {
  if (!date) return "";
  try {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return date.toLocaleTimeString();
  }
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();

function dayOf(date) {
  const now = new Date();
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, new Date(now.getTime() - 86400000))) return "Yesterday";
  try {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return date.toLocaleDateString();
  }
}

// ── Chapters ──────────────────────────────────────────────────────────────

const CHAPTER_IN_TEXT = /(?:^|[^a-z])(?:chapter|chap|ch)[\s._-]*(\d+(?:\.\d+)?)/i;

/** The app's chapter number, or the one in the chapter's title or id ("Chapter 12"). */
function chapterNumberOf(action) {
  for (const value of [action?.chapterNum, action?.readChapter?.chapNum]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  for (const text of [action?.readChapter?.title, action?.chapterId, action?.chapterSourceId]) {
    const match = CHAPTER_IN_TEXT.exec(String(text ?? ""));
    if (match) return Number(match[1]);
  }
  return 0;
}

/** The action, with the chapter number from its title when the app gave none. */
function withChapterNumber(action) {
  const number = chapterNumberOf(action);
  if (!action || typeof action !== "object" || number === Number(action.chapterNum)) return action;
  return Object.create(action, { chapterNum: { value: number, enumerable: true } });
}

// ── Recording what Paperback sends ────────────────────────────────────────

const MARKS = { saved: "✓", failed: "✕", waiting: "…" };

async function titlesOf(ext, mangaIds, given) {
  const titles = { ...read(TITLES_KEY), ...given };
  // Up to three look-ups for manga the app sent without a title.
  const missing = mangaIds.filter((id) => !titles[id]).slice(0, 3);
  for (const id of missing) {
    try {
      const manga = await ext.getMangaDetails?.(id);
      if (manga?.mangaInfo?.primaryTitle) titles[id] = manga.mangaInfo.primaryTitle;
    } catch {
      // Left as "Manga <id>".
    }
  }
  const kept = Object.fromEntries(Object.entries(titles).slice(-300));
  write(TITLES_KEY, kept);
  return kept;
}

async function processAndRecord(ext, process, name, actions) {
  const list = Array.isArray(actions) ? actions.map(withChapterNumber) : actions;
  const at = new Date();
  let result;
  let error;
  try {
    result = await process(list);
  } catch (caught) {
    // Never throw back at the app: everything stays queued for next time.
    error = String(caught?.message ?? caught).slice(0, 160);
    result = { successfulItems: [], failedItems: [] };
  }
  try {
    const saved = new Set(result?.successfulItems ?? []);
    const failed = new Set(result?.failedItems ?? []);
    const byManga = new Map();
    for (const action of Array.isArray(list) ? list : []) {
      const id = String(action?.sourceManga?.mangaId ?? "");
      if (!byManga.has(id)) byManga.set(id, []);
      byManga.get(id).push(action);
    }
    const given = {};
    for (const [id, mangaActions] of byManga) {
      const title = mangaActions.find((a) => a?.sourceManga?.mangaInfo?.primaryTitle)?.sourceManga
        ?.mangaInfo?.primaryTitle;
      if (title) given[id] = title;
    }
    const titles = await titlesOf(ext, [...byManga.keys()], given);
    const entries = [];
    const counts = { saved: 0, failed: 0, waiting: 0 };
    for (const [id, mangaActions] of byManga) {
      const chapter = Math.max(0, ...mangaActions.map((a) => Number(a?.chapterNum) || 0));
      const kind = mangaActions.some((a) => failed.has(a?.id))
        ? "failed"
        : mangaActions.every((a) => saved.has(a?.id))
          ? "saved"
          : "waiting";
      counts[kind]++;
      const readAt = mangaActions
        .map((a) => dateOf(a?.creationDate))
        .reduce((newest, date) => (date && (!newest || date > newest) ? date : newest), undefined);
      const what = chapter > 0 ? `chapter ${chapter}` : "a chapter without a number";
      entries.push({
        at: at.toISOString(),
        kind,
        readAt: readAt?.toISOString(),
        text: `${titles[id] ?? `Manga ${id}`}: ${what} ${
          kind === "saved"
            ? `sent to ${name}`
            : kind === "failed"
              ? `didn't reach ${name} (it will try again)`
              : "not sent yet (it will try again)"
        }`,
      });
    }
    addHistory(entries);
    write(LAST_KEY, { at: at.toISOString(), ...counts, error });
  } catch {
    // The history is only a convenience.
  }
  return result;
}

// ── The "Automatic updates" page ──────────────────────────────────────────

function historyRow(entry, id, withDay) {
  const at = dateOf(entry.at);
  const read = dateOf(entry.readAt);
  return LabelRow(id, {
    title: `${MARKS[entry.kind] ?? "•"} ${entry.text}`,
    subtitle: [
      at ? (withDay ? `${dayOf(at)} ${timeOfDay(at)}` : timeOfDay(at)) : undefined,
      at && read ? `${durationText(seconds(at, read))} after you read it` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  });
}

function lastUpdateText() {
  const at = dateOf(read(LAST_KEY)?.at);
  return at ? `${durationText(seconds(new Date(), at))} ago` : "Not yet";
}

class UpdatesForm extends Form {
  constructor(name) {
    super();
    this.name = name;
    this.ticking = 0;
  }

  // Redrawn every second while open, so the timer counts up and a new update
  // shows up right away.
  formDidAppear() {
    const run = ++this.ticking;
    void (async () => {
      for (let tick = 0; tick < 1800 && run === this.ticking; tick++) {
        await Application.sleep(1);
        if (run === this.ticking) this.reloadForm();
      }
    })();
  }

  formWillDisappear() {
    this.ticking++;
  }

  getSections() {
    const last = read(LAST_KEY);
    const at = dateOf(last?.at);
    const history = getHistory();
    const days = [];
    for (const entry of history) {
      const when = dateOf(entry.at);
      const day = when ? dayOf(when) : "Earlier";
      let current = days[days.length - 1];
      if (current?.day !== day) days.push((current = { day, entries: [] }));
      current.entries.push(entry);
    }
    return [
      Section(
        {
          id: "pbsync-last",
          header: "Automatic updates",
          footer: `The timer counts up while this page is open and goes back to 0 each time Paperback sends ${this.name} what you've read, usually a few minutes after you finish a chapter.`,
        },
        [
          LabelRow("pbsync-last", {
            title: "Last update",
            value: lastUpdateText(),
            subtitle: last
              ? [
                  timeOfDay(at),
                  `${last.saved ?? 0} sent, ${last.failed ?? 0} failed, ${last.waiting ?? 0} waiting`,
                  last.error,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Read a chapter of a manga linked to this tracker, then come back here.",
          }),
        ],
      ),
      ...(history.length
        ? days.map(({ day, entries }, d) =>
            Section(
              { id: `pbsync-day-${d}`, header: day },
              entries.map((entry, index) => historyRow(entry, `pbsync-${d}-${index}`, false)),
            ),
          )
        : [
            Section("pbsync-none", [
              LabelRow("pbsync-none", {
                title: "No updates yet",
                subtitle: "Chapters you read in linked manga show up here.",
              }),
            ]),
          ]),
      Section(
        {
          id: "pbsync-key",
          footer: `✓ sent · ✕ didn't reach ${this.name} · … not sent yet. The last ${HISTORY_SIZE} are kept.`,
        },
        history.length
          ? [
              ButtonRow("pbsync-clear", {
                title: "Clear history",
                onSelect: Application.Selector(this, "clear"),
              }),
            ]
          : [],
      ),
    ];
  }

  async clear() {
    write(HISTORY_KEY, []);
    this.reloadForm();
  }
}

/** The tracker's settings, with a row on top that opens "Automatic updates". */
function withUpdatesRow(form, name) {
  if (!form || typeof form.getSections !== "function" || form.__pbsync) return form;
  const own = form.getSections.bind(form);
  const page = new UpdatesForm(name);
  Object.defineProperty(form, "__pbsync", { value: true });
  form.getSections = () => {
    const recent = getHistory().slice(0, RECENT);
    return [
      Section({ id: "pbsync-updates", header: "Automatic updates" }, [
        NavigationRow("pbsync-open", {
          title: "Last update",
          value: lastUpdateText(),
          subtitle: recent[0] ? `${MARKS[recent[0].kind] ?? "•"} ${recent[0].text}` : undefined,
          form: page,
        }),
      ]),
      ...own(),
    ];
  };
  return form;
}

// ── Putting it around the tracker ─────────────────────────────────────────

/** `source` is what the tracker's bundle exports; `id` its extension's name in it. */
export function wrap(source, id, name) {
  const ext = source?.[id];
  if (!ext || typeof ext.processChapterReadActionQueue !== "function") return source;
  const label = name || id;
  const process = ext.processChapterReadActionQueue.bind(ext);
  // One batch at a time, so an older chapter can't overwrite a newer one.
  let turn = Promise.resolve();
  ext.processChapterReadActionQueue = (actions) => {
    const run = turn.then(() => processAndRecord(ext, process, label, actions));
    turn = run.catch(() => undefined);
    return run;
  };
  if (typeof ext.getSettingsForm === "function") {
    const settings = ext.getSettingsForm.bind(ext);
    ext.getSettingsForm = async (...args) => withUpdatesRow(await settings(...args), label);
  }
  return source;
}
