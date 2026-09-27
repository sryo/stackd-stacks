// Pure helpers for AutoDMG. No sd.* access, so they run under plain node
// (tests/logic.test.mjs); index.html wires them to sd.proc / sd.apps.

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// `hdiutil attach -plist` lists one dict per partition; only the mounted
// volume carries a mount-point. Values are XML-escaped, so a volume named
// "A & B" arrives as "A &amp; B".
export function mountPointOf(plistText) {
  const m = plistText.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e]) : null;
}

export const shQuote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

// One /bin/sh line (it also runs through `do shell script` for the admin
// retry) that installs `appLocation` at `targetPath` without ever leaving
// the user app-less: copy to a sibling, rename the old app aside, rename
// the copy in, then delete the old one. A failure before the final rename
// restores the old app and removes the partial copy; an old app left aside
// by an interrupted run is put back first.
export function swapInstallScript(appLocation, targetPath) {
  const [src, dst] = [appLocation, targetPath].map(shQuote);
  const fresh = shQuote(targetPath + ".stackd-new");
  const old = shQuote(targetPath + ".stackd-old");
  return [
    `if [ ! -e ${dst} ] && [ -e ${old} ]; then mv ${old} ${dst}; fi`,
    `rm -rf ${fresh} ${old} || exit 1`,
    `cp -R ${src} ${fresh} || { rm -rf ${fresh}; exit 1; }`,
    `xattr -dr com.apple.quarantine ${fresh} 2>/dev/null`,
    `if [ -e ${dst} ]; then mv ${dst} ${old} || { rm -rf ${fresh}; exit 1; }; fi`,
    `mv ${fresh} ${dst} || { [ -e ${old} ] && mv ${old} ${dst}; rm -rf ${fresh}; exit 1; }`,
    `rm -rf ${old}`,
    `exit 0`
  ].join("; ");
}

// The running app installed at `path` (an sd.apps.running entry), or null.
// Matching by bundle path rather than name keeps a same-named app launched
// from elsewhere (a beta, the copy still on the disk image) from being quit.
export function appAt(apps, path) {
  const norm = (p) => p.replace(/\/+$/, "");
  return apps.find((a) => typeof a.bundleURL === "string" && norm(a.bundleURL) === norm(path)) || null;
}

// Wrap an async `fn` so runs never overlap: a call made while one is in
// flight marks it dirty, and it runs exactly once more when the current run
// settles. Rejections go to `onError` instead of escaping unhandled.
export function serialized(fn, onError = () => {}) {
  let running = null, again = false;
  const run = () => {
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        try { await fn(); } catch (e) { onError(e); }
      } while (again);
      running = null;
    })();
    return running;
  };
  return run;
}
