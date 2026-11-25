// The files of a computer for a paired one (src/host/files.js, docs/FILES.md): what must never happen is a file
// written over, a file put together from two versions, an unfinished file under its real name, a copy that never
// ends, and a drive or the home deleted. First the module by itself in a temporary folder (with a home that is a
// temporary folder too - nothing here can reach the real one), then the same through a real phone, relay and host.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createFiles, CHUNK, PAGE, PART } = require("../src/host/files");
const { withPhone, waitFor } = require("./browser-test-rig");

const code = c => ({ code: c });
const b64 = b => b.toString("base64");
async function tree(dir) {
  const out = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(d.name + "/", ...(await tree(p)).map(x => d.name + "/" + x));
    else out.push(d.name);
  }
  return out.sort();
}
async function finished(files, peer, job) {
  let j;
  await waitFor(async () => { j = await files.job(peer, { job }); return j.state !== "running"; }, "the copy ends");
  return j;
}

async function alone(root) {
  const home = path.join(root, "home"), work = path.join(root, "work");
  await fsp.mkdir(home); await fsp.mkdir(work);
  const events = [];
  const files = createFiles({ home, notify: (peer, name, data) => events.push({ peer, name, data }) });
  const at = (...p) => path.join(work, ...p);

  // ---------- paths ----------
  for (const bad of [undefined, "", "   ", 5, "a\0b", "x".repeat(5000)]) await assert.rejects(files.stat({ path: bad }), code("invalidData"));
  await assert.rejects(files.stat({ path: "relative/one" }), code("folderNotAbsolute"));
  await assert.rejects(files.stat({ path: at("nothing") }), code("fileMissing"));
  assert.equal((await files.stat({ path: "~" })).path, home);
  assert.equal((await files.stat({ path: at("sub", "..") })).path, work, "a path is tidied, and means what it says");
  const roots = await files.list({ path: "" });
  assert.equal(roots.parent, null);
  assert.ok(roots.entries.length && roots.entries.every(e => e.dir), "the roots are folders");
  assert.ok(roots.entries.some(e => path.parse(work).root.toLowerCase() === e.name.toLowerCase()), "the drive of the test is among them");
  assert.equal((await files.list({ path: path.parse(work).root, limit: 1 })).parent, "", "above a root are the roots");
  console.log("ok: paths - whole only, tidied, the home, the roots");

  // ---------- a long folder, a page at a time ----------
  const many = at("many");
  await fsp.mkdir(many);
  const names = [];
  for (let i = 0; i < 1200; i++) names.push(i % 10 === 0 ? `Dir-${i}` : i % 7 === 0 ? `.hidden-${i}` : `file-${i}.txt`);
  await Promise.all(names.map(n => (n.startsWith("Dir") ? fsp.mkdir(path.join(many, n)) : fsp.writeFile(path.join(many, n), n))));
  const seen = [];
  let pages = 0;
  for (let after; ;) {
    const page = await files.list({ path: many, after });
    assert.ok(page.entries.length <= PAGE);
    seen.push(...page.entries);
    pages++;
    if (!page.next) break;
    after = page.next;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen.map(e => e.name).sort(), [...names].sort(), "every entry once, the hidden ones too");
  const firstFile = seen.findIndex(e => !e.dir);
  assert.ok(seen.slice(0, firstFile).every(e => e.dir) && seen.slice(firstFile).every(e => !e.dir), "folders first");
  assert.equal(seen.find(e => e.name === "file-1.txt").size, 10);
  await assert.rejects(files.list({ path: at("many", "file-1.txt") }), code("notFolder"));
  await assert.rejects(files.list({ path: many, limit: PAGE + 1 }), code("invalidData"));
  console.log("ok: 1200 entries in three pages, none twice, none left out");

  // ---------- reading a piece at a time ----------
  const big = crypto.randomBytes(5 * 1024 * 1024 + 123);
  await fsp.writeFile(at("big.bin"), big);
  const got = [];
  let first;
  for (let pos = 0; ;) {
    const r = await files.read({ path: at("big.bin"), pos, len: CHUNK, size: first?.size, mtime: first?.mtime });
    first ||= r;
    const piece = Buffer.from(r.data, "base64");
    got.push(piece);
    pos += piece.length;
    if (r.eof) break;
    assert.equal(piece.length, CHUNK);
  }
  assert.ok(Buffer.concat(got).equals(big), "the pieces are the file");
  await assert.rejects(files.read({ path: at("big.bin"), pos: 0, len: CHUNK + 1 }), code("invalidData"));
  await assert.rejects(files.read({ path: many, pos: 0, len: 10 }), code("notFile"));
  assert.deepEqual({ ...(await files.read({ path: at("big.bin"), pos: big.length, len: 10 })), size: 0, mtime: 0 }, { data: "", size: 0, mtime: 0, eof: true });
  await fsp.appendFile(at("big.bin"), "more");
  await assert.rejects(files.read({ path: at("big.bin"), pos: CHUNK, len: CHUNK, size: first.size, mtime: first.mtime }), code("changed"));
  console.log("ok: 5 MB read in pieces is the same bytes; a file that changed meanwhile is refused");

  // ---------- new folders and names ----------
  assert.equal((await files.mkdir({ path: at("new") })).path, at("new"));
  await assert.rejects(files.mkdir({ path: at("new") }), code("exists"));
  assert.equal((await files.mkdir({ path: at("new"), keep: true })).path, at("new (2)"));
  assert.equal((await files.mkdir({ path: at("new"), keep: true })).path, at("new (3)"));
  await assert.rejects(files.mkdir({ path: at("no", "such", "parent") }), code("folderMissing"));
  await fsp.writeFile(at("a.txt"), "A"); await fsp.writeFile(at("b.txt"), "B");
  await assert.rejects(files.rename({ from: at("a.txt"), to: at("b.txt") }), code("exists"));
  assert.equal(await fsp.readFile(at("b.txt"), "utf8"), "B", "nothing was written over");
  await files.rename({ from: at("a.txt"), to: at("new", "moved.txt") });
  assert.equal(await fsp.readFile(at("new", "moved.txt"), "utf8"), "A");
  await assert.rejects(files.rename({ from: at("new"), to: at("new", "inside") }), code("intoItself"));
  await assert.rejects(files.rename({ from: path.parse(work).root, to: at("drive") }), code("rootRefused"));
  console.log("ok: a new folder, a rename, a move - a taken name is refused or numbered, never written over");

  // ---------- copying a tree ----------
  const src = at("src");
  await fsp.mkdir(path.join(src, "deep", "er"), { recursive: true });
  await fsp.writeFile(path.join(src, "one.txt"), "1");
  await fsp.writeFile(path.join(src, "deep", "two.bin"), crypto.randomBytes(3 * 1024 * 1024));
  await fsp.writeFile(path.join(src, "deep", "er", ".three"), "3");
  let links = false;
  try {
    await fsp.symlink(src, path.join(src, "deep", "up"), "junction");          // a link to a folder it is inside
    await fsp.symlink(path.parse(src).root, path.join(src, "drive"), "junction"); // a link to the whole drive
    links = true;
  } catch { console.log("   (no links can be made here: the link checks are left out)"); }
  const before = (await tree(src)).filter(x => !x.startsWith("deep/up") && !x.startsWith("drive"));
  const c1 = await files.copy("A", { from: src, to: at("copy") });
  assert.equal(c1.to, at("copy"));
  const d1 = await finished(files, "A", c1.job);
  assert.equal(d1.state, "done", d1.error);
  assert.deepEqual(await tree(at("copy")), before, "the same tree, without what the links would have brought");
  assert.equal(d1.files, 3); assert.equal(d1.bytes, d1.total);
  if (links) assert.equal(d1.skipped, 2, "the link to its own parent and the link to the drive were not gone into");
  assert.ok(Buffer.compare(await fsp.readFile(at("copy", "deep", "two.bin")), await fsp.readFile(path.join(src, "deep", "two.bin"))) === 0);
  assert.deepEqual(events.map(e => [e.peer, e.name, e.data.state]), [["A", "files.job", "done"]], "its end is told to the one that began it");
  const c2 = await files.copy("A", { from: src, to: at("copy") });
  assert.equal(c2.to, at("copy (2)"), "a taken name is numbered");
  assert.equal((await finished(files, "A", c2.job)).state, "done");
  const c3 = await files.copy("A", { from: path.join(src, "one.txt"), to: at("copy", "one.txt") });
  assert.equal(c3.to, at("copy", "one (2).txt"), "a file keeps its extension");
  await finished(files, "A", c3.job);
  await assert.rejects(files.copy("A", { from: src, to: path.join(src, "deep", "again") }), code("intoItself"));
  const beside = await files.copy("A", { from: at("copy"), to: at("copy") });
  assert.equal(beside.to, at("copy (3)"), "a folder copied where it is gets a numbered name, as a file does");
  assert.equal((await finished(files, "A", beside.job)).state, "done");
  await files.remove({ path: at("copy (3)") });
  await assert.rejects(files.copy("A", { from: path.parse(src).root, to: at("drive-copy") }), code("rootRefused"));
  await assert.rejects(files.job("B", { job: c1.job }), code("jobMissing"), "a job is its peer's");
  assert.ok(!(await tree(work)).some(x => x.endsWith(PART)), "no unfinished file is left");
  console.log("ok: a tree copied whole, numbered beside a taken name, never into itself, a link never followed round");

  // ---------- a move across "volumes" is a copy and then the source goes ----------
  const m = await files.copy("A", { from: at("copy (2)"), to: at("moved"), move: true });
  assert.equal((await finished(files, "A", m.job)).state, "done");
  assert.deepEqual(await tree(at("moved")), before);
  assert.equal(fs.existsSync(at("copy (2)")), false);

  // ---------- a copy stopped ----------
  const heavy = at("heavy");
  await fsp.mkdir(heavy);
  for (let i = 0; i < 40; i++) await fsp.writeFile(path.join(heavy, `f${i}.bin`), Buffer.alloc(2 * 1024 * 1024, i));
  const c4 = await files.copy("A", { from: heavy, to: at("heavy-copy") });
  const c5 = await files.copy("A", { from: heavy, to: at("heavy-copy-b") });
  await assert.rejects(files.copy("A", { from: heavy, to: at("heavy-copy-c") }), code("tooManyJobs"));
  const stoppedJob = await files.cancel("A", { job: c4.job });
  assert.equal(stoppedJob.state, "cancelled");
  assert.equal(fs.existsSync(at("heavy-copy")), false, "a stopped copy leaves nothing where it was going");
  assert.equal((await tree(heavy)).length, 40, "and its source as it was");
  await files.cancel("A", { job: c5.job });
  console.log("ok: a stopped copy leaves nothing behind and does not touch its source; two at a time for a peer");

  // ---------- an upload ----------
  const body = crypto.randomBytes(CHUNK * 2 + 77);
  const up = await files.begin("A", { path: at("b.txt"), size: body.length });
  assert.equal(up.path, at("b (2).txt"), "a taken name is numbered");
  assert.equal(fs.existsSync(at("b (2).txt")), false, "it has no name until it is whole");
  await assert.rejects(files.write("A", { upload: up.upload, pos: 5, data: b64(body.subarray(0, 10)) }), code("invalidData"));
  await assert.rejects(files.write("B", { upload: up.upload, pos: 0, data: b64(body.subarray(0, 10)) }), code("jobMissing"));
  for (let pos = 0; pos < body.length; pos += CHUNK) await files.write("A", { upload: up.upload, pos, data: b64(body.subarray(pos, pos + CHUNK)) });
  assert.equal((await files.commit("A", { upload: up.upload })).path, at("b (2).txt"));
  assert.ok((await fsp.readFile(at("b (2).txt"))).equals(body));
  assert.equal(await fsp.readFile(at("b.txt"), "utf8"), "B");
  const short = await files.begin("A", { path: at("short.bin"), size: 100 });
  await files.write("A", { upload: short.upload, pos: 0, data: b64(Buffer.alloc(40)) });
  await assert.rejects(files.commit("A", { upload: short.upload }), code("invalidData"), "a file that is not whole is not named");
  await assert.rejects(files.write("A", { upload: short.upload, pos: 40, data: b64(Buffer.alloc(61)) }), code("invalidData"), "nor one longer than was said");
  const other = await files.begin("A", { path: at("other.bin"), size: 5 });
  await assert.rejects(files.begin("A", { path: at("third.bin"), size: 5 }), code("tooManyJobs"));
  await files.drop("A");                                            // the link dropped
  await assert.rejects(files.write("A", { upload: other.upload, pos: 0, data: b64(Buffer.alloc(5)) }), code("jobMissing"));
  assert.ok(!(await tree(work)).some(x => x.endsWith(PART) || x === "short.bin" || x === "other.bin"), "a dropped link leaves no unfinished file");
  console.log("ok: an upload is named only when whole; a dropped link takes its unfinished files");

  // ---------- deleting ----------
  await assert.rejects(files.remove({ path: path.parse(work).root }), code("rootRefused"));
  await assert.rejects(files.remove({ path: "~" }), code("rootRefused"));
  await assert.rejects(files.remove({ path: home }), code("rootRefused"));
  assert.equal(fs.existsSync(home), true);
  await assert.rejects(files.remove({ path: at("nothing") }), code("fileMissing"));
  assert.deepEqual(await files.remove({ path: at("moved") }), { trashed: false });
  assert.equal(fs.existsSync(at("moved")), false);
  if (links) {
    await files.remove({ path: path.join(src, "deep", "up") });
    assert.equal(fs.existsSync(path.join(src, "one.txt")), true, "a link goes, not what it leads to");
  }
  const binned = [];
  const withBin = createFiles({ home, trash: async f => { binned.push(f); } });
  assert.deepEqual(await withBin.remove({ path: at("b.txt") }), { trashed: true });
  assert.deepEqual(binned, [at("b.txt")]);
  assert.equal(fs.existsSync(at("b.txt")), true, "with a bin the file is the bin's to take");
  const noBin = createFiles({ home, trash: async () => { throw new Error("no bin on this drive"); } });
  await assert.rejects(noBin.remove({ path: at("b.txt") }), code("fileFailed"));
  assert.equal(fs.existsSync(at("b.txt")), true, "a bin that refuses is not a reason to delete for good");
  console.log("ok: a drive and the home are never deleted; the bin where there is one, and never past a bin that refused");
  await files.dispose();
}

// A real phone -> relay -> host: the methods are served, to a peer with control only, and a 1 MB file comes whole.
async function served(root) {
  const work = path.join(root, "served");
  await fsp.mkdir(work);
  const body = crypto.randomBytes(1024 * 1024 + 5);
  await fsp.writeFile(path.join(work, "app.apk"), body);
  const browser = { dispose() {}, drop() {} };
  await withPhone(browser, async ({ call, phone, host, node }) => {
    const info = await phone.request(host.self().id, "host.info", {});
    assert.equal(info.files, 1); assert.equal(info.trash, 0);
    const listed = await call("files.list", { path: work });
    assert.deepEqual(listed.entries.map(e => [e.name, e.size]), [["app.apk", body.length]]);
    const got = [];
    let first;
    for (let pos = 0; ;) {
      const r = await call("files.read", { path: path.join(work, "app.apk"), pos, len: CHUNK, size: first?.size, mtime: first?.mtime });
      first ||= r;
      got.push(Buffer.from(r.data, "base64"));
      pos += got.at(-1).length;
      if (r.eof) break;
    }
    assert.ok(Buffer.concat(got).equals(body), "through the relay the pieces are the file");
    const up = await call("files.begin", { path: path.join(work, "from-phone.bin"), size: body.length });
    for (let pos = 0; pos < body.length; pos += CHUNK) await call("files.write", { upload: up.upload, pos, data: b64(body.subarray(pos, pos + CHUNK)) });
    await call("files.commit", { upload: up.upload });
    assert.ok((await fsp.readFile(path.join(work, "from-phone.bin"))).equals(body));
    await assert.rejects(call("files.read", { path: path.join(work, "gone"), pos: 0, len: 10 }), code("fileMissing"));
    await call("files.mkdir", { path: path.join(work, "made") });
    await call("files.rename", { from: path.join(work, "made"), to: path.join(work, "named") });
    const job = await call("files.copy", { from: path.join(work, "named"), to: path.join(work, "copied") });
    await waitFor(async () => (await call("files.job", { job: job.job })).state === "done", "the copy ends on the host");
    assert.deepEqual(await call("files.delete", { path: path.join(work, "copied") }), { trashed: false });
    assert.equal(fs.existsSync(path.join(work, "copied")), false);

    // An upload left unfinished goes with the phone's link.
    const left = await call("files.begin", { path: path.join(work, "left.bin"), size: 10 });
    assert.equal(fs.existsSync(left.path + PART), true);
    phone.stop();
    await waitFor(() => !fs.existsSync(left.path + PART), "the unfinished upload goes with the link");

    // A host that only holds resources is paired, and is not served the files.
    const resource = await node("resource", { kind: "host" });
    await resource.pair("127.0.0.1", host.self().port, host.self().code);
    await waitFor(() => resource.online(host.self().id), "resource host -> desktop");
    await assert.rejects(resource.call(host.self().id, "files.list", { path: work }));
  }, { host: { home: path.join(root, "home") } });
  console.log("ok: real phone -> relay -> host: listed, read whole, uploaded, changed; cleaned up with the link; refused to a resource host");
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentdeck-files-"));
  try {
    await alone(root);
    await served(root);
    console.log("files: all checks passed");
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
