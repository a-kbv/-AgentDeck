// A real phone provider -> encrypted relay -> served desktop; and a test Chrome with a temporary profile for the tests
// that drive a page (never the user's Chrome or profile).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { WebSocket } = require("ws");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const noise = require("../src/mesh/noise");
const pairCode = require("../src/mesh/pair-code");
const { CdpConnection, activeEndpoint } = require("../src/host/browser-cdp");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// A test Chrome of its own: headless, a temporary profile in `dir` - never the user's Chrome, tabs or settings.
async function chromePath() {
  const candidates = [process.env.AGENTDECK_TEST_CHROME,
    ...(process.platform === "win32" ? [path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe"), path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")]
      : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"])].filter(Boolean);
  for (const p of candidates) { try { await fs.promises.access(p); return p; } catch {} }
  throw new Error("Chrome is required. Set AGENTDECK_TEST_CHROME to its executable.");
}
async function launch(executable, dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  const child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--window-size=1100,800", "about:blank"], { windowsHide: true, stdio: "ignore" });
  let endpoint;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Test Chrome exited (${child.exitCode})`);
    try { endpoint = activeEndpoint(await fs.promises.readFile(path.join(dir, "DevToolsActivePort"), "utf8")); return endpoint; } catch { return false; }
  }, "test Chrome starts");
  const control = new CdpConnection(endpoint);
  await control.ready;
  return { control, endpoint, child, async stop() {
    try { await control.send("Browser.close"); } catch {}
    control.close();
    await waitFor(() => child.exitCode !== null, "test Chrome stops", 5000).catch(() => child.kill());
  } };
}
// A new tab of that Chrome, attached: send(method, params) and eval(expression) -> its value.
async function session(control, url) {
  const { targetId } = await control.send("Target.createTarget", { url });
  const { sessionId } = await control.send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId, send: (m, p = {}) => control.send(m, p, sessionId), eval: async expression => {
    const r = await control.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ": " + r.exceptionDetails.exception?.description);
    return r.result.value;
  } };
}
function makeHost() {
  const data = { registry: { projects: [] }, sessions: [], agents: [], at: Date.now() };
  return Object.assign(new EventEmitter(), {
    terminals: { getTabs: () => [] }, viewers: { leave() {}, state: () => null }, launch: {}, sendText: {}, git: {}, setup: {},
    sessions: { get: () => data, data: async () => data, registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} } },
    home: os.homedir(), tabs: () => [], liveSessions: async () => []
  });
}
async function withPhone(browser, run, servedOpts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-browser-mesh-"));
  const nodes = [], phones = [];
  const node = async (name, opts = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port: 0 }));
    const n = createLinks({ dir, defaultName: name, version: "test", kind: "desktop", discover: false, log: () => {}, ...opts });
    nodes.push(n); await n.start(); return n;
  };
  const served = createServed({ host: Object.assign(makeHost(), servedOpts.host || {}), browser, ...(servedOpts.served || {}) });
  try {
    const relay = await node("relay", { kind: "host", relayOnly: true });
    const host = await node("desktop", { api: served.api });
    served.attach(host);
    await host.pair("127.0.0.1", relay.self().port, relay.self().code);
    await waitFor(() => host.online(relay.self().id), "desktop -> relay");
    const { createRelayProvider } = await import(pathToFileURL(path.join(__dirname, "../mobile/src/provider-relay.js")).href);
    const entry = inv => ({ id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name, t: inv.kind });
    // A phone paired with the relay and the desktop, linked through the relay (more than one may be).
    const pairPhone = async (name = "Browser test phone") => {
      const { t: _kind, ...r } = entry(await host.call(relay.self().id, "pair.invite"));
      const payload = pairCode.encode({ r: { ...r, a: "127.0.0.1", p: relay.self().port }, n: [entry(host.invite())] });
      const p = createRelayProvider({ WebSocket, keypair: noise.generateKeypair(), name, version: "test" });
      phones.push(p);
      await p.start();
      const paired = await p.pairAll(payload);
      if (!paired.every(x => x.state === "paired")) throw new Error(`Pairing failed: ${JSON.stringify(paired)}`);
      await waitFor(() => p.online(host.self().id), "phone -> relay -> desktop");
      return p;
    };
    const phone = await pairPhone();
    const call = (method, params = {}) => phone.request(host.self().id, method.includes(".") ? method : `browser.${method}`, params, { timeout: 20000 });
    await run({ call, phone, host, relay, served, node, pairPhone });
  } finally {
    for (const phone of phones) phone.stop();
    for (const n of nodes.reverse()) n.stop();
    browser.dispose();
    await sleep(150);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { withPhone, waitFor, sleep, freePort, chromePath, launch, session };
