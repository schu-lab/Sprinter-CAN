'use strict';

// Electron is intentionally a thin desktop shell. The Python collector owns
// CAN access, reconnects, recording, replay, and the localhost web service.
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let win = null;
let service = null;
let serviceUrl = null;
let quitting = false;
let killTimer = null;

function runtimeRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : __dirname;
}

function loadConfig() {
  const defaults = {
    python: process.platform === 'win32' ? 'python' : 'python3',
    channel: 0,
    demo: false,
    servicePort: 0,
    logDirectory: null,
    rawLogFormat: 'blf',
    autoRecord: false,
    autoPoll: true,
    pollPeriodMs: 1250,
    interFrameMs: 25,
    kiosk: false,
  };
  let config = { ...defaults };
  try {
    const filename = path.join(runtimeRoot(), 'config.json');
    if (fs.existsSync(filename)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(filename, 'utf8')) };
    }
  } catch (error) {
    console.error('config.json parse error:', error.message);
  }

  if (process.env.PYTHON) config.python = process.env.PYTHON;
  if (process.env.KVASER_CHANNEL !== undefined) {
    config.channel = process.env.KVASER_CHANNEL;
  }
  if (process.env.CAN_DEMO === '1') config.demo = true;
  if (process.env.CAN_LOG_DIR) config.logDirectory = process.env.CAN_LOG_DIR;
  if (process.env.CAN_AUTO_RECORD === '1') config.autoRecord = true;
  if (process.env.CAN_AUTO_POLL === '0') config.autoPoll = false;
  if (process.env.CAN_AUTO_POLL === '1') config.autoPoll = true;
  if (process.env.CAN_POLL_PERIOD_MS !== undefined) {
    config.pollPeriodMs = Number(process.env.CAN_POLL_PERIOD_MS);
  }
  if (process.env.CAN_INTER_FRAME_MS !== undefined) {
    config.interFrameMs = Number(process.env.CAN_INTER_FRAME_MS);
  }
  if (process.env.CAN_KIOSK === '1') config.kiosk = true;
  if (process.argv.includes('--demo')) config.demo = true;
  if (process.argv.includes('--kiosk')) config.kiosk = true;
  if (app.isPackaged && process.platform === 'linux' &&
      !process.argv.includes('--windowed')) {
    config.kiosk = true;
  }

  const servicePort = Number(config.servicePort);
  if (!Number.isInteger(servicePort) || servicePort < 0 || servicePort > 65535) {
    config.servicePort = defaults.servicePort;
  } else {
    config.servicePort = servicePort;
  }
  if (!Number.isFinite(Number(config.pollPeriodMs)) || Number(config.pollPeriodMs) <= 0) {
    config.pollPeriodMs = defaults.pollPeriodMs;
  }
  if (!Number.isFinite(Number(config.interFrameMs)) || Number(config.interFrameMs) < 0) {
    config.interFrameMs = defaults.interFrameMs;
  }
  if (!['blf', 'asc', 'log'].includes(config.rawLogFormat)) {
    config.rawLogFormat = defaults.rawLogFormat;
  }
  return config;
}

function cliValue(name) {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) return process.argv[exactIndex + 1] || null;
  const prefix = `${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function resolveLogDirectory(config) {
  if (config.logDirectory) {
    return path.isAbsolute(config.logDirectory)
      ? config.logDirectory
      : path.join(app.getPath('documents'), config.logDirectory);
  }
  return path.join(app.getPath('documents'), 'Sprinter CAN Sessions');
}

function showLaunchError(message) {
  if (!win || win.isDestroyed()) return;
  const safe = String(message).replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
  const html = `<!doctype html><meta charset="utf-8">
    <style>
      body{margin:0;background:#0b0c0e;color:#e8e6e1;font:14px Consolas,monospace;
      display:grid;place-items:center;height:100vh}.box{max-width:720px;padding:28px;
      border:1px solid #532b2b;background:#171315;border-radius:8px}
      h1{color:#ff4d4d;font-size:18px}p{line-height:1.6;color:#b9b7b2}
    </style><div class="box"><h1>Collector service could not start</h1>
    <p>${safe}</p><p>Check Python, python-can, and config.json.</p></div>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function startService() {
  if (quitting || (service && service.exitCode === null)) return;
  const config = loadConfig();
  const root = runtimeRoot();
  const script = path.join(root, 'can_service.py');
  const args = [
    script,
    '--host', '127.0.0.1',
    '--port', String(config.servicePort),
    '--channel', String(config.channel),
    '--poll-period', String(Number(config.pollPeriodMs) / 1000),
    '--inter-frame', String(Number(config.interFrameMs) / 1000),
    '--log-dir', resolveLogDirectory(config),
    '--raw-format', config.rawLogFormat,
    '--renderer-dir', path.join(root, 'renderer'),
  ];
  if (config.demo) args.push('--demo');
  if (config.autoRecord) args.push('--auto-record');
  args.push(config.autoPoll ? '--auto-poll' : '--no-auto-poll');
  const replay = cliValue('--replay');
  const replaySpeed = cliValue('--replay-speed');
  if (replay) args.push('--replay', replay);
  if (replaySpeed) args.push('--replay-speed', replaySpeed);

  const bundledPython = path.join(root, 'runtime', 'python', 'bin', 'python3');
  const candidates = [...new Set([
    fs.existsSync(bundledPython) ? bundledPython : null,
    config.python,
    'python3',
    'python',
  ].filter(Boolean))];

  function tryCandidate(index) {
    if (index >= candidates.length) {
      showLaunchError(
        `Could not start Python. Tried: ${candidates.join(', ')}.`,
      );
      return;
    }
    const executable = candidates[index];
    const environment = { ...process.env };
    const bundledPackages = path.join(root, 'vendor', 'python');
    if (fs.existsSync(bundledPackages)) {
      environment.PYTHONPATH = [
        bundledPackages,
        environment.PYTHONPATH,
      ].filter(Boolean).join(path.delimiter);
      environment.PYTHONNOUSERSITE = '1';
    }
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
    });
    let launched = false;
    let output = '';

    child.once('spawn', () => {
      launched = true;
      service = child;
    });
    child.on('error', (error) => {
      if (!launched && error.code === 'ENOENT') {
        tryCandidate(index + 1);
      } else {
        showLaunchError(error.message);
      }
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'ready' && event.url) {
            serviceUrl = event.url;
            if (win && !win.isDestroyed()) win.loadURL(serviceUrl);
          }
        } catch {
          console.log(`[collector] ${line}`);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      chunk.split(/\r?\n/).filter(Boolean).forEach((line) =>
        console.error(`[collector] ${line}`));
    });
    child.on('exit', (code, signal) => {
      if (service === child) {
        service = null;
        serviceUrl = null;
      }
      if (!quitting) {
        showLaunchError(
          `Collector exited before the app closed (code ${code}` +
          `${signal ? `, signal ${signal}` : ''}).`,
        );
      }
    });
  }

  tryCandidate(0);
}

function createWindow() {
  const config = loadConfig();
  win = new BrowserWindow({
    width: config.kiosk ? 1280 : 1320,
    height: config.kiosk ? 800 : 860,
    minWidth: 1024,
    minHeight: 600,
    kiosk: config.kiosk,
    fullscreen: config.kiosk,
    autoHideMenuBar: true,
    backgroundColor: '#0B0C0E',
    title: 'Sprinter CAN Telemetry',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        void shell.openExternal(target.href).catch(() => {});
      }
    } catch {}
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (serviceUrl && new URL(target).origin === new URL(serviceUrl).origin) return;
    event.preventDefault();
  });
  if (serviceUrl) win.loadURL(serviceUrl);
  else startService();
}

function shutdownService() {
  clearTimeout(killTimer);
  const child = service;
  if (!child || child.exitCode !== null) return;
  try {
    child.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
  } catch {}
  killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill(); } catch {}
    }
  }, 2000);
}

// Reveal the session-logs folder. The directory is resolved here, in the main
// process, so the renderer can't ask us to open an arbitrary path.
ipcMain.handle('open-logs', async () => {
  const dir = resolveLogDirectory(loadConfig());
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const error = await shell.openPath(dir);
  return { ok: !error, path: dir, error: error || undefined };
});

// Render the health-report HTML to a real PDF via an offscreen window, then let
// the user choose where to save it (defaulting into the logs folder).
ipcMain.handle('save-pdf', async (_event, { html, suggestedName }) => {
  const name = String(suggestedName || 'sprinter-can-report.pdf')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  const temporary = path.join(os.tmpdir(), `sprinter-report-${Date.now()}.html`);
  const pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
  });
  try {
    fs.writeFileSync(temporary, String(html), 'utf8');
    await pdfWindow.loadFile(temporary);
    const data = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save report as PDF',
      defaultPath: path.join(resolveLogDirectory(loadConfig()), name),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, data);
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    pdfWindow.destroy();
    try { fs.unlinkSync(temporary); } catch {}
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  shutdownService();
});
