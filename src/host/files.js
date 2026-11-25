// The files of this computer for a paired one that may control it (mesh/serve.js "files.*"; docs/FILES.md): folders
// listed a page at a time, a file read a piece at a time, folders made, things renamed, copied, moved and deleted, and
// files taken from the other side a piece at a time. The same for the desktop's own side of its two panes, called
// without a link (peer "").
//
// Nothing is ever written over: a copy, a move across volumes and an upload whose name is taken get "name (2)", a
// rename and a new folder answer `exists` (the one asking offers "name (2)"). What is being written carries
// PART at its end and gets its name only when it is whole.
//
// A path is the other side's typing: a whole path of this computer, "~" for the home. "" is the list of roots (the
// drives on Windows, "/" elsewhere). A volume's root is neither copied, moved nor deleted, and the home is not deleted.
//
// Copying a folder follows the links in it, as the system's file manager does - but not one to a volume's root or to
// a folder it is already inside (counted in `skipped`), so a link never copies a whole disk or goes round for ever.
//
// Errors are HostError codes the other side translates: invalidData, folderNotAbsolute, fileMissing, notFile,
// notFolder, exists, fileDenied, changed, crossDevice, rootRefused, intoItself, tooManyJobs, jobMissing, diskFull,
// fileFailed.
//
// createFiles({ home, trash, notify }) - trash(path): moves it to the system's bin (a promise), absent on a host
// without one: there a delete is for good; notify(peer, name, data): an event to that peer ("files.job" when a copy
// ends).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { HostError } = require("./errors");
const { readAt } = require("./file-chunks");

const fsp = fs.promises;
const MAX_PATH = 4096;
const PAGE = 500;                      // entries in one files.list
const CHUNK = 256 * 1024;              // bytes in one files.read / files.write (docs/FILES.md 3.3)
const COPY_CHUNK = 1024 * 1024;
const MAX_JOBS = 2, MAX_UPLOADS = 2;   // per peer
const UPLOAD_IDLE_MS = 10 * 60 * 1000;
const JOB_KEEP_MS = 10 * 60 * 1000;    // a finished job can be asked about this long
const MAX_SIZE = 2 ** 40;              // an upload's size: a sanity bound, not a quota
const PART = ".agentdeck-part";
const ERRNO = {
  ENOENT: "fileMissing", EACCES: "fileDenied", EPERM: "fileDenied", EBUSY: "fileDenied", EEXIST: "exists",
  ENOTEMPTY: "exists", ENOSPC: "diskFull", EXDEV: "crossDevice", ENOTDIR: "notFolder", EISDIR: "notFile"
};

const fail = (code, message) => { throw new HostError(code, message); };
// What the file system said, as a code of ours.
function failed(e) {
  if (e instanceof HostError) throw e;
  throw new HostError(ERRNO[e?.code] || "fileFailed", ERRNO[e?.code] ? undefined : String(e?.message || e));
}
const int = (v, min, max) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail("invalidData");
  return v;
};
const isRoot = p => path.parse(p).root === p;
const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
// b is a or inside it.
const inside = (a, b) => same(a, b) || (process.platform === "win32" ? b.toLowerCase() : b).startsWith((process.platform === "win32" ? a.toLowerCase() : a) + (a.endsWith(path.sep) ? "" : path.sep));
const lstat = p => fsp.lstat(p).catch(() => null);

// "name.ext" -> "name (2).ext", "name (3).ext"...; a folder's name has no extension to keep.
function numbered(file, n, dir) {
  const ext = dir ? "" : path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)} (${n})${ext}`);
}
// file when nothing has that name, else the first numbered name that is free.
async function freeName(file, dir) {
  if (!(await lstat(file)) && !(await lstat(file + PART))) return file;
  for (let n = 2; n < 1000; n++) {
    const next = numbered(file, n, dir);
    if (!(await lstat(next)) && !(await lstat(next + PART))) return next;
  }
  return fail("exists");
}

function createFiles({ home = "", trash = null, notify = () => {} } = {}) {
  const jobs = new Map();     // id -> job
  const uploads = new Map();  // id -> upload

  // ---------- paths ----------
  // The other side's path, whole and tidied. Nothing is looked at on the disk.
  function whole(input) {
    if (typeof input !== "string" || input.length > MAX_PATH || input.includes("\0")) fail("invalidData");
    const typed = input.trim();
    if (!typed) fail("invalidData");
    const tilde = typed === "~" || typed.startsWith("~/") || typed.startsWith("~\\");
    if (tilde && !home) fail("fileMissing");
    const full = tilde ? path.join(home, typed.slice(2)) : typed;
    if (!path.isAbsolute(full)) fail("folderNotAbsolute");
    return path.resolve(full);
  }
  // The folder a new thing goes into: it must be one.
  async function folderOf(file) {
    const parent = path.dirname(file);
    const st = await fsp.stat(parent).catch(() => null);
    if (!st) fail("folderMissing");
    if (!st.isDirectory()) fail("notFolder");
    return parent;
  }
  async function roots() {
    if (process.platform !== "win32") return ["/"];
    const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(l => `${l}:\\`);
    const there = await Promise.all(letters.map(r => fsp.stat(r).then(() => true, () => false)));
    return letters.filter((_, i) => there[i]);
  }

  // ---------- reading ----------
  // One entry as the other side sees it. A link says what it leads to (dir, size), and that it is a link.
  async function entry(file, name = path.basename(file) || file) {
    const own = await fsp.lstat(file).catch(failed);
    const link = own.isSymbolicLink();
    const st = link ? await fsp.stat(file).catch(() => own) : own;
    return { name, dir: st.isDirectory(), link, size: st.isFile() ? st.size : 0, mtime: Math.round(st.mtimeMs) };
  }
  const order = (a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  // {path, after?, limit?} -> { path, parent, sep, home, entries, next }: folders first, then by name; `next` is
  // given back as `after` for the page that follows ("" when this was the last). parent: "" above a root (the roots
  // themselves), null for the roots.
  async function list(p) {
    const limit = p?.limit === undefined ? PAGE : int(p.limit, 1, PAGE);
    if (p?.path === "" || p?.path === undefined) {
      const entries = (await roots()).map(name => ({ name, dir: true, link: false, size: 0, mtime: 0 }));
      return { path: "", parent: null, sep: path.sep, home, entries, next: "" };
    }
    const dir = whole(p.path);
    const after = p?.after === undefined || p.after === "" ? null : String(p.after).slice(0, 600);
    const found = await fsp.readdir(dir, { withFileTypes: true }).catch(failed);
    const all = await Promise.all(found.map(async d => {
      // Whether a link leads to a folder decides where it is sorted; only links are looked at for it.
      const isDir = d.isSymbolicLink() ? await fsp.stat(path.join(dir, d.name)).then(s => s.isDirectory(), () => false) : d.isDirectory();
      return { name: d.name, dir: isDir, key: d.name.toLowerCase() };
    }));
    all.sort(order);
    let from = 0;
    if (after !== null) {
      const cut = { dir: after[0] === "d", name: after.slice(1), key: after.slice(1).toLowerCase() };
      from = all.findIndex(x => order(x, cut) > 0);
      if (from < 0) from = all.length;
    }
    const page = all.slice(from, from + limit);
    // One that went between the listing and the look at it is left out.
    const entries = (await Promise.all(page.map(x => entry(path.join(dir, x.name), x.name).catch(() => null)))).filter(Boolean);
    const last = page[page.length - 1];
    return {
      path: dir, parent: isRoot(dir) ? "" : path.dirname(dir), sep: path.sep, home, entries,
      next: from + limit < all.length && last ? (last.dir ? "d" : "f") + last.name : ""
    };
  }
  const stat = async p => { const file = whole(p?.path); return { path: file, ...(await entry(file)) }; };

  // {path, pos, len, size?, mtime?} -> { data (base64), size, mtime, eof }. With the size and time a first piece
  // answered, a file that is no longer that one is refused (`changed`): its pieces must not be put together.
  async function read(p) {
    const file = whole(p?.path), pos = int(p?.pos, 0, MAX_SIZE), len = int(p?.len, 1, CHUNK);
    const fh = await fsp.open(file, "r").catch(failed);
    try {
      const st = await fh.stat();
      if (!st.isFile()) fail(st.isDirectory() ? "notFile" : "fileDenied");
      const size = st.size, mtime = Math.round(st.mtimeMs);
      if ((p.size !== undefined && p.size !== size) || (p.mtime !== undefined && p.mtime !== mtime)) fail("changed");
      const buf = pos < size ? await readAt(fh, pos, Math.min(len, size - pos)) : Buffer.alloc(0);
      return { data: buf.toString("base64"), size, mtime, eof: pos + buf.length >= size };
    } catch (e) { return failed(e); } finally { await fh.close().catch(() => {}); }
  }

  // ---------- changing ----------
  // {path, keep?} -> { path }: one new folder in a folder that is there.
  async function mkdir(p) {
    let dir = whole(p?.path);
    await folderOf(dir);
    for (let n = 2; ; n++) {
      try { await fsp.mkdir(dir); return { path: dir }; } catch (e) {
        if (e?.code !== "EEXIST" || !p?.keep || n >= 1000) failed(e);
        dir = numbered(whole(p.path), n, true);
      }
    }
  }
  // {from, to} -> { path }: a new name, or another folder of the same volume.
  async function rename(p) {
    const from = whole(p?.from), to = whole(p?.to);
    if (isRoot(from)) fail("rootRefused");
    const st = await fsp.lstat(from).catch(failed);
    if (st.isDirectory() && !same(from, to) && inside(from, to)) fail("intoItself");
    await folderOf(to);
    // Only a change of letters' case leads to the same file where names are told apart without it.
    if (await lstat(to) && !(same(from, to) && from !== to)) fail("exists");
    await fsp.rename(from, to).catch(failed);
    return { path: to };
  }
  // {path} -> { trashed }: into the bin where this computer has one, else for good. A link goes, not what it leads to.
  async function remove(p) {
    const file = whole(p?.path);
    if (isRoot(file) || (home && same(file, path.resolve(home)))) fail("rootRefused");
    await fsp.lstat(file).catch(failed);
    if (trash) {
      await Promise.resolve().then(() => trash(file)).catch(e => fail("fileFailed", String(e?.message || e)));
      return { trashed: true };
    }
    await fsp.rm(file, { recursive: true }).catch(failed);
    return { trashed: false };
  }

  // ---------- copies ----------
  const jobOut = j => ({ job: j.id, state: j.state, to: j.to, move: j.move, files: j.files, bytes: j.bytes, total: j.total, skipped: j.skipped, error: j.error });
  const stopped = j => { if (j.cancel) fail("cancelled"); };
  // What a tree holds, following its links as the copy will: the bytes, for the progress.
  async function measure(j, src, chain) {
    stopped(j);
    const st = await fsp.stat(src).catch(() => null);
    if (!st) return;
    if (st.isFile()) { j.total += st.size; return; }
    if (!st.isDirectory()) return;
    const real = await fsp.realpath(src).catch(() => src);
    if (isRoot(real) || chain.some(x => same(x, real))) return;
    for (const name of await fsp.readdir(src).catch(() => [])) await measure(j, path.join(src, name), [...chain, real]);
  }
  async function copyFile(j, src, dst) {
    const part = dst + PART;
    const [from, to] = await Promise.all([fsp.open(src, "r"), fsp.open(part, "w")]).catch(failed);
    try {
      for (let pos = 0; ;) {
        stopped(j);
        const buf = await readAt(from, pos, COPY_CHUNK);
        if (!buf.length) break;
        await to.write(buf, 0, buf.length, pos);
        pos += buf.length;
        j.bytes += buf.length;
      }
    } catch (e) {
      await Promise.all([from.close(), to.close()].map(x => x.catch(() => {})));
      await fsp.rm(part, { force: true }).catch(() => {});
      return failed(e);
    }
    await Promise.all([from.close(), to.close()]);
    await fsp.rename(part, dst).catch(failed);
    j.files++;
  }
  async function copyTree(j, src, dst, chain) {
    stopped(j);
    const st = await fsp.stat(src).catch(() => null);
    if (!st) { j.skipped++; return; }                     // a link that leads nowhere, or one that went meanwhile
    if (st.isFile()) return copyFile(j, src, dst);
    if (!st.isDirectory()) { j.skipped++; return; }
    const real = await fsp.realpath(src).catch(() => src);
    if (isRoot(real) || chain.some(x => same(x, real))) { j.skipped++; return; }
    await fsp.mkdir(dst).catch(failed);
    for (const name of await fsp.readdir(src).catch(failed)) await copyTree(j, path.join(src, name), path.join(dst, name), [...chain, real]);
  }
  async function runJob(j) {
    try {
      await measure(j, j.from, []);
      await copyTree(j, j.from, j.to, []);
      if (j.move) {
        stopped(j);
        await fsp.rm(j.from, { recursive: true }).catch(failed);
      }
      j.state = "done";
    } catch (e) {
      j.state = j.cancel ? "cancelled" : "failed";
      j.error = j.cancel ? "" : e?.code || "fileFailed";
      // The name was free when the job began, so all that is there is the job's own.
      await fsp.rm(j.to, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(j.to + PART, { force: true }).catch(() => {});
    }
    j.done = true;
    try { notify(j.peer, "files.job", jobOut(j)); } catch {}
    setTimeout(() => jobs.delete(j.id), JOB_KEEP_MS).unref?.();
  }
  // {from, to, move?} -> the job, begun: a file or a folder with all in it, to a name that is free.
  async function copy(peer, p) {
    const from = whole(p?.from), wanted = whole(p?.to);
    if (isRoot(from)) fail("rootRefused");
    const st = await fsp.stat(from).catch(failed);
    // Beside itself is not into itself: a folder copied where it is gets the numbered name.
    if (st.isDirectory() && !same(from, wanted) && inside(from, wanted)) fail("intoItself");
    await folderOf(wanted);
    if ([...jobs.values()].filter(x => x.peer === peer && !x.done).length >= MAX_JOBS) fail("tooManyJobs");
    const to = await freeName(wanted, st.isDirectory());
    const j = { id: crypto.randomUUID(), peer, from, to, move: Boolean(p?.move), state: "running", files: 0, bytes: 0, total: 0, skipped: 0, error: "", cancel: false, done: false };
    jobs.set(j.id, j);
    j.run = runJob(j);
    return jobOut(j);
  }
  function jobOf(peer, id) {
    const j = typeof id === "string" ? jobs.get(id) : null;
    if (!j || j.peer !== peer) fail("jobMissing");
    return j;
  }
  const job = async (peer, p) => jobOut(jobOf(peer, p?.job));
  async function cancel(peer, p) {
    const j = jobOf(peer, p?.job);
    if (!j.done) { j.cancel = true; await j.run; }
    return jobOut(j);
  }

  // ---------- uploads ----------
  function uploadOf(peer, id) {
    const u = typeof id === "string" ? uploads.get(id) : null;
    if (!u || u.peer !== peer) fail("jobMissing");
    return u;
  }
  async function drop(u) {
    if (!uploads.delete(u.id)) return;
    clearTimeout(u.timer);
    await u.busy.catch(() => {});
    await u.fh.close().catch(() => {});
    await fsp.rm(u.part, { force: true }).catch(() => {});
  }
  const touch = u => { clearTimeout(u.timer); u.timer = setTimeout(() => drop(u), UPLOAD_IDLE_MS); u.timer.unref?.(); };
  // {path, size} -> { upload, path }: a file of that many bytes is coming; the path is the name it will get.
  async function begin(peer, p) {
    const wanted = whole(p?.path), size = int(p?.size, 0, MAX_SIZE);
    await folderOf(wanted);
    if ([...uploads.values()].filter(x => x.peer === peer).length >= MAX_UPLOADS) fail("tooManyJobs");
    const file = await freeName(wanted, false);
    const fh = await fsp.open(file + PART, "wx").catch(failed);
    const u = { id: crypto.randomUUID(), peer, file, part: file + PART, fh, size, written: 0, busy: Promise.resolve(), writing: false };
    uploads.set(u.id, u);
    touch(u);
    return { upload: u.id, path: file };
  }
  // {upload, pos, data (base64)} -> { written }: the next piece; pos is where the last one ended.
  async function write(peer, p) {
    const u = uploadOf(peer, p?.upload);
    if (typeof p?.data !== "string" || p.data.length > Math.ceil(CHUNK * 4 / 3) + 4) fail("tooBig");
    const buf = Buffer.from(p.data, "base64");
    if (u.writing || !buf.length || buf.length > CHUNK || p.pos !== u.written || u.written + buf.length > u.size) fail("invalidData");
    u.writing = true;
    u.busy = u.fh.write(buf, 0, buf.length, u.written);
    try { await u.busy; } catch (e) { await drop(u); return failed(e); } finally { u.writing = false; }
    u.written += buf.length;
    touch(u);
    return { written: u.written };
  }
  // {upload} -> { path }: all of it came; the file gets its name.
  async function commit(peer, p) {
    const u = uploadOf(peer, p?.upload);
    if (u.writing || u.written !== u.size) fail("invalidData");
    uploads.delete(u.id);
    clearTimeout(u.timer);
    await u.fh.close().catch(() => {});
    try {
      // A name taken since the upload began is not written over either.
      if (await lstat(u.file)) u.file = await freeName(u.file, false);
      await fsp.rename(u.part, u.file);
    } catch (e) {
      await fsp.rm(u.part, { force: true }).catch(() => {});
      return failed(e);
    }
    return { path: u.file };
  }
  async function abort(peer, p) { await drop(uploadOf(peer, p?.upload)); return true; }

  // A link that dropped: what that peer was sending is left unfinished and goes. Its copies go on (docs/FILES.md 3.5).
  const dropPeer = peer => Promise.all([...uploads.values()].filter(u => u.peer === peer).map(drop));
  async function dispose() {
    for (const j of jobs.values()) j.cancel = true;
    await Promise.all([...jobs.values()].map(j => j.run));
    await Promise.all([...uploads.values()].map(drop));
  }

  return { list, stat, read, mkdir, rename, remove, copy, job, cancel, begin, write, commit, abort, drop: dropPeer, dispose, hasTrash: Boolean(trash) };
}

module.exports = { createFiles, CHUNK, PAGE, PART };
