// Meaningful boundaries: Chrome discovery is local-only, commands are allowlisted, views are peer/link-scoped,
// disconnect races detach late sessions, slow captures do not queue, and the actual phone/relay RPC carries images.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { WebSocketServer } = require("ws");
const { createBrowser, webUrl } = require("../src/host/browser");
const { activeEndpoint, chromeProfiles, discoverBrowsers, CdpConnection } = require("../src/host/browser-cdp");
const { withPhone, sleep, waitFor } = require("./browser-test-rig");

class Chrome extends EventEmitter {
  constructor() {
    super(); this.ready = Promise.resolve(this); this.closed = false; this.calls = []; this.sessions = new Set();
    this.tabs = [{ type: "page", targetId: "login", url: "https://example.test/login", title: "Login" },
      { type: "page", targetId: "internal", url: "chrome://settings", title: "Settings" }, { type: "service_worker", targetId: "worker", url: "https://example.test/worker" }];
  }
  async send(method, p = {}, session) {
    this.calls.push({ method, p, session });
    if (this.closed) throw { code: "browserDisconnected" };
    if (method === "Target.getTargets") return { targetInfos: this.tabs };
    if (method === "Target.getTargetInfo") return { targetInfo: this.tabs.find(t => t.targetId === p.targetId) };
    if (method === "Target.attachToTarget") { if (this.attachGate) await this.attachGate; const sessionId = `s-${this.calls.length}`; this.sessions.add(sessionId); return { sessionId }; }
    if (method === "Target.detachFromTarget") { this.sessions.delete(p.sessionId); return {}; }
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1800, clientHeight: 1000, offsetX: 0, offsetY: 0, pageX: 0, pageY: 300 } };
    if (method === "Page.captureScreenshot") { if (this.captureGate) await this.captureGate; return { data: Buffer.alloc(256 * 1024, 42).toString("base64") }; }
    if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{ id: 1, url: "https://example.test/" }, { id: 2, url: "https://example.test/login" }] };
    if (method === "Target.createTarget") { this.tabs.push({ targetId: "new", type: "page", title: "New", url: p.url }); return { targetId: "new" }; }
    return {};
  }
  close() { if (!this.closed) { this.closed = true; this.emit("closed"); } }
}
const discovered = async () => [{ id: "chrome-0", name: "Chrome", endpoint: "ws://127.0.0.1:1234/devtools/browser/test" }];
const make = (chrome, opts = {}) => createBrowser({ discover: discovered, connect: () => chrome, ...opts });
async function main() {
  assert.equal(activeEndpoint("9222\r\n/devtools/browser/abc-123\r\n"), "ws://127.0.0.1:9222/devtools/browser/abc-123");
  for (const value of ["0\n/devtools/browser/id", "65536\n/devtools/browser/id", "9222\n//evil.test/a", "9222\n/devtools/browser/id?x=a", "1x\n/devtools/browser/id"]) assert.equal(activeEndpoint(value), null);
  assert.equal(chromeProfiles({ platform: "win32", home: "C:/user", env: {} }).length, 4);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdeck-browser-discovery-"));
  try {
    assert.deepEqual(await discoverBrowsers([{ name: "Chrome", dir }]), []);
    await fs.writeFile(path.join(dir, "DevToolsActivePort"), "9222\n/devtools/browser/real");
    assert.equal((await discoverBrowsers([{ name: "Chrome", dir }]))[0].id, "chrome-0");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  for (const url of ["file:///C:/secret", "javascript:alert(1)", "chrome://settings", "https://user:pass@example.com", "data:text/html,test"]) assert.throws(() => webUrl(url), { code: "invalidData" });
  const empty = createBrowser({ discover: async () => [] });
  assert.deepEqual(await empty.list("phone"), { setup: true, browsers: [] }); empty.dispose();
  console.log("ok: local discovery, endpoint validation, setup and URL restrictions");

  const chrome = new Chrome(), browser = make(chrome);
  try {
    const list = await browser.list("A");
    assert.deepEqual(list.browsers[0].tabs.map(t => t.id), ["login"]);
    assert.ok(!JSON.stringify(list).includes("ws://"));
    const attached = await browser.attach("A", { browser: "chrome-0", tab: "login" });
    const { view } = attached;
    await assert.rejects(browser.frame("B", { view }), { code: "browserNotViewing" });
    await assert.rejects(browser.input("B", { view, action: "text", text: "stolen" }), { code: "browserNotViewing" });
    assert.throws(() => browser.detach("B", { view }), { code: "browserNotViewing" });
    const frame = await browser.frame("A", { view });
    assert.equal(frame.width, 1800);
    assert.equal(chrome.calls.find(c => c.method === "Page.captureScreenshot").p.clip.scale, 0.8);
    await browser.input("A", { view, action: "click", x: 0.5, y: 0.25 });
    const press = chrome.calls.find(c => c.method === "Input.dispatchMouseEvent");
    assert.deepEqual([press.p.x, press.p.y], [900, 250]);
    await browser.input("A", { view, action: "text", text: "тест 🔒" });
    assert.equal(chrome.calls.find(c => c.method === "Input.insertText").p.text, "тест 🔒");
    await browser.input("A", { view, action: "key", key: "Enter" });
    assert.deepEqual(chrome.calls.filter(c => c.method === "Input.dispatchKeyEvent").map(c => c.p.type), ["keyDown", "keyUp"]);
    for (const data of [{ action: "Runtime.evaluate", expression: "anything" }, { action: "key", key: "F12" }, { action: "click", x: -0.1, y: 0 }, { action: "scroll", x: 0, y: 0, dy: Infinity }, { action: "navigate", url: "file:///secret" }]) {
      await assert.rejects(browser.input("A", { ...data, view }), { code: "invalidData" });
    }
    let done; chrome.captureGate = new Promise(r => { done = r; });
    const held = browser.frame("A", { view });
    await sleep(10);
    await assert.rejects(browser.frame("A", { view }), { code: "browserBusy" });
    done(); await held; chrome.captureGate = null;
    chrome.tabs[0].url = "chrome://settings";
    await assert.rejects(browser.input("A", { view, action: "text", text: "bad" }), { code: "browserTabGone" });
    assert.equal(chrome.sessions.size, 0);
    chrome.tabs[0].url = "https://example.test/login";
    const second = await browser.attach("A", { browser: "chrome-0", tab: "login" });
    browser.drop("A");
    await assert.rejects(browser.frame("A", { id: second.view }), { code: "invalidData" });
    await assert.rejects(browser.frame("A", { view: second.view }), { code: "browserNotViewing" });
    assert.equal(chrome.sessions.size, 0);
    assert.equal(chrome.closed, false, "consented browser connection survives leaving a tab");
    console.log("ok: same-tab controls, ownership, command bounds, internal-page navigation, capture backpressure and disconnect");
  } finally { browser.dispose(); }

  const delayed = new Chrome(), raced = make(delayed);
  try {
    let unblock; delayed.attachGate = new Promise(r => { unblock = r; });
    const pending = raced.attach("A", { browser: "chrome-0", tab: "login" });
    await waitFor(() => delayed.calls.some(c => c.method === "Target.attachToTarget"), "attach in flight");
    raced.drop("A"); unblock();
    await assert.rejects(pending, { code: "browserDisconnected" });
    assert.equal(delayed.sessions.size, 0, "late attach is detached after a link drop");
  } finally { raced.dispose(); }
  let clock = 0;
  const leasedChrome = new Chrome(), leased = make(leasedChrome, { now: () => clock });
  try {
    const attached = await leased.attach("A", { browser: "chrome-0", tab: "login" });
    clock = 46000;
    await assert.rejects(leased.frame("A", { view: attached.view }), { code: "browserNotViewing" });
    assert.equal(leasedChrome.sessions.size, 0);
  } finally { leased.dispose(); }
  console.log("ok: late attach cleanup and idle view expiry");

  // Exercise the actual websocket adapter: success, protocol error, pending request cancelled by a close.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(r => server.once("listening", r));
  server.on("connection", ws => ws.on("message", data => {
    const m = JSON.parse(data);
    if (m.method === "hold") return;
    ws.send(JSON.stringify({ id: m.id, ...(m.method === "bad" ? { error: { message: "private detail" } } : { result: { ok: true } }) }));
  }));
  const conn = new CdpConnection(`ws://127.0.0.1:${server.address().port}/devtools/browser/test`);
  try {
    assert.deepEqual(await conn.send("good"), { ok: true });
    await assert.rejects(conn.send("bad"), { code: "browserCommandFailed" });
    const hold = conn.send("hold"); await sleep(10); conn.close();
    await assert.rejects(hold, { code: "browserDisconnected" });
  } finally { conn.close(); for (const client of server.clients) client.terminate(); await new Promise(r => server.close(r)); }

  const remoteChrome = new Chrome();
  await withPhone(make(remoteChrome), async ({ call, phone, host, node }) => {
    assert.equal((await phone.request(host.self().id, "host.info")).browser, 1);
    const result = await call("list");
    assert.equal(result.browsers[0].tabs[0].id, "login");
    const { view } = await call("attach", { browser: "chrome-0", tab: "login" });
    const frame = await call("frame", { view });
    assert.equal(Buffer.from(frame.data, "base64").length, 256 * 1024, "large image crosses the encrypted relay intact");
    await call("input", { view, action: "text", text: "phone login" });
    assert.ok(remoteChrome.calls.some(c => c.method === "Input.insertText" && c.p.text === "phone login"));
    const resource = await node("resource", { kind: "host" });
    await resource.pair("127.0.0.1", host.self().port, host.self().code);
    await waitFor(() => resource.online(host.self().id), "resource host linked");
    await assert.rejects(resource.call(host.self().id, "browser.list"), { code: "relayOnly" });
    phone.stop();
    await waitFor(() => remoteChrome.sessions.size === 0, "phone disconnect detaches target");
  });
  const { imagePoint, frameDelay } = await import(pathToFileURL(path.join(__dirname, "../mobile/src/browser.js")).href);
  const rect = { left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120 };
  assert.deepEqual(imagePoint(rect, 110, 45), { x: 0.5, y: 0.25 });
  assert.equal(imagePoint(rect, 0, 0), null);
  assert.equal(frameDelay(0, 5000), 150, "slow connections never get a burst of queued frames");
  console.log("ok: real phone -> relay -> host API, image transfer, resource-host denial, link cleanup and phone geometry");
  console.log("browser: all checks passed");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
