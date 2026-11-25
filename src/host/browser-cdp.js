// Attach to an already running Chrome. Never launch it, change its profile, or expose its debugging socket to peers.
// Chrome 144+: the user enables chrome://inspect/#remote-debugging and accepts Chrome's connection prompt.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const WebSocket = require("ws");
const { HostError } = require("./errors");

function chromeProfiles({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (env.AGENTDECK_CHROME_USER_DATA_DIR) return [{ name: "Chrome", dir: path.resolve(env.AGENTDECK_CHROME_USER_DATA_DIR) }];
  const base = platform === "win32" ? env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    : platform === "darwin" ? path.join(home, "Library", "Application Support") : env.XDG_CONFIG_HOME || path.join(home, ".config");
  const dirs = platform === "win32" ? ["Google/Chrome/User Data", "Google/Chrome Beta/User Data", "Google/Chrome Dev/User Data", "Google/Chrome SxS/User Data"]
    : platform === "darwin" ? ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary"]
      : ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium"];
  return dirs.map((dir, i) => ({ name: ["Chrome", "Chrome Beta", "Chrome Dev", platform === "linux" ? "Chromium" : "Chrome Canary"][i], dir: path.join(base, dir) }));
}

// This file is trusted only for a loopback port and a browser websocket path. A peer cannot supply either.
function activeEndpoint(text) {
  const [port, socket] = text.trim().split(/\r?\n/).map(x => x.trim());
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(socket || "")) return null;
  return `ws://127.0.0.1:${Number(port)}${socket}`;
}

async function discoverBrowsers(profiles = chromeProfiles()) {
  const found = await Promise.all(profiles.map(async (p, i) => {
    try {
      const file = path.join(p.dir, "DevToolsActivePort");
      if ((await fs.stat(file)).size > 4096) return null;
      const endpoint = activeEndpoint(await fs.readFile(file, "utf8"));
      return endpoint ? { id: `chrome-${i}`, name: p.name, endpoint } : null;
    } catch { return null; }
  }));
  return found.filter(Boolean);
}

class CdpConnection extends EventEmitter {
  constructor(endpoint, { timeout = 8000, connectTimeout = 45000 } = {}) {
    super();
    this.pending = new Map();
    this.next = 0;
    this.timeout = timeout;
    this.closed = false;
    this.ws = new WebSocket(endpoint, { handshakeTimeout: connectTimeout, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => {
      const fail = () => reject(new HostError("browserUnavailable"));
      this.ws.once("open", () => { this.ws.off("error", fail); resolve(this); });
      this.ws.once("error", fail);
      this.ws.once("close", fail);
    });
    this.ws.on("error", () => {});
    this.ws.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HostError("browserDisconnected")); }
      this.pending.clear();
      this.emit("closed");
    });
    this.ws.on("message", data => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new HostError("browserCommandFailed"));
        else p.resolve(msg.result || {});
      } else if (msg.method) this.emit("event", msg);
    });
  }
  async send(method, params = {}, sessionId) {
    await this.ready;
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new HostError("browserDisconnected");
    if (this.pending.size >= 32) throw new HostError("browserBusy");
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError("browserTimeout"));
        // An unacknowledged command might still take effect. Discard the connection and its views.
        this.close();
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), e => {
        if (!e) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HostError("browserDisconnected"));
      });
    });
  }
  close() { this.ws.terminate(); }
}

module.exports = { chromeProfiles, activeEndpoint, discoverBrowsers, CdpConnection };
