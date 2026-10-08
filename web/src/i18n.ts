import en from "./locales/en";

export type Key = keyof typeof en;
export type Strings = Record<Key, string>;

export const LANGUAGES: readonly (readonly [code: string, name: string])[] = [
  ["en", "English"],
  ["es", "Español"],
  ["pt", "Português"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["it", "Italiano"],
  ["nl", "Nederlands"],
  ["pl", "Polski"],
  ["ru", "Русский"],
  ["uk", "Українська"],
  ["tr", "Türkçe"],
  ["ar", "العربية"],
  ["he", "עברית"],
  ["fa", "فارسی"],
  ["hi", "हिन्दी"],
  ["id", "Bahasa Indonesia"],
  ["vi", "Tiếng Việt"],
  ["ko", "한국어"],
  ["ja", "日本語"],
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
];

const RIGHT_TO_LEFT = new Set(["ar", "he", "fa"]);
const STORAGE_KEY = "inkport.language";
const locales = import.meta.glob<{ default: Strings }>(["./locales/*.ts", "!./locales/en.ts"]);

let strings: Strings = en;
let current = "en";

export const language = (): string => current;

export function t(key: Key, values: Record<string, string | number> = {}): string {
  return strings[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) return placeholder;
    return typeof value === "number" ? value.toLocaleString(current) : value;
  });
}

export function matchLanguage(tag: string): string | undefined {
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return /-(tw|hk|mo|hant)\b/.test(lower) ? "zh-TW" : "zh-CN";
  const base = lower.split("-")[0] === "iw" ? "he" : lower.split("-")[0];
  return LANGUAGES.find(([code]) => code === base)?.[0];
}

export function preferredLanguage(): string {
  const saved = readSaved();
  if (saved && LANGUAGES.some(([code]) => code === saved)) return saved;
  for (const tag of navigator.languages ?? [navigator.language]) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return "en";
}

let requested = "";

// Only a choice made in the picker is remembered; a detected language keeps following the browser.
export async function setLanguage(code: string, remember: boolean): Promise<void> {
  requested = code;
  const loaded = code === "en" ? en : (await locales[`./locales/${code}.ts`]!()).default;
  if (requested !== code) return;
  strings = loaded;
  current = code;
  const root = document.documentElement;
  root.lang = code;
  root.dir = RIGHT_TO_LEFT.has(code) ? "rtl" : "ltr";
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) element.textContent = t(element.dataset.i18n as Key);
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nLabel as Key));
  }
  for (const element of document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    element.placeholder = t(element.dataset.i18nPlaceholder as Key);
  }
  if (!remember) return;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Private mode or blocked storage: the choice simply isn't remembered.
  }
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export const formatDate = (ms: number): string => new Intl.DateTimeFormat(current, { dateStyle: "medium" }).format(ms);
