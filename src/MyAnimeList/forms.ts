/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */

import {
  ButtonRow,
  Form,
  InputRow,
  LabelRow,
  NavigationRow,
  OAuthButtonRow,
  Section,
  SelectRow,
  StepperRow,
  type FormSectionElement,
} from "@paperback/types";

import type { MalManga } from "./models";
import {
  AUTHORIZE_URL,
  clearHistory,
  CLIENT_ID,
  dateOf,
  durationText,
  getHistory,
  getSyncReport,
  getUser,
  isLoggedIn,
  REDIRECT_URI,
  setToken,
  setUser,
  TOKEN_URL,
  tokensFromLogin,
  type HistoryEntry,
  type UpdateKind,
} from "./session";

/** "2:14 PM" (or the phone's own format) */
function timeOfDay(date: Date | undefined): string {
  if (!date) return "";
  try {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return date.toLocaleTimeString();
  }
}

const seconds = (later: Date, earlier: Date) => (later.getTime() - earlier.getTime()) / 1000;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "Today", "Yesterday" or "Oct 14" */
function dayOf(date: Date): string {
  const now = new Date();
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, new Date(now.getTime() - 86400000))) return "Yesterday";
  try {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return date.toLocaleDateString();
  }
}

const MARKS: Record<UpdateKind, string> = {
  saved: "✓",
  same: "=",
  capped: "⚠︎",
  failed: "✕",
  manual: "✎",
};

const RECENT = 5;

/** One update: what happened, when, and how long after reading it reached MyAnimeList. */
function historyRow(entry: HistoryEntry, id: string, withDay = true) {
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

/** Every update the tracker made (the last 100), by day. */
export class MalHistoryForm extends Form {
  override getSections(): FormSectionElement<unknown>[] {
    const history = getHistory();
    if (!history.length) {
      return [
        Section("none", [
          LabelRow("none", {
            title: "No updates yet",
            subtitle: "Chapters you read in linked manga show up here.",
          }),
        ]),
      ];
    }
    const days: { day: string; entries: HistoryEntry[] }[] = [];
    for (const entry of history) {
      const at = dateOf(entry.at);
      const day = at ? dayOf(at) : "Earlier";
      let last = days[days.length - 1];
      if (last?.day !== day) days.push((last = { day, entries: [] }));
      last.entries.push(entry);
    }
    return [
      ...days.map(({ day, entries }, d) =>
        Section(
          { id: `day-${d}`, header: day },
          entries.map((entry, index) => historyRow(entry, `entry-${d}-${index}`, false)),
        ),
      ),
      Section(
        {
          id: "key",
          footer: "✓ saved · = already up to date · ⚠︎ MyAnimeList kept less · ✕ failed · ✎ by hand",
        },
        [
          ButtonRow("clear", {
            title: "Clear history",
            onSelect: Application.Selector(this as MalHistoryForm, "clear"),
          }),
        ],
      ),
    ];
  }

  async clear(): Promise<void> {
    clearHistory();
    this.reloadForm();
  }
}

export const STATUSES = [
  { id: "reading", title: "Reading" },
  { id: "completed", title: "Completed" },
  { id: "on_hold", title: "On hold" },
  { id: "dropped", title: "Dropped" },
  { id: "plan_to_read", title: "Plan to read" },
  { id: "remove", title: "Remove from my list" },
];

/** The tracker's settings: sign in to MyAnimeList, or out. */
export class MalSettingsForm extends Form {
  constructor(private readonly refreshUser: () => Promise<void>) {
    super();
  }

  // The timer: while this page is open, it's redrawn every second so the
  // "Last update" time counts up, and a new update shows up right away.
  private ticking = 0;
  // One history page, kept while the settings are redrawn.
  private historyForm?: MalHistoryForm;

  override formDidAppear(): void {
    this.startTimer();
  }

  override formWillDisappear(): void {
    this.ticking++;
  }

  private startTimer(): void {
    const run = ++this.ticking;
    void (async () => {
      // At most half an hour, in case the page is closed without notice.
      for (let tick = 0; tick < 1800 && run === this.ticking && isLoggedIn(); tick++) {
        await Application.sleep(1);
        if (run === this.ticking) this.reloadForm();
      }
    })();
  }

  override getSections(): FormSectionElement<unknown>[] {
    if (isLoggedIn()) {
      const sync = getSyncReport();
      const when = dateOf(sync?.at);
      const history = getHistory();
      return [
        Section(
          {
            id: "sync",
            header: "Automatic updates",
            footer:
              "The timer counts up while this page is open and goes back to 0 each time Paperback sends what you've read, usually a few minutes after you finish a chapter.",
          },
          [
            LabelRow("last-sync", {
              title: "Last update",
              value: when ? `${durationText(seconds(new Date(), when))} ago` : "Not yet",
              subtitle: sync
                ? [
                    timeOfDay(when),
                    `${sync.updated} saved, ${sync.unchanged} already up to date, ${sync.failed} failed`,
                    sync.error,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "Read a chapter of a linked manga, then come back here.",
            }),
          ],
        ),
        Section(
          { id: "recent", header: "Recent updates" },
          history.length
            ? [
                ...history
                  .slice(0, RECENT)
                  .map((entry, index) => historyRow(entry, `recent-${index}`)),
                NavigationRow("history", {
                  title: "See all",
                  value: String(history.length),
                  form: (this.historyForm ??= new MalHistoryForm()),
                }),
              ]
            : [
                LabelRow("recent-none", {
                  title: "Nothing yet",
                  subtitle: "Chapters you read in linked manga show up here.",
                }),
              ],
        ),
        Section("account", [
          LabelRow("user", { title: "Signed in as", value: getUser()?.name ?? "MyAnimeList user" }),
          ButtonRow("logout", {
            title: "Sign out",
            onSelect: Application.Selector(this as MalSettingsForm, "signOut"),
          }),
        ]),
      ];
    }
    return [
      Section(
        { id: "account", footer: "Sign in so reading a chapter updates your MyAnimeList list." },
        [
          OAuthButtonRow("login", {
            title: "Sign in with MyAnimeList",
            authorizeEndpoint: AUTHORIZE_URL,
            clientId: CLIENT_ID,
            redirectUri: REDIRECT_URI,
            responseType: {
              type: "pkce",
              tokenEndpoint: TOKEN_URL,
              pkceCodeLength: 64,
              pkceCodeMethod: "plain",
              formEncodeGrant: true,
            },
            onSuccess: Application.Selector(this as MalSettingsForm, "signedIn"),
          }),
        ],
      ),
    ];
  }

  async signedIn(first: string, second: string): Promise<void> {
    setToken(tokensFromLogin(first, second));
    try {
      await this.refreshUser();
    } finally {
      this.reloadForm();
      this.startTimer();
    }
  }

  async signOut(): Promise<void> {
    setToken(undefined);
    setUser(undefined);
    this.reloadForm();
  }
}

export interface ListStatusChange {
  status: string;
  chapters: number;
  volumes: number;
  score: number;
  rereads: number;
  notes: string;
}

/** A manga's entry on your list: status, progress, score, notes. */
export class MalProgressForm extends Form {
  private readonly values: ListStatusChange;

  constructor(
    private readonly manga: MalManga | undefined,
    private readonly save: (change: ListStatusChange) => Promise<void>,
  ) {
    super();
    const list = manga?.my_list_status;
    this.values = {
      status: list?.status ?? "reading",
      chapters: list?.num_chapters_read ?? 0,
      volumes: list?.num_volumes_read ?? 0,
      score: list?.score ?? 0,
      rereads: list?.num_times_reread ?? 0,
      notes: list?.comments ?? "",
    };
    // Submit and Cancel buttons only when there's something to save (the
    // base class sets this on the instance, so it's set the same way here).
    Object.defineProperty(this, "requiresExplicitSubmission", {
      value: isLoggedIn() && manga !== undefined,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  override getSections(): FormSectionElement<unknown>[] {
    if (!isLoggedIn()) {
      return [
        Section("signin", [
          LabelRow("signin", {
            title: "Not signed in",
            subtitle: "Sign in to MyAnimeList in this tracker's settings first.",
          }),
        ]),
      ];
    }
    if (!this.manga) {
      return [
        Section("missing", [LabelRow("missing", { title: "MyAnimeList doesn't have this manga" })]),
      ];
    }
    const chapters = this.manga.num_chapters || 0;
    const volumes = this.manga.num_volumes || 0;
    return [
      Section({ id: "info", header: this.manga.title }, [
        LabelRow("user", { title: "Your list", value: getUser()?.name ?? "" }),
        LabelRow("chapters", { title: "Chapters", value: chapters ? String(chapters) : "Unknown" }),
      ]),
      Section(
        {
          id: "status",
          header: "Status",
          footer: "“Remove from my list” deletes this manga from your MyAnimeList list.",
        },
        [
          SelectRow("status", {
            title: "Status",
            value: [this.values.status],
            minItemCount: 1,
            maxItemCount: 1,
            layout: "list",
            items: STATUSES,
            onValueChange: Application.Selector(this as MalProgressForm, "setStatus"),
          }),
        ],
      ),
      Section({ id: "progress", header: "Progress" }, [
        StepperRow("chapters-read", {
          title: "Chapters read",
          value: this.values.chapters,
          minValue: 0,
          maxValue: chapters || 100000,
          stepValue: 1,
          loopOver: false,
          onValueChange: Application.Selector(this as MalProgressForm, "setChapters"),
        }),
        StepperRow("volumes-read", {
          title: "Volumes read",
          value: this.values.volumes,
          minValue: 0,
          maxValue: volumes || 10000,
          stepValue: 1,
          loopOver: false,
          onValueChange: Application.Selector(this as MalProgressForm, "setVolumes"),
        }),
      ]),
      Section({ id: "rating", header: "Your score" }, [
        StepperRow("score", {
          title: "Score (0 = none)",
          value: this.values.score,
          minValue: 0,
          maxValue: 10,
          stepValue: 1,
          loopOver: false,
          onValueChange: Application.Selector(this as MalProgressForm, "setScore"),
        }),
        StepperRow("rereads", {
          title: "Times re-read",
          value: this.values.rereads,
          minValue: 0,
          maxValue: 100,
          stepValue: 1,
          loopOver: false,
          onValueChange: Application.Selector(this as MalProgressForm, "setRereads"),
        }),
        InputRow("notes", {
          title: "Notes",
          value: this.values.notes,
          onValueChange: Application.Selector(this as MalProgressForm, "setNotes"),
        }),
      ]),
    ];
  }

  async setStatus(value: string[]): Promise<void> {
    this.values.status = value[0] ?? this.values.status;
  }
  async setChapters(value: number): Promise<void> {
    this.values.chapters = value;
  }
  async setVolumes(value: number): Promise<void> {
    this.values.volumes = value;
  }
  async setScore(value: number): Promise<void> {
    this.values.score = value;
  }
  async setRereads(value: number): Promise<void> {
    this.values.rereads = value;
  }
  async setNotes(value: string): Promise<void> {
    this.values.notes = value;
  }

  override async formDidSubmit(): Promise<void> {
    await this.save({ ...this.values });
  }
}
