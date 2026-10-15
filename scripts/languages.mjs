// Works out which language a source is in, for the Languages repositories
// (scripts/aggregate.mjs). 0.9 sources say so (`language`); most 0.8 ones
// don't, so for those, in order: a manual override, the same site's 0.9
// source, the 0.8 SourceInfo, a language tag, the website's country domain.
// Unknown counts as English.

const NAMES = {
  english: "en",
  multi: "multi",
  "multi-language": "multi",
  "multi language": "multi",
  indonesia: "id",
  indonesian: "id",
  bahasa: "id",
  arabic: "ar",
  spanish: "es",
  español: "es",
  espanol: "es",
  french: "fr",
  français: "fr",
  italian: "it",
  italiano: "it",
  portuguese: "pt",
  português: "pt",
  brazilian: "pt-br",
  korean: "ko",
  raw: "ja",
  japanese: "ja",
  vietnamese: "vi",
  thai: "th",
  turkish: "tr",
  russian: "ru",
  german: "de",
  polish: "pl",
  chinese: "zh",
};

// Country domains that mean a language (generic ones like .io, .cc, .me,
// .gg and .ru, used by English sites too, are left out).
const DOMAINS = {
  fr: "fr",
  it: "it",
  es: "es",
  de: "de",
  id: "id",
  vn: "vi",
  br: "pt-br",
  pt: "pt",
  kr: "ko",
  th: "th",
  tr: "tr",
  pl: "pl",
};

const FLAGS = {
  GB: "en",
  US: "en",
  FR: "fr",
  ES: "es",
  MX: "es",
  IT: "it",
  ID: "id",
  VN: "vi",
  BR: "pt-br",
  PT: "pt",
  JP: "ja",
  KR: "ko",
  CN: "zh",
  DE: "de",
  TH: "th",
  TR: "tr",
  SA: "ar",
  RU: "ru",
  PL: "pl",
};

// A language name, code or flag → a code ("en", "fr", "pt-br", "multi"), or "".
export function languageCode(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const points = Array.from(text, (ch) => ch.codePointAt(0)).filter(
    (p) => p >= 0x1f1e6 && p <= 0x1f1ff,
  );
  if (points.length === 2 && text.length <= 4) {
    return FLAGS[String.fromCharCode(...points.map((p) => p - 0x1f1e6 + 65))] ?? "";
  }
  const lower = text.toLowerCase();
  if (NAMES[lower]) return NAMES[lower];
  for (const [name, code] of Object.entries(NAMES)) {
    if (new RegExp(`(^|[^\\p{L}])${name}([^\\p{L}]|$)`, "u").test(lower)) return code;
  }
  if (/^[a-z]{2}(-[a-z]{2,4})?$/.test(lower)) return lower === "jp" ? "ja" : lower;
  return "";
}

export const isEnglish = (code) => !code || code === "en" || code === "multi" || code === "all";

export function domainLanguage(host) {
  const tld = /\.([a-z]{2})$/.exec(String(host ?? ""))?.[1];
  return (tld && DOMAINS[tld]) || "";
}
