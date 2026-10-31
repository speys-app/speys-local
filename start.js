#!/usr/bin/env node
// Speys Local Dashboard: `node start.js [--port 3400] [--no-open] [--install] [--uninstall]`
import { execFile } from "node:child_process";

// node:sqlite (OwnLearn's practice database) prints an "experimental" warning when it loads
process.removeAllListeners("warning");
const { startDashboard } = await import("./core/server.js");

const args = process.argv.slice(2);

if (args.includes("--install") || args.includes("--uninstall")) {
  const { install, uninstall } = await import("./core/autostart.js");
  if (args.includes("--uninstall")) uninstall();
  else process.exitCode = install() ? 0 : 1;
} else {
  const portAt = args.indexOf("--port");
  const port = portAt === -1 ? 3400 : Number(args[portAt + 1]);
  const url = `http://localhost:${port}`;
  const open = () => {
    if (args.includes("--no-open")) return;
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    execFile(opener, [url]);
  };

  try {
    const { applets } = await startDashboard({ port });
    console.log(`Speys Local Dashboard · ${applets.length} applet · ${url}`);
    for (const a of applets) {
      if (a.error) console.error(`  ${a.id}: ${a.error}`);
    }
    open();
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    // Already running (autostart): just open the page
    console.log(`${url} is already in use.`);
    open();
  }
}
