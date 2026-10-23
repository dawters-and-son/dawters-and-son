// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — macOS shell (Electron). The studio itself is dawters.html.
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('DAWters and Son');
// keep the data folder from earlier versions (named DAWters and Suns) so the autosaved song carries over
try { const old = path.join(app.getPath('appData'), 'DAWters and Suns'); if (fs.existsSync(old)) app.setPath('userData', old); } catch (e) { /* first install */ }

let win = null;
const statePath = () => path.join(app.getPath('userData'), 'window.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { return { width: 1440, height: 900 }; } };
const saveState = () => { if (!win || win.isDestroyed()) return; try { fs.writeFileSync(statePath(), JSON.stringify(Object.assign(win.getNormalBounds(), { max: win.isMaximized() }))); } catch (e) { /* ignore */ } };

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width || 1440, height: st.height || 900, minWidth: 820, minHeight: 560,
    title: 'DAWters and Son', backgroundColor: '#14120F', show: false,
    // Windows/Linux: the studio has its own menus, so hide the native bar (Alt still shows it, shortcuts still work)
    autoHideMenuBar: process.platform !== 'darwin', icon: process.platform === 'darwin' ? undefined : path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false },
  });
  if (st.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveState);
  // "--tuner" (the Windows Start-menu Tuner shortcut) opens straight into the tuner
  win.loadFile(path.join(__dirname, 'dawters.html'), process.argv.includes('--tuner') ? { hash: 'tuner' } : undefined);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
}

const send = (cmd) => { if (win) win.webContents.send('menu', cmd); };
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl = [
    ...(isMac ? [{ label: 'DAWters and Son', submenu: [
      { label: 'About DAWters and Son', click: () => send('about') },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'New Song', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
      { label: 'Open Song…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { label: 'Save Song…', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { type: 'separator' },
      { label: 'Import Audio…', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
      { label: 'Export Mixdown / Stems…', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
      { label: 'Mastering…', accelerator: 'Shift+CmdOrCtrl+M', click: () => send('master') },
      ...(isMac ? [] : [{ type: 'separator' }, { label: 'Settings…', accelerator: 'Ctrl+,', click: () => send('settings') }, { role: 'quit' }]),
    ] },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => send('cut') },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('copy') },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('paste') },
      { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: () => send('duplicate') },
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => send('selectAll') },
    ] },
    { label: 'Track', submenu: [
      { label: 'Add Track', accelerator: 'CmdOrCtrl+T', click: () => send('addTrack') },
      { label: 'Bounce Tracks…', click: () => send('bounce') },
      { label: 'Quick Idea', click: () => send('idea') },
    ] },
    { label: 'View', submenu: [
      { label: 'Deck', click: () => send('deck') },
      { label: 'Tracks', click: () => send('tracks') },
      { label: 'Matrix', click: () => send('matrix') },
      { label: 'Pattern', click: () => send('pattern') },
      { label: 'Console', click: () => send('console') },
      { label: 'Master', click: () => send('master') },
      { type: 'separator' },
      { label: 'Tuner', accelerator: 'Shift+CmdOrCtrl+T', click: () => send('tuner') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Keyboard Shortcuts', click: () => send('help') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

ipcMain.handle('save-file', async (e, name, data) => {
  const base = (() => { try { return app.getPath('music'); } catch (x) { return app.getPath('documents'); } })();
  const dir = path.join(base, 'DAWters and Son');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (x) { /* ignore */ }
  const ext = path.extname(name).slice(1) || '*';
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(dir, name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, Buffer.from(data));
  return r.filePath;
});
// ---- ffmpeg: a static binary ships in the app's Resources folder ----
const ffmpegPath = () => {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cands = [process.env.DAW_FFMPEG, path.join(process.resourcesPath || '', exe), path.join(__dirname, exe)].filter(Boolean);
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) { /* next */ } }
  return null;
};
ipcMain.handle('ffmpeg-has', () => !!ffmpegPath());
ipcMain.handle('ffmpeg-encode', async (e, wav, args, ext) => {
  const bin = ffmpegPath(); if (!bin) return { error: 'ffmpeg is missing from this build' };
  const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'dawters-'));
  const inp = path.join(dir, 'in.wav'), out = path.join(dir, 'out.' + String(ext).replace(/[^a-z0-9]/gi, ''));
  try {
    await fs.promises.writeFile(inp, Buffer.from(wav));
    const err = await new Promise((res) => {
      const p = require('child_process').spawn(bin, ['-hide_banner', '-nostdin', '-y', '-i', inp, ...args.map(String), out], { stdio: ['ignore', 'ignore', 'pipe'] });
      let tail = ''; p.stderr.on('data', (d) => { tail = (tail + d).slice(-600); });
      p.on('error', (x) => res(x.message)); p.on('close', (code) => res(code === 0 ? null : 'ffmpeg exited with ' + code + ': ' + tail.trim().split('\n').slice(-2).join(' | ')));
    });
    if (err) return { error: err };
    const data = await fs.promises.readFile(out);
    return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
});
ipcMain.handle('mic-access', async () => {
  if (process.platform !== 'darwin') return true;
  try { return await systemPreferences.askForMediaAccess('microphone'); } catch (e) { return false; }
});

// a .dawters path on the command line (Windows file association) or from Finder: read it and hand it to the studio
const songArg = (argv) => argv.slice(1).find((a) => /\.dawters$/i.test(a) && fs.existsSync(a));
const sendSong = (file) => {
  if (!file || !win) return;
  fs.promises.readFile(file).then((b) => { const go = () => win.webContents.send('open-file', path.basename(file), b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go); else go(); }).catch(() => {});
};
let macOpen = null;
app.on('open-file', (e, file) => { e.preventDefault(); if (win) sendSong(file); else macOpen = file; });
// one studio at a time: a second launch focuses the first (and "--tuner" opens its tuner)
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  if (argv.includes('--tuner')) win.webContents.executeJavaScript("location.hash='#tuner'").catch(() => {});
  sendSong(songArg(argv));
});
if (process.platform === 'win32') app.setAppUserModelId('com.wilk.dawters');

app.whenReady().then(() => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'midi', 'midiSysex', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection'].includes(perm)));
  ses.setPermissionCheckHandler((wc, perm) => ['media', 'midi', 'midiSysex', 'speaker-selection'].includes(perm));
  ses.setDevicePermissionHandler(() => true);
  buildMenu();
  createWindow();
  sendSong(songArg(process.argv) || macOpen);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
