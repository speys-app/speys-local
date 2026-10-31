// Sound per platform, and macOS's notification. Used by the page and the hook; neither waits for them to finish.
// Paths go through argv or the environment, they are not embedded in a script.
import { spawn } from "node:child_process";

const powershell = (script, env) => ({ cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script], env });

// SoundPlayer only reads wav; MediaPlayer needs a moment before it knows the length
const PLAY_WAV = "(New-Object Media.SoundPlayer $env:SPEYS_SOUND).PlaySync()";
const PLAY_OTHER = "Add-Type -AssemblyName PresentationCore; $p = New-Object Windows.Media.MediaPlayer; $p.Open([uri]$env:SPEYS_SOUND); $p.Play(); Start-Sleep 1; $d = $p.NaturalDuration; Start-Sleep ($(if ($d.HasTimeSpan) { [math]::Ceiling($d.TimeSpan.TotalSeconds) } else { 10 }))";

export const canPlay = (platform = process.platform) => platform === "darwin" || platform === "win32";

export function soundCommand(file, platform = process.platform) {
  if (platform === "darwin") return { cmd: "afplay", args: [file] };
  if (platform === "win32") return powershell(/\.wav$/i.test(file) ? PLAY_WAV : PLAY_OTHER, { SPEYS_SOUND: file });
  return null;
}

export function notificationCommand(title, subtitle, message, platform = process.platform) {
  if (platform !== "darwin") return null; // on Windows the sound is enough
  const quote = (s) => String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return { cmd: "osascript", args: ["-e", `display notification "${quote(message)}" with title "${quote(title)}" subtitle "${quote(subtitle)}"`] };
}

/** On Windows a detached PowerShell exits without running anything, and one that isn't detached dies with the hook: a detached node waits for it. */
export function detachedCommand({ cmd, args }, platform = process.platform) {
  if (platform !== "win32") return { cmd, args };
  return { cmd: process.execPath, args: ["-e", `require("node:child_process").spawnSync(${JSON.stringify(cmd)}, ${JSON.stringify(args)}, { stdio: "ignore", windowsHide: true })`] };
}

function start(command) {
  if (!command) return;
  const { cmd, args } = detachedCommand(command);
  spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true, env: { ...process.env, ...command.env } }).unref();
}

export const playSound = (file) => start(soundCommand(file));
export const showNotification = (title, subtitle, message) => start(notificationCommand(title, subtitle, message));
