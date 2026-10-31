// Translations: English is the source language and the text itself is the key: t("Save"), t("{n} open", { n }).
// Other languages live in <applet>/locales/<lang>.json; text without a translation stays in English.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SOURCE_LANGUAGE = "en";

const cache = new Map();

/** Messages of one folder; re-read only when the file changes, so a translation shows up without a restart. */
export function messagesOf(folder, language) {
  if (language === SOURCE_LANGUAGE) return {};
  const file = join(folder, "locales", `${language}.json`);
  if (!existsSync(file)) return {};
  const stamp = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.messages;
  let messages = {};
  try {
    messages = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // a broken translation file must not take the applet down: English is shown
  }
  cache.set(file, { stamp, messages });
  return messages;
}

export const format = (text, values) => (values ? text.replace(/\{(\w+)\}/g, (all, key) => (key in values ? values[key] : all)) : text);

/** @param {() => Record<string, string>} messages */
export const translator = (messages) => (text, values) => format(messages()[text] ?? text, values);
