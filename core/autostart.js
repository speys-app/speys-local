// Start with the computer: `node start.js --install`, remove with `--uninstall`.
// macOS only for now (launchd); it opens no browser, it only keeps the server running.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LABEL = "app.speys.local";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = join(homedir(), "Library", "Logs", "Speys", "local.log");
const ROOT = resolve(import.meta.dirname, "..");

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const domain = () => `gui/${process.getuid()}`;

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(ROOT, "start.js"))}</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

function unload() {
  try {
    execFileSync("launchctl", ["bootout", `${domain()}/${LABEL}`], { stdio: "ignore" });
  } catch {
    // was not loaded
  }
}

export function install() {
  if (process.platform !== "darwin") {
    console.error("Autostart is macOS only for now; run `node start.js` here.");
    return false;
  }
  mkdirSync(join(homedir(), "Library", "Logs", "Speys"), { recursive: true });
  unload();
  writeFileSync(PLIST, plist());
  execFileSync("launchctl", ["bootstrap", domain(), PLIST]);
  console.log("Installed: runs when the computer starts. http://localhost:3400");
  return true;
}

export function uninstall() {
  if (process.platform !== "darwin") return;
  unload();
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log("Autostart removed.");
}
