/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

import {
  ButtonRow,
  closureSelector,
  EditSection,
  Form,
  FormConfirmationError,
  LabelRow,
  NavigationRow,
  Section,
  SelectRow,
  StepperRow,
  ToggleRow,
  WebViewRow,
  type Cookie,
  type CookieStorageInterceptor,
} from "@paperback/types";

import {
  checkPage,
  DISCOVERY_SECTIONS,
  isComixDomain,
  SITE_ADDRESSES,
  siteHost,
  siteUrl,
  type SectionEntry,
} from "../models";
import { CHAPTER_LIST_MODES, getChapterListMode } from "../utils/chapterList";
import { COMIX_PASS, describeCookies, keepSiteCookies } from "../utils/cookies";
import {
  contentRatings,
  contentTypes,
  ensureFilters,
  filters,
  getContentRating,
  getHiddenDemographics,
  getHiddenGenres,
  getShowOnlyTypes,
  getYear,
  horizontalChapterSections,
  horizontalRecentSection,
  horizontalTrendingSections,
  useYearFilter,
} from "../utils/filters";
import { clearLog, getLog, logEvent } from "../utils/log";
import { getLoadingSpeed, LOADING_SPEEDS } from "../utils/queue";
import { CHAPTER_LIST_SPEEDS, getChapterListSpeed } from "../utils/webView";

export function getDiscoverySectionsOrder(): SectionEntry[] {
  return (Application.getState("sections") as SectionEntry[] | undefined) ?? DISCOVERY_SECTIONS;
}

function getDeletedSections(): SectionEntry[] {
  return (Application.getState("deleted_sections") as SectionEntry[] | undefined) ?? [];
}

function saveSetting(form: Form, key: string, value: unknown): void {
  Application.setState(value, key);
  Application.invalidateDiscoverSections();
  form.reloadForm();
}

export class ComixSettingsForm extends Form {
  // The cookie store holds the Cloudflare pass (cf_clearance); the user agent
  // is the app's, which the pass is tied to.
  constructor(
    private readonly cookieStore: CookieStorageInterceptor,
    private readonly userAgent: string,
  ) {
    super();
  }

  override getSections() {
    const saved = this.cookieStore.cookiesForUrl(`${siteUrl()}/`);
    const pass = saved.find((cookie) => cookie.name === "cf_clearance");
    const comixPass = saved.find((cookie) => cookie.name === COMIX_PASS);
    const expiry = (date?: Date) =>
      date ? `Expires ${date.toLocaleDateString()} ${date.toLocaleTimeString()}` : undefined;
    return [
      Section(
        {
          id: "cloudflare",
          header: "Checks",
          footer:
            "Two checks guard comix: Cloudflare's, and comix's own (\"Verify you're human\"). Each pass works for every manga until it runs out. To get a fresh one, open the check, complete it if it shows (comix's often passes by itself), wait for comix's page, then tap Done. If things keep failing, tap Forget for a clean start.",
        },
        [
          SelectRow("site_address", {
            title: "Site Address",
            subtitle: siteHost(),
            layout: "list",
            value: [siteHost()],
            items: SITE_ADDRESSES.map((address) => ({ id: address.id, title: address.title })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as ComixSettingsForm,
              "handleSiteAddressChange",
            ),
          }),
          LabelRow("cloudflare_pass", {
            title: "Cloudflare Pass",
            value: pass ? "Saved" : "None",
            subtitle: expiry(pass?.expires),
          }),
          WebViewRow("cloudflare_check", {
            title: "Redo Cloudflare Check",
            request: {
              url: `${siteUrl()}/`,
              method: "GET",
              headers: { "user-agent": this.userAgent },
            },
            onComplete: Application.Selector(this as ComixSettingsForm, "handleCheckDone"),
            onCancel: Application.Selector(this as ComixSettingsForm, "handleCheckCancelled"),
          }),
          LabelRow("comix_pass", {
            title: "comix Pass",
            value: comixPass ? "Saved" : "None",
            subtitle: expiry(comixPass?.expires),
          }),
          WebViewRow("comix_check", {
            title: "Do comix's Check",
            request: {
              url: checkPage(),
              method: "GET",
              headers: { "user-agent": this.userAgent },
            },
            onComplete: Application.Selector(this as ComixSettingsForm, "handleCheckDone"),
            onCancel: Application.Selector(this as ComixSettingsForm, "handleCheckCancelled"),
          }),
          ButtonRow("cloudflare_forget", {
            title: "Forget Saved Pass & Cookies",
            onSelect: Application.Selector(this as ComixSettingsForm, "forgetPass"),
          }),
        ],
      ),
      Section("settings", [
        NavigationRow("Contents", {
          title: "Contents",
          subtitle: "Contents Tags Settings",
          form: new FilterSettings(),
        }),
        ButtonRow("reload_genres", {
          title: "Reload all Filters",
          onSelect: Application.Selector(this as ComixSettingsForm, "refreshFilters"),
        }),
      ]),
      Section("home_sections", [
        NavigationRow("HomeSections", {
          title: "Home Sections",
          subtitle: "Home Sections Settings",
          form: new SectionSettings(),
        }),
      ]),
      Section(
        {
          id: "loading_speed",
          footer:
            "How many home page sections (and search pages) load at once. If Cloudflare starts asking for checks on the home page, pick a safer speed. Chapter lists and chapters always load one at a time.",
        },
        [
          SelectRow("loading_speed", {
            title: "Loading Speed",
            subtitle: getLoadingSpeed().title,
            layout: "list",
            value: [getLoadingSpeed().id],
            items: LOADING_SPEEDS.map((speed) => ({ id: speed.id, title: speed.title })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as ComixSettingsForm,
              "handleLoadingSpeedChange",
            ),
          }),
        ],
      ),
      Section(
        {
          id: "chapter_lists",
          footer:
            "comix hands out chapter lists 20 at a time, so a long list (500+ entries) takes a while the first time: about 30 s at Fast, 1 min at Balanced, 1½ min at Safe. Faster speeds may make comix ask for its check; if that happens, pick a safer one. Lists are remembered: opening a manga again only asks for what's new.",
        },
        [
          SelectRow("chapter_list_mode", {
            title: "Chapter Lists",
            subtitle: getChapterListMode().title,
            layout: "list",
            value: [getChapterListMode().id],
            items: CHAPTER_LIST_MODES.map((mode) => ({ id: mode.id, title: mode.title })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as ComixSettingsForm,
              "handleChapterListModeChange",
            ),
          }),
          SelectRow("chapter_list_speed", {
            title: "Chapter List Speed",
            subtitle: getChapterListSpeed().title,
            layout: "list",
            value: [getChapterListSpeed().id],
            items: CHAPTER_LIST_SPEEDS.map((speed) => ({ id: speed.id, title: speed.title })),
            minItemCount: 1,
            maxItemCount: 1,
            onValueChange: Application.Selector(
              this as ComixSettingsForm,
              "handleChapterListSpeedChange",
            ),
          }),
        ],
      ),
      Section(
        {
          id: "reading_log",
          footer: "If a chapter won't load, open this right after and send a screenshot.",
        },
        [
          NavigationRow("reading_log", {
            title: "Reading Log",
            subtitle: "What happened when chapters were opened",
            form: new ReadingLogForm(),
          }),
        ],
      ),
    ];
  }

  async refreshFilters() {
    await ensureFilters(true);
    this.reloadForm();
  }

  // Same as the app's own bypass banner: keep the fresh cf_clearance.
  // Same as the app's own check browser: keep what comix.to left.
  async handleCheckDone(cookies: Cookie[]) {
    const kept = keepSiteCookies(this.cookieStore, cookies, { fromCheckBrowser: true });
    logEvent(
      "check browser",
      `settings: kept ${
        kept.length
          ? describeCookies(cookies.filter((cookie) => kept.includes(cookie.name)))
          : "nothing"
      }`,
    );
    this.reloadForm();
  }

  async handleCheckCancelled() {
    this.reloadForm();
  }

  // A clean start: forget every comix.to cookie (Cloudflare's pass and the
  // site's own session and pass).
  async forgetPass() {
    this.cookieStore.cookies = this.cookieStore.cookies.filter(
      (cookie) => !isComixDomain(cookie.domain),
    );
    logEvent("check browser", "forgot all comix cookies");
    this.reloadForm();
  }

  async handleSiteAddressChange(value: string[]) {
    if (value[0] && value[0] !== siteHost()) {
      Application.setState(value[0], "site_address");
      logEvent("check browser", `site address is now ${value[0]}`);
    }
    this.reloadForm();
  }

  async handleChapterListSpeedChange(value: string[]) {
    if (value[0]) Application.setState(value[0], "chapter_list_speed");
    this.reloadForm();
  }

  async handleChapterListModeChange(value: string[]) {
    if (value[0]) Application.setState(value[0], "chapter_list_mode");
    this.reloadForm();
  }

  async handleLoadingSpeedChange(value: string[]) {
    if (value[0]) Application.setState(value[0], "loading_speed");
    this.reloadForm();
  }
}

class ReadingLogForm extends Form {
  override getSections() {
    const log = getLog();
    return [
      Section(
        { id: "log", header: "Recent events", footer: "Newest first." },
        log.length === 0
          ? [
              LabelRow("log_empty", {
                title: "Nothing logged yet",
                subtitle: "Open a chapter first",
              }),
            ]
          : log.map((entry, index) =>
              LabelRow(`log_${index}`, {
                title: `${timeOfDay(entry.at)} · ${entry.what}`,
                subtitle: entry.detail,
              }),
            ),
      ),
      Section("log_actions", [
        ButtonRow("log_clear", {
          title: "Clear Log",
          onSelect: Application.Selector(this as ReadingLogForm, "clear"),
        }),
      ]),
    ];
  }

  async clear() {
    clearLog();
    this.reloadForm();
  }
}

function timeOfDay(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

class FilterSettings extends Form {
  override getSections() {
    return [
      Section({ id: "update_settings", footer: "Tags Settings" }, [
        SelectRow("hide_genres", {
          title: "Hide Genres",
          subtitle: "Hide Some Genre",
          layout: "list",
          value: getHiddenGenres(),
          items: filters.genres,
          minItemCount: 0,
          maxItemCount: filters.genres.length,
          onValueChange: Application.Selector(this as FilterSettings, "handleHideGenresChange"),
        }),
        SelectRow("hide_demog", {
          title: "Hide Demographic Type",
          subtitle: "Hide Some Demographic Type",
          layout: "list",
          value: getHiddenDemographics(),
          items: filters.demographic,
          minItemCount: 0,
          maxItemCount: filters.demographic.length,
          onValueChange: Application.Selector(this as FilterSettings, "handleHideDemogChange"),
        }),
      ]),
      Section({ id: "type_settings", footer: "Type Settings" }, [
        SelectRow("type", {
          title: "Content Type",
          subtitle: "Show Only this type of content",
          layout: "list",
          value: getShowOnlyTypes(),
          items: contentTypes,
          minItemCount: 0,
          maxItemCount: contentTypes.length,
          onValueChange: Application.Selector(this as FilterSettings, "handleShowOnlyChange"),
        }),
      ]),
      Section({ id: "content_rating", footer: "Content Rating" }, [
        SelectRow("content_rating", {
          title: "Content Rating",
          value: getContentRating(),
          items: contentRatings,
          layout: "list",
          minItemCount: 1,
          maxItemCount: contentRatings.length,
          onValueChange: Application.Selector(this as FilterSettings, "handleContentRatingChange"),
        }),
      ]),
      Section({ id: "reset_settings", footer: "Reset Settings" }, [
        ButtonRow("reset_genres", {
          title: "Reset all Filters",
          onSelect: Application.Selector(this as FilterSettings, "confirmResetFilters"),
        }),
      ]),
    ];
  }

  async handleHideGenresChange(id: string[]) {
    saveSetting(this, "hide_genres", id);
  }
  async handleHideDemogChange(id: string[]) {
    saveSetting(this, "hide_demog", id);
  }
  async handleShowOnlyChange(id: string[]) {
    saveSetting(this, "show_only", id);
  }
  async handleContentRatingChange(id: string[]) {
    saveSetting(this, "content_rating", id);
  }
  async confirmResetFilters() {
    throw new FormConfirmationError(
      Application.Selector(this as FilterSettings, "resetFilters"),
      "Do you want to reset all values?",
    );
  }
  async resetFilters() {
    for (const key of ["hide_genres", "hide_demog", "show_only"]) {
      Application.setState([], key);
    }
    Application.invalidateDiscoverSections();
    this.reloadForm();
  }
}

class SectionSettings extends Form {
  override getSections() {
    return [
      ...(this.isEnabled("updatesHot") || this.isEnabled("updatesNew")
        ? [
            Section({ id: "latestSectionSettings", header: "Latest Section Settings" }, [
              ToggleRow("sectionType", {
                title: "Horizontal List View",
                subtitle:
                  "Enable to display the latest sections as a horizontal list. Disable to show it in a table layout",
                value: horizontalChapterSections(),
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleChapterSectionChange",
                ),
              }),
            ]),
          ]
        : []),
      ...(this.isEnabled("trending_manga") || this.isEnabled("trending_wt")
        ? [
            Section({ id: "trendingSectionSettings", header: "Trending Section Settings" }, [
              ToggleRow("sectionType", {
                title: "Horizontal List View",
                subtitle:
                  "Enable to display the trending sections as a horizontal list. Disable to show it in a table layout",
                value: horizontalTrendingSections(),
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleTrendingSectionChange",
                ),
              }),
              ToggleRow("allTimes", {
                title: "Filter Trending Sections by Year",
                subtitle: "Enable or disable year-based filtering",
                value: useYearFilter(),
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleYearTimesChange",
                ),
              }),
              StepperRow("yearSettings", {
                title: "Year",
                subtitle: "Select the year",
                value: getYear(),
                minValue: 2023,
                maxValue: new Date().getFullYear(),
                stepValue: 1,
                loopOver: false,
                onValueChange: Application.Selector(this as SectionSettings, "handleYearChange"),
                isHidden: !useYearFilter(),
              }),
            ]),
          ]
        : []),
      ...(this.isEnabled("recent")
        ? [
            Section({ id: "recentSectionSettings", header: "Recent Section Settings" }, [
              ToggleRow("sectionType", {
                title: "Horizontal List View",
                subtitle:
                  "Enable to display the recent section as a horizontal list. Disable to show it in a table layout",
                value: horizontalRecentSection(),
                onValueChange: Application.Selector(
                  this as SectionSettings,
                  "handleRecentSectionChange",
                ),
              }),
            ]),
          ]
        : []),
      Section({ id: "sectionsOrderSettings", header: "Sections Order" }, [
        NavigationRow("sectionOrder", {
          title: "Sections Order",
          subtitle: "Sections Order",
          form: new SectionOrderForm(),
        }),
      ]),
    ];
  }

  async handleChapterSectionChange(value: boolean) {
    saveSetting(this, "chapterSection", value);
  }
  async handleTrendingSectionChange(value: boolean) {
    saveSetting(this, "trendingSection", value);
  }
  async handleRecentSectionChange(value: boolean) {
    saveSetting(this, "recentSection", value);
  }
  async handleYearTimesChange(value: boolean) {
    saveSetting(this, "yearTimes", value);
  }
  async handleYearChange(value: number) {
    saveSetting(this, "year_settings", value);
  }

  private isEnabled(id: string) {
    return !getDeletedSections().some((item) => item.id === id);
  }
}

class SectionOrderForm extends Form {
  override getSections() {
    const deleted = getDeletedSections();
    return [
      EditSection("edit", {
        id: "edit",
        header: "Section order",
        footer: "Long press to reorder, swipe to hide",
        items: getDiscoverySectionsOrder().map((item) => LabelRow(item.id, { title: item.title })),
        allowDeletion: true,
        allowReorder: true,
        onReorder: Application.Selector(this as SectionOrderForm, "rowDidReorder"),
        onDeletion: Application.Selector(this as SectionOrderForm, "rowDidDelete"),
      }),
      ...(deleted.length > 0
        ? [
            Section(
              { id: "addSectionSelect", footer: "Tap to restore" },
              deleted.map((item) =>
                LabelRow(item.id, {
                  title: item.title,
                  onSelect: closureSelector(this, "restore_" + item.id, () =>
                    this.restoreSection(item.id),
                  ),
                }),
              ),
            ),
          ]
        : []),
      Section("status", [
        ButtonRow("reset", {
          title: "Reset all Sections",
          isHidden: getDeletedSections().length == 0,
          onSelect: Application.Selector(this as SectionOrderForm, "confirmResetSections"),
        }),
      ]),
    ];
  }

  async confirmResetSections() {
    throw new FormConfirmationError(
      Application.Selector(this as SectionOrderForm, "resetSections"),
      "Do you want to restore all deleted sections?",
    );
  }

  async resetSections(): Promise<void> {
    Application.setState(DISCOVERY_SECTIONS, "sections");
    Application.setState([], "deleted_sections");
    this.reloadForm();
  }

  async rowDidDelete(index: number): Promise<void> {
    const sections = getDiscoverySectionsOrder();
    const deleted = sections.splice(index, 1);
    Application.setState([...getDeletedSections(), ...deleted], "deleted_sections");
    Application.setState(sections, "sections");
    this.reloadForm();
  }

  async rowDidReorder(sourceIndex: number, destinationIndex: number): Promise<void> {
    const sections = getDiscoverySectionsOrder();
    const [item] = sections.splice(sourceIndex, 1);
    if (item) {
      sections.splice(destinationIndex, 0, item);
    }
    Application.setState(sections, "sections");
    this.reloadForm();
    Application.invalidateDiscoverSections();
  }

  private async restoreSection(id: string): Promise<void> {
    const deleted = getDeletedSections();
    const restored = deleted.find((item) => item.id === id);
    if (!restored) return;
    Application.setState([...getDiscoverySectionsOrder(), restored], "sections");
    Application.setState(
      deleted.filter((item) => item.id !== id),
      "deleted_sections",
    );
  }
}
