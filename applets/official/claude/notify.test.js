import assert from "node:assert/strict";
import { test } from "node:test";
import { canPlay, detachedCommand, notificationCommand, soundCommand } from "./notify.js";

test("Windows plays a sound and shows no notification", () => {
  assert.equal(notificationCommand("t", "s", "m", "win32"), null);
});

test("Windows picks a player that can read the file", () => {
  assert.match(soundCommand("C:\\a b\\x.WAV", "win32").args.at(-1), /SoundPlayer/);
  assert.match(soundCommand("C:\\a b\\x.mp3", "win32").args.at(-1), /MediaPlayer/);
  assert.equal(soundCommand("C:\\a b\\x.mp3", "win32").env.SPEYS_SOUND, "C:\\a b\\x.mp3");
});

test("Windows runs PowerShell through a detached node, with the path still out of the code", () => {
  const s = soundCommand("C:\\'; Remove-Item x; '.wav", "win32");
  const d = detachedCommand(s, "win32");
  assert.equal(d.cmd, process.execPath);
  assert.ok(!d.args.join(" ").includes("Remove-Item"));
  assert.deepEqual(detachedCommand({ cmd: "afplay", args: ["/x"] }, "darwin"), { cmd: "afplay", args: ["/x"] });
});

test("macOS keeps its commands, other platforms have none", () => {
  assert.deepEqual(soundCommand("/x.aiff", "darwin"), { cmd: "afplay", args: ["/x.aiff"] });
  assert.equal(notificationCommand("t", "s", 'say "hi"', "darwin").cmd, "osascript");
  assert.match(notificationCommand("t", "s", 'say "hi"', "darwin").args[1], /say \\"hi\\"/);
  assert.equal(soundCommand("/x.wav", "linux"), null);
  assert.equal(notificationCommand("t", "s", "m", "linux"), null);
  assert.deepEqual(["darwin", "win32", "linux"].map(canPlay), [true, true, false]);
});
