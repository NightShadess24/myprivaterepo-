// The 0.8 version of layer.js: put around 0.8 trackers from other
// repositories (Anilist, MangaUpdates, MyAnimeList) when the 0.8 Trackers
// repository is built. It records what Paperback sends them and adds
// "Last update" and "Update history" to the top of their settings. 0.8
// settings can't redraw themselves, so the time is the one when the page
// was opened. The tracker's own code is unchanged.

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
  timeOfDay,
  TITLES_KEY,
} from "./common.js";

// ── Storage ───────────────────────────────────────────────────────────────

let manager;

async function read(key) {
  try {
    manager = manager || App.createSourceStateManager();
    return (await manager.retrieve(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function write(key, value) {
  try {
    manager = manager || App.createSourceStateManager();
    await manager.store(key, value);
  } catch {
    // Not saved: the history is only a convenience.
  }
}

async function getHistory() {
  const history = await read(HISTORY_KEY);
  return Array.isArray(history) ? history : [];
}

// ── Recording what Paperback sends ────────────────────────────────────────

const chapterNumberOf = (action) =>
  chapterNumberFrom([action?.chapterNumber], [action?.sourceChapterId]);

async function titlesOf(ext, mangaIds) {
  const titles = { ...(await read(TITLES_KEY)) };
  // Up to three look-ups for manga not looked up before.
  for (const id of mangaIds.filter((id) => !titles[id]).slice(0, 3)) {
    try {
      const manga = await ext.getMangaDetails?.(id);
      const title = manga?.mangaInfo?.titles?.[0];
      if (title) titles[id] = title;
    } catch {
      // Left as "Manga <id>".
    }
  }
  const kept = Object.fromEntries(Object.entries(titles).slice(-300));
  await write(TITLES_KEY, kept);
  return kept;
}

async function processAndRecord(ext, process, name, actionQueue) {
  const at = new Date();
  let fetched = [];
  const originals = new Map();
  const outcomes = new Map();
  // The app's queue as the tracker sees it: chapters without a number get the
  // one in their id, and what the tracker does with each is noted.
  const queue = {
    queuedChapterReadActions: async () => {
      const list = await actionQueue.queuedChapterReadActions();
      fetched = (Array.isArray(list) ? list : []).map((action) => {
        const number = chapterNumberOf(action);
        if (!action || typeof action !== "object" || number === Number(action.chapterNumber)) {
          return action;
        }
        const fixed = Object.create(action, { chapterNumber: { value: number, enumerable: true } });
        originals.set(fixed, action);
        return fixed;
      });
      return fetched;
    },
    discardChapterReadAction: async (action) => {
      outcomes.set(action, "saved");
      return actionQueue.discardChapterReadAction(originals.get(action) ?? action);
    },
    retryChapterReadAction: async (action) => {
      outcomes.set(action, "failed");
      return actionQueue.retryChapterReadAction(originals.get(action) ?? action);
    },
  };
  let error;
  try {
    await process.call(ext, queue);
  } catch (caught) {
    error = String(caught?.message ?? caught).slice(0, 160);
  }
  try {
    if (!fetched.length) return;
    const groups = new Map();
    for (const action of fetched) {
      const mangaId = String(action?.mangaId ?? "");
      if (!groups.has(mangaId))
        groups.set(mangaId, { mangaId, chapters: [], outcomes: [], readTimes: [] });
      const group = groups.get(mangaId);
      group.chapters.push(action?.chapterNumber);
      group.outcomes.push(outcomes.get(action));
      group.readTimes.push(action?.readTime);
    }
    const titles = await titlesOf(ext, [...groups.keys()]);
    const { entries, counts } = entriesFor([...groups.values()], titles, name, at);
    await write(HISTORY_KEY, [...entries, ...(await getHistory())].slice(0, HISTORY_SIZE));
    await write(LAST_KEY, { at: at.toISOString(), ...counts, error });
  } catch {
    // The history is only a convenience.
  }
}

// ── Settings ──────────────────────────────────────────────────────────────

const label = (id, title, value) =>
  (App.createDUIMultilineLabel ?? App.createDUILabel)({ id, label: title, value: value ?? "" });

function historyForm(name) {
  return App.createDUIForm({
    sections: async () => {
      const last = await read(LAST_KEY);
      const history = await getHistory();
      return [
        App.createDUISection({
          id: "pbsync_last",
          header: "Automatic updates",
          footer: `The time is from when you opened this page. Paperback sends ${name} what you've read in batches, usually a few minutes after you finish a chapter.`,
          isHidden: false,
          rows: async () => [
            App.createDUILabel({
              id: "pbsync_ago",
              label: "Last update",
              value: lastUpdateText(last),
            }),
            ...(last
              ? [
                  App.createDUILabel({
                    id: "pbsync_counts",
                    label: timeOfDay(dateOf(last.at)),
                    value: countsText(last),
                  }),
                ]
              : []),
          ],
        }),
        ...(history.length
          ? byDay(history).map(({ day, entries }, d) =>
              App.createDUISection({
                id: `pbsync_day_${d}`,
                header: day,
                isHidden: false,
                rows: async () =>
                  entries.map((entry, index) =>
                    label(`pbsync_${d}_${index}`, entryTitle(entry), entryDetail(entry, false)),
                  ),
              }),
            )
          : [
              App.createDUISection({
                id: "pbsync_none",
                isHidden: false,
                rows: async () => [
                  label(
                    "pbsync_none",
                    "No updates yet",
                    "Chapters you read in linked manga show up here.",
                  ),
                ],
              }),
            ]),
        App.createDUISection({
          id: "pbsync_key",
          footer: keyText(name),
          isHidden: false,
          rows: async () =>
            history.length
              ? [
                  App.createDUIButton({
                    id: "pbsync_clear",
                    label: "Clear history",
                    onTap: async () => write(HISTORY_KEY, []),
                  }),
                ]
              : [],
        }),
      ];
    },
  });
}

/** The tracker's settings section with "Last update" and "Update history" on top. */
function withUpdatesRows(theirs, name) {
  const ours = async () => [
    App.createDUILabel({
      id: "pbsync_last_update",
      label: "Last update",
      value: lastUpdateText(await read(LAST_KEY)),
    }),
    App.createDUINavigationButton({
      id: "pbsync_history",
      label: "Update history",
      form: historyForm(name),
    }),
  ];
  if (theirs && typeof theirs.rows === "function") {
    return App.createDUISection({
      id: theirs.id ?? "sourceMenu",
      header: theirs.header,
      footer: theirs.footer,
      isHidden: false,
      rows: async () => [...(await ours()), ...(await theirs.rows())],
    });
  }
  // Their section can't be read: theirs one level down.
  return App.createDUISection({
    id: "pbsync_menu",
    header: "Settings",
    isHidden: false,
    rows: async () => [
      ...(await ours()),
      ...(theirs
        ? [
            App.createDUINavigationButton({
              id: "pbsync_settings",
              label: `${name} settings`,
              form: App.createDUIForm({ sections: async () => [theirs] }),
            }),
          ]
        : []),
    ],
  });
}

// ── Putting it around the tracker ─────────────────────────────────────────

/** `Sources` is what the 0.8 bundle exports; `id` the tracker's class in it. */
export function wrap(Sources, id, name, version) {
  const Tracker = Sources?.[id];
  const proto = Tracker?.prototype;
  if (!proto || typeof proto.processChapterReadActionQueue !== "function" || proto.__pbsync) {
    return false;
  }
  const title = name || id;
  const info = Sources[`${id}Info`];
  if (info && version) info.version = version;
  const process = proto.processChapterReadActionQueue;
  // One batch at a time, so an older chapter can't overwrite a newer one.
  const turns = new WeakMap();
  proto.processChapterReadActionQueue = function (actionQueue) {
    const run = (turns.get(this) ?? Promise.resolve()).then(() =>
      processAndRecord(this, process, title, actionQueue),
    );
    turns.set(
      this,
      run.catch(() => undefined),
    );
    return run;
  };
  const menu = proto.getSourceMenu;
  if (typeof menu === "function") {
    proto.getSourceMenu = async function (...args) {
      return withUpdatesRows(await menu.apply(this, args), title);
    };
  }
  Object.defineProperty(proto, "__pbsync", { value: true });
  return true;
}
