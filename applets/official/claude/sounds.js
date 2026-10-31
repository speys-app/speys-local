// Notification sounds: your own files in <home>/claude/sounds, then the sounds the system ships with. Used by the page and the hook.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WINDOWS = process.platform === "win32";
const SYSTEM_FOLDER = WINDOWS ? join(process.env.WINDIR || "C:\\Windows", "Media") : "/System/Library/Sounds";
const SYSTEM_TYPE = WINDOWS ? ".wav" : ".aiff";
const AUDIO = /\.(m4a|mp3|wav|aiff?|caf)$/i;
export const NONE = "none";
const stem = (file) => file.replace(/\.[^.]+$/, "");
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => AUDIO.test(f)).sort() : []);

export const soundsFolder = (home) => join(home, "apps", "claude", "sounds");

export function listSounds(home) {
  return [
    ...filesIn(soundsFolder(home)).map((f) => ({ id: `file:${f}`, name: stem(f), own: true })),
    ...filesIn(SYSTEM_FOLDER).map((f) => ({ id: `system:${stem(f)}`, name: stem(f), own: false })),
  ];
}

/** Own file with this name if there is one (older installs), else a system sound. */
function defaultSound(home, ownFile, systemName) {
  if (existsSync(join(soundsFolder(home), ownFile))) return `file:${ownFile}`;
  return existsSync(join(SYSTEM_FOLDER, `${systemName}${SYSTEM_TYPE}`)) ? `system:${systemName}` : NONE;
}

export const chosenSounds = (home, saved = {}) => ({
  done: saved.done || defaultSound(home, "bitti.m4a", WINDOWS ? "tada" : "Glass"),
  approval: saved.approval || defaultSound(home, "onay.m4a", WINDOWS ? "Windows Notify" : "Ping"),
});

/** The file of a sound id; ids are checked against the list, so a request cannot reach other files. */
export function soundPath(home, id) {
  const found = listSounds(home).find((s) => s.id === id);
  if (!found) return null;
  const [kind, name] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  return kind === "file" ? join(soundsFolder(home), name) : join(SYSTEM_FOLDER, `${name}${SYSTEM_TYPE}`);
}
