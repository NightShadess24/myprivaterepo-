/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// Settings → User-Agent, from the Paperback 0.8 ComixTo extension
// (acepilot147/pb-extensions, GPL-3.0, Settings.ts): the browser identity sent
// with every comix request, the hidden pages and the check browser. They must
// all match, because comix only accepts its pass (waf_pass) with the identity
// it was issued to. A custom value wins over a preset; neither means
// Paperback's own. Presets are Apple WebKit browsers only (from keiyoushi's
// list): Paperback connects through Apple's network stack, so anything else
// would look mismatched.

export const USER_AGENT_DEFAULT = { id: "default", title: "Paperback's own", ua: "" };

export const USER_AGENT_PRESETS: { id: string; title: string; ua: string }[] = [
  {
    id: "iphone-safari-18-3-1",
    title: "iPhone · Safari 18.3.1 (iOS 18.3.2)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Mobile/15E148 Safari/604.1",
  },
  {
    id: "iphone-safari-18-3",
    title: "iPhone · Safari 18.3 (iOS 18.3.1)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
  },
  {
    id: "iphone-safari-18-1",
    title: "iPhone · Safari 18.1.1 (iOS 18.1.1)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Mobile/15E148 Safari/604.1",
  },
  {
    id: "iphone-safari-18-3-ios17",
    title: "iPhone · Safari 18.3 (iOS 17.7.2)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
  },
  {
    id: "iphone-safari-17-5",
    title: "iPhone · Safari 17.5 (iOS 17.5.1)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  {
    id: "iphone-safari-16-6",
    title: "iPhone · Safari 16.6 (iOS 16.7.10)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  },
  {
    id: "iphone-chrome-134",
    title: "iPhone · Chrome 134 (iOS 18.3.2)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/134.0.6998.99 Mobile/15E148 Safari/604.1",
  },
  {
    id: "iphone-edge-134",
    title: "iPhone · Edge 134 (iOS 17.7.2)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/134.3124.77 Mobile/15E148 Safari/605.1.15",
  },
  {
    id: "iphone-firefox-136",
    title: "iPhone · Firefox 136 (iOS 14.7.4)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/136.0 Mobile/15E148 Safari/605.1.15",
  },
  {
    id: "ipad-safari-18-3",
    title: "iPad · Safari 18.3 (iPadOS 17.7.2)",
    ua: "Mozilla/5.0 (iPad; CPU OS 17_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
  },
  {
    id: "ipad-firefox-136",
    title: "iPad · Firefox 136 (iPadOS 14.7.4)",
    ua: "Mozilla/5.0 (iPad; CPU OS 14_7_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/136.0 Mobile/15E148 Safari/605.1.15",
  },
  {
    id: "mac-safari-18-3",
    title: "Mac · Safari 18.3 (macOS 14.7.4)",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
  },
];

export function getUserAgentPresetId(): string {
  const id = Application.getState("user_agent_preset") as string | undefined;
  return USER_AGENT_PRESETS.some((preset) => preset.id === id) ? id! : USER_AGENT_DEFAULT.id;
}

export function getCustomUserAgent(): string {
  const value = Application.getState("custom_user_agent");
  return typeof value === "string" ? value.trim() : "";
}

// The identity to send: custom, else the preset, else Paperback's own.
export async function appUserAgent(): Promise<string> {
  const custom = getCustomUserAgent();
  if (custom) return custom;
  const preset = USER_AGENT_PRESETS.find((p) => p.id === getUserAgentPresetId());
  return preset?.ua || (await Application.getDefaultUserAgent());
}
