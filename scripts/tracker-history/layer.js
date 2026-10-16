// A layer put around 0.9 trackers from other repositories (AniList,
// MangaUpdates, …) when the 0.9 Trackers repository is built: it records what
// Paperback sends them and adds an "Automatic updates" page to their
// settings, with a timer since the last update and the history of updates,
// like this repository's MyAnimeList tracker. The tracker's own code is
// unchanged; scripts/tracker-history.mjs puts this after it.

import { ButtonRow, Form, LabelRow, NavigationRow, Section } from "@paperback/types";

import {
  byDay,
  chapterNumberFrom,
  countsText,
  dateOf,
  entriesFor,
  entryDetail,
  entryTitle,
  HISTORY_KEY,
  HISTORY_SIZE,
  keyText,
  LAST_KEY,
  lastUpdateText,
  RECENT,
  timeOfDay,
  TITLES_KEY,
} from "./common.js";

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

// ── Chapters ──────────────────────────────────────────────────────────────

const chapterNumberOf = (action) =>
  chapterNumberFrom(
    [action?.chapterNum, action?.readChapter?.chapNum],
    [action?.readChapter?.title, action?.chapterId, action?.chapterSourceId],
  );

/** The action, with the chapter number from its title when the app gave none. */
function withChapterNumber(action) {
  const number = chapterNumberOf(action);
  if (!action || typeof action !== "object" || number === Number(action.chapterNum)) return action;
  return Object.create(action, { chapterNum: { value: number, enumerable: true } });
}

// ── Recording what Paperback sends ────────────────────────────────────────

async function titlesOf(ext, mangaIds, given) {
  const titles = { ...read(TITLES_KEY), ...given };
  // Up to three look-ups for manga the app sent without a title.
  for (const id of mangaIds.filter((id) => !titles[id]).slice(0, 3)) {
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
    const groups = new Map();
    const given = {};
    for (const action of Array.isArray(list) ? list : []) {
      const mangaId = String(action?.sourceManga?.mangaId ?? "");
      if (!groups.has(mangaId))
        groups.set(mangaId, { mangaId, chapters: [], outcomes: [], readTimes: [] });
      const group = groups.get(mangaId);
      group.chapters.push(action?.chapterNum);
      group.outcomes.push(
        saved.has(action?.id) ? "saved" : failed.has(action?.id) ? "failed" : undefined,
      );
      group.readTimes.push(action?.creationDate);
      const title = action?.sourceManga?.mangaInfo?.primaryTitle;
      if (title) given[mangaId] = title;
    }
    const titles = await titlesOf(ext, [...groups.keys()], given);
    const { entries, counts } = entriesFor([...groups.values()], titles, name, at);
    addHistory(entries);
    write(LAST_KEY, { at: at.toISOString(), ...counts, error });
  } catch {
    // The history is only a convenience.
  }
  return result;
}

// ── The "Automatic updates" page ──────────────────────────────────────────

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
    const history = getHistory();
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
            value: lastUpdateText(last),
            subtitle: last
              ? [timeOfDay(dateOf(last.at)), countsText(last), last.error]
                  .filter(Boolean)
                  .join(" · ")
              : "Read a chapter of a manga linked to this tracker, then come back here.",
          }),
        ],
      ),
      ...(history.length
        ? byDay(history).map(({ day, entries }, d) =>
            Section(
              { id: `pbsync-day-${d}`, header: day },
              entries.map((entry, index) =>
                LabelRow(`pbsync-${d}-${index}`, {
                  title: entryTitle(entry),
                  subtitle: entryDetail(entry, false),
                }),
              ),
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
        { id: "pbsync-key", footer: keyText(this.name) },
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
          value: lastUpdateText(read(LAST_KEY)),
          subtitle: recent[0] ? entryTitle(recent[0]) : undefined,
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
