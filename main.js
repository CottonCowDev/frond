const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  nativeImage,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ======================================================================
//  ARCHITECTURE
//
//  GHOST HOST   one invisible 1x1 transparent window. It is the ONLY window with a taskbar
//               button (skipTaskbar: false), so the taskbar shows one icon for 1 or 50+ notes.
//  NOTES        every note is a frameless transparent window OWNED by the host
//               (parent: ghost, skipTaskbar: true). Nothing about a note is ever deleted
//               except by an explicit user action (Delete note); closing a note window by
//               accident (Alt+F4) is blocked, so a note can never silently vanish.
//  STATE        notes.json lives in the per-user data folder (never inside the app files),
//               is written atomically (tmp + fsync + rename), coalesced to <=120ms, flushed
//               synchronously on quit / session end / crash, with .bak and .tmp fallbacks and
//               a txt_backups recovery path. Start-up rebuilds every note.
//  FIRST BOOT   a brand-new user has no notes.json: an empty template with zero notes is
//               created, so nothing from the developer machine can ever ship to a client.
//  WINDOW LIFECYCLE  one array (noteWins) owns every note window; entries are removed and
//               listeners dropped on 'closed' so nothing keeps a dead window alive.
// ======================================================================

// All app data lives in Electron's per-user folder, e.g. %APPDATA%/<app>/Frond_Storage on Windows.
const dataPath = path.join(app.getPath("userData"), "Frond_Storage");

const DATA_DIR = dataPath;
const NOTES_FILE = path.join(dataPath, "notes.json");
const NOTES_TMP = NOTES_FILE + ".tmp";
const NOTES_BAK = NOTES_FILE + ".bak";
const BACKUP_DIR = path.join(dataPath, "txt_backups");

// Taskbar / window icon of the Ghost Host (the one icon the user sees in the taskbar)
const ICON_PATH = path.join(__dirname, "icon.ico");

// Geometry. Every window is larger than the visible element: the transparent margins give the
// CSS shadows room to fade out. The typing shadow (0 24px 70px) reaches 70px to the sides,
// 94px below and 46px above the note, so the margins are sized to contain it.
const MX = 72,
  MT = 48,
  MB = 96;
const NOTE_W = 284,
  NOTE_H = 244;
const FULL_W = NOTE_W + 2 * MX; // 428
const FULL_H = MT + NOTE_H + MB; // 388

// Tab window: margins sized so the tab's CSS shadow (0 4px 15px, lifted 0 6px 18px) is never clipped.
const CHIP_W = 180,
  CHIP_H = 30;
const TAB_MX = 24,
  TAB_MT = 20,
  TAB_MB = 24;
const TAB_W = CHIP_W + 2 * TAB_MX; // 228
const TAB_H = TAB_MT + CHIP_H + TAB_MB; // 74
const TAB_CHIP_BOTTOM = TAB_MT + CHIP_H; // 50
const TAB_PITCH = 34;

const STEP = 248; // vertical pitch of a docked column
const SNAP_X = 120,
  SNAP_Y = 70,
  BEHIND_Y = 90;
const PULL_LIFT = 30; // card-index peek offset
const PULL_FREE = 60; // pull further than this and the note is ungrouped

const SAVE_DEBOUNCE_MS = 120; // trailing debounce for notes.json
const SAVE_MAX_WAIT_MS = 500; // ...but never wait longer than this while typing
const BAK_EVERY_MS = 5000; // refresh notes.json.bak at most this often
const BOOT_BATCH = 6; // windows created per event-loop turn at start-up

// Export button scope: false = the note whose button was clicked, true = every note in one .txt
const EXPORT_ALL = false;

const HL_COLORS = [
  "rgba(255, 235, 59, 0.55)", // Classic Yellow
  "rgba(255, 152, 0, 0.45)", // Soft Orange
  "rgba(233, 30, 99, 0.4)", // Pastel Pink
];

let data = { theme: "light", hl: HL_COLORS[0], notes: [] };

let ghost = null; // the Ghost Host
const noteWins = []; // GLOBAL REGISTRY: every live note window
let frontId = null; // note holding alwaysOnTop priority
let lastActiveId = null; // note that had keyboard focus last
let appState = "visible"; // 'visible' | 'vacuuming' | 'hidden' | 'bursting'
let booting = true;
let quitting = false;
let exporting = false;
let pull = null; // active card-index pull session
let typingId = null; // note currently being typed in (focus-shadow ecosystem)
let cascade = 0; // staggers rescued / new notes
let idCounter = 0;

// ---------- safety helpers ----------
function safe(fn, label) {
  try {
    return fn();
  } catch (e) {
    console.error("[bunker] " + label + ": " + e.message);
  }
}
const byId = (id) => data.notes.find((n) => n.id === id);
const kidsOf = (id) => data.notes.filter((n) => n.parentId === id);
const live = () => noteWins.filter((w) => w && !w.isDestroyed());
const winById = (id) => live().find((w) => w.__noteId === id);
const makeId = () =>
  Date.now().toString(36) +
  Math.random().toString(36).slice(2, 8) +
  (idCounter++).toString(36);

// one dead window can never abort a broadcast loop
function sendTo(wins, channel, payload) {
  wins.forEach((w) => {
    safe(() => {
      if (!w.isDestroyed() && !w.webContents.isDestroyed())
        w.webContents.send(channel, payload);
    }, "send " + channel);
  });
}

// The OS must never draw its own rectangular frame shadow (re-applied on every window transition).
function noShadow(w) {
  if (!w || w.isDestroyed()) return;
  safe(() => w.setHasShadow(false), "noShadow");
}
// Notes must never get a taskbar button of their own.
function pinToHost(w) {
  if (!w || w.isDestroyed()) return;
  safe(() => w.setSkipTaskbar(true), "skipTaskbar");
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- fallback taskbar icon (only used when icon.ico is missing) ----------
function makeIcon() {
  return safe(() => {
    const S = 32,
      R = 6,
      lo = 2,
      hi = S - 3;
    const buf = Buffer.alloc(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const cx = Math.min(Math.max(x, lo + R), hi - R);
        const cy = Math.min(Math.max(y, lo + R), hi - R);
        const inside = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R;
        const i = (y * S + x) * 4;
        if (!inside) continue; // stays fully transparent
        const band = y < lo + 8; // darker header band
        buf[i] = band ? 0 : 64; // B
        buf[i + 1] = band ? 168 : 224; // G
        buf[i + 2] = band ? 230 : 255; // R
        buf[i + 3] = 255; // A
      }
    }
    return nativeImage.createFromBitmap(buf, { width: S, height: S });
  }, "make icon");
}

// ======================================================================
//  STORAGE (100% local, every operation wrapped)
// ======================================================================

// First boot for a client: create the storage folders and, when no notes.json exists,
// an empty template with ZERO notes. A crash leftover (.tmp / .bak) is NOT overwritten:
// loadData() recovers from those first.
function ensureStorage() {
  safe(
    () => fs.mkdirSync(BACKUP_DIR, { recursive: true }),
    "create storage folders",
  );
  const anyCopy = [NOTES_FILE, NOTES_TMP, NOTES_BAK].some((f) =>
    fs.existsSync(f),
  );
  if (anyCopy) return;
  safe(() => {
    const template = JSON.stringify(
      {
        version: 3,
        savedAt: new Date().toISOString(),
        theme: "light",
        hl: HL_COLORS[0],
        notes: [],
      },
      null,
      2,
    );
    fs.writeFileSync(NOTES_FILE, template, "utf8");
  }, "init empty notes.json");
}

function parseNotesFile(file) {
  const raw = safe(
    () => JSON.parse(fs.readFileSync(file, "utf8")),
    "read " + path.basename(file),
  );
  return raw && Array.isArray(raw.notes) ? raw : null;
}

function normalizeNotes(list) {
  const seen = new Set();
  return list
    .filter((n) => n && typeof n === "object")
    .map((n) => {
      let nid = typeof n.id === "string" && n.id ? n.id : "";
      if (!nid || seen.has(nid)) nid = makeId();
      seen.add(nid);
      return {
        id: nid,
        text: String(n.text || ""),
        html: String(n.html || ""),
        x: Number.isFinite(n.x) ? n.x : undefined,
        y: Number.isFinite(n.y) ? n.y : undefined,
        w: NOTE_W, // stored for the record: note windows are fixed-size
        h: NOTE_H,
        state:
          ["free", "docked", "behind"].indexOf(n.state) >= 0 ? n.state : "free",
        parentId: typeof n.parentId === "string" ? n.parentId : null,
        stackIdx: Number.isFinite(n.stackIdx) ? n.stackIdx : 0,
        backupFile: typeof n.backupFile === "string" ? n.backupFile : null,
        backupFromWords: !!n.backupFromWords,
      };
    });
}

// last resort when every JSON copy is unreadable: rebuild notes from the plain-text backups
function recoverFromBackups() {
  const files =
    safe(
      () => fs.readdirSync(BACKUP_DIR).filter((f) => /\.txt$/i.test(f)),
      "list backups",
    ) || [];
  if (!files.length) return null;
  const notes = files.map((f) => {
    const text =
      safe(
        () => fs.readFileSync(path.join(BACKUP_DIR, f), "utf8"),
        "read backup",
      ) || "";
    return {
      id: makeId(),
      text: text,
      html: escapeHtml(text).replace(/\r?\n/g, "<br>"),
      backupFile: f,
      backupFromWords: true,
    };
  });
  return { theme: "light", hl: HL_COLORS[0], notes: notes };
}

function loadData() {
  ensureStorage();
  let raw = null;
  safe(() => {
    // newest valid copy wins (a fully written .tmp can be newer than notes.json after a power cut)
    const candidates = [NOTES_FILE, NOTES_TMP, NOTES_BAK]
      .filter((f) => fs.existsSync(f))
      .map((f) => ({ f: f, t: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (let i = 0; i < candidates.length && !raw; i++)
      raw = parseNotesFile(candidates[i].f);
    if (!raw && fs.existsSync(NOTES_FILE)) {
      safe(
        () =>
          fs.renameSync(
            NOTES_FILE,
            NOTES_FILE.replace(/\.json$/, ".corrupt-" + Date.now() + ".json"),
          ),
        "quarantine",
      );
      raw = recoverFromBackups();
    }
  }, "locate notes");
  if (!raw) return;

  data.theme = raw.theme === "dark" ? "dark" : "light";
  data.hl = HL_COLORS.indexOf(raw.hl) >= 0 ? raw.hl : HL_COLORS[0];
  data.notes = normalizeNotes(raw.notes);
  data.notes.forEach((n) => {
    const p = n.parentId && byId(n.parentId);
    if (n.parentId && (!p || p.parentId)) {
      n.parentId = null;
      n.state = "free";
    }
    if (!n.parentId) n.state = "free";
  });
}

let saveTimer = null;
let firstDirtyAt = 0;
let lastBakAt = 0;

function writeSnapshot() {
  safe(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const json = JSON.stringify(
      {
        version: 3,
        savedAt: new Date().toISOString(),
        theme: data.theme,
        hl: data.hl,
        notes: data.notes,
      },
      null,
      2,
    );

    const fd = fs.openSync(NOTES_TMP, "w"); // write + fsync the temp copy first...
    try {
      fs.writeSync(fd, json, 0, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(NOTES_TMP, NOTES_FILE); // ...then swap it in atomically

    if (Date.now() - lastBakAt > BAK_EVERY_MS) {
      // rolling safety copy
      lastBakAt = Date.now();
      safe(() => fs.writeFileSync(NOTES_BAK, json, "utf8"), "write bak");
    }
  }, "write notes");
}

// debounced "real-time" save (typing, dragging)
function saveData() {
  const now = Date.now();
  if (!firstDirtyAt) firstDirtyAt = now;
  clearTimeout(saveTimer);
  const wait = Math.max(
    0,
    Math.min(SAVE_DEBOUNCE_MS, firstDirtyAt + SAVE_MAX_WAIT_MS - now),
  );
  saveTimer = setTimeout(saveNow, wait);
}
// immediate save (structure changes, quit, session end, crash)
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  firstDirtyAt = 0;
  writeSnapshot();
}

// ---------- regex keyword engine (backup names + tab labels) ----------
function extractWords(text) {
  return (
    String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]{5,}/g) || []
  );
}

function labelFor(text) {
  const uniq = Array.from(new Set(extractWords(text)))
    .slice(0, 2)
    .join(" ");
  return (uniq || "note").slice(0, 24);
}

function pickBackupName(note) {
  if (note.backupFile && note.backupFromWords)
    return { file: note.backupFile, fromWords: true };
  const pool = Array.from(new Set(extractWords(note.text))).sort(
    () => Math.random() - 0.5,
  );
  if (pool.length) {
    const count = Math.min(pool.length, 2 + Math.floor(Math.random() * 2)); // 2-3 words
    let name = pool.slice(0, count).join("_");
    if (
      data.notes.some((n) => n.id !== note.id && n.backupFile === name + ".txt")
    ) {
      name += "_" + note.id.slice(0, 4);
    }
    return { file: name + ".txt", fromWords: true };
  }
  if (note.backupFile) return { file: note.backupFile, fromWords: false };
  return { file: "note_" + Date.now() + ".txt", fromWords: false };
}

function writeBackup(note) {
  safe(() => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const pick = pickBackupName(note);
    if (note.backupFile && note.backupFile !== pick.file) {
      safe(
        () => fs.unlinkSync(path.join(BACKUP_DIR, note.backupFile)),
        "remove old backup",
      );
    }
    note.backupFile = pick.file;
    note.backupFromWords = pick.fromWords;
    fs.writeFileSync(path.join(BACKUP_DIR, pick.file), note.text || "", "utf8");
  }, "write backup");
}

// ======================================================================
//  GEOMETRY / STACK LAYOUT
// ======================================================================
function cancelTween(w) {
  if (w && w.__tween) {
    clearInterval(w.__tween);
    w.__tween = null;
  }
}
function tweenTo(w, x, y, ms) {
  cancelTween(w);
  const from = w.getPosition();
  const t0 = Date.now();
  w.__tween = setInterval(() => {
    if (w.isDestroyed()) {
      cancelTween(w);
      return;
    }
    const t = Math.min(1, (Date.now() - t0) / ms);
    const e = 1 - Math.pow(1 - t, 3);
    w.__prog = Date.now() + 300;
    safe(
      () =>
        w.setPosition(
          Math.round(from[0] + (x - from[0]) * e),
          Math.round(from[1] + (y - from[1]) * e),
        ),
      "tween",
    );
    if (t >= 1) {
      cancelTween(w);
      noShadow(w);
    }
  }, 16);
}

function applyBounds(n) {
  const w = winById(n.id);
  if (!w) return;
  cancelTween(w);
  const tab = n.state === "behind";
  w.__prog = Date.now() + 300;
  safe(
    () =>
      w.setBounds({
        x: Math.round(n.x),
        y: Math.round(n.y),
        width: tab ? TAB_W : FULL_W,
        height: tab ? TAB_H : FULL_H,
      }),
    "setBounds",
  );
  noShadow(w);
}

function place(n, x, y) {
  n.x = Math.round(x);
  n.y = Math.round(y);
  const w = winById(n.id);
  if (w && !w.__busy) applyBounds(n);
}

function columnTop(anchor, excludeId) {
  const docked = data.notes.filter(
    (k) =>
      k.parentId === anchor.id && k.state === "docked" && k.id !== excludeId,
  ).length;
  return anchor.y - docked * STEP;
}

function layoutGroup(rootId) {
  const root = byId(rootId);
  if (!root) return;
  const kids = kidsOf(rootId);
  const byIdx = (a, b) => (a.stackIdx || 0) - (b.stackIdx || 0);
  const docked = kids.filter((k) => k.state === "docked").sort(byIdx);
  const behind = kids.filter((k) => k.state === "behind").sort(byIdx);

  docked.forEach((k, i) => {
    k.stackIdx = i;
    place(k, root.x, root.y - (i + 1) * STEP);
  });
  const topY = root.y - docked.length * STEP;
  const tabX = root.x + MX + (NOTE_W - CHIP_W) / 2 - TAB_MX;
  behind.forEach((k, j) => {
    k.stackIdx = j;
    place(k, tabX, topY + MT - j * TAB_PITCH - TAB_CHIP_BOTTOM);
  });
}

function layoutAll() {
  data.notes.filter((n) => !n.parentId).forEach((n) => layoutGroup(n.id));
}

function sendMode(n) {
  const w = winById(n.id);
  if (w) sendTo([w], "mode", { state: n.state, label: labelFor(n.text) });
}

// stretch a window down to the bottom of its display so 100vh reaches the screen edge
function ensureTall(w) {
  const b = w.getBounds();
  const d = screen.getDisplayMatching(b);
  const bottom = d.bounds.y + d.bounds.height;
  const h = Math.max(b.height, bottom - b.y);
  if (h !== b.height) {
    w.__prog = Date.now() + 300;
    safe(
      () => w.setBounds({ x: b.x, y: b.y, width: b.width, height: h }),
      "extend",
    );
    noShadow(w);
  }
  return h;
}

// ---------- keep every note reachable (monitor unplugged, resolution change) ----------
function isReachable(n) {
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
  const px = n.x + MX + NOTE_W / 2,
    py = n.y + MT + 17; // centre of the drag handle
  return screen
    .getAllDisplays()
    .some(
      (d) =>
        px >= d.bounds.x &&
        px < d.bounds.x + d.bounds.width &&
        py >= d.bounds.y &&
        py < d.bounds.y + d.bounds.height,
    );
}
function rescue(n) {
  const wa = screen.getPrimaryDisplay().workArea;
  const off = (cascade++ % 10) * 28;
  n.x = wa.x + 40 + off - MX;
  n.y = wa.y + 40 + off - MT;
}
function reflowRoots() {
  if (booting) return;
  data.notes
    .filter((n) => !n.parentId)
    .forEach((n) => {
      if (!isReachable(n)) {
        rescue(n);
        applyBounds(n);
      }
    });
  layoutAll();
  saveData();
}

// ---------- front priority ----------
function setFront(id) {
  frontId = id;
  live().forEach((w) => w.setAlwaysOnTop(w.__noteId === id));
  const w = winById(id);
  if (w) {
    w.show();
    w.moveTop();
    w.focus();
    noShadow(w);
  }
}

// ---------- drop = snap / behind / detach ----------
function handleDrop(id) {
  const n = byId(id);
  const win = winById(id);
  if (!n || !win || win.__busy || win.__hidden || n.state === "behind") return;
  if (appState !== "visible" || win.__prog > Date.now()) return;
  if (pull && pull.id === id) return;

  const pos = win.getPosition();
  const x = pos[0],
    y = pos[1];
  n.x = x;
  n.y = y;

  if (kidsOf(id).length) {
    layoutGroup(id);
    saveData();
    return;
  }

  let target = null,
    action = null,
    best = Infinity;
  data.notes.forEach((a) => {
    if (a.id === id || a.state !== "free" || a.parentId) return;
    const aw = winById(a.id);
    if (!aw || aw.__busy) return;
    const dx = Math.abs(x - a.x);
    if (dx >= SNAP_X) return;
    const dyBehind = Math.abs(y - a.y);
    const dyDock = Math.abs(y + STEP - columnTop(a, id));
    let act = null,
      d = Infinity;
    if (dyBehind < BEHIND_Y) {
      act = "behind";
      d = dyBehind;
    } else if (dyDock < SNAP_Y) {
      act = "dock";
      d = dyDock;
    }
    if (act && d + dx < best) {
      best = d + dx;
      target = a;
      action = act;
    }
  });

  const oldParent = n.parentId;
  if (target) {
    const wanted = action === "dock" ? "docked" : "behind";
    const sibs = data.notes.filter(
      (k) => k.parentId === target.id && k.id !== id && k.state === wanted,
    );
    n.parentId = target.id;
    n.state = wanted;
    n.stackIdx = sibs.length
      ? Math.max.apply(
          null,
          sibs.map((k) => k.stackIdx || 0),
        ) + 1
      : 0;
  } else {
    n.parentId = null;
    n.state = "free";
  }
  if (oldParent && oldParent !== n.parentId) layoutGroup(oldParent);
  if (n.parentId) layoutGroup(n.parentId);
  sendMode(n);
  saveData();
}

// ---------- explicit delete: the ONLY way a note is ever removed ----------
function removeNote(id) {
  const n = byId(id);
  if (!n) return;
  const kids = kidsOf(id);
  let heir = null;
  if (kids.length) {
    heir = kids.find((k) => k.state === "docked") || kids[0];
    kids.forEach((k) => {
      if (k !== heir) k.parentId = heir.id;
    });
    heir.parentId = null;
    heir.state = "free";
    heir.stackIdx = 0;
    place(heir, n.x, n.y);
    applyBounds(heir);
    sendMode(heir);
  }
  const parent = n.parentId;
  data.notes = data.notes.filter((k) => k.id !== id);
  const w = winById(id);
  if (w) {
    w.__allowClose = true;
    w.close();
  }
  if (parent) layoutGroup(parent);
  if (heir) layoutGroup(heir.id);
  if (!data.notes.length) {
    // never leave the desktop without a note
    const fresh = newNote(n.x, n.y);
    data.notes.push(fresh);
    safe(() => openNote(fresh, { focus: true }), "open fresh note");
  }
  saveNow();
}

// ======================================================================
//  ACTIVE FOCUS SHADOW + GLOBAL DIMMING ECOSYSTEM
//  (single owner `typingId`; handlers run serially on the main thread, so no races)
// ======================================================================
function senderNoteId(e) {
  const w = BrowserWindow.fromWebContents(e.sender);
  return w && !w.isDestroyed() ? w.__noteId : null;
}

function releaseTyping(id) {
  if (typingId !== id) return;
  typingId = null;
  sendTo(live(), "note-restore");
}

ipcMain.on("note-typing", (e) => {
  const id = senderNoteId(e);
  if (!id || appState !== "visible") return;
  typingId = id;
  const wins = live();
  sendTo(
    wins.filter((w) => w.__noteId !== id),
    "note-dim-others",
  );
  sendTo(
    wins.filter((w) => w.__noteId === id),
    "note-restore",
  );
});

ipcMain.on("note-typing-stopped", (e) => {
  const id = senderNoteId(e);
  if (!id || typingId !== id) return; // stale stop: another note owns the focus shadow now
  typingId = null;
  sendTo(
    live().filter((w) => w.__noteId !== id),
    "note-restore",
  );
});

// ======================================================================
//  GLOBAL VACUUM / BURST  (state machine, one shared clock, one loop)
//  The Ghost Host is what really minimizes: notes are hidden first, then the host goes to the
//  taskbar. A taskbar click restores the host, which triggers the simultaneous burst.
// ======================================================================
function vacuumAll() {
  if (appState !== "visible" || booting) return;
  const wins = live().filter((w) => !w.__hidden && w.isVisible());
  if (!wins.length) return;
  appState = "vacuuming";
  pull = null;

  typingId = null; // nothing may stay dimmed while the notes vanish
  sendTo(live(), "note-restore");

  const lead = Math.min(400, 100 + wins.length * 4);
  const startAt = Date.now() + lead;

  wins.forEach((w) => {
    cancelTween(w);
    w.__busy = true;
    ensureTall(w);
  }); // 1) stretch all
  sendTo(wins, "vacuum", { startAt: startAt }); // 2) one guarded broadcast

  setTimeout(
    () => {
      // 3) after the 350ms animation
      wins.forEach((w) => {
        if (w.isDestroyed()) return;
        w.__hidden = true;
        safe(() => w.hide(), "hide note");
      });
      appState = "hidden";
      if (ghost && !ghost.isDestroyed())
        safe(() => ghost.minimize(), "minimize host");
    },
    lead + 350 + 40,
  );
}

// the user clicked the taskbar button of the active app: Windows minimizes the host (and hides
// its owned notes) without an animation. Bring our own bookkeeping in line.
function onHostMinimized() {
  if (appState !== "visible" || booting) return;
  appState = "hidden";
  pull = null;
  typingId = null;
  sendTo(live(), "note-restore");
  live().forEach((w) => {
    cancelTween(w);
    w.__hidden = true;
    safe(() => w.hide(), "hide note");
  });
}

function restoreAllAndBurst() {
  if (appState === "vacuuming" || appState === "bursting" || booting) return;
  const targets = live().filter((w) => w.__hidden);
  if (!targets.length) {
    appState = "visible";
    return;
  }
  appState = "bursting";

  const SHOW_DELAY = 40;
  const startAt =
    Date.now() + SHOW_DELAY + 80 + Math.min(300, targets.length * 3);

  targets.forEach((w) => {
    w.__busy = true;
    noShadow(w);
    ensureTall(w);
  });
  sendTo(targets, "burst", { startAt: startAt }); // renderers cloak themselves at once, then wait for startAt

  setTimeout(() => {
    // one tight loop: every note appears in the same instant
    targets.forEach((w) => {
      if (w.isDestroyed()) return;
      w.__hidden = false;
      safe(() => w.showInactive(), "show note");
    });
    const front =
      winById(lastActiveId) || targets.filter((w) => !w.isDestroyed())[0];
    if (front) safe(() => front.focus(), "focus note");
  }, SHOW_DELAY);

  setTimeout(
    () => {
      // safety net if a renderer never reports back
      targets.forEach((w) => {
        if (w.isDestroyed()) return;
        w.__busy = false;
        const n = byId(w.__noteId);
        if (n) applyBounds(n);
      });
      appState = "visible";
    },
    Math.max(0, startAt - Date.now()) + 420 + 600,
  );
}

// ======================================================================
//  GHOST HOST
// ======================================================================
function createGhostHost() {
  ghost = new BrowserWindow({
    width: 1,
    height: 1,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false, // the ONLY window with a taskbar button
    focusable: true,
    backgroundColor: "#00000000",
    title: "Sticky Notes",
    icon: path.join(__dirname, "icon.ico"), // local icon file shown on the taskbar button
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  ghost.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        "<!DOCTYPE html><title>Sticky Notes</title><style>html,body{background:transparent}</style>",
      ),
  );
  ghost.setIgnoreMouseEvents(true); // the 1x1 pixel never intercepts a click

  // icon.ico is the real icon; the generated one is only a fallback if the file is missing
  if (!fs.existsSync(ICON_PATH)) {
    console.error(
      "[bunker] icon.ico not found next to main.js, using the generated fallback icon",
    );
    const icon = makeIcon();
    if (icon) safe(() => ghost.setIcon(icon), "host icon");
  }

  ghost.showInactive(); // visible-but-invisible: this is what creates the taskbar button

  ghost.on("minimize", onHostMinimized);
  ghost.on("restore", () => restoreAllAndBurst());
  ghost.on("focus", () => {
    // taskbar activation: hand the keyboard to the last active note
    if (appState !== "visible" || booting) return;
    const w = winById(lastActiveId) || live()[0];
    if (w && w.isVisible()) safe(() => w.focus(), "focus note");
  });
  ghost.on("session-end", () => {
    quitting = true;
    saveNow();
  }); // Windows shutdown / logoff
  ghost.on("close", () => {
    quitting = true;
    saveNow();
  }); // "Close window" on the taskbar = quit
  ghost.on("closed", () => {
    ghost = null;
  });
}

// ======================================================================
//  NOTE WINDOWS
// ======================================================================
function newNote(x, y) {
  return {
    id: makeId(),
    text: "",
    html: "",
    x: x,
    y: y,
    w: NOTE_W,
    h: NOTE_H,
    state: "free",
    parentId: null,
    stackIdx: 0,
    backupFile: null,
    backupFromWords: false,
  };
}

// the ONE place a note window is created: every instance (full note, collapsed tab,
// pulled-out note) goes through these options
function openNote(note, opts) {
  opts = opts || {};
  const tab = note.state === "behind";
  const o = {
    width: tab ? TAB_W : FULL_W,
    height: tab ? TAB_H : FULL_H,
    skipTaskbar: true, // never a taskbar button: the Ghost Host owns the only one
    frame: false,
    transparent: true,
    hasShadow: false, // never render the default square OS shadow
    thickFrame: false, // Windows: WS_THICKFRAME carries the DWM frame shadow
    resizable: false,
    minimizable: false, // a minimized skipTaskbar window would become a stray caption icon
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#00000000",
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false, // hidden notes must still run the burst timers on time
    },
  };
  if (ghost && !ghost.isDestroyed()) o.parent = ghost; // owned by the Ghost Host
  if (Number.isFinite(note.x) && Number.isFinite(note.y)) {
    o.x = Math.round(note.x);
    o.y = Math.round(note.y);
  }

  const win = new BrowserWindow(o);
  win.__noteId = note.id;
  win.__hidden = false;
  win.__busy = false;
  win.__prog = 0;
  win.__tween = null;
  win.__loaded = false;
  win.__allowClose = false;
  win.__crashes = 0;
  noteWins.push(win);
  noShadow(win);
  pinToHost(win);

  ["ready-to-show", "show", "focus", "resize"].forEach((evt) =>
    win.on(evt, () => noShadow(win)),
  );
  ["ready-to-show", "show"].forEach((evt) => win.on(evt, () => pinToHost(win)));

  win.webContents.on("did-finish-load", () => {
    win.__loaded = true;
  });
  win.webContents.on("render-process-gone", () => {
    // a crashed note renderer comes back by itself
    if (quitting || win.isDestroyed()) return;
    win.__loaded = false;
    win.__crashes += 1;
    if (win.__crashes <= 5) safe(() => win.webContents.reload(), "reload note");
  });

  if (!opts.deferShow) {
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      if (opts.focus) win.show();
      else win.showInactive();
    });
  }
  win.loadFile(path.join(__dirname, "index.html"), { query: { id: note.id } });

  // a note is never closed by accident (Alt+F4 etc.): only Delete / quit may close it
  win.on("close", (e) => {
    if (!win.__allowClose && !quitting) e.preventDefault();
  });

  win.on("move", () => {
    if (
      win.__prog > Date.now() ||
      win.__busy ||
      win.__hidden ||
      appState !== "visible"
    )
      return;
    const n = byId(note.id);
    if (n && kidsOf(n.id).length) {
      const p = win.getPosition();
      n.x = p[0];
      n.y = p[1];
      layoutGroup(n.id);
    }
  });
  win.on("moved", () => handleDrop(note.id));
  win.on("focus", () => {
    lastActiveId = note.id;
    if (frontId && frontId !== note.id) {
      live().forEach((w) => w.setAlwaysOnTop(false));
      frontId = null;
    }
  });

  // lifecycle cleanup: nothing may keep a dead window (or its timers / listeners) alive
  win.on("closed", () => {
    cancelTween(win);
    const i = noteWins.indexOf(win);
    if (i >= 0) noteWins.splice(i, 1);
    if (lastActiveId === note.id) lastActiveId = null;
    if (frontId === note.id) frontId = null;
    if (pull && pull.id === note.id) pull = null;
    releaseTyping(note.id); // a typist that closes must not leave everyone else dimmed
    win.removeAllListeners();
  });
  return win;
}

// ======================================================================
//  BOOTSTRAP RECOVERY: rebuild every note, reveal them all in one instant
// ======================================================================
function restoreNotes() {
  // every note that is free-standing must be reachable on the current monitors
  data.notes
    .filter((n) => !n.parentId)
    .forEach((n) => {
      if (!isReachable(n)) rescue(n);
    });

  const list = data.notes.slice();
  let i = 0;
  (function createBatch() {
    // batches keep the main process responsive with 50+ notes
    const end = Math.min(i + BOOT_BATCH, list.length);
    for (; i < end; i++) {
      const n = list[i];
      safe(() => openNote(n, { deferShow: true }), "restore note " + n.id);
    }
    if (i < list.length) setTimeout(createBatch, 0);
    else waitForLoaded(Date.now());
  })();
}

function waitForLoaded(t0) {
  const wins = live();
  if (wins.every((w) => w.__loaded) || Date.now() - t0 > 12000) revealAll();
  else setTimeout(() => waitForLoaded(t0), 40);
}

function revealAll() {
  layoutAll(); // docked notes and tabs sit in their slots before anything shows
  live().forEach((w) => safe(() => w.showInactive(), "reveal note")); // one tight loop: all at once
  data.notes.forEach((n) => {
    // a note whose window failed to build gets a second chance
    if (!winById(n.id)) safe(() => openNote(n), "retry note " + n.id);
  });
  booting = false;
  saveNow();
}

// ======================================================================
//  IPC: data
// ======================================================================
ipcMain.handle("note:get", (e, id) => {
  const n = byId(id);
  return {
    theme: data.theme,
    hl: data.hl,
    text: n ? n.text : "",
    html: n ? n.html : "",
    state: n ? n.state : "free",
    label: n ? labelFor(n.text) : "note",
    dimmed: !!typingId && typingId !== id,
  };
});

ipcMain.on("note:input", (e, id, text, html) => {
  const n = byId(id);
  if (!n) return;
  n.text = String(text);
  n.html = String(html);
  writeBackup(n);
  saveData();
});

ipcMain.on("theme:set", (e, theme) => {
  data.theme = theme === "dark" ? "dark" : "light";
  saveData();
  sendTo(live(), "theme:changed", data.theme);
});

ipcMain.on("hl:set", (e, color) => {
  if (HL_COLORS.indexOf(color) < 0) return;
  data.hl = color;
  saveData();
  sendTo(live(), "hl:changed", color);
});

ipcMain.on("note:new", (e) => {
  if (appState !== "visible" || booting) return;
  const from = BrowserWindow.fromWebContents(e.sender);
  const p = from ? from.getPosition() : [100, 100];
  const n = newNote(p[0] + 30, p[1] + 30);
  if (!isReachable(n)) rescue(n);
  data.notes.push(n);
  saveNow();
  safe(() => openNote(n, { focus: true }), "open new note");
});

ipcMain.on("note:delete", (e, id) => removeNote(id));

ipcMain.on("note:sendBehind", (e, id) => {
  const n = byId(id);
  if (!n || n.state !== "docked" || !n.parentId) return;
  const sibs = data.notes.filter(
    (k) => k.parentId === n.parentId && k.state === "behind",
  );
  n.state = "behind";
  n.stackIdx = sibs.length
    ? Math.max.apply(
        null,
        sibs.map((k) => k.stackIdx || 0),
      ) + 1
    : 0;
  layoutGroup(n.parentId);
  sendMode(n);
  saveNow();
});

ipcMain.on("tab:resurrect", (e, id) => {
  const n = byId(id);
  if (!n || n.state !== "behind") return;
  const old = byId(n.parentId);
  if (!old) return;
  const others = kidsOf(old.id).filter((k) => k.id !== n.id);

  n.parentId = null;
  n.state = "free";
  n.stackIdx = 0;
  n.x = old.x;
  n.y = old.y;
  old.parentId = n.id;
  old.state = "behind";
  old.stackIdx = -1;
  others.forEach((k) => {
    k.parentId = n.id;
  });

  applyBounds(n);
  applyBounds(old);
  layoutGroup(n.id);
  sendMode(n);
  sendMode(old);
  setFront(n.id);
  saveNow();
});

// ======================================================================
//  IPC: native export (OS file manager)
// ======================================================================
function buildExport(n) {
  const EOL = os.EOL;
  const norm = (t) => String(t || "").replace(/\r?\n/g, EOL);
  if (!EXPORT_ALL) return norm(n.text) + EOL;
  const parts = data.notes.map(
    (k, i) => "=== Note " + (i + 1) + " ===" + EOL + norm(k.text),
  );
  return (
    "Sticky Notes backup, " +
    new Date().toISOString() +
    EOL +
    EOL +
    parts.join(EOL + EOL) +
    EOL
  );
}

ipcMain.on("note:export", async (e, id) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const n = byId(id);
  if (!n || !win || win.isDestroyed() || exporting) return;
  exporting = true;
  try {
    saveNow(); // the file on disk is current before the dialog opens
    const stamp = new Date().toISOString().slice(0, 10);
    const base = EXPORT_ALL
      ? "sticky-notes-backup"
      : labelFor(n.text).replace(/\s+/g, "_");
    const res = await dialog.showSaveDialog(win, {
      // the real OS file manager
      title: "Export as .txt",
      defaultPath: path.join(
        app.getPath("documents"),
        base + "-" + stamp + ".txt",
      ),
      buttonLabel: "Export",
      filters: [{ name: "Text file", extensions: ["txt"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (res.canceled || !res.filePath) return;
    const target = /\.txt$/i.test(res.filePath)
      ? res.filePath
      : res.filePath + ".txt";
    fs.writeFileSync(target, buildExport(n), "utf8");
  } catch (err) {
    safe(
      () =>
        dialog.showErrorBox(
          "Export failed",
          String(err && err.message ? err.message : err),
        ),
      "export error box",
    );
  } finally {
    exporting = false;
  }
});

// ======================================================================
//  IPC: card-index pull-out
// ======================================================================
ipcMain.on("pull:start", (e, id, sx, sy) => {
  const n = byId(id);
  const w = winById(id);
  if (!n || !w || n.state !== "behind" || appState !== "visible") return;
  cancelTween(w);
  const b = w.getBounds();
  pull = {
    id: id,
    startY: sy,
    baseX: b.x,
    baseY: b.y,
    free: false,
    grabX: FULL_W / 2,
    grabY: MT + 17,
  };
});

function ungroupPull(n, w, sx, sy) {
  const oldParent = n.parentId;
  n.parentId = null; // break the parent-child docking state
  n.state = "free"; // reset layering
  n.stackIdx = 0;
  n.x = Math.round(sx - pull.grabX);
  n.y = Math.round(sy - pull.grabY);
  pull.free = true;
  applyBounds(n);
  sendMode(n);
  w.moveTop();
  noShadow(w);
  if (oldParent) layoutGroup(oldParent);
  saveNow();
}

ipcMain.on("pull:move", (e, id, sx, sy) => {
  if (!pull || pull.id !== id) return;
  const n = byId(id);
  const w = winById(id);
  if (!n || !w) {
    pull = null;
    return;
  }

  if (!pull.free) {
    const dy = sy - pull.startY;
    if (dy <= -PULL_FREE) {
      ungroupPull(n, w, sx, sy);
      return;
    }
    const up = Math.max(0, -dy);
    const t = Math.min(1, up / PULL_LIFT);
    const offset = -PULL_LIFT * (1 - (1 - t) * (1 - t)); // ease-out to -30px
    w.__prog = Date.now() + 300;
    safe(
      () => w.setPosition(pull.baseX, Math.round(pull.baseY + offset)),
      "pull lift",
    );
  } else {
    w.__prog = Date.now() + 300;
    safe(
      () =>
        w.setPosition(Math.round(sx - pull.grabX), Math.round(sy - pull.grabY)),
      "pull free",
    );
  }
});

ipcMain.on("pull:end", (e, id) => {
  if (!pull || pull.id !== id) return;
  const s = pull;
  pull = null;
  const n = byId(id);
  const w = winById(id);
  if (!n || !w) return;
  noShadow(w);
  if (s.free) {
    // independent window: remember where it landed (no re-snap)
    const p = w.getPosition();
    n.x = p[0];
    n.y = p[1];
    saveData();
    return;
  }
  tweenTo(w, s.baseX, s.baseY, 180); // card slides back down into the box
});

// ======================================================================
//  IPC: window plumbing
// ======================================================================
// transparent margins (shadow room) must not eat clicks meant for windows underneath
ipcMain.on("mouse:ignore", (e, ignore) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed())
    safe(
      () => w.setIgnoreMouseEvents(!!ignore, { forward: true }),
      "ignore mouse",
    );
});

ipcMain.on("vacuum:request", () => vacuumAll());

ipcMain.on("burst-done", (e, id) => {
  const w = winById(id);
  const n = byId(id);
  if (w) w.__busy = false;
  if (n) applyBounds(n);
});

// ======================================================================
//  LIFECYCLE
// ======================================================================
process.on("uncaughtException", (err) => {
  // the main process must outlive any single bug
  console.error("[bunker] uncaught: " + (err && err.stack ? err.stack : err));
  safe(saveNow, "save after exception");
});

app.setAppUserModelId('com.cottoncow.frond');

if (!app.requestSingleInstanceLock()) {
  // two instances would fight over notes.json
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!ghost || ghost.isDestroyed()) return;
    if (ghost.isMinimized())
      ghost.restore(); // 'restore' runs the bulk burst
    else live().forEach((w) => safe(() => w.moveTop(), "raise note"));
  });

  app.whenReady().then(() => {
    createGhostHost(); // 1) the one taskbar window
    loadData(); // 2) first boot -> empty template, otherwise notes.json (+ .tmp / .bak / txt fallbacks)
    if (!data.notes.length) {
      // 3) a brand-new user gets one blank note so the app is usable
      const wa = screen.getPrimaryDisplay().workArea;
      data.notes.push(newNote(wa.x + 100 - MX, wa.y + 100 - MT));
    }
    restoreNotes(); // 4) rebuild every note, reveal together

    screen.on("display-removed", reflowRoots);
    screen.on("display-metrics-changed", reflowRoots);
  });

  app.on("before-quit", () => {
    quitting = true;
    saveNow();
  });
  app.on("window-all-closed", () => app.quit());
}
