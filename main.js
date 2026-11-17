const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

let uio = null;
try { uio = require("uiohook-napi").uIOhook; } catch (e) { uio = null; }
const OW = 330, OH = 112;
const DEF = {
  keys: {
    plus: { key: "F9", on: true },
    minus: { key: "F10", on: true },
    end: { key: "F11", on: true },
    toggle: { key: "F8", on: true },
    move: { key: "F6", on: true },
  },
  pos: null,
  scale: 1,
  autoScan: true,
  scanned: {},
  autoStart: false,
  gameOnly: true,
  trayOnClose: true,
};
const cfgFile = () => path.join(app.getPath("userData"), "settings.json");
function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(cfgFile(), "utf8"));
    return { ...DEF, ...j, keys: { ...DEF.keys, ...(j.keys || {}) } };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEF));
  }
}
function saveCfg() {
  try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg)); } catch (e) {}
}

let scanning = false, tray = null, quitting = false, fortniteOn = false, uioOn = false;
const startHidden = process.argv.includes("--hidden");
const mouseMap = {};
let cfg, win, ov, last = null, overlayOn = true, moving = false, drag = null, failed = [];

const size = () => ({ width: Math.round(OW * cfg.scale), height: Math.round(OH * cfg.scale) });

function clampToScreen(x, y) {
  const { width, height } = size();
  const d = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.min(Math.max(x, d.x), d.x + d.width - width),
    y: Math.min(Math.max(y, d.y), d.y + d.height - height),
  };
}

function placeOverlay() {
  const { width, height } = size();
  let x, y;
  if (cfg.pos) {
    ({ x, y } = clampToScreen(cfg.pos.x, cfg.pos.y));
  } else {
    const d = screen.getPrimaryDisplay().workArea;
    x = d.x + d.width - width - 24;
    y = d.y + 24;
  }
  ov.setBounds({ x, y, width, height });
  ov.webContents.setZoomFactor(cfg.scale);
}

function createOverlay() {
  ov = new BrowserWindow({
    ...size(), transparent: true, frame: false, resizable: false, skipTaskbar: true,
    focusable: false, alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  ov.setAlwaysOnTop(true, "screen-saver");
  ov.setIgnoreMouseEvents(true);
  ov.loadFile("overlay.html");
  ov.webContents.on("did-finish-load", () => {
    placeOverlay();
    if (last) ov.webContents.send("state", last);
    syncOverlay();
  });
}

function createMain() {
  win = new BrowserWindow({
    width: 480, height: 880, minWidth: 380, minHeight: 600, backgroundColor: "#000000",
    title: "Coffres", icon: path.join(__dirname, "build", "icon.ico"), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile("index.html");
  win.once("ready-to-show", () => { if (!startHidden) win.show(); });
  win.on("close", (e) => {
    if (!quitting && cfg.trayOnClose) { e.preventDefault(); win.hide(); }
  });
  win.on("closed", () => app.quit());
}

function syncOverlay() {
  if (!ov || ov.isDestroyed()) return;
  const want = overlayOn && (fortniteOn || !cfg.gameOnly || moving);
  if (want) ov.showInactive(); else ov.hide();
}

function toggleOverlay() {
  overlayOn = !overlayOn;
  if (!overlayOn && moving) setMove(false);
  syncOverlay();
}

function setMove(on) {
  moving = on;
  if (on) overlayOn = true;
  syncOverlay();
  ov.setIgnoreMouseEvents(!on);
  ov.webContents.send("mode", on);
  if (!on) {
    const [x, y] = ov.getPosition();
    cfg.pos = { x, y };
    saveCfg();
  }
}


// ---------- Analyse automatique des replays ----------
const demosDir = () => path.join(process.env.LOCALAPPDATA || "", "FortniteGame", "Saved", "Demos");
function scanExe() {
  const p = app.isPackaged ? path.join(process.resourcesPath, "ReplayScan.exe") : path.join(__dirname, "scanner-bin", "ReplayScan.exe");
  try { return fs.statSync(p).size > 1e6 ? p : null; } catch (e) { return null; }
}
function listReplays() {
  try {
    return fs.readdirSync(demosDir()).filter((f) => f.toLowerCase().endsWith(".replay")).map((f) => {
      const p = path.join(demosDir(), f), st = fs.statSync(p);
      return { p, name: f, mtime: st.mtimeMs, size: st.size };
    });
  } catch (e) { return []; }
}
function runScan(file) {
  return new Promise((resolve) => {
    const exe = scanExe();
    if (!exe) return resolve({ file: path.basename(file), error: "scanner absent" });
    execFile(exe, [file], { maxBuffer: 64 * 1024 * 1024, timeout: 240000, windowsHide: true }, (err, out) => {
      if (err) return resolve({ file: path.basename(file), error: String(err.message || err) });
      try { resolve(JSON.parse(out)[0]); } catch (e) { resolve({ file: path.basename(file), error: "sortie illisible" }); }
    });
  });
}
function pollReplays() {
  if (!cfg.autoScan || scanning || !scanExe() || !win || win.isDestroyed()) return;
  const now = Date.now();
  const next = listReplays().find((f) => !cfg.scanned[f.name] && now - f.mtime > 20000 && f.size > 200000);
  if (!next) return;
  scanning = true;
  runScan(next.p).then((r) => {
    if (!r.error || r.partial) { cfg.scanned[next.name] = Date.now(); saveCfg(); }
    else cfg.scanned[next.name] = -2;
    if (!win.isDestroyed()) win.webContents.send("scan", r);
  }).finally(() => { scanning = false; });
}

const send = (c) => () => win && !win.isDestroyed() && win.webContents.send("cmd", c);
const actions = {
  plus: send("plus"),
  minus: send("minus"),
  end: send("end"),
  toggle: toggleOverlay,
  move: () => setMove(!moving),
};

function registerKeys() {
  globalShortcut.unregisterAll();
  for (const k of Object.keys(mouseMap)) delete mouseMap[k];
  const bad = [];
  for (const [id, k] of Object.entries(cfg.keys)) {
    if (!k.on || !k.key || !actions[id]) continue;
    if (/^(Mouse|Wheel):/.test(k.key)) {
      if (uio) mouseMap[k.key] = id; else bad.push(id);
      continue;
    }
    let ok = false;
    try { ok = globalShortcut.register(k.key, actions[id]); } catch (e) {}
    if (!ok) bad.push(id);
  }
  if (uio) {
    const need = Object.keys(mouseMap).length > 0;
    try {
      if (need && !uioOn) { uio.start(); uioOn = true; }
      if (!need && uioOn) { uio.stop(); uioOn = false; }
    } catch (e) {}
  }
  return bad;
}

function checkFortnite() {
  execFile("tasklist", ["/FI", "IMAGENAME eq FortniteClient-Win64-Shipping.exe", "/NH", "/FO", "CSV"], { windowsHide: true }, (err, out) => {
    const on = !err && /FortniteClient-Win64-Shipping/i.test(out || "");
    if (on !== fortniteOn) { fortniteOn = on; syncOverlay(); }
  });
}

function applyAutoStart() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ["--hidden"] });
  } catch (e) {}
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "build", "icon.ico")));
    tray.setToolTip("Coffres");
    const show = () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Ouvrir", click: show },
      { label: "Afficher / masquer l’overlay", click: toggleOverlay },
      { type: "separator" },
      { label: "Quitter", click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on("click", show);
  } catch (e) {}
}

app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
  cfg = loadCfg();
  createMain();
  createTray();
  createOverlay();
  failed = registerKeys();
  if (uio) {
    uio.on("mousedown", (e) => { const id = mouseMap["Mouse:" + e.button]; if (id) actions[id](); });
    uio.on("wheel", (e) => {
      if (e.direction !== 3) return;
      const id = mouseMap[e.rotation < 0 ? "Wheel:up" : "Wheel:down"];
      if (id) actions[id]();
    });
  }
  applyAutoStart();
  setInterval(checkFortnite, 5000);
  checkFortnite();
  if (!cfg.scanInit) {
    listReplays().forEach((f) => { cfg.scanned[f.name] = -1; });
    cfg.scanInit = true;
    saveCfg();
  }
  setInterval(pollReplays, 15000);
  ipcMain.handle("scan:info", () => ({ available: !!scanExe(), dir: demosDir(), exists: fs.existsSync(demosDir()), auto: cfg.autoScan }));
  ipcMain.handle("scan:auto", (_e, v) => { cfg.autoScan = !!v; saveCfg(); return cfg.autoScan; });
  ipcMain.handle("scan:all", async (_e, imported) => {
    if (!scanExe()) return { error: "noscanner" };
    if (scanning) return { error: "busy" };
    scanning = true;
    const done = new Set(imported || []), now = Date.now();
    const list = listReplays().filter((f) => !done.has(f.name) && now - f.mtime > 20000 && f.size > 200000).sort((a, b) => a.mtime - b.mtime);
    let i = 0;
    for (const f of list) {
      win.webContents.send("scan:progress", { i: ++i, total: list.length, name: f.name });
      const r = await runScan(f.p);
      if (!r.error || r.partial) cfg.scanned[f.name] = Date.now();
      if (!win.isDestroyed()) win.webContents.send("scan", r);
    }
    saveCfg();
    scanning = false;
    return { count: list.length };
  });

  ipcMain.handle("settings:get", () => ({ keys: cfg.keys, scale: cfg.scale, failed, app: { autoStart: cfg.autoStart, gameOnly: cfg.gameOnly, trayOnClose: cfg.trayOnClose }, mouse: !!uio }));
  ipcMain.handle("app:set", (_e, k, v) => {
    if (!["autoStart", "gameOnly", "trayOnClose"].includes(k)) return false;
    cfg[k] = !!v; saveCfg();
    if (k === "autoStart") applyAutoStart();
    if (k === "gameOnly") syncOverlay();
    return true;
  });
  ipcMain.handle("keys:set", (_e, id, key, on) => {
    if (!actions[id] || typeof key !== "string") return { error: "bad" };
    const dup = Object.entries(cfg.keys).some(([i, k]) => i !== id && k.on && on && k.key.toLowerCase() === key.toLowerCase());
    if (dup) return { error: "dup" };
    cfg.keys[id] = { key, on: !!on };
    saveCfg();
    failed = registerKeys();
    return { failed };
  });
  ipcMain.on("ov:cmd", (_e, c, v) => {
    if (c === "reset") { cfg.pos = null; placeOverlay(); saveCfg(); }
    if (c === "scale") { cfg.scale = Math.min(1.6, Math.max(0.6, Number(v) || 1)); placeOverlay(); saveCfg(); }
  });
  ipcMain.on("ov:drag", (_e, phase) => {
    if (!moving || !ov) return;
    const c = screen.getCursorScreenPoint();
    if (phase === "start") {
      const [x, y] = ov.getPosition();
      drag = { dx: c.x - x, dy: c.y - y };
    } else if (phase === "move" && drag) {
      const { x, y } = clampToScreen(c.x - drag.dx, c.y - drag.dy);
      const { width, height } = size();
      ov.setBounds({ x, y, width, height });
    } else if (phase === "end") {
      drag = null;
      const [x, y] = ov.getPosition();
      cfg.pos = { x, y };
      saveCfg();
    }
  });
  ipcMain.on("state", (_e, s) => {
    last = s;
    if (ov && !ov.isDestroyed()) ov.webContents.send("state", s);
  });
});

app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => { globalShortcut.unregisterAll(); try { if (uio && uioOn) uio.stop(); } catch (e) {} });
