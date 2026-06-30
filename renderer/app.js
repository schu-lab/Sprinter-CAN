'use strict';

/* ====================================================================
   Sprinter CAN Telemetry — renderer.
   Receives collector events via window.bus.onMessage and renders the
   instrument cluster.  All decoding-display logic lives here.
   ==================================================================== */

// The dashboard talks to the standalone collector over same-origin HTTP/SSE.
// Keeping this tiny client behind window.bus preserves the renderer's internal
// message API and also lets tests replace it.
if (!window.bus) {
  const listeners = new Set();
  const notify = (message) => listeners.forEach((listener) => listener(message));
  let events = null;
  const connect = () => {
    if (events) return;
    events = new EventSource('/api/events');
    events.onmessage = (event) => {
      try {
        notify(JSON.parse(event.data));
      } catch {
        notify({ type: 'warn', msg: 'Collector sent an invalid event.' });
      }
    };
    events.onerror = () => {
      notify({
        type: 'status',
        connected: false,
        searching: true,
        msg: 'reconnecting to collector service…',
      });
    };
  };
  window.bus = {
    onMessage: (callback) => {
      listeners.add(callback);
      connect();
      return () => listeners.delete(callback);
    },
    send: async (command) => {
      try {
        const response = await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || `HTTP ${response.status}`);
        }
        return result;
      } catch (error) {
        notify({
          type: 'error',
          msg: `Collector command failed: ${error.message}`,
          retryable: true,
        });
        return null;
      }
    },
  };
}

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const HERO_PIDS = new Set([0x0C, 0x0D, 0x05]); // RPM, Speed, Coolant
const SPECIAL_IDS = new Set([0x7DF, 0x7E0, 0x7E8]); // OBD request/response
const BUS_LINK_BPS = 500000;
const NO_FRAME_HINT_MS = 8000;     // show "no frames" hint after this idle gap
const SPARK_SAMPLES = 60;
const {
  telemetryKey,
  compareTelemetryEntries,
  formatValue,
  computeBusLoad,
  classifyCanId,
  VEHICLE_SYSTEMS,
  buildPidAvailability,
  telemetryDetailFor,
  STATUS_LABELS,
  healthFor,
  evaluateSystemStatus,
  overallSystemStatus,
  systemAlerts,
  escapeHtml: esc,
} = window.TelemetryCore;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  paused: false,
  totalFrames: 0,
  totalFrameBits: 0,
  peakBusLoad: 0,
  frameWindow: [],          // [{t, dlc}] within the last ~1s (for fps + load)
  ids: new Map(),           // id -> complete per-arbitration-ID observation record
  pids: new Map(),          // "ecu:pid[:metric]" -> telemetry reading
  lastFrameTime: 0,
  errored: false,
  connected: false,
  searching: false,         // collector up but no device / reconnecting (hot-plug)
  supported: new Map(),     // ecu(int) -> Map(pid(int) -> name|null)
  supportedBlocks: new Map(), // ecu(int) -> Set(base support-PID responses)
  monitors: new Map(),      // ecu(int) -> {mil, dtc_count, b, c, d}
  scanStart: Date.now(),
  activePage: 'vehicle',
  selectedSystem: 'engine',
  lastVehicleRender: 0,
  lastAlertSignature: '',
  detailTelemetryKey: null,
  recording: {
    active: false,
    started_utc: null,
  },
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  dot: $('conn-dot'),
  connText: $('conn-text'),
  frames: $('stat-frames'),
  fps: $('stat-fps'),
  idsCount: $('stat-ids'),
  load: $('stat-load'),
  loadFill: $('loadbar-fill'),
  banner: $('banner'),
  cards: $('cards'),
  cardsEmpty: $('cards-empty'),
  busBody: $('bus-body'),
  busEmpty: $('bus-empty'),
  scope: $('scope'),
  btnPause: $('btn-pause'),
  btnResume: $('btn-resume'),
  btnClear: $('btn-clear'),
  btnDiscover: $('btn-discover'),
  btnReport: $('btn-report'),
  milBadge: $('mil-badge'),
  recordBadge: $('record-badge'),
  recordElapsed: $('record-elapsed'),
  pollCheck: $('poll-check'),
  pollLabel: $('poll-label'),
  discoverOverlay: $('discover-overlay'),
  discoverContent: $('discover-content'),
  btnDiscoverClose: $('btn-discover-close'),
  btnRecord: $('btn-record'),
  logInfoLabel: $('log-info-label'),
  logInfoPath: $('log-info-path'),
  btnOpenLogs: $('btn-open-logs'),
  telemetryOverlay: $('telemetry-overlay'),
  btnTelemetryClose: $('btn-telemetry-close'),
  telemetryDetailCode: $('telemetry-detail-code'),
  telemetryDetailTitle: $('telemetry-detail-title'),
  telemetryDetailReading: $('telemetry-detail-reading'),
  telemetryDetailValue: $('telemetry-detail-value'),
  telemetryDetailUnit: $('telemetry-detail-unit'),
  telemetryDetailHealth: $('telemetry-detail-health'),
  telemetryDetailSpark: $('telemetry-detail-spark'),
  telemetryDetailSummary: $('telemetry-detail-summary'),
  telemetryDetailWatch: $('telemetry-detail-watch'),
  telemetryDetailNote: $('telemetry-detail-note'),
  telemetryDetailEcu: $('telemetry-detail-ecu'),
  telemetryDetailSource: $('telemetry-detail-source'),
  telemetryDetailSystems: $('telemetry-detail-systems'),
  telemetryDetailAge: $('telemetry-detail-age'),
  telemetryDetailRange: $('telemetry-detail-range'),
  telemetryDetailSamples: $('telemetry-detail-samples'),
  viewButtons: [...document.querySelectorAll('[data-page]')],
  viewPages: [...document.querySelectorAll('[data-page-panel]')],
  systemTargets: [...document.querySelectorAll('[data-system]')],
  systemStateLabels: [...document.querySelectorAll('[data-system-state]')],
  systemHighlights: [...document.querySelectorAll('[data-highlight-system]')],
  vehicleOverall: $('vehicle-overall'),
  vehicleOverallLabel: $('vehicle-overall-label'),
  vehicleAlertCount: $('vehicle-alert-count'),
  vehicleAlertList: $('vehicle-alert-list'),
  systemDomain: $('system-domain'),
  systemDetails: $('system-details'),
  systemTitle: $('system-title'),
  systemDescription: $('system-description'),
  systemPath: $('system-path'),
  systemSummary: $('system-summary'),
  systemReadings: $('system-readings'),
  systemStatusPill: $('system-status-pill'),
  systemStatusLabel: $('system-status-label'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hexId(id) {
  return '0x' + id.toString(16).toUpperCase().padStart(3, '0');
}

function formatData(hex) {
  // Group hex string into space-separated byte pairs.
  return (hex.match(/../g) || []).join(' ').toUpperCase();
}

function setActivePage(page) {
  if (!el.viewPages.some((panel) => panel.dataset.pagePanel === page)) return;
  state.activePage = page;
  el.viewPages.forEach((panel) => {
    panel.hidden = panel.dataset.pagePanel !== page;
  });
  el.viewButtons.forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (page === 'vehicle') renderVehicleSystems(Date.now(), true);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function handleFrame(msg) {
  const now = performance.now();
  state.lastFrameTime = now;
  state.totalFrames++;
  state.totalFrameBits += 47 + 8 * msg.dlc;
  state.frameWindow.push({ t: now, dlc: msg.dlc });

  let rec = state.ids.get(msg.id);
  if (!rec) {
    rec = {
      dlc: msg.dlc,
      minDlc: msg.dlc,
      maxDlc: msg.dlc,
      data: msg.data,
      count: 0,
      changes: 0,
      ext: !!msg.ext,
      firstSeen: now,
      lastSeen: now,
      times: [],
      flashUntil: 0,
      row: null,
    };
    state.ids.set(msg.id, rec);
  }
  if (msg.data !== rec.data) {
    rec.flashUntil = now + 600;
    rec.changes++;
  }
  rec.dlc = msg.dlc;
  rec.minDlc = Math.min(rec.minDlc, msg.dlc);
  rec.maxDlc = Math.max(rec.maxDlc, msg.dlc);
  rec.ext = rec.ext || !!msg.ext;
  rec.data = msg.data;
  rec.count++;
  rec.lastSeen = now;
  rec.times.push(now);
  const cutoff = now - 1000;
  while (rec.times.length && rec.times[0] < cutoff) rec.times.shift();
}

function handlePid(msg) {
  const ecu = Number.isInteger(msg.ecu) ? msg.ecu : null;
  const metric = typeof msg.metric === 'string' ? msg.metric : null;
  const key = telemetryKey(ecu, msg.pid, metric);
  let p = state.pids.get(key);
  if (!p) {
    p = {
      ecu, pid: msg.pid, metric, name: msg.name, unit: msg.unit,
      value: msg.value, updatedAt: Date.now(), history: [], el: null,
    };
    state.pids.set(key, p);
  }
  p.value = msg.value;
  p.unit = msg.unit;
  p.name = msg.name;
  p.updatedAt = Date.now();
  p.history.push(msg.value);
  if (p.history.length > SPARK_SAMPLES) p.history.shift();
}

function handleStatus(msg) {
  if (typeof msg.connected === 'boolean') state.connected = msg.connected;
  if (typeof msg.searching === 'boolean') state.searching = msg.searching;
  if (typeof msg.poll === 'boolean') setPollUI(msg.poll);

  if (msg.connected === true) {
    // Bus is actually open — clear any "no device" / searching banner outright.
    state.errored = false;
    state.searching = false;
    hintActive = false;
    clearBanner();
  } else if (state.searching) {
    // Actively reconnecting (hot-plug). Treat as benign, not a hard error.
    state.errored = false;
    showBanner('hint',
      '🔌 ' + (msg.msg || 'Searching for Kvaser device…') +
      ' — will connect automatically when the U100 is plugged in.');
  }
  if (msg.msg) el.connText.textContent = msg.msg;
}

function handleError(msg) {
  if (msg.retryable === true) {
    // A bus-open failure during the hot-plug retry loop is expected — surface
    // the detail as an amber hint, not a red error, and keep retrying.
    state.searching = true;
    state.errored = false;
    showBanner('hint', '🔌 ' + (msg.msg || 'Searching…'));
    return;
  }
  state.errored = true;
  state.searching = false;
  showBanner('error', '⛔ ' + (msg.msg || 'Unknown error'));
}

let discoverTimer = null;
function handleSupported(msg) {
  let m = state.supported.get(msg.ecu);
  if (!m) { m = new Map(); state.supported.set(msg.ecu, m); }
  let blocks = state.supportedBlocks.get(msg.ecu);
  if (!blocks) {
    blocks = new Set();
    state.supportedBlocks.set(msg.ecu, blocks);
  }
  if (Number.isInteger(msg.base)) blocks.add(msg.base);
  (msg.pids || []).forEach((pid) => {
    const name = msg.names
      ? (msg.names[pid] ?? msg.names[String(pid)] ?? null)
      : null;
    m.set(pid, name);
  });
  clearTimeout(discoverTimer);
  renderDiscover();
}

function handleMonitors(msg) {
  state.monitors.set(msg.ecu, {
    mil: !!msg.mil, dtc_count: msg.dtc_count | 0,
    b: msg.b | 0, c: msg.c | 0, d: msg.d | 0,
    updatedAt: Date.now(),
  });
}

function handleRecording(msg) {
  state.recording = { ...state.recording, ...msg };
  el.btnRecord.textContent = msg.active ? 'Stop Log' : 'Start Log';
  el.btnRecord.classList.toggle('recording', !!msg.active);
  el.btnRecord.disabled = false;
  el.recordBadge.hidden = !msg.active;
  updateLogLocation();
}

// Show where session logs live: the base folder when idle, the live session
// folder while recording, and the last saved session after a stop.
function updateLogLocation() {
  const rec = state.recording;
  const base = rec.base_directory;
  if (!base) return;
  let label = 'Logs →';
  let path = base;
  if (rec.active && rec.path) {
    label = 'Recording →';
    path = rec.path;
  } else if (rec.path) {
    label = 'Last log →';
    path = rec.path;
  }
  el.logInfoLabel.textContent = label;
  el.logInfoPath.textContent = path;
  el.logInfoPath.title = `Session logs are stored in ${base}`;
}

let warnTimer = null;
function handleWarn(msg) {
  if (state.errored) return; // never paper over a real error
  showBanner('hint', '⚠ ' + (msg.msg || 'warning'));
  clearTimeout(warnTimer);
  warnTimer = setTimeout(() => {
    if (el.banner.dataset.kind === 'hint' && !hintActive) clearBanner();
  }, 4000);
}

window.bus.onMessage((msg) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'frame':
      handleFrame(msg);
      break;
    case 'pid':
      handlePid(msg);
      break;
    case 'status':
      handleStatus(msg);
      break;
    case 'error':
      handleError(msg);
      break;
    case 'warn':
      handleWarn(msg);
      break;
    case 'supported':
      handleSupported(msg);
      break;
    case 'monitors':
      handleMonitors(msg);
      break;
    case 'recording':
      handleRecording(msg);
      break;
    case 'log':
      // surface in connection text without spamming banner
      if (msg.msg) el.connText.textContent = msg.msg;
      break;
  }
});

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------
let hintActive = false;
function showBanner(kind, text) {
  el.banner.hidden = false;
  el.banner.dataset.kind = kind;
  el.banner.textContent = text;
}
function clearBanner() {
  el.banner.hidden = true;
  el.banner.textContent = '';
}

// ---------------------------------------------------------------------------
// Render loop (~10 Hz for tables/cards; scope animates on its own rAF)
// ---------------------------------------------------------------------------
function trimWindow(now) {
  const cutoff = now - 1000;
  while (state.frameWindow.length && state.frameWindow[0].t < cutoff) {
    state.frameWindow.shift();
  }
}

function updateHeader(now) {
  trimWindow(now);
  const fps = state.frameWindow.length; // frames in last 1s
  el.frames.textContent = state.totalFrames.toLocaleString();
  el.fps.textContent = fps;
  el.idsCount.textContent = state.ids.size;
  const load = computeBusLoad(state.frameWindow, BUS_LINK_BPS);
  state.peakBusLoad = Math.max(state.peakBusLoad, load);
  el.load.textContent = load.toFixed(1) + '%';
  el.loadFill.style.width = load.toFixed(1) + '%';

  // connection dot:
  //   green  = bus open and frames flowing
  //   amber  = searching for device (hot-plug) OR connected but idle
  //   red    = a hard error (e.g. no Python interpreter)
  const recent = now - state.lastFrameTime < 2000 && state.lastFrameTime > 0;
  let st;
  if (state.errored) st = 'error';
  else if (recent) st = 'ok';
  else st = 'idle';
  el.dot.dataset.state = st;

  // Check-engine badge: any module reporting MIL on or stored DTCs.
  let mil = false, dtcTotal = 0;
  state.monitors.forEach((m) => { mil = mil || m.mil; dtcTotal += m.dtc_count; });
  if (mil || dtcTotal > 0) {
    el.milBadge.hidden = false;
    el.milBadge.textContent = '● CEL' + (dtcTotal ? ` (${dtcTotal})` : '');
  } else {
    el.milBadge.hidden = true;
  }
  if (state.recording.active && state.recording.started_utc) {
    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - Date.parse(state.recording.started_utc)) / 1000),
    );
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = String(elapsedSeconds % 60).padStart(2, '0');
    el.recordElapsed.textContent = `REC ${minutes}:${seconds}`;
  }

  // No-frames hint (only when actually connected to the bus, not searching/errored)
  if (state.connected && !state.searching && !state.errored &&
      (state.lastFrameTime === 0 || now - state.lastFrameTime > NO_FRAME_HINT_MS)) {
    if (!hintActive) {
      hintActive = true;
      showBanner('hint',
        '⚠ No frames received. Check ignition is ON and the U100 is on the ' +
        'correct (OBD) bus. This diagnostic bus is largely request/response — ' +
        'try enabling Poll PIDs (while parked).');
    }
  } else if (hintActive) {
    hintActive = false;
    // Only clear if the current banner is the hint — never stomp an error banner.
    if (el.banner.dataset.kind === 'hint') clearBanner();
  }

  return fps;
}

function renderCards() {
  el.cardsEmpty.style.display = state.pids.size ? 'none' : '';
  const entries = [...state.pids.entries()].sort(compareTelemetryEntries);
  for (const [, p] of entries) {
    if (!p.el) p.el = createCard(p);
    p.el.valueEl.textContent = formatValue(p.value, p.pid, p.unit);
    p.el.unitEl.textContent = p.unit;
    p.el.card.setAttribute(
      'aria-label',
      `${p.name}, ${formatValue(p.value, p.pid, p.unit)} ${p.unit}. Open details.`,
    );
    drawSpark(p.el.spark, p.history, HERO_PIDS.has(p.pid));
  }
}

function createCard(p) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card' + (HERO_PIDS.has(p.pid) ? ' hero' : '');
  card.title = 'Open telemetry details';

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = p.name;

  const pidTag = document.createElement('div');
  pidTag.className = 'card-pid';
  const ecuTag = Number.isInteger(p.ecu) ? `ECU ${hexId(p.ecu)} · ` : '';
  pidTag.textContent = ecuTag + 'PID 0x' +
    p.pid.toString(16).toUpperCase().padStart(2, '0') +
    (p.metric ? ` · ${p.metric.toUpperCase()}` : '');

  const valLine = document.createElement('div');
  const valueEl = document.createElement('span');
  valueEl.className = 'card-value';
  const unitEl = document.createElement('span');
  unitEl.className = 'card-unit';
  valLine.appendChild(valueEl);
  valLine.appendChild(unitEl);

  const spark = document.createElement('canvas');
  spark.className = 'card-spark';

  const action = document.createElement('span');
  action.className = 'card-action';
  action.textContent = 'OPEN DETAILS';

  card.append(name, pidTag, valLine, spark, action);
  card.addEventListener('click', () => showTelemetryDetail(p, card));
  el.cards.appendChild(card);

  return { card, valueEl, unitEl, spark };
}

function drawSpark(canvas, history, hero) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 150;
  const h = canvas.clientHeight || (hero ? 40 : 28);
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (history.length < 2) return;

  let min = Math.min(...history), max = Math.max(...history);
  if (max - min < 1e-6) { max += 1; min -= 1; }
  const pad = 2;
  const span = max - min;

  ctx.beginPath();
  history.forEach((v, i) => {
    const x = (i / (history.length - 1)) * (w - pad * 2) + pad;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#35E0D0';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // last-point dot
  const lx = w - pad, ly = h - pad - ((history[history.length - 1] - min) / span) * (h - pad * 2);
  ctx.beginPath();
  ctx.arc(lx, ly, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = '#FFB627';
  ctx.fill();
}

let telemetryDetailTrigger = null;

function telemetryHealth(pid, value) {
  const health = healthFor(pid, value);
  if (health.level === 'med') {
    return { status: 'critical', label: 'CHECK', note: health.note };
  }
  if (health.level === 'low') {
    return { status: 'warning', label: 'NOTICE', note: health.note };
  }
  if (health.level === 'ok') {
    return { status: 'healthy', label: 'IN RANGE', note: health.note };
  }
  return {
    status: 'live',
    label: 'LIVE',
    note: 'No simple app threshold is configured for this parameter.',
  };
}

function renderTelemetryDetail() {
  if (el.telemetryOverlay.hidden || !state.detailTelemetryKey) return;
  const reading = state.pids.get(state.detailTelemetryKey);
  if (!reading) {
    closeTelemetryDetail();
    return;
  }

  const detail = telemetryDetailFor(reading.pid);
  const health = telemetryHealth(reading.pid, reading.value);
  const history = reading.history.filter(Number.isFinite);
  const age = Math.max(0, (Date.now() - reading.updatedAt) / 1000);
  const minimum = history.length ? Math.min(...history) : reading.value;
  const maximum = history.length ? Math.max(...history) : reading.value;
  const unitSuffix = reading.unit ? ` ${reading.unit}` : '';

  el.telemetryDetailCode.textContent =
    `${Number.isInteger(reading.ecu) ? hexId(reading.ecu) : 'ECU —'} · ${hexPid(reading.pid)}`;
  el.telemetryDetailTitle.textContent = reading.name.toUpperCase();
  el.telemetryDetailReading.dataset.status = health.status;
  el.telemetryDetailValue.textContent =
    formatValue(reading.value, reading.pid, reading.unit);
  el.telemetryDetailUnit.textContent = reading.unit;
  el.telemetryDetailHealth.textContent = health.label;
  el.telemetryDetailSummary.textContent = detail.summary;
  el.telemetryDetailWatch.textContent = detail.watch;
  el.telemetryDetailNote.textContent = health.note;
  el.telemetryDetailEcu.textContent =
    Number.isInteger(reading.ecu) ? hexId(reading.ecu) : 'Unknown';
  el.telemetryDetailSource.textContent = `${detail.source} · ${hexPid(reading.pid)}`;
  el.telemetryDetailSystems.textContent = detail.systems.join(' · ') || 'Unassigned';
  el.telemetryDetailAge.textContent = age < 10 ? `${age.toFixed(1)}s ago` : `${Math.round(age)}s ago`;
  el.telemetryDetailRange.textContent =
    `${formatValue(minimum, reading.pid, reading.unit)}–` +
    `${formatValue(maximum, reading.pid, reading.unit)}${unitSuffix}`;
  el.telemetryDetailSamples.textContent = history.length;
  drawSpark(el.telemetryDetailSpark, history, true);
}

function showTelemetryDetail(reading, trigger) {
  state.detailTelemetryKey = telemetryKey(reading.ecu, reading.pid, reading.metric);
  telemetryDetailTrigger = trigger || null;
  el.telemetryOverlay.hidden = false;
  renderTelemetryDetail();
  el.btnTelemetryClose.focus();
}

function closeTelemetryDetail() {
  if (el.telemetryOverlay.hidden) return;
  el.telemetryOverlay.hidden = true;
  state.detailTelemetryKey = null;
  const trigger = telemetryDetailTrigger;
  telemetryDetailTrigger = null;
  if (trigger && trigger.isConnected) trigger.focus();
}

function renderBusTable(now) {
  const hasRows = state.ids.size > 0;
  el.busEmpty.style.display = hasRows ? 'none' : '';

  const entries = [...state.ids.entries()].sort((a, b) => a[0] - b[0]);
  for (const [id, rec] of entries) {
    if (!rec.row) rec.row = createRow(id);
    // rolling Hz: count timestamps in last 1s
    const cutoff = now - 1000;
    while (rec.times.length && rec.times[0] < cutoff) rec.times.shift();
    const hz = rec.times.length;
    const ageSec = (now - rec.lastSeen) / 1000;

    rec.row.dlc.textContent = rec.dlc;
    rec.row.data.textContent = formatData(rec.data);
    rec.row.hz.textContent = hz;
    rec.row.count.textContent = rec.count.toLocaleString();
    rec.row.age.textContent = ageSec < 10 ? ageSec.toFixed(1) + 's' : Math.round(ageSec) + 's';

    // flash on data change
    if (!REDUCED_MOTION && rec.flashUntil > now) {
      if (!rec.row.tr.classList.contains('flash')) {
        rec.row.tr.classList.add('flash');
      }
    } else if (rec.row.tr.classList.contains('flash') && rec.flashUntil <= now) {
      rec.row.tr.classList.remove('flash');
    }

    // keep DOM order sorted by id
    el.busBody.appendChild(rec.row.tr);
  }
}

function createRow(id) {
  const tr = document.createElement('tr');
  if (SPECIAL_IDS.has(id)) tr.classList.add('special');
  const cId = cell('c-id', hexId(id));
  const cDlc = cell('c-dlc', '');
  const cData = cell('c-data', '');
  const cHz = cell('c-hz', '');
  const cCount = cell('c-count', '');
  const cAge = cell('c-age', '');
  tr.append(cId, cDlc, cData, cHz, cCount, cAge);
  el.busBody.appendChild(tr);
  return { tr, dlc: cDlc, data: cData, hz: cHz, count: cCount, age: cAge };
}

function cell(cls, text) {
  const td = document.createElement('td');
  td.className = cls;
  td.textContent = text;
  return td;
}

// ---------------------------------------------------------------------------
// Vehicle system map
// ---------------------------------------------------------------------------
function systemSnapshots(nowMs) {
  const readings = [...state.pids.values()];
  const monitors = [...state.monitors.entries()].map(([ecu, monitor]) => ({
    ecu,
    ...monitor,
  }));
  return VEHICLE_SYSTEMS.map((system) => ({
    system,
    ...evaluateSystemStatus(system, readings, monitors, state.connected, nowMs),
  }));
}

function readingStatus(pid, value) {
  const health = healthFor(pid, value);
  if (health.level === 'med') return { status: 'critical', note: health.note };
  if (health.level === 'low') return { status: 'warning', note: health.note };
  return { status: 'healthy', note: health.note };
}

function selectSystem(systemId) {
  if (!VEHICLE_SYSTEMS.some((system) => system.id === systemId)) return;
  state.selectedSystem = systemId;
  renderVehicleSystems(Date.now(), true);
}

function renderVehicleAlerts(snapshots) {
  const alerts = systemAlerts(snapshots, state.connected);
  const signature = JSON.stringify(alerts.map((alert) => [
    alert.id, alert.status, alert.summary,
  ]));
  if (signature === state.lastAlertSignature) return;
  state.lastAlertSignature = signature;

  const activeCount = alerts.filter((alert) =>
    alert.status === 'critical' || alert.status === 'warning').length;
  el.vehicleAlertCount.dataset.state = activeCount
    ? 'active'
    : (state.connected ? 'clear' : 'offline');
  el.vehicleAlertCount.textContent = activeCount
    ? `${activeCount} ACTIVE`
    : (state.connected ? 'NO ACTIVE' : 'OFFLINE');

  if (!alerts.length) {
    el.vehicleAlertList.innerHTML = `<div class="vehicle-alert-empty">
      <span>&#10003;</span>
      <strong>No active warnings</strong>
      <p>Current observed signals have no warning or critical flags.</p>
    </div>`;
    return;
  }

  el.vehicleAlertList.innerHTML = alerts.map((alert) => {
    const status = STATUS_LABELS[alert.status] || alert.status.toUpperCase();
    const contents = `<div class="vehicle-alert-meta">
        <span>${esc(status)}</span><span>${esc(alert.domain)}</span>
      </div>
      <strong>${esc(alert.title)}</strong>
      <p>${esc(alert.summary)}</p>
      ${alert.systemId
        ? '<span class="vehicle-alert-action">View system evidence &rarr;</span>'
        : ''}`;
    return alert.systemId
      ? `<button class="vehicle-alert-card" data-status="${alert.status}"
          data-alert-system="${esc(alert.systemId)}">${contents}</button>`
      : `<article class="vehicle-alert-card static"
          data-status="${alert.status}">${contents}</article>`;
  }).join('');
}

function renderSystemDetails(snapshot, nowMs) {
  const { system } = snapshot;
  el.systemDomain.textContent = system.domain.toUpperCase();
  el.systemTitle.textContent = system.label.toUpperCase();
  el.systemDescription.textContent = system.description;
  el.systemPath.textContent = system.path;
  el.systemSummary.textContent = snapshot.summary;
  el.systemStatusPill.dataset.status = snapshot.status;
  el.systemStatusLabel.textContent = STATUS_LABELS[snapshot.status];

  const readingHtml = [...snapshot.readings]
    .sort((a, b) => a.pid - b.pid || (a.ecu ?? 0) - (b.ecu ?? 0))
    .map((reading) => {
      const result = readingStatus(reading.pid, reading.value);
      const age = Math.max(0, (nowMs - reading.updatedAt) / 1000);
      const ecu = Number.isInteger(reading.ecu) ? hexId(reading.ecu) : 'ECU —';
      const note = result.note || `${age.toFixed(1)}s old`;
      const key = telemetryKey(reading.ecu, reading.pid, reading.metric);
      return `<article class="system-reading" data-level="${result.status}"
          data-telemetry-key="${esc(key)}" tabindex="0" role="button"
          title="Open telemetry details">
        <div class="system-reading-top">
          <span>${esc(reading.name)}</span>
          <span>${hexPid(reading.pid)}</span>
        </div>
        <div class="system-reading-value">${esc(formatValue(
          reading.value, reading.pid, reading.unit,
        ))}<span class="system-reading-unit">${esc(reading.unit)}</span></div>
        <div class="system-reading-note">${ecu} · ${esc(note)}</div>
      </article>`;
    });

  const monitorHtml = snapshot.monitors.map((monitor) => {
    const status = monitor.mil ? 'critical' : (monitor.dtc_count ? 'warning' : 'healthy');
    const age = Math.max(0, (nowMs - monitor.updatedAt) / 1000);
    return `<article class="system-reading" data-level="${status}">
      <div class="system-reading-top">
        <span>MONITOR STATUS</span><span>${hexId(monitor.ecu)}</span>
      </div>
      <div class="system-reading-value">${monitor.mil ? 'MIL ON' : 'MIL OFF'}</div>
      <div class="system-reading-note">${monitor.dtc_count} stored DTC(s) · ${age.toFixed(1)}s old</div>
    </article>`;
  });

  const allHtml = [...monitorHtml, ...readingHtml];
  el.systemReadings.innerHTML = allHtml.length
    ? allHtml.join('')
    : `<div class="system-reading-empty">${
      snapshot.status === 'offline'
        ? 'This system has no current evidence. Reconnect or resume polling.'
        : 'No applicable standard OBD signals have been observed for this system.'
    }</div>`;
}

function renderVehicleSystems(nowMs, force = false) {
  if (state.activePage !== 'vehicle' && !force) return;
  if (!force && nowMs - state.lastVehicleRender < 250) return;
  state.lastVehicleRender = nowMs;

  const snapshots = systemSnapshots(nowMs);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.system.id, snapshot]));
  el.systemTargets.forEach((target) => {
    const snapshot = byId.get(target.dataset.system);
    if (!snapshot) return;
    const selected = target.dataset.system === state.selectedSystem;
    target.dataset.status = snapshot.status;
    target.classList.toggle('selected', selected);
    if (target.classList.contains('system-node')) {
      target.setAttribute(
        'aria-label',
        `${snapshot.system.label}: ${STATUS_LABELS[snapshot.status]}`,
      );
      target.setAttribute('aria-pressed', String(selected));
    }
  });
  el.systemStateLabels.forEach((label) => {
    const snapshot = byId.get(label.dataset.systemState);
    if (snapshot) label.textContent = STATUS_LABELS[snapshot.status];
  });
  el.systemHighlights.forEach((highlight) => {
    highlight.classList.toggle(
      'selected',
      highlight.dataset.highlightSystem === state.selectedSystem,
    );
  });

  const overall = overallSystemStatus(snapshots, state.connected);
  el.vehicleOverall.dataset.status = overall;
  el.vehicleOverallLabel.textContent = STATUS_LABELS[overall];
  renderVehicleAlerts(snapshots);

  const selected = byId.get(state.selectedSystem) || snapshots[0];
  renderSystemDetails(selected, nowMs);
}

function renderTick() {
  const now = performance.now();
  updateHeader(now);
  if (!state.paused) {
    renderCards();
    renderBusTable(now);
    renderVehicleSystems(Date.now());
    renderTelemetryDetail();
  }
}
setInterval(renderTick, 100);

// ---------------------------------------------------------------------------
// Scope pulse — activity scaled by frames/sec
// ---------------------------------------------------------------------------
const scopeCtx = el.scope.getContext('2d');
const scopeBuf = new Array(110).fill(0);
function scopeFrame() {
  const w = el.scope.width, h = el.scope.height;
  const fps = state.frameWindow.length;
  const activity = Math.min(1, fps / 200); // normalize
  // push a new sample: jittered around activity
  const jitter = REDUCED_MOTION ? activity : activity * (0.5 + Math.random());
  scopeBuf.push(jitter);
  scopeBuf.shift();

  scopeCtx.clearRect(0, 0, w, h);
  // baseline grid
  scopeCtx.strokeStyle = '#23262D';
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, h / 2); scopeCtx.lineTo(w, h / 2);
  scopeCtx.stroke();

  scopeCtx.beginPath();
  scopeBuf.forEach((v, i) => {
    const x = (i / (scopeBuf.length - 1)) * w;
    const y = h / 2 - (v * (h / 2 - 2)) * (i % 2 ? 1 : -1);
    i === 0 ? scopeCtx.moveTo(x, y) : scopeCtx.lineTo(x, y);
  });
  scopeCtx.strokeStyle = fps > 0 ? '#FFB627' : '#8A6A1F';
  scopeCtx.lineWidth = 1.2;
  scopeCtx.stroke();

  requestAnimationFrame(scopeFrame);
}
requestAnimationFrame(scopeFrame);

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
el.viewButtons.forEach((button) => {
  button.addEventListener('click', () => setActivePage(button.dataset.page));
});

el.systemTargets.forEach((target) => {
  target.addEventListener('click', () => selectSystem(target.dataset.system));
});

function openSystemReading(target) {
  const reading = state.pids.get(target.dataset.telemetryKey);
  if (reading) showTelemetryDetail(reading, target);
}

el.systemReadings.addEventListener('click', (event) => {
  const target = event.target.closest('[data-telemetry-key]');
  if (target) openSystemReading(target);
});
el.systemReadings.addEventListener('keydown', (event) => {
  const target = event.target.closest('[data-telemetry-key]');
  if (target && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openSystemReading(target);
  }
});

el.vehicleAlertList.addEventListener('click', (event) => {
  const card = event.target.closest('[data-alert-system]');
  if (!card) return;
  selectSystem(card.dataset.alertSystem);
  el.systemDetails.scrollIntoView({
    behavior: REDUCED_MOTION ? 'auto' : 'smooth',
    block: 'nearest',
  });
});

el.btnPause.addEventListener('click', () => {
  state.paused = true;
  el.btnPause.disabled = true;
  el.btnResume.disabled = false;
  el.connText.textContent = 'display paused · capture continues';
});
el.btnResume.addEventListener('click', () => {
  state.paused = false;
  el.btnPause.disabled = false;
  el.btnResume.disabled = true;
  el.connText.textContent = 'display resumed';
});
el.btnClear.addEventListener('click', () => {
  state.totalFrames = 0;
  state.totalFrameBits = 0;
  state.peakBusLoad = 0;
  state.frameWindow = [];
  state.ids.clear();
  state.pids.clear();
  state.supported.clear();
  state.supportedBlocks.clear();
  state.monitors.clear();
  state.scanStart = Date.now();
  state.lastFrameTime = 0;
  el.busBody.innerHTML = '';
  el.cards.innerHTML = '';
  el.busEmpty.style.display = '';
  el.cardsEmpty.style.display = '';
});

el.btnRecord.addEventListener('click', () => {
  el.btnRecord.disabled = true;
  window.bus.send({ cmd: 'record', on: !state.recording.active });
});

// "Open folder" only works in the Electron shell (needs the main process).
// In a plain browser the button stays hidden; the path text is still shown.
if (window.desktop && typeof window.desktop.openLogs === 'function') {
  el.btnOpenLogs.hidden = false;
  el.btnOpenLogs.addEventListener('click', () => {
    Promise.resolve(window.desktop.openLogs()).catch(() => {});
  });
}

function setPollUI(on) {
  el.pollCheck.checked = on;
  el.pollLabel.textContent = on ? 'Polling OBD' : 'PID polling off';
}
el.pollCheck.addEventListener('change', () => {
  const on = el.pollCheck.checked;
  window.bus.send({ cmd: 'poll', on });
  setPollUI(on); // optimistic; collector echoes a status to confirm
});

// ---------------------------------------------------------------------------
// Supported-PID discovery
// ---------------------------------------------------------------------------
function hexPid(pid) {
  return '0x' + pid.toString(16).toUpperCase().padStart(2, '0');
}

function renderDiscover() {
  const ecus = [...state.supported.entries()].sort((a, b) => a[0] - b[0]);
  if (!ecus.length) {
    el.discoverContent.innerHTML =
      '<div class="overlay-empty">Scanning… no responses yet.</div>';
    return;
  }
  let html = '';
  for (const [ecu, pidMap] of ecus) {
    const pids = buildPidAvailability(
      pidMap,
      state.supportedBlocks.get(ecu) || new Set(),
    );
    const decoded = pids.filter((pid) => pid.status === 'decoded').length;
    const undecoded = pids.filter((pid) => pid.status === 'undecoded').length;
    const unavailable = pids.filter((pid) => pid.status === 'unavailable').length;
    html += '<div class="ecu-block">';
    html += `<div class="ecu-title">ECU ${hexId(ecu)}` +
            `<span class="ecu-count">${pidMap.size} supported · ${decoded} decoded` +
            ` · ${undecoded} not decoded · ${unavailable} unavailable</span></div>`;
    html += '<div class="pid-grid">';
    for (const pid of pids) {
      const label = pid.name || 'SAE / manufacturer PID';
      const stateLabel = pid.status === 'decoded'
        ? 'decoded by this app'
        : (pid.status === 'undecoded'
          ? 'supported · decoder not implemented'
          : 'not available from this ECU');
      html += `<div class="pid-chip ${pid.status}">` +
              `<span class="pid-code">${hexPid(pid.pid)}</span>` +
              `<span class="pid-name">${esc(label)}</span>` +
              `<span class="pid-state">${esc(stateLabel)}</span></div>`;
    }
    html += '</div></div>';
  }
  el.discoverContent.innerHTML = html;
}

function openDiscover() {
  el.discoverOverlay.hidden = false;
  renderDiscover();
}
function closeDiscover() {
  el.discoverOverlay.hidden = true;
}

el.btnDiscover.addEventListener('click', () => {
  state.supported.clear();
  state.supportedBlocks.clear();
  window.bus.send({ cmd: 'discover' });
  openDiscover();
  // If nothing answers within a few seconds, say so instead of "scanning…".
  clearTimeout(discoverTimer);
  discoverTimer = setTimeout(() => {
    if (!state.supported.size) {
      el.discoverContent.innerHTML =
        '<div class="overlay-empty">No responses. Is the bus connected and ' +
        'the ignition ON? Discovery transmits requests — run it while parked.</div>';
    }
  }, 4000);
});
el.btnDiscoverClose.addEventListener('click', closeDiscover);
el.discoverOverlay.addEventListener('click', (e) => {
  if (e.target === el.discoverOverlay) closeDiscover();
});
el.btnTelemetryClose.addEventListener('click', closeTelemetryDetail);
el.telemetryOverlay.addEventListener('click', (event) => {
  if (event.target === el.telemetryOverlay) closeTelemetryDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.telemetryOverlay.hidden) {
    closeTelemetryDetail();
    return;
  }
  if (e.key === 'Escape' && !el.discoverOverlay.hidden) closeDiscover();
});

function buildReportData() {
  const now = new Date();
  const nowMs = performance.now();
  const scanDurationSec = Math.max(0.001, (Date.now() - state.scanStart) / 1000);

  // Include modules learned from discovery, monitor replies, decoded PID
  // traffic, and raw OBD response IDs. An ECU should not disappear from the
  // report merely because the capability sweep was not run.
  const ecuSet = new Set([...state.supported.keys(), ...state.monitors.keys()]);
  state.pids.forEach((pid) => {
    if (Number.isInteger(pid.ecu)) ecuSet.add(pid.ecu);
  });
  state.ids.forEach((_record, id) => {
    if (id >= 0x7E8 && id <= 0x7EF) ecuSet.add(id);
  });
  const ecus = [...ecuSet].sort((a, b) => a - b).map((ecu) => {
    const pidMap = state.supported.get(ecu) || new Map();
    const pids = [...pidMap.entries()].sort((a, b) => a[0] - b[0]).map(([pid, name]) => ({
      pid, code: hexPid(pid), name: name || null, decoded: !!name,
    }));
    const mon = state.monitors.get(ecu) || null;
    return {
      ecu, id: hexId(ecu),
      supportedCount: pids.length,
      decodedCount: pids.filter((p) => p.decoded).length,
      pids,
      monitors: mon,
    };
  });

  const telemetry = [...state.pids.entries()].sort(compareTelemetryEntries).map(([, p]) => {
    const h = healthFor(p.pid, p.value);
    return {
      ecu: p.ecu,
      ecuCode: Number.isInteger(p.ecu) ? hexId(p.ecu) : '—',
      pid: p.pid, code: hexPid(p.pid),
      metric: p.metric || null,
      name: p.name, value: p.value, unit: p.unit,
      level: h.level, note: h.note,
    };
  });

  const census = [...state.ids.entries()].sort((a, b) => a[0] - b[0]).map(([id, rec]) => {
    const classification = classifyCanId(id, rec.ext);
    return {
      numericId: id,
      id: hexId(id),
      format: classification.format,
      role: classification.role,
      dlc: rec.dlc,
      minDlc: rec.minDlc,
      maxDlc: rec.maxDlc,
      data: formatData(rec.data),
      count: rec.count,
      dataChanges: rec.changes,
      averageHz: rec.count / scanDurationSec,
      lastSeenAgeSec: Math.max(0, (nowMs - rec.lastSeen) / 1000),
      observedForSec: Math.max(0, (rec.lastSeen - rec.firstSeen) / 1000),
    };
  });

  const countRole = (role) =>
    census.filter((record) => record.role === role).length;
  const network = {
    standardIds: census.filter((record) => record.format === '11-bit').length,
    extendedIds: census.filter((record) => record.format === '29-bit').length,
    functionalRequests: countRole('Functional OBD request'),
    physicalRequests: countRole('Physical diagnostic request'),
    ecuResponses: countRole('Diagnostic ECU response'),
    broadcasts: countRole('Broadcast / not decoded'),
    averageBusLoadPct: Math.min(
      100,
      (state.totalFrameBits / scanDurationSec / BUS_LINK_BPS) * 100,
    ),
    peakBusLoadPct: state.peakBusLoad,
  };

  const systems = systemSnapshots(Date.now()).map((snapshot) => ({
    id: snapshot.system.id,
    label: snapshot.system.label,
    domain: snapshot.system.domain,
    path: snapshot.system.path,
    status: snapshot.status,
    statusLabel: STATUS_LABELS[snapshot.status],
    summary: snapshot.summary,
    evidence: snapshot.readings.map((reading) => ({
      ecu: Number.isInteger(reading.ecu) ? hexId(reading.ecu) : '—',
      pid: hexPid(reading.pid),
      name: reading.name,
      value: reading.value,
      unit: reading.unit,
    })),
  }));

  let mil = false, dtcTotal = 0;
  state.monitors.forEach((m) => { mil = mil || m.mil; dtcTotal += m.dtc_count; });

  return {
    generated: now.toISOString(),
    vehicle: '2016 Mercedes Sprinter 2500 (W906 / NCV3) — OM642 3.0L V6 diesel',
    bus: 'OBD diagnostic CAN · ISO 15765-4 · 500 kbit/s · 11-bit',
    scanDurationSec: Math.round(scanDurationSec),
    totals: {
      frames: state.totalFrames,
      uniqueIds: state.ids.size,
      ecus: ecus.length,
      pidsSupported: ecus.reduce((s, e) => s + e.supportedCount, 0),
      pidsDecoded: telemetry.length,
      mil, dtcTotal,
    },
    network, systems, ecus, telemetry, census,
  };
}

const SEV = {
  ok:   { label: 'OK',     color: '#1a9e5f' },
  low:  { label: 'NOTICE', color: '#c08a1e' },
  med:  { label: 'CHECK',  color: '#c0392b' },
  info: { label: 'INFO',   color: '#5a6470' },
};

const REPORT_STATUS = {
  healthy:   { label: 'HEALTHY',  color: '#1a9e5f' },
  warning:   { label: 'WARNING',  color: '#c08a1e' },
  critical:  { label: 'CRITICAL', color: '#c0392b' },
  'no-data': { label: 'NO DATA',  color: '#7a828c' },
  offline:   { label: 'OFFLINE',  color: '#444a55' },
};

function buildReportHTML(d) {
  const sev = (lvl) => `<span class="sev" style="background:${SEV[lvl].color}">${SEV[lvl].label}</span>`;
  const systemStatus = (status) => {
    const item = REPORT_STATUS[status] || REPORT_STATUS['no-data'];
    return `<span class="sev" style="background:${item.color}">${item.label}</span>`;
  };
  const milLine = d.totals.mil
    ? `<span class="flag bad">MIL / Check-engine ON</span>`
    : `<span class="flag good">MIL OFF</span>`;

  const ecuHtml = d.ecus.map((e) => {
    const mon = e.monitors
      ? `MIL ${e.monitors.mil ? 'ON' : 'off'} · ${e.monitors.dtc_count} stored DTC(s)`
      : 'no monitor data';
    const chips = e.pids.map((p) =>
      `<span class="chip ${p.decoded ? 'kn' : 'un'}">${p.code} ${esc(p.name || '—')}</span>`).join('');
    return `<section class="ecu">
      <h3>Module ${e.id}</h3>
      <p class="meta">${e.supportedCount} PIDs supported · ${e.decodedCount} decoded · ${esc(mon)}</p>
      <div class="chips">${chips || '<em>no capability data — run Discover</em>'}</div>
    </section>`;
  }).join('');

  const telRows = d.telemetry.map((t) =>
    `<tr><td class="mono">${t.ecuCode}</td><td class="mono">${t.code}</td><td>${esc(t.name)}</td>` +
    `<td class="mono num">${t.value}</td><td>${esc(t.unit)}</td>` +
    `<td>${sev(t.level)}</td><td>${esc(t.note)}</td></tr>`).join('');

  const systemRows = d.systems.map((system) =>
    `<tr><td>${esc(system.label)}</td><td>${systemStatus(system.status)}</td>` +
    `<td>${esc(system.summary)}</td><td class="num">${system.evidence.length}</td></tr>`).join('');

  const censusRows = d.census.map((c) => {
    const dlc = c.minDlc === c.maxDlc ? String(c.dlc) : `${c.minDlc}–${c.maxDlc}`;
    return `<tr><td class="mono">${c.id}</td><td>${c.format}</td>` +
      `<td>${esc(c.role)}</td><td class="num">${dlc}</td>` +
      `<td class="mono">${esc(c.data)}</td>` +
      `<td class="num">${c.count.toLocaleString()}</td>` +
      `<td class="num">${c.averageHz.toFixed(2)}</td>` +
      `<td class="num">${c.lastSeenAgeSec.toFixed(1)}s</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Sprinter CAN Health Report — ${esc(d.generated)}</title>
<style>
  :root{font-family:system-ui,Segoe UI,Arial,sans-serif}
  body{margin:0;background:#f4f5f7;color:#1c2230}
  .wrap{max-width:980px;margin:0 auto;padding:32px 28px}
  h1{margin:0 0 4px;font-size:24px}
  h2{margin:28px 0 10px;font-size:16px;border-bottom:2px solid #d7dbe0;padding-bottom:6px}
  h3{margin:0 0 4px;font-size:14px}
  .sub{color:#5a6470;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}
  .kpi{background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:12px}
  .kpi .n{font-size:22px;font-weight:700}
  .kpi .l{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5a6470}
  .flag{display:inline-block;padding:3px 10px;border-radius:5px;font-size:12px;font-weight:600}
  .flag.good{background:#e3f5ec;color:#1a9e5f}.flag.bad{background:#fbe5e3;color:#c0392b}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e1e4e8;border-radius:8px;overflow:hidden}
  th,td{text-align:left;padding:7px 10px;font-size:13px;border-bottom:1px solid #eef0f2}
  th{background:#fafbfc;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#5a6470}
  .mono{font-family:ui-monospace,Consolas,monospace}.num{text-align:right}
  .sev{display:inline-block;padding:2px 8px;border-radius:4px;color:#fff;font-size:11px;font-weight:600}
  .ecu{background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:14px;margin:12px 0}
  .ecu .meta{color:#5a6470;font-size:12px;margin:0 0 8px}
  .chips{display:flex;flex-wrap:wrap;gap:5px}
  .chip{font-family:ui-monospace,Consolas,monospace;font-size:11px;padding:3px 7px;border-radius:4px;border:1px solid #d7dbe0}
  .chip.kn{border-color:#1a9e5f;color:#137a48}.chip.un{color:#7a828c}
  .network-note{margin:8px 0 10px;color:#5a6470;font-size:12px;line-height:1.5}
  footer{margin-top:28px;color:#7a828c;font-size:11px;line-height:1.6}
  @media print{body{background:#fff}.kpi,table,.ecu{border-color:#ccc}}
</style></head><body><div class="wrap">
  <h1>Sprinter CAN — Vehicle Health Scan</h1>
  <div class="sub">${esc(d.vehicle)}<br>${esc(d.bus)}<br>
    Generated ${esc(d.generated)} · scan window ${d.scanDurationSec}s</div>

  <h2>Summary</h2>
  <div>${milLine} &nbsp; <span class="flag ${d.totals.dtcTotal ? 'bad' : 'good'}">${d.totals.dtcTotal} stored DTC(s)</span></div>
  <div class="grid">
    <div class="kpi"><div class="n">${d.totals.ecus}</div><div class="l">Modules</div></div>
    <div class="kpi"><div class="n">${d.totals.uniqueIds}</div><div class="l">CAN IDs seen</div></div>
    <div class="kpi"><div class="n">${d.totals.pidsSupported}</div><div class="l">PIDs supported</div></div>
    <div class="kpi"><div class="n">${d.totals.pidsDecoded}</div><div class="l">PIDs decoded</div></div>
    <div class="kpi"><div class="n">${d.totals.frames.toLocaleString()}</div><div class="l">Frames observed</div></div>
    <div class="kpi"><div class="n">${d.network.averageBusLoadPct.toFixed(2)}%</div><div class="l">Average bus load</div></div>
    <div class="kpi"><div class="n">${d.network.peakBusLoadPct.toFixed(2)}%</div><div class="l">Peak bus load</div></div>
  </div>

  <h2>Vehicle systems (${d.systems.length})</h2>
  <table><thead><tr><th>System</th><th>Status</th><th>Observed summary</th><th>Evidence</th></tr></thead>
  <tbody>${systemRows}</tbody></table>

  <h2>Modules (${d.ecus.length})</h2>
  ${ecuHtml || '<p><em>No modules discovered — run Discover PIDs first.</em></p>'}

  <h2>Live telemetry snapshot (${d.telemetry.length})</h2>
  <table><thead><tr><th>ECU</th><th>PID</th><th>Parameter</th><th>Value</th><th>Unit</th><th>Status</th><th>Note</th></tr></thead>
  <tbody>${telRows || '<tr><td colspan="7"><em>No decoded values — enable Poll OBD.</em></td></tr>'}</tbody></table>

  <h2>Complete CAN network inventory (${d.census.length} IDs)</h2>
  <p class="network-note">
    ${d.network.standardIds} standard IDs · ${d.network.extendedIds} extended IDs ·
    ${d.network.functionalRequests} functional requests ·
    ${d.network.physicalRequests} physical requests ·
    ${d.network.ecuResponses} ECU responses ·
    ${d.network.broadcasts} other broadcast IDs.
    Undecoded IDs are retained so newly learned traffic is not omitted.
  </p>
  <table><thead><tr><th>ID</th><th>Format</th><th>Observed role</th><th>DLC</th>
    <th>Last data</th><th>Frames</th><th>Avg Hz</th><th>Age</th></tr></thead>
  <tbody>${censusRows || '<tr><td colspan="8"><em>No CAN frames observed.</em></td></tr>'}</tbody></table>

  <footer>
    Status flags are <b>heuristic</b> health hints, not a diagnosis. Stored-DTC count and MIL
    come from Mode 01 PID 0x01; the actual fault codes (Mode 03) and diesel-specific values
    (DPF/DEF via UDS Mode 22) are not yet read. Raw broadcast frames are shown as hex but not
    decoded — there is no DBC. The network inventory includes every arbitration ID observed
    during this app window. Bus load and rates are estimates from passive observation.
  </footer>
  <script type="application/json" id="scan-data">${JSON.stringify(d)}</script>
</div></body></html>`;
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Small read-only surface for integration checks and future native share/print
// adapters. Keeping report assembly here ensures every export path uses the
// same complete snapshot.
window.SprinterReport = Object.freeze({
  buildData: buildReportData,
  buildHTML: buildReportHTML,
});

// Browser/headless fallback: open the self-contained report in a new tab so the
// user can print it to PDF; if the popup is blocked, download the HTML.
function exportReportFallback(html, stamp) {
  try {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const tab = window.open(url, '_blank');
    if (tab) {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    URL.revokeObjectURL(url);
  } catch { /* fall through to download */ }
  download(`sprinter-can-report_${stamp}.html`, html, 'text/html');
}

el.btnReport.addEventListener('click', async () => {
  const d = buildReportData();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const html = buildReportHTML(d);
  // Electron: render a real PDF via the main process and let the user save it.
  if (window.desktop && typeof window.desktop.savePdf === 'function') {
    el.btnReport.disabled = true;
    try {
      const result = await window.desktop.savePdf(html, `sprinter-can-report_${stamp}.pdf`);
      if (result && result.ok) {
        el.connText.textContent = `report saved → ${result.path}`;
      } else if (result && result.error) {
        showBanner('error', '⛔ Could not save PDF: ' + result.error);
      }
    } catch (error) {
      showBanner('error', '⛔ Could not save PDF: ' + error.message);
    } finally {
      el.btnReport.disabled = false;
    }
    return;
  }
  exportReportFallback(html, stamp);
});
