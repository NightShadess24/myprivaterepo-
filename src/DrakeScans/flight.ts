/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 NightShadess24 */

// drakecomic.net is a Next.js site: each page's data comes with its HTML as
// `self.__next_f.push([1, "…"])` scripts. Joined, they hold the JSON the page
// was drawn from (the series, its chapters, a chapter's pages), which is
// steadier to read than the page's markup.

const CHUNK = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/** All of a page's data, as one text. */
export function pageData(html: string): string {
  let text = "";
  for (const match of html.matchAll(CHUNK)) {
    try {
      text += JSON.parse(`"${match[1]}"`) as string;
    } catch {
      // a chunk that isn't text; the data is in the others
    }
  }
  return text;
}

/** The JSON object or array that starts at `at`. */
function valueAt(text: string, at: number): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(at, i + 1));
    }
  }
  throw new Error("Drake Scans sent an incomplete page");
}

/** The object that starts with `start`, e.g. `{"series":`. */
export function objectStartingWith<T>(data: string, start: string): T | undefined {
  const at = data.indexOf(start);
  return at < 0 ? undefined : (valueAt(data, at) as T);
}

/** The value of the first `"key":` (an object, an array or a plain value). */
export function valueOf<T>(data: string, key: string): T | undefined {
  const marker = `"${key}":`;
  const at = data.indexOf(marker);
  if (at < 0) return undefined;
  const start = at + marker.length;
  if (data[start] === "{" || data[start] === "[") return valueAt(data, start) as T;
  const plain = /^(true|false|null|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*")/.exec(
    data.slice(start, start + 500),
  );
  return plain ? (JSON.parse(plain[1]) as T) : undefined;
}
