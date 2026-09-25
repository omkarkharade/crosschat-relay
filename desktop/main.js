// Crosschat tray app. It controls the relay's background service rather than
// running the relay itself, so quitting the tray never stops the relay.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, clipboard, dialog, Menu, nativeImage, Notification, shell, Tray } from 'electron';

import { drawIcon } from './icon.js';

const here = dirname(fileURLToPath(import.meta.url));
// Packaged apps carry the relay in resources/relay; from source, it's the repo root.
const relayRoot = app.isPackaged ? join(process.resourcesPath, 'relay') : join(here, '..');
const relayScript = join(relayRoot, 'dist', 'index.js');

const POLL_MS = 5000;

/** @type {import('../src/service.js')} */
let service;
/** @type {Tray} */
let tray;
let state = { status: undefined, overview: undefined, busy: undefined, error: undefined };
let previous = { healthy: undefined, blocked: undefined };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => tray?.popUpContextMenu());
  // No windows: stay alive in the tray until the user quits.
  app.on('window-all-closed', () => undefined);
  app.whenReady().then(start, (error) => fail(error));
}

async function start() {
  if (process.platform === 'win32') app.setAppUserModelId('dev.crosschat.desktop');
  app.dock?.hide();

  if (!existsSync(relayScript)) {
    return fail(new Error(`The relay is not built at ${relayScript}. Run "npm run build" in the Crosschat folder first.`));
  }
  service = await import(pathToFileURL(join(relayRoot, 'dist', 'service.js')).href);

  tray = new Tray(icon('stopped'));
  tray.setToolTip('Crosschat relay');
  tray.on('click', () => tray.popUpContextMenu());
  await refresh();
  setInterval(() => void refresh(), POLL_MS);

  if (!state.status?.installed) offerInstall();
  if (app.isPackaged && isFirstRun()) setOpenAtLogin(true);
}

// ------------------------------------------------------------------ state

async function refresh() {
  try {
    const status = await service.status();
    const overview = status.healthy ? await fetchOverview(status).catch(() => undefined) : undefined;
    state = { ...state, status, overview };
    notifyChanges(status, overview);
  } catch (error) {
    state = { ...state, error: messageOf(error) };
  }
  render();
}

/** Task and agent counts, read with the admin token the relay keeps in its data folder. */
async function fetchOverview(status) {
  const [overview, workers] = await Promise.all([relayApi(status, 'GET', '/api/overview'), relayApi(status, 'GET', '/api/workers').catch(() => undefined)]);
  return overview ? { ...overview, workers } : undefined;
}

/** Call the relay's API with the admin token it keeps in its data folder. */
async function relayApi(status, method, path, body) {
  const token = readFileSync(join(status.config.dataDir, 'api-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${status.config.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`The relay answered ${response.status}.`);
  return response.json();
}

/** Tray lines for workers: a summary, then one line per task being worked on. */
function workerItems() {
  const info = state.overview?.workers;
  if (!info || info.workers.length === 0) return [];
  const working = info.workers.filter((worker) => worker.state === 'running');
  const listening = info.workers.filter((worker) => worker.state === 'idle').length;
  const summary = info.paused
    ? `Workers paused (${info.workers.length})`
    : `${listening} worker${listening === 1 ? '' : 's'} listening${working.length ? ` · ${working.length} working` : ''}`;
  return [
    { label: summary, enabled: false },
    ...working.map((worker) => ({ label: `  ${worker.agentSlug}: ${truncate(worker.currentTask?.title ?? '', 48)}`, enabled: false })),
    {
      label: info.paused ? 'Resume workers' : 'Pause workers',
      enabled: !state.busy,
      click: () => void act(info.paused ? 'Resuming workers…' : 'Pausing workers…', () => relayApi(state.status, 'POST', '/api/workers/pause', { paused: !info.paused })),
    },
    { type: 'separator' },
  ];
}

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function notifyChanges(status, overview) {
  if (!Notification.isSupported()) return;
  if (previous.healthy === true && !status.healthy && !state.busy) {
    notify('Crosschat relay stopped', 'It is no longer answering. Open the tray menu to restart it.');
  }
  const blocked = overview?.stats.tasks.blocked;
  if (blocked !== undefined && previous.blocked !== undefined && blocked > previous.blocked) {
    notify('A task is blocked', 'An agent needs something from you. Open the dashboard to unblock it.', openDashboard);
  }
  previous = { healthy: status.healthy, blocked: blocked ?? previous.blocked };
}

function notify(title, body, onClick) {
  const notification = new Notification({ title, body, icon: icon(undefined, 64) });
  if (onClick) notification.on('click', onClick);
  notification.show();
}

// --------------------------------------------------------------- rendering

function statusKey() {
  const { status } = state;
  if (!status?.installed) return 'stopped';
  if (status.healthy) return state.overview?.stats.tasks.blocked ? 'warning' : 'running';
  return status.running ? 'error' : 'stopped';
}

function statusLine() {
  const { status } = state;
  if (state.busy) return state.busy;
  if (!status) return 'Checking…';
  if (!status.installed) return 'Relay not installed';
  if (status.healthy) return 'Relay running';
  return status.running ? 'Relay not responding' : 'Relay stopped';
}

function render() {
  const key = statusKey();
  tray.setImage(icon(key));
  const counts = countsLine();
  tray.setToolTip(['Crosschat', statusLine(), counts].filter(Boolean).join('\n'));
  const menu = buildMenu(counts);
  tray.setContextMenu(menu);
  // CROSSCHAT_TRAY_DEBUG=1 prints what the tray shows, for testing without a desktop.
  if (process.env.CROSSCHAT_TRAY_DEBUG) {
    console.log(JSON.stringify({ icon: key, menu: menu.items.filter((item) => item.type !== 'separator').map((item) => `${item.enabled ? '' : '(disabled) '}${item.label}`) }));
  }
}

function countsLine() {
  const stats = state.overview?.stats;
  if (!stats) return undefined;
  const { claimed, queued, blocked } = stats.tasks;
  return `${claimed} in progress · ${queued} queued${blocked ? ` · ${blocked} blocked` : ''}`;
}

function buildMenu(counts) {
  const { status, busy } = state;
  const installed = Boolean(status?.installed);
  const healthy = Boolean(status?.healthy);
  const agentsOnline = state.overview?.stats.agents.online;

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [
    { label: `Crosschat · ${statusLine()}`, enabled: false },
    ...(counts ? [{ label: counts, enabled: false }] : []),
    ...(agentsOnline !== undefined ? [{ label: `${agentsOnline} agent${agentsOnline === 1 ? '' : 's'} online`, enabled: false }] : []),
    ...(state.error ? [{ label: `Error: ${state.error}`, enabled: false }] : []),
    { type: 'separator' },
  ];

  if (!installed) {
    items.push({ label: 'Install background service…', enabled: !busy, click: () => void installService() });
  } else {
    items.push(
      ...workerItems(),
      { label: 'Open dashboard', enabled: healthy, click: openDashboard },
      { label: 'Copy admin token (for signing in)', click: copyToken },
      { type: 'separator' },
      healthy || status?.running
        ? { label: 'Stop relay', enabled: !busy, click: () => void act('Stopping…', () => service.stop()) }
        : { label: 'Start relay', enabled: !busy, click: () => void act('Starting…', () => service.start()) },
      { label: 'Restart relay', enabled: !busy && installed, click: () => void act('Restarting…', () => service.restart()) },
      { type: 'separator' },
      { label: 'Open log file', click: () => void shell.openPath(status.config.logFile) },
      { label: 'Open data folder', click: () => void shell.openPath(status.config.dataDir) },
    );
  }

  items.push(
    { type: 'separator' },
    { label: 'Open Crosschat at login', type: 'checkbox', checked: isOpenAtLogin(), click: (item) => setOpenAtLogin(item.checked) },
    ...(installed ? [{ label: 'Uninstall background service…', enabled: !busy, click: () => void uninstallService() }] : []),
    { type: 'separator' },
    { label: installed ? 'Quit tray (relay keeps running)' : 'Quit', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

/** The icon with a status dot; by default the tray size (16pt, drawn at 2x for high-DPI displays). */
function icon(status, size = 32) {
  const rgba = drawIcon(size, status);
  // Electron bitmaps are BGRA.
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const red = rgba[offset];
    rgba[offset] = rgba[offset + 2];
    rgba[offset + 2] = red;
  }
  return nativeImage.createFromBitmap(rgba, { width: size, height: size, scaleFactor: size === 32 ? 2 : 1 });
}

// ---------------------------------------------------------------- actions

async function act(label, action) {
  state = { ...state, busy: label, error: undefined };
  render();
  try {
    await action();
  } catch (error) {
    state = { ...state, error: messageOf(error) };
    dialog.showErrorBox('Crosschat', messageOf(error));
  } finally {
    state = { ...state, busy: undefined };
    await refresh();
  }
}

function offerInstall() {
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Crosschat',
    message: 'Run the Crosschat relay in the background?',
    detail:
      'It starts when you log in and restarts if it stops, so your agents can always reach it. No administrator rights are needed. You can stop or remove it any time from the tray icon.',
    buttons: ['Install', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) void installService();
}

async function installService() {
  await act('Installing…', async () => {
    const node = relayNode();
    await service.install({ nodePath: node.path, scriptPath: relayScript, ...(node.env ? { env: node.env } : {}) });
  });
  if (state.status?.healthy) {
    notify('Crosschat relay is running', 'Open the dashboard from the tray icon. Use "Copy admin token" to sign in.', openDashboard);
  }
}

async function uninstallService() {
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Crosschat',
    message: 'Remove the background service?',
    detail: 'The relay stops and no longer starts at login. Your tasks, agents, and admin token stay in the data folder.',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice === 0) await act('Removing…', () => service.uninstall());
}

/**
 * Which Node.js runs the relay. A packaged app uses its own Electron binary in
 * Node mode, so nothing else needs installing; from source, a system Node.js is
 * preferred.
 */
function relayNode() {
  if (!app.isPackaged) {
    try {
      const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim();
      if (found) return { path: found };
    } catch {
      // Fall back to Electron's own Node.
    }
  }
  return { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function openDashboard() {
  if (state.status?.dashboardUrl) void shell.openExternal(state.status.dashboardUrl);
}

function copyToken() {
  try {
    clipboard.writeText(readFileSync(join(state.status.config.dataDir, 'api-token'), 'utf8').trim());
    notify('Admin token copied', 'Paste it into the dashboard sign-in. Clear your clipboard afterwards if others use this computer.');
  } catch {
    dialog.showErrorBox('Crosschat', 'No admin token file was found. If you set CROSSCHAT_API_TOKEN yourself, sign in with that value.');
  }
}

// ------------------------------------------------------- open at login

// When run from source, the login item must launch Electron with this app's folder.
const loginItem = () => ({ path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });
const linuxAutostart = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'crosschat-tray.desktop');

function isOpenAtLogin() {
  if (process.platform === 'linux') return existsSync(linuxAutostart());
  return app.getLoginItemSettings(loginItem()).openAtLogin;
}

function setOpenAtLogin(enabled) {
  if (process.platform === 'linux') {
    if (!enabled) return rmSync(linuxAutostart(), { force: true });
    const { path, args } = loginItem();
    mkdirSync(dirname(linuxAutostart()), { recursive: true });
    const exec = [path, ...args].map((part) => `"${part}"`).join(' ');
    writeFileSync(linuxAutostart(), `[Desktop Entry]\nType=Application\nName=Crosschat\nExec=${exec}\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItem() });
}

function isFirstRun() {
  const marker = join(app.getPath('userData'), 'first-run-done');
  if (existsSync(marker)) return false;
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, new Date().toISOString());
  return true;
}

// ----------------------------------------------------------------- errors

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(error) {
  dialog.showErrorBox('Crosschat', messageOf(error));
  app.quit();
}
