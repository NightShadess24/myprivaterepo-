/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// comix challenges bursty/concurrent traffic, so run one WebView at a time. The
// chain is reset on both branches so a rejected task doesn't poison the ones
// queued behind it.
let tail: Promise<void> = Promise.resolve();

export function scheduleComix<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Home page and search loading speed, picked under Settings → Loading Speed:
// how many browse pages may load at once.
export interface LoadingSpeed {
  id: string;
  title: string;
  limit: number;
}

export const LOADING_SPEEDS: LoadingSpeed[] = [
  { id: "fast", title: "Fast (all at once)", limit: Infinity },
  { id: "balanced", title: "Balanced (3 at a time)", limit: 3 },
  { id: "safe", title: "Safe (1 at a time)", limit: 1 },
];

export function getLoadingSpeed(): LoadingSpeed {
  const id = Application.getState("loading_speed") as string | undefined;
  return LOADING_SPEEDS.find((speed) => speed.id === id) ?? LOADING_SPEEDS[0];
}

let browseRunning = 0;
const browseWaiting: (() => void)[] = [];

// Runs `task` once fewer than the chosen number of browse loads are running.
// "Safe" behaves like comix-capture: one page at a time.
export async function scheduleBrowse<T>(task: () => Promise<T>): Promise<T> {
  while (browseRunning >= getLoadingSpeed().limit) {
    await new Promise<void>((resolve) => browseWaiting.push(resolve));
  }
  browseRunning++;
  try {
    return await task();
  } finally {
    browseRunning--;
    browseWaiting.shift()?.();
  }
}
