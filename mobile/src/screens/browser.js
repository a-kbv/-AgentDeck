// The computer's existing Chrome tabs. Frames are requested only while visible, one at a time; no video/socket
// plugin is needed on either phone OS. Input is serialized, never saved to drafts, and bound to the chosen view.
import { t, errorText } from "../i18n.js";
import { esc } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, wireBack } from "./parts.js";
import { imagePoint, frameDelay } from "../browser.js";

export function render(el, ctx, p) {
  const { store } = ctx, provider = store.provider, name = store.nodeName(p.node);
  let left = false, view = null, generation = 0, timer = 0, loading = false, queue = Promise.resolve(), queued = 0;
  let lastFrame = null, gesture = null, painting = false, zoom = 1, pan = null;
  const pointers = new Map();
  el.classList.add("remote-browser");
  el.innerHTML = `${header(t("browser.title"), { back: true, sub: esc(name), actions: iconBtn("fit", t("browser.zoom"), 'data-act="zoom" aria-pressed="false"') + iconBtn("refresh", t("browser.refreshTabs"), 'data-act="refresh-tabs"') })}
    <main class="body browser-list"></main><div class="browser-view" hidden>
      <div class="browser-toolbar">${iconBtn("back", t("browser.historyBack"), 'data-browser-action="back"')}${iconBtn("right", t("browser.historyForward"), 'data-browser-action="forward"')}${iconBtn("refresh", t("browser.reload"), 'data-browser-action="reload"')}
        <form class="browser-address"><input type="url" aria-label="${esc(t("browser.address"))}" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="submit" class="icon-btn" aria-label="${esc(t("browser.go"))}">${icon("rightArrow")}</button></form>
        ${iconBtn("x", t("browser.tabs"), 'data-act="tabs"')}</div>
      <p class="browser-state" role="status"></p>
      <div class="browser-canvas"><img class="browser-image" alt="${esc(t("browser.page"))}" draggable="false" hidden></div>
      <p class="fine browser-hint">${esc(t("browser.hint"))}</p>
      <form class="browser-type"><input type="password" aria-label="${esc(t("browser.type"))}" placeholder="${esc(t("browser.type"))}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="8192">
        ${iconBtn("eye", t("browser.showText"), 'type="button" data-act="show-text" aria-pressed="false"')}<button type="submit" class="icon-btn" aria-label="${esc(t("browser.sendText"))}">${icon("send")}</button></form>
      <div class="browser-keys">${["Tab", "SelectAll", "Backspace", "Enter", "Escape"].map(key => `<button data-browser-key="${key}">${esc(t(`browser.key.${key}`))}</button>`).join("")}</div>
    </div>`;
  wireBack(el, ctx);
  const list = el.querySelector(".browser-list"), panel = el.querySelector(".browser-view"), image = el.querySelector(".browser-image");
  const status = el.querySelector(".browser-state"), address = el.querySelector(".browser-address input"), field = el.querySelector(".browser-type input"), canvas = el.querySelector(".browser-canvas");
  const call = (method, params = {}, timeout = 15000) => provider.request(p.node, `browser.${method}`, params, { timeout });
  const online = () => store.nodes().some(n => n.id === p.node && n.online);
  const state = s => { status.textContent = s; status.hidden = !s; };
  function clearImage() { image.hidden = true; image.removeAttribute("src"); lastFrame = null; gesture = null; pan = null; pointers.clear(); }
  function sizeImage() {
    canvas.classList.toggle("zoomed", zoom > 1);
    image.style.width = zoom > 1 ? `${Math.round(canvas.clientWidth * zoom)}px` : "";
    const button = el.querySelector('[data-act="zoom"]');
    button.setAttribute("aria-pressed", String(zoom > 1));
    button.classList.toggle("on", zoom > 1);
  }
  const resized = new ResizeObserver(sizeImage);
  resized.observe(canvas);
  function detach() {
    generation++;
    clearTimeout(timer);
    const old = view;
    view = null;
    clearImage();
    field.value = "";
    field.type = "password";
    if (old && online()) call("detach", { view: old }).catch(() => {});
  }
  function failure(e) {
    if (left) return;
    state(errorText(e));
    // A stale picture must never look like a connected, usable tab.
    clearImage();
    if (["browserNotViewing", "browserDisconnected", "browserTabGone", "offline", "closed", "timeout", "browserTimeout"].includes(e?.code)) {
      detach();
      state(`${errorText(e)} ${t("browser.reopen")}`);
    }
  }
  async function refreshTabs() {
    if (loading || left) return;
    detach();
    panel.hidden = true;
    list.hidden = false;
    loading = true;
    list.innerHTML = `<p class="empty"><i class="spinner"></i> ${esc(t("browser.connecting"))}</p>`;
    try {
      if (!online()) throw { code: "offline" };
      const result = await call("list", {}, 60000);
      if (left) return;
      list.innerHTML = `<div class="note"><div class="note-text">${esc(t("browser.sameSession", { name }))}</div></div>`;
      if (result.setup) list.innerHTML += `<div class="browser-setup"><h2>${esc(t("browser.setupTitle"))}</h2><p>${esc(t("browser.setupBody", { name }))}</p><code>chrome://inspect/#remote-debugging</code><p>${esc(t("browser.setupAllow"))}</p><button class="primary" data-act="refresh-tabs">${esc(t("browser.retry"))}</button></div>`;
      else for (const b of result.browsers) {
        list.innerHTML += `<h2 class="group">${esc(b.name)}</h2>${b.error ? `<p class="empty">${esc(errorText(b.error))}</p>` : `<div class="rows">${b.tabs.map(tab => `<button class="browser-tab" data-browser="${esc(b.id)}" data-tab="${esc(tab.id)}">${icon("globe")}<span><b>${esc(tab.title || tab.url)}</b><small>${esc(tab.url)}</small></span>${icon("right")}</button>`).join("")}</div>${b.tabs.length ? "" : `<p class="empty">${esc(t("browser.noTabs"))}</p>`}<button class="browser-new" data-new-browser="${esc(b.id)}">${icon("plus")}${esc(t("browser.newTab"))}</button>`}`;
      }
    } catch (e) {
      if (!left) list.innerHTML = `<p class="empty">${esc(e?.code === "unknownMethod" ? t("browser.needsUpdate", { name }) : errorText(e))}</p><button class="browser-new" data-act="refresh-tabs">${esc(t("browser.retry"))}</button>`;
    } finally { loading = false; }
  }
  async function capture(token) {
    if (left || !view || token !== generation || document.visibilityState === "hidden") return;
    const started = Date.now(), id = view;
    try {
      const frame = await call("frame", { view: id });
      if (left || view !== id || token !== generation) return;
      if (typeof frame.data !== "string" || frame.data.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(frame.data)) throw { code: "browserCommandFailed" };
      // Decode before swapping: input and picture must always use the same geometry.
      const next = new Image();
      next.src = `data:image/jpeg;base64,${frame.data}`;
      await new Promise((resolve, reject) => { if (next.complete && next.naturalWidth) resolve(); else { next.onload = resolve; next.onerror = reject; } });
      if (left || view !== id || token !== generation) return;
      painting = true;
      image.src = next.src;
      image.hidden = false;
      lastFrame = frame;
      painting = false;
      if (document.activeElement !== address) address.value = frame.tab.url;
      image.alt = frame.tab.title || t("browser.page");
      state("");
    } catch (e) { if (view === id && token === generation) failure(e); }
    if (!left && view === id && token === generation) timer = setTimeout(() => capture(token), frameDelay(started));
  }
  async function openTab(browser, tab) {
    detach();
    const token = generation;
    panel.hidden = false;
    list.hidden = true;
    address.value = "";
    state(t("browser.opening"));
    try {
      const result = await call("attach", { browser, tab }, 60000);
      if (left || token !== generation) { call("detach", { view: result.view }).catch(() => {}); return; }
      view = result.view;
      address.value = result.tab.url;
      capture(token);
    } catch (e) { if (!left && token === generation) failure(e); }
  }
  function input(data) {
    if (!view || left || !online() || document.visibilityState === "hidden" || queued >= 16) return Promise.resolve(false);
    const id = view, token = generation;
    queued++;
    const sent = queue.then(async () => {
      if (left || view !== id || token !== generation || document.visibilityState === "hidden") return false;
      try { await call("input", { ...data, view: id }); return true; }
      catch (e) { if (view === id && token === generation) failure(e); return false; }
    });
    queue = sent.finally(() => { queued--; });
    return sent;
  }
  el.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.act === "refresh-tabs" || b.dataset.act === "tabs") return refreshTabs();
    if (b.dataset.act === "zoom") { zoom = zoom === 1 ? 2 : zoom === 2 ? 3 : 1; sizeImage(); return; }
    if (b.dataset.tab) return openTab(b.dataset.browser, b.dataset.tab);
    if (b.dataset.newBrowser) {
      const url = await ctx.prompt(t("browser.newAddress"), "https://", t("browser.go"));
      if (!url || left) return;
      try { const tab = await call("open", { browser: b.dataset.newBrowser, url }); openTab(b.dataset.newBrowser, tab.id); }
      catch (e) { ctx.fail(e); }
    } else if (b.dataset.browserAction) input({ action: b.dataset.browserAction });
    else if (b.dataset.browserKey) input({ action: "key", key: b.dataset.browserKey });
    else if (b.dataset.act === "show-text") {
      field.type = field.type === "password" ? "text" : "password";
      b.setAttribute("aria-pressed", String(field.type === "text"));
    }
  });
  el.querySelector(".browser-address").onsubmit = e => { e.preventDefault(); input({ action: "navigate", url: address.value }); address.blur(); };
  el.querySelector(".browser-type").onsubmit = async e => {
    e.preventDefault();
    if (!field.value) return;
    const value = field.value;
    if (await input({ action: "text", text: value }) && field.value === value) field.value = "";
  };
  const point = e => imagePoint(image.getBoundingClientRect(), e.clientX, e.clientY);
  image.addEventListener("pointerdown", e => {
    if (!lastFrame || painting) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    image.setPointerCapture(e.pointerId);
    if (pointers.size > 1) {
      const points = [...pointers.values()];
      gesture = null;
      pan = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2, left: canvas.scrollLeft, top: canvas.scrollTop };
      e.preventDefault(); return;
    }
    const pos = point(e);
    if (!pos) return;
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, pos, width: lastFrame.width, height: lastFrame.height };
    e.preventDefault();
  });
  image.addEventListener("pointermove", e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pan || pointers.size < 2) return;
    const points = [...pointers.values()];
    canvas.scrollLeft = pan.left + pan.x - (points[0].x + points[1].x) / 2;
    canvas.scrollTop = pan.top + pan.y - (points[0].y + points[1].y) / 2;
  });
  image.addEventListener("pointerup", e => {
    pointers.delete(e.pointerId);
    if (pan) { if (!pointers.size) pan = null; return; }
    if (!gesture || e.pointerId !== gesture.id) return;
    const start = gesture;
    gesture = null;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) < 10) input({ action: "click", ...start.pos });
    else {
      const rect = image.getBoundingClientRect();
      input({ action: "scroll", ...start.pos, dx: Math.max(-3000, Math.min(3000, -dx * start.width / rect.width)), dy: Math.max(-3000, Math.min(3000, -dy * start.height / rect.height)) });
    }
  });
  image.addEventListener("pointercancel", () => { gesture = null; pan = null; pointers.clear(); });
  image.addEventListener("wheel", e => {
    if (!lastFrame) return;
    e.preventDefault();
    const pos = point(e);
    if (pos) input({ action: "scroll", ...pos, dy: Math.max(-3000, Math.min(3000, e.deltaY)), dx: Math.max(-3000, Math.min(3000, e.deltaX)) });
  }, { passive: false });
  const offLink = provider.on("link", ({ node, up }) => {
    if (node !== p.node || up || left) return;
    detach();
    state(`${errorText("offline")} ${t("browser.reopen")}`);
  });
  const visibility = () => {
    // Detach on background, clearing the picture and password immediately; resuming starts from the tab list.
    if (document.visibilityState === "hidden") { detach(); state(t("browser.reopen")); }
    else if (!left && !loading) refreshTabs();
  };
  document.addEventListener("visibilitychange", visibility);
  refreshTabs();
  return () => { left = true; detach(); offLink(); resized.disconnect(); document.removeEventListener("visibilitychange", visibility); };
}
