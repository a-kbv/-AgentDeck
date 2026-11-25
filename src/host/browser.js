// A small, allowlisted browser API for controlling the SAME tabs the user and the agent use on this computer.
// The mesh's control gate protects every call. Each attached view additionally belongs to one peer/link, expires
// without requests, and is detached on disconnect. No raw CDP, cookies, JS evaluation, profile paths, or websocket
// addresses are exposed. Frames are pulled: at most one capture per view, with no push queue on a slow relay.
const { randomUUID } = require("node:crypto");
const { HostError } = require("./errors");
const { discoverBrowsers, CdpConnection } = require("./browser-cdp");

const webPage = url => /^(https?:\/\/|about:blank$|chrome:\/\/newtab\/?$)/i.test(url || "");
const text = (v, max = 512) => { if (typeof v !== "string" || !v || v.length > max) throw new HostError("invalidData"); return v; };
const number = (v, min, max) => { if (!Number.isFinite(v) || v < min || v > max) throw new HostError("invalidData"); return v; };
function webUrl(v) {
  const raw = text(v, 4096);
  let url;
  try { url = new URL(raw); } catch { throw new HostError("invalidData"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new HostError("invalidData");
  return url.href;
}
const tabOut = t => ({ id: t.targetId, title: String(t.title || "").slice(0, 512), url: String(t.url || "").slice(0, 4096) });

function createBrowser({ discover = discoverBrowsers, connect = endpoint => new CdpConnection(endpoint), idleMs = 45000, now = Date.now } = {}) {
  const connections = new Map(), views = new Map(), epochs = new Map();
  let disposed = false;
  const epoch = peer => epochs.get(peer) || 0;
  const valid = (peer, version) => { if (disposed || epoch(peer) !== version) throw new HostError("browserDisconnected"); };
  function release(v) {
    if (!views.delete(v.id)) return;
    if (v.session) v.conn.send("Target.detachFromTarget", { sessionId: v.session }).catch(() => {});
  }
  async function connection(id) {
    if (disposed) throw new HostError("browserDisconnected");
    const found = (await discover()).find(b => b.id === text(id));
    if (disposed) throw new HostError("browserDisconnected");
    if (!found) throw new HostError("browserSetupRequired");
    let entry = connections.get(found.id);
    if (entry && (entry.endpoint !== found.endpoint || entry.conn.closed)) {
      entry.conn.close(); connections.delete(found.id); entry = null;
    }
    if (!entry) {
      if (connections.size >= 4) throw new HostError("browserBusy");
      const conn = connect(found.endpoint);
      entry = { endpoint: found.endpoint, conn, used: now() };
      connections.set(found.id, entry);
      conn.on("closed", () => {
        if (connections.get(found.id) === entry) connections.delete(found.id);
        for (const v of [...views.values()]) if (v.conn === conn) release(v);
      });
      conn.on("event", e => {
        for (const v of [...views.values()]) {
          if (v.conn !== conn) continue;
          if ((e.method === "Target.detachedFromTarget" && e.params?.sessionId === v.session)
            || (e.method === "Target.targetDestroyed" && e.params?.targetId === v.target)) release(v);
        }
      });
    }
    entry.used = now();
    try { await entry.conn.ready; } catch (e) { entry.conn.close(); throw e; }
    return entry.conn;
  }
  async function list(peer) {
    const version = epoch(peer);
    const browsers = await discover();
    valid(peer, version);
    if (!browsers.length) return { setup: true, browsers: [] };
    const out = [];
    // One permission prompt at a time if more than one Chrome channel has remote debugging enabled.
    for (const b of browsers) {
      try {
        const conn = await connection(b.id);
        valid(peer, version);
        const { targetInfos } = await conn.send("Target.getTargets");
        valid(peer, version);
        out.push({ id: b.id, name: b.name, tabs: targetInfos.filter(t => t.type === "page" && webPage(t.url)).map(tabOut) });
      } catch (e) {
        valid(peer, version);
        out.push({ id: b.id, name: b.name, tabs: [], error: e.code || "browserUnavailable" });
      }
    }
    return { setup: false, browsers: out };
  }
  async function attach(peer, p) {
    text(p?.browser); text(p?.tab);
    if (views.size >= 4 || [...views.values()].some(v => v.peer === peer)) throw new HostError("browserBusy");
    const v = { id: randomUUID(), peer, version: epoch(peer), target: p.tab, session: "", conn: null, used: now(), busy: false, capture: false };
    views.set(v.id, v); // Reserve before awaiting, including when a Chrome permission prompt is open.
    try {
      v.conn = await connection(p.browser);
      valid(peer, v.version);
      if (!views.has(v.id)) throw new HostError("browserDisconnected");
      const { targetInfo } = await v.conn.send("Target.getTargetInfo", { targetId: v.target });
      if (targetInfo.type !== "page" || !webPage(targetInfo.url)) throw new HostError("browserTabGone");
      const { sessionId } = await v.conn.send("Target.attachToTarget", { targetId: v.target, flatten: true });
      v.session = sessionId;
      // A disconnect during attach must also detach the late session, even if drop already removed its view.
      if (epoch(peer) !== v.version || !views.has(v.id) || disposed) {
        v.conn.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        throw new HostError("browserDisconnected");
      }
      await v.conn.send("Page.enable", {}, v.session);
      await v.conn.send("Page.bringToFront", {}, v.session);
      valid(peer, v.version);
      if (!views.has(v.id)) throw new HostError("browserNotViewing");
      v.used = now();
      return { view: v.id, tab: tabOut(targetInfo) };
    } catch (e) { release(v); throw e; }
  }
  function view(peer, id) {
    const v = views.get(text(id));
    if (!v || v.peer !== peer) throw new HostError("browserNotViewing");
    if (now() - v.used > idleMs) { release(v); throw new HostError("browserNotViewing"); }
    v.used = now();
    return v;
  }
  async function frame(peer, p) {
    const v = view(peer, p?.view);
    if (!v.session) throw new HostError("browserNotViewing");
    if (v.capture) throw new HostError("browserBusy");
    v.capture = true;
    try {
      const { targetInfo } = await v.conn.send("Target.getTargetInfo", { targetId: v.target });
      if (!webPage(targetInfo.url)) { release(v); throw new HostError("browserTabGone"); }
      const metrics = await v.conn.send("Page.getLayoutMetrics", {}, v.session);
      const vp = metrics.cssVisualViewport || metrics.visualViewport;
      const width = number(vp.clientWidth, 1, 20000), height = number(vp.clientHeight, 1, 20000);
      const scale = Math.min(1, 1440 / width, 1200 / height);
      const { data } = await v.conn.send("Page.captureScreenshot", {
        format: "jpeg", quality: 70, captureBeyondViewport: false,
        clip: { x: vp.pageX, y: vp.pageY, width, height, scale }
      }, v.session);
      if (!views.has(v.id)) throw new HostError("browserNotViewing");
      if (typeof data !== "string" || data.length > 3 * 1024 * 1024) throw new HostError("browserFrameTooBig");
      v.viewport = { width, height, offsetX: vp.offsetX || 0, offsetY: vp.offsetY || 0 };
      return { data, ...v.viewport, tab: tabOut(targetInfo) };
    } finally { v.capture = false; }
  }
  async function input(peer, p) {
    const v = view(peer, p?.view);
    if (!v.session) throw new HostError("browserNotViewing");
    if (v.busy) throw new HostError("browserBusy");
    v.busy = true;
    const send = (method, params) => {
      valid(peer, v.version);
      if (!views.has(v.id)) throw new HostError("browserNotViewing");
      return v.conn.send(method, params, v.session);
    };
    try {
      // Recheck the target: a tab navigated to a browser-internal page must no longer accept remote input.
      const { targetInfo } = await v.conn.send("Target.getTargetInfo", { targetId: v.target });
      if (!webPage(targetInfo.url)) { release(v); throw new HostError("browserTabGone"); }
      if (p.action === "text") await send("Input.insertText", { text: text(p.text, 8192) });
      else if (p.action === "key") {
        const keys = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
        if (p.key === "SelectAll") {
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: process.platform === "darwin" ? 4 : 2 });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        } else {
          if (!Object.hasOwn(keys, p.key)) throw new HostError("invalidData");
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: p.key, code: p.key, windowsVirtualKeyCode: keys[p.key], nativeVirtualKeyCode: keys[p.key], ...(p.key === "Enter" ? { text: "\r" } : {}) });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: p.key, code: p.key, windowsVirtualKeyCode: keys[p.key], nativeVirtualKeyCode: keys[p.key] });
        }
      } else if (p.action === "click" || p.action === "scroll") {
        if (!v.viewport) throw new HostError("browserNotViewing");
        const x = number(p.x, 0, 1) * v.viewport.width + v.viewport.offsetX;
        const y = number(p.y, 0, 1) * v.viewport.height + v.viewport.offsetY;
        if (p.action === "click") {
          await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        } else await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: number(p.dx ?? 0, -3000, 3000), deltaY: number(p.dy, -3000, 3000) });
      } else if (p.action === "navigate") await send("Page.navigate", { url: webUrl(p.url) });
      else if (p.action === "reload") await send("Page.reload");
      else if (p.action === "back" || p.action === "forward") {
        const { entries, currentIndex } = await send("Page.getNavigationHistory");
        const entry = entries[currentIndex + (p.action === "back" ? -1 : 1)];
        if (entry && webPage(entry.url)) await send("Page.navigateToHistoryEntry", { entryId: entry.id });
      } else throw new HostError("invalidData");
      return true;
    } finally { v.busy = false; }
  }
  async function open(peer, p) {
    const version = epoch(peer), url = webUrl(p?.url);
    const conn = await connection(p?.browser);
    valid(peer, version);
    const { targetId } = await conn.send("Target.createTarget", { url });
    return { id: targetId };
  }
  function detach(peer, p) {
    const v = views.get(text(p?.view));
    if (v && v.peer !== peer) throw new HostError("browserNotViewing");
    if (v) release(v);
    return true;
  }
  function drop(peer) {
    epochs.set(peer, epoch(peer) + 1);
    for (const v of [...views.values()]) if (v.peer === peer) release(v);
  }
  const timer = setInterval(() => {
    for (const v of [...views.values()]) if (now() - v.used > idleMs && !v.busy && !v.capture) release(v);
    // Keep the browser-level connection: reconnecting may require a new consent dialog at the computer.
    // Only page sessions expire; no pictures are taken without a view's explicit frame requests.
  }, Math.min(idleMs, 10000));
  timer.unref?.();
  function dispose() {
    disposed = true;
    clearInterval(timer);
    for (const v of [...views.values()]) release(v);
    for (const entry of connections.values()) entry.conn.close();
    connections.clear();
  }
  return { list, attach, frame, input, open, detach, drop, dispose };
}

module.exports = { createBrowser, webUrl };
