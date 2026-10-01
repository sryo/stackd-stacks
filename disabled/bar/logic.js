// Pure bar decisions, kept free of the sd:// runtime import so node can
// test them directly (node --test tests/).

// display:"all" spawns one instance per NSScreen in NSScreen.screens order,
// and index 0 is the screen that carries the system menu bar.
export function isPrimaryScreen(screen) {
  return !!screen && screen.index === 0;
}

function onScreen(pt, screen) {
  if (pt.display) return pt.display.id === screen.displayID;
  const f = screen.frame;
  return pt.x >= f.x && pt.x < f.x + f.w && pt.y >= f.y && pt.y < f.y + f.h;
}

// Fullscreen peek: in a fullscreen space the bar hides ("fullscreen-minimal")
// until the pointer touches the top 2px of this display, then stays
// ("fullscreen-peek") until the pointer drops 8px below the bar.
export function nextPeekMode(mode, pt, screen, barH) {
  if (mode !== "fullscreen-minimal" && mode !== "fullscreen-peek") return mode;
  if (!pt || !screen || !onScreen(pt, screen)) return mode;
  const localY = pt.y - screen.frame.y;
  if (mode === "fullscreen-minimal" && localY < 2) return "fullscreen-peek";
  if (mode === "fullscreen-peek" && localY > barH + 8) return "fullscreen-minimal";
  return mode;
}

// Hover-gate rects for sd.window.setInteractiveRects, in CSS viewport
// coordinates (the daemon maps them through the panel frame). Items with an
// empty box, e.g. while the bar is hidden in fullscreen, are not targets.
export function interactiveRects(domRects) {
  const out = [];
  for (const r of domRects) {
    if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
}

export function isNotched(screen) {
  return !!(screen && screen.notch && screen.notch.width > 0);
}

const NOWPLAYING = "nowplaying:";
const HIDDEN_AUDIO_BUNDLES = new Set([
  null, "", "com.mateoyadarola.stackd", "stackd",
  "com.apple.coreaudiod", "com.apple.audio.coreaudiod"
]);

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function appName(p) {
  if (p.name) return p.name;
  const tail = p.bundleId.split(".").pop() || "App";
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

// Pills for the now-playing cluster: a rich pill for sd.media.nowPlaying and
// a bare app-name pill for every other app producing audio. The media payload
// does not name its app, so when the active player is playing and exactly one
// process is audible, that process is the active player and gets no pill.
export function nowPlayingPills(media, procs) {
  const pills = [];
  const title = media && media.title ? truncate(media.title, 30) : "";
  const artist = media && media.artist ? truncate(media.artist, 20) : "";
  if (title || artist) {
    pills.push({ id: NOWPLAYING + "_active", value: artist ? `${title} · ${artist}` : title });
  }
  const audible = (procs || []).filter((p) => p && p.playingOutput && !HIDDEN_AUDIO_BUNDLES.has(p.bundleId));
  const activeIsAudible = pills.length > 0 && media.playing !== false && audible.length === 1;
  if (activeIsAudible) return pills;
  for (const p of audible) {
    pills.push({ id: NOWPLAYING + p.bundleId, value: appName(p), bundleId: p.bundleId });
  }
  return pills;
}

export function volumeLabel(output, transport) {
  if (!output) return "";
  const builtIn = transport == null || transport === "builtIn";
  // "Mateo's AirPods Max" → "AirPods Max"
  const name = builtIn ? "" : (output.deviceName || "").replace(/^[^']+'s\s+/, "");
  const parts = [output.muted ? "{sf:speaker.slash.fill}" : "{sf:speaker.wave.2.fill}"];
  if (name) parts.push(name);
  if (output.muted) parts.push("muted");
  else if (output.volume != null) parts.push(`${Math.round(output.volume * 100)}%`);
  return parts.join(" ");
}

// Room a center zone has before it runs into the side zone it grows toward.
// `anchorEdge` is the zone's fixed edge (at the notch or the screen middle),
// `sideEdge` the facing edge of the side zone's outermost item; either
// direction works, so center-left and center-right share it.
export function centerZoneMax(anchorEdge, sideEdge, gap) {
  return Math.max(0, Math.abs(sideEdge - anchorEdge) - gap);
}

export function rainPollDelay(fetched) {
  return (fetched ? 30 : 5) * 60 * 1000;
}

// Visible items bucketed per zone in DOM order. Lower `order` sits nearer
// the zone's anchored edge (ties by id), so the right-anchored zones render
// reversed. Without a notch there's no center gap to straddle, so
// center-left folds into center-right.
export function zoneItems(items, notched) {
  const zones = { left: [], "center-left": [], "center-right": [], right: [] };
  const sorted = items.slice().sort((a, b) =>
    ((a.order ?? 100) - (b.order ?? 100)) || a.id.localeCompare(b.id));
  for (const item of sorted) {
    let side = item.side || "right";
    if (!notched && side === "center-left") side = "center-right";
    zones[side].push(item);
  }
  zones.right.reverse();
  zones["center-left"].reverse();
  return zones;
}
