/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */

import {
  ButtonRow,
  Form,
  InputRow,
  LabelRow,
  OAuthButtonRow,
  Section,
  SelectRow,
  StepperRow,
  type FormSectionElement,
} from "@paperback/types";

import type { MalManga } from "./models";
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  getSyncReport,
  getUser,
  isLoggedIn,
  REDIRECT_URI,
  setToken,
  setUser,
  TOKEN_URL,
  tokensFromLogin,
} from "./session";

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

  override getSections(): FormSectionElement<unknown>[] {
    if (isLoggedIn()) {
      const sync = getSyncReport();
      const when = sync ? new Date(sync.at) : undefined;
      return [
        Section(
          {
            id: "sync",
            header: "Automatic updates",
            footer: "Paperback sends what you read in batches, so updates can take a few minutes.",
          },
          [
            LabelRow("last-sync", {
              title: "Last update",
              value: when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "Not yet",
              subtitle: sync
                ? [
                    `${sync.updated} saved, ${sync.unchanged} already up to date, ${sync.failed} failed`,
                    sync.error,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "Read a chapter of a linked manga, then come back here.",
            }),
            ...(sync?.lines ?? []).map((line, index) =>
              LabelRow(`sync-line-${index}`, { title: line }),
            ),
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
