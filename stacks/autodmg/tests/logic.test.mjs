import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountPointOf, swapInstallScript, appAt, serialized } from "../logic.js";

const attachPlist = readFileSync(new URL("./fixtures/hdiutil-attach.plist", import.meta.url), "utf8");

test("mountPointOf reads the mount point from real hdiutil attach -plist output, unescaping XML", () => {
  assert.equal(mountPointOf(attachPlist).normalize(), "/Volumes/Tést & <x>");
});

// swapInstallScript runs under a real /bin/sh against temp dirs: the
// invariant is that the installed app is never removed before its
// replacement is fully copied.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "autodmg-"));
  const vol = join(root, "Volumes", "Foo's Disk");
  const apps = join(root, "Applications");
  mkdirSync(join(vol, "Foo.app", "Contents"), { recursive: true });
  writeFileSync(join(vol, "Foo.app", "Contents", "v"), "new");
  mkdirSync(apps);
  return { root, src: join(vol, "Foo.app"), target: join(apps, "Foo.app"), apps };
}
const sh = (script) => spawnSync("/bin/sh", ["-c", script]).status;
const installed = (target) => readFileSync(join(target, "Contents", "v"), "utf8");

test("swapInstallScript replaces an installed app and leaves no staging dirs", () => {
  const { src, target, apps, root } = sandbox();
  mkdirSync(join(target, "Contents"), { recursive: true });
  writeFileSync(join(target, "Contents", "v"), "old");
  assert.equal(sh(swapInstallScript(src, target)), 0);
  assert.equal(installed(target), "new");
  assert.deepEqual(readdirSync(apps), ["Foo.app"]);
  rmSync(root, { recursive: true });
});

test("swapInstallScript keeps the installed app when the copy fails", () => {
  const { target, apps, root } = sandbox();
  mkdirSync(join(target, "Contents"), { recursive: true });
  writeFileSync(join(target, "Contents", "v"), "old");
  assert.notEqual(sh(swapInstallScript(join(root, "missing.app"), target)), 0);
  assert.equal(installed(target), "old");
  assert.deepEqual(readdirSync(apps), ["Foo.app"]);
  rmSync(root, { recursive: true });
});

test("swapInstallScript installs when nothing is at the target yet", () => {
  const { src, target, apps, root } = sandbox();
  assert.equal(sh(swapInstallScript(src, target)), 0);
  assert.equal(installed(target), "new");
  assert.deepEqual(readdirSync(apps), ["Foo.app"]);
  rmSync(root, { recursive: true });
});

test("swapInstallScript restores an app a previous interrupted run left renamed aside", () => {
  const { target, apps, root } = sandbox();
  mkdirSync(join(target + ".stackd-old", "Contents"), { recursive: true });
  writeFileSync(join(target + ".stackd-old", "Contents", "v"), "old");
  assert.notEqual(sh(swapInstallScript(join(root, "missing.app"), target)), 0);
  assert.equal(installed(target), "old");
  assert.deepEqual(readdirSync(apps), ["Foo.app"]);
  rmSync(root, { recursive: true });
});

test("appAt matches the running app by bundle path, not by display name", () => {
  const apps = [
    { name: "Foo", bundleId: "com.beta.foo", bundleURL: "/Users/me/Downloads/Foo.app" },
    { name: "Foo (localized)", bundleId: "com.foo", bundleURL: "/Applications/Foo.app/" },
  ];
  assert.equal(appAt(apps, "/Applications/Foo.app")?.bundleId, "com.foo");
  assert.equal(appAt(apps, "/Applications/Bar.app"), null);
  assert.equal(appAt([{ name: "Foo" }], "/Applications/Foo.app"), null);
});

test("serialized never overlaps runs and folds calls made mid-run into one rerun", async () => {
  let active = 0, maxActive = 0, runs = 0;
  let release;
  const run = serialized(async () => {
    runs++; active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => { release = r; });
    active--;
  });
  run(); run(); run();
  release();
  await new Promise((r) => setImmediate(r));
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2);
  assert.equal(maxActive, 1);
});

test("serialized reports a rejected run and keeps accepting calls", async () => {
  const errors = [];
  let n = 0;
  const run = serialized(async () => { if (n++ === 0) throw new Error("boom"); }, (e) => errors.push(e.message));
  await run();
  await run();
  assert.deepEqual(errors, ["boom"]);
  assert.equal(n, 2);
});
