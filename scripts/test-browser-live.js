// Real Chrome + the real mobile screen + encrypted phone/relay/host transport. All accounts are synthetic.
// Both Chrome processes use temporary profiles. The user's running Chrome, tabs and settings are untouched.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const esbuild = require("../mobile/node_modules/esbuild");
const { CdpConnection, activeEndpoint } = require("../src/host/browser-cdp");
const { createBrowser } = require("../src/host/browser");
const { withPhone, waitFor, sleep } = require("./browser-test-rig");

async function chromePath() {
  const candidates = [process.env.AGENTDECK_TEST_CHROME,
    ...(process.platform === "win32" ? [path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe"), path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")]
      : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"])].filter(Boolean);
  for (const p of candidates) { try { await fs.access(p); return p; } catch {} }
  throw new Error("Chrome is required. Set AGENTDECK_TEST_CHROME to its executable.");
}
async function launch(executable, dir) {
  await fs.mkdir(dir, { recursive: true });
  const child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--window-size=1100,800", "about:blank"], { windowsHide: true, stdio: "ignore" });
  let endpoint;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Test Chrome exited (${child.exitCode})`);
    try { endpoint = activeEndpoint(await fs.readFile(path.join(dir, "DevToolsActivePort"), "utf8")); return endpoint; } catch { return false; }
  }, "test Chrome starts");
  const control = new CdpConnection(endpoint);
  await control.ready;
  return { control, endpoint, child, async stop() {
    try { await control.send("Browser.close"); } catch {}
    control.close();
    await waitFor(() => child.exitCode !== null, "test Chrome stops", 5000).catch(() => child.kill());
  } };
}
async function session(control, url) {
  const { targetId } = await control.send("Target.createTarget", { url });
  const { sessionId } = await control.send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, send: (m, p = {}) => control.send(m, p, sessionId), eval: async expression => {
    const r = await control.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ": " + r.exceptionDetails.exception?.description);
    return r.result.value;
  } };
}
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentdeck-browser-live-")), browsers = [];
  let server, gateway;
  const errors = [];
  try {
    const desktop = await launch(await chromePath(), path.join(root, "desktop")); browsers.push(desktop);
    const phone = await launch(await chromePath(), path.join(root, "phone")); browsers.push(phone);
    const harness = await esbuild.build({ stdin: { contents: `
      import {render} from './mobile/src/screens/browser.js';
      import {setLanguage} from './mobile/src/i18n.js';
      setLanguage('en');
      const events=new Map();
      const provider={on(name,fn){events.set(name,fn);return()=>events.delete(name);},async request(node,method,params){
        const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
        const v=await r.json();if(v.error)throw v.error;return v.result;
      }};
      const store={provider,nodeName:()=> 'Test desktop',nodes:()=>[{id:'desktop',online:true}]};
      window.testEvents=events;
      window.cleanup=render(document.querySelector('.screen'),{store,back(){window.cleanup();},fail(e){window.uiError=e;},prompt:()=>null},{node:'desktop'});
    `, resolveDir: path.join(__dirname, "..") }, bundle: true, format: "iife", write: false });
    const css = await esbuild.build({ entryPoints: [path.join(__dirname, "../mobile/src/style.css")], bundle: true, write: false, loader: { ".woff2": "dataurl" } });
    const loginPage = `<!doctype html><meta charset="utf-8"><title>Login on desktop</title><style>body{font:20px system-ui;background:#f2f5fb;color:#142030;margin:80px auto;width:400px}label{display:block;margin:20px 0}input,button{font:inherit;width:100%;padding:12px;box-sizing:border-box}button{background:#2854ce;color:white;border:0;border-radius:8px}</style><h1>Desktop sign-in</h1><form method="post" action="/sign-in"><label>Email<input name="email" id="email" autocomplete="off"></label><label>Password<input name="password" id="password" type="password"></label><button id="login">Sign in</button></form>`;
    server = http.createServer(async (req, res) => {
      try {
        if (req.url === "/rpc") {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const { method, params } = JSON.parse(Buffer.concat(chunks));
          try { const result = await gateway(method.replace(/^browser\./, ""), params); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ result })); }
          catch (e) { res.end(JSON.stringify({ error: { code: e.code, message: e.message } })); }
        } else if (req.url === "/harness") {
          res.setHeader("Content-Type", "text/html");
          res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="app" class="screen-browser"><section class="screen"></section></div><script src="/harness.js"></script>');
        } else if (req.url === "/harness.js") { res.setHeader("Content-Type", "application/javascript"); res.end(harness.outputFiles[0].text); }
        else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(css.outputFiles[0].text); }
        else if (req.url === "/sign-in" && req.method === "POST") {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const form = new URLSearchParams(Buffer.concat(chunks).toString());
          assert.equal(form.get("email"), "mobile@example.test"); assert.equal(form.get("password"), "парола🔒");
          res.writeHead(302, { Location: "/private", "Set-Cookie": "test-session=logged-in; HttpOnly; Path=/; SameSite=Lax" }); res.end();
        } else if (req.url === "/private") {
          assert.match(req.headers.cookie || "", /test-session=logged-in/);
          res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<title>Signed in on desktop</title><h1 id="signed-in">Signed in from phone</h1><div style="height:2200px;background:linear-gradient(white,lightblue)">Scroll test</div>');
        } else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Set-Cookie", "existing-session=kept; Path=/"); res.end(loginPage); }
      } catch (e) { errors.push(e); res.writeHead(500); res.end("Test failed"); }
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const agent = await session(desktop.control, `${base}/login`);
    await waitFor(() => agent.eval("!!document.querySelector('#email')"), "desktop login page");
    const browser = createBrowser({ discover: async () => [{ id: "chrome-0", name: "Chrome", endpoint: desktop.endpoint }] });
    await withPhone(browser, async ({ call }) => {
      gateway = call;
      const mobile = await session(phone.control, "about:blank");
      await mobile.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await mobile.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await mobile.send("Page.navigate", { url: `${base}/harness` });
      await waitFor(() => mobile.eval("!!document.querySelector('.browser-tab')"), "mobile tab list");
      await mobile.eval(`document.querySelector('[data-tab="${agent.targetId}"]').click()`);
      await waitFor(() => mobile.eval("!!document.querySelector('.browser-image:not([hidden])')?.naturalWidth"), "live desktop picture on phone");
      const touch = async (x, y) => {
        await mobile.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await mobile.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const clickRemote = async selector => {
        const target = await agent.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight};})()`);
        const rect = await mobile.eval("(()=>{const r=document.querySelector('.browser-image').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};})()");
        await touch(rect.x + rect.w * target.x / target.w, rect.y + rect.h * target.y / target.h);
      };
      const type = value => mobile.eval(`(()=>{const i=document.querySelector('.browser-type input');i.value=${JSON.stringify(value)};i.form.requestSubmit();})()`);
      await clickRemote("#email");
      await waitFor(() => agent.eval("document.activeElement.id==='email'"), "touch focuses email in same desktop tab");
      await type("mobile@example.test");
      await waitFor(() => agent.eval("document.querySelector('#email').value==='mobile@example.test'"), "username typed from mobile UI");
      await mobile.eval("document.querySelector('[data-browser-key=SelectAll]').click()");
      await waitFor(() => agent.eval("document.querySelector('#email').selectionStart===0 && document.querySelector('#email').selectionEnd===document.querySelector('#email').value.length"), "select all works in remote field");
      await type("mobile@example.test");
      await waitFor(() => agent.eval("document.querySelector('#email').value==='mobile@example.test' && document.querySelector('#email').selectionStart>0"), "selected value is replaced");
      await mobile.eval("document.querySelector('[data-browser-key=Tab]').click()");
      await waitFor(() => agent.eval("document.activeElement.id==='password'"), "Tab changes remote field");
      await type("парола🔒");
      await waitFor(() => agent.eval("document.querySelector('#password').value==='парола🔒'"), "Unicode password typed remotely");
      await mobile.eval("document.querySelector('[data-browser-key=Enter]').click()");
      await waitFor(() => agent.eval("!!document.querySelector('#signed-in')"), "remote Enter signs in");
      const cookies = await agent.send("Network.getCookies", { urls: [base] });
      assert.ok(cookies.cookies.some(c => c.name === "test-session" && c.httpOnly));
      assert.ok(cookies.cookies.some(c => c.name === "existing-session" && c.value === "kept"));
      assert.equal(await mobile.eval("document.querySelector('.browser-type input').value"), "", "no password left in mobile input");
      await waitFor(() => mobile.eval("document.querySelector('.browser-address input').value.endsWith('/private')"), "phone follows remote navigation");
      const img = await mobile.eval("(()=>{const r=document.querySelector('.browser-image').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()");
      await mobile.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: img.x, y: img.y + 50 }] });
      await mobile.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: img.x, y: img.y - 50 }] });
      await mobile.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await waitFor(() => agent.eval("scrollY>50"), "swipe scrolls computer page");
      await mobile.eval("document.querySelector('[data-act=zoom]').click()");
      await waitFor(() => mobile.eval("document.querySelector('.browser-image').getBoundingClientRect().width>700"), "2x zoom enlarges the remote picture");
      const beforePan = await agent.eval("scrollY");
      await mobile.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 220, y: 350 }, { x: 300, y: 400 }] });
      await mobile.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 140, y: 350 }, { x: 220, y: 400 }] });
      await mobile.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await waitFor(() => mobile.eval("document.querySelector('.browser-canvas').scrollLeft>20"), "two-finger pan moves the enlarged picture");
      assert.equal(await agent.eval("scrollY"), beforePan, "panning the picture does not scroll the remote page");
      await mobile.eval("document.querySelector('[data-act=zoom]').click();document.querySelector('[data-act=zoom]').click()");
      const shots = path.join(__dirname, "../.tmp"); await fs.mkdir(shots, { recursive: true });
      const { data } = await mobile.send("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(shots, "browser-live-mobile.png"), Buffer.from(data, "base64"));
      // Leave and reattach: login belongs to Chrome, not the phone view.
      await mobile.eval("document.querySelector('[data-act=tabs]').click()");
      await waitFor(() => mobile.eval("!document.querySelector('.browser-list').hidden && !!document.querySelector('.browser-tab')"), "return to tab list");
      assert.ok(await agent.eval("!!document.querySelector('#signed-in')"), "tab and login survive leaving the phone view");
      await mobile.eval(`document.querySelector('[data-tab="${agent.targetId}"]').click()`);
      await waitFor(() => mobile.eval("!!document.querySelector('.browser-image:not([hidden])')?.naturalWidth"), "same tab reattached");
      await mobile.eval("testEvents.get('link')({node:'desktop',up:false})");
      assert.equal(await mobile.eval("document.querySelector('.browser-image').hasAttribute('src')"), false, "link loss clears stale picture");
      await mobile.eval("cleanup()");
      assert.deepEqual(errors, []);
      console.log("browser live: real Chrome tab -> real mobile screen -> encrypted relay: touch, typing, Unicode password, select-all, Tab/Enter, HTTP-only login, existing session, swipe, zoom, two-finger pan, detach/reattach and link loss passed");
      console.log("Screenshot: .tmp/browser-live-mobile.png (synthetic test page; no real account)");
    });
  } finally {
    for (const b of browsers.reverse()) await b.stop();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
