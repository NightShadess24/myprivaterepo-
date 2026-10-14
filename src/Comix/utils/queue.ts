/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// comix challenges bursty/concurrent traffic, so run one WebView at a time.
// Opening a chapter is `urgent`: it goes ahead of chapter lists still waiting
// (e.g. a library refresh), so reading never waits behind a whole refresh. A
// failed task never blocks the ones queued behind it.
const urgentQueue: (() => void)[] = [];
const normalQueue: (() => void)[] = [];
let busy = false;

function runNext(): void {
  const next = urgentQueue.shift() ?? normalQueue.shift();
  if (next) next();
  else busy = false;
}

export function scheduleComix<T>(
  task: () => Promise<T>,
  { urgent = false }: { urgent?: boolean } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job = () => {
      busy = true;
      Promise.resolve().then(task).then(resolve, reject).finally(runNext);
    };
    if (!busy) job();
    else (urgent ? urgentQueue : normalQueue).push(job);
  });
}

// Gives up on a WebView run that never answers (the app can leave one hanging,
// e.g. if the page navigates away), so the spinner turns into an error and the
// queue moves on instead of loading forever.
// The clock is checked too: if the app's timer ever ends early, keep waiting
// instead of failing work that is still on time.
export async function withTimeout<T>(work: Promise<T>, seconds: number, what: string): Promise<T> {
  work.catch(() => undefined); // a late failure after giving up is ignored
  const finished = work.then((value) => ({ value }));
  const start = Date.now();
  let earlyWakeups = 0;
  for (;;) {
    const remaining = seconds - (Date.now() - start) / 1000;
    if (remaining <= 0) break;
    const result = await Promise.race([finished, Application.sleep(remaining).then(() => null)]);
    if (result) return result.value;
    if ((Date.now() - start) / 1000 < seconds * 0.95 && ++earlyWakeups >= 3) {
      return (await finished).value; // timer unreliable: just wait for the work
    }
  }
  throw new Error(`Comix: ${what} took longer than ${seconds}s, try again`);
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
