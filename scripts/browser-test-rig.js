// A real phone provider -> encrypted relay -> served desktop. No Chrome/profile is started by this rig.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { WebSocket } = require("ws");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const noise = require("../src/mesh/noise");
const pairCode = require("../src/mesh/pair-code");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function makeHost() {
  const data = { registry: { projects: [] }, sessions: [], agents: [], at: Date.now() };
  return Object.assign(new EventEmitter(), {
    terminals: { getTabs: () => [] }, viewers: { leave() {}, state: () => null }, launch: {}, sendText: {}, git: {}, setup: {},
    sessions: { get: () => data, data: async () => data, registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} } },
    home: os.homedir(), tabs: () => [], liveSessions: async () => []
  });
}
async function withPhone(browser, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-browser-mesh-"));
  const nodes = [], phones = [];
  const node = async (name, opts = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port: 0 }));
    const n = createLinks({ dir, defaultName: name, version: "test", kind: "desktop", discover: false, log: () => {}, ...opts });
    nodes.push(n); await n.start(); return n;
  };
  const served = createServed({ host: makeHost(), browser });
  try {
    const relay = await node("relay", { kind: "host", relayOnly: true });
    const host = await node("desktop", { api: served.api });
    served.attach(host);
    await host.pair("127.0.0.1", relay.self().port, relay.self().code);
    await waitFor(() => host.online(relay.self().id), "desktop -> relay");
    const { createRelayProvider } = await import(pathToFileURL(path.join(__dirname, "../mobile/src/provider-relay.js")).href);
    const entry = inv => ({ id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name, t: inv.kind });
    const { t: _kind, ...r } = entry(await host.call(relay.self().id, "pair.invite"));
    const payload = pairCode.encode({ r: { ...r, a: "127.0.0.1", p: relay.self().port }, n: [entry(host.invite())] });
    const phone = createRelayProvider({ WebSocket, keypair: noise.generateKeypair(), name: "Browser test phone", version: "test" });
    phones.push(phone);
    await phone.start();
    const paired = await phone.pairAll(payload);
    if (!paired.every(x => x.state === "paired")) throw new Error(`Pairing failed: ${JSON.stringify(paired)}`);
    await waitFor(() => phone.online(host.self().id), "phone -> relay -> desktop");
    const call = (method, params = {}) => phone.request(host.self().id, `browser.${method}`, params, { timeout: 20000 });
    await run({ call, phone, host, relay, served, node });
  } finally {
    for (const phone of phones) phone.stop();
    for (const n of nodes.reverse()) n.stop();
    browser.dispose();
    await sleep(150);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { withPhone, waitFor, sleep, freePort };
