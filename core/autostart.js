// Start with the computer: `node start.js --install`, remove with `--uninstall`.
// launchd on macOS, the user's Run key on Windows (no admin rights needed; it starts at sign-in but isn't restarted
// after a crash). It opens no browser, it only keeps the server running.
import { execFileSync, spawn } from "node:child_process";
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

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const quoted = (s) => `'${s.replaceAll("'", "''")}'`;
// A hidden PowerShell: node would otherwise leave a console window open for as long as it runs
const HIDDEN = ["-NoProfile", "-WindowStyle", "Hidden", "-Command", `& ${quoted(process.execPath)} ${quoted(join(ROOT, "start.js"))} --no-open`];

function installWindows() {
  const value = `powershell.exe ${HIDDEN.slice(0, -1).join(" ")} "${HIDDEN.at(-1)}"`;
  execFileSync("reg.exe", ["add", RUN_KEY, "/v", LABEL, "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
  // The Run key takes effect at the next sign-in; this is the server for now
  spawn(process.execPath, [join(ROOT, "start.js"), "--no-open"], { cwd: ROOT, stdio: "ignore", detached: true, windowsHide: true }).unref();
  console.log("Installed: runs when you sign in. http://localhost:3400");
  return true;
}

function uninstallWindows() {
  try {
    execFileSync("reg.exe", ["delete", RUN_KEY, "/v", LABEL, "/f"], { stdio: "ignore" });
  } catch {
    // was not installed
  }
  console.log("Autostart removed. A server already running stays until you sign out.");
}

export function install() {
  if (process.platform === "win32") return installWindows();
  if (process.platform !== "darwin") {
    console.error("Autostart is macOS and Windows only for now; run `node start.js` here.");
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
  if (process.platform === "win32") return uninstallWindows();
  if (process.platform !== "darwin") return;
  unload();
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log("Autostart removed.");
}
