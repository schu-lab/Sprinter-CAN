'use strict';

// Pure renderer/system-model tests; no Electron process or CAN hardware needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../renderer/core.js');

test('telemetry keys keep identical PIDs from different ECUs separate', () => {
  assert.notEqual(core.telemetryKey(0x7E8, 0x0C), core.telemetryKey(0x7E9, 0x0C));
  assert.equal(core.telemetryKey(0x7E8, 0x0C), '2024:12');
  assert.notEqual(
    core.telemetryKey(0x7E8, 0x24, 'lambda'),
    core.telemetryKey(0x7E8, 0x24, 'voltage'),
  );
});

test('telemetry entries sort by ECU and then PID', () => {
  const entries = [
    ['b', { ecu: 0x7E9, pid: 0x05 }],
    ['c', { ecu: 0x7E8, pid: 0x0D }],
    ['a', { ecu: 0x7E8, pid: 0x0C }],
  ];
  entries.sort(core.compareTelemetryEntries);
  assert.deepEqual(entries.map(([key]) => key), ['a', 'c', 'b']);
});

test('values use PID-appropriate precision', () => {
  assert.equal(core.formatValue(1726.25, 0x0C, 'rpm'), '1726');
  assert.equal(core.formatValue(14.126, 0x42, 'V'), '14.13');
  assert.equal(core.formatValue(null, 0x42, 'V'), '—');
});

test('bus load estimate uses frame overhead and DLC', () => {
  const load = core.computeBusLoad([{ dlc: 8 }], 500000);
  assert.equal(load, (111 / 500000) * 100);
});

test('CAN IDs are classified for the exported network inventory', () => {
  assert.equal(core.classifyCanId(0x7DF).role, 'Functional OBD request');
  assert.equal(core.classifyCanId(0x7E2).role, 'Physical diagnostic request');
  assert.equal(core.classifyCanId(0x7EA).role, 'Diagnostic ECU response');
  assert.equal(core.classifyCanId(0x123).role, 'Broadcast / not decoded');
  assert.equal(core.classifyCanId(0x18DAF110, true).format, '29-bit');
});

test('health heuristics classify representative values', () => {
  assert.equal(core.healthFor(0x05, 90).level, 'ok');
  assert.equal(core.healthFor(0x05, 112).level, 'med');
  assert.equal(core.healthFor(0x42, 11.9).level, 'med');
});

test('vehicle systems expose the requested Sprinter service groups', () => {
  assert.deepEqual(
    core.VEHICLE_SYSTEMS.map((system) => system.id),
    ['engine', 'fuel', 'electrical', 'controls', 'chassis', 'body', 'diagnostics'],
  );
});

test('vehicle systems use seven external native buttons without a wireframe', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'index.html'),
    'utf8',
  );
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'styles.css'),
    'utf8',
  );
  assert.equal((html.match(/<button class="system-node"/g) || []).length, 7);
  assert.equal((html.match(/data-highlight-system="/g) || []).length, 7);
  assert.doesNotMatch(html, /van-wireframe|system-zone|sprinter-map/);

  const chassis = html.match(
    /data-highlight-system="chassis">([\s\S]*?)<\/g>/,
  )[1];
  assert.equal((chassis.match(/<ellipse /g) || []).length, 2);
  assert.doesNotMatch(chassis, /<path /);
  assert.match(
    css,
    /\.vehicle-highlight\[data-highlight-system="body"\]\s*\{\s*color: var\(--green\)/,
  );
});

test('report retains raw network inventory and all learned ECU sources', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'app.js'),
    'utf8',
  );
  assert.match(source, /state\.pids\.forEach/);
  assert.match(source, /id >= 0x7E8 && id <= 0x7EF/);
  assert.match(source, /Complete CAN network inventory/);
  assert.match(source, /Undecoded IDs are retained/);
});

test('Raspberry Pi package targets ARM64 AppImage and bundles Python', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8',
  ));
  const target = packageJson.build.linux.target[0];
  assert.equal(target.target, 'AppImage');
  assert.deepEqual(target.arch, ['arm64']);
  assert.ok(packageJson.build.extraResources.some(
    (resource) => resource.to === 'app/runtime/python',
  ));
  assert.ok(packageJson.build.extraResources.some(
    (resource) => resource.to === 'app/vendor/python',
  ));
});

test('telemetry details explain known PIDs and identify related systems', () => {
  const rpm = core.telemetryDetailFor(0x0C);
  assert.match(rpm.summary, /crankshaft speed/i);
  assert.deepEqual(rpm.systems, ['Engine']);
  assert.equal(rpm.source, 'SAE J1979 · Mode 01');

  const fuelTrim = core.telemetryDetailFor(0x06);
  assert.match(fuelTrim.watch, /diesel/i);
  assert.deepEqual(fuelTrim.systems, ['Fuel / Emissions']);
});

test('telemetry details provide a safe fallback for unknown PIDs', () => {
  const detail = core.telemetryDetailFor(0xFE);
  assert.match(detail.summary, /Mode 01/i);
  assert.deepEqual(detail.systems, []);
});

test('PID availability separates decoded, undecoded, and unavailable states', () => {
  const availability = core.buildPidAvailability(
    new Map([
      [0x01, 'Monitor status'],
      [0x04, 'Engine load'],
      [0x13, null],
    ]),
    new Set([0x00]),
  );
  const byPid = new Map(availability.map((pid) => [pid.pid, pid]));

  assert.deepEqual(
    { name: byPid.get(0x01).name, status: byPid.get(0x01).status },
    { name: 'Monitor status', status: 'decoded' },
  );
  assert.equal(byPid.get(0x04).status, 'decoded');
  assert.equal(byPid.get(0x13).status, 'undecoded');
  assert.equal(byPid.get(0x13).name, 'O2 sensors present');
  assert.equal(byPid.get(0x05).status, 'unavailable');
  assert.equal(byPid.has(0x42), false, 'unobserved support blocks stay hidden');
});

test('catalog labels do not imply that a PID decoder exists', () => {
  const availability = core.buildPidAvailability(
    new Map([
      [0x24, 'O2 sensor 1 lambda / voltage'],
      [0x41, null],
      [0x51, null],
    ]),
    new Set([0x20, 0x40]),
  );
  const byPid = new Map(availability.map((pid) => [pid.pid, pid]));
  assert.equal(byPid.get(0x24).status, 'decoded');
  assert.equal(byPid.get(0x41).status, 'undecoded');
  assert.equal(byPid.get(0x41).name, 'Monitor this cycle');
  assert.equal(byPid.get(0x51).status, 'undecoded');
  assert.equal(byPid.get(0x51).name, 'Fuel type');
});

test('system status distinguishes no data, stale data, and disconnected data', () => {
  const engine = core.VEHICLE_SYSTEMS.find((system) => system.id === 'engine');
  const now = 100000;
  assert.equal(core.evaluateSystemStatus(engine, [], [], true, now).status, 'no-data');
  assert.equal(core.evaluateSystemStatus(
    engine,
    [{ pid: 0x0C, value: 800, name: 'Engine RPM', updatedAt: now - 20000 }],
    [],
    true,
    now,
  ).status, 'offline');
  assert.equal(core.evaluateSystemStatus(engine, [], [], false, now).status, 'offline');
});

test('system status promotes range warnings and critical electrical readings', () => {
  const now = 100000;
  const engine = core.VEHICLE_SYSTEMS.find((system) => system.id === 'engine');
  const electrical = core.VEHICLE_SYSTEMS.find((system) => system.id === 'electrical');
  assert.equal(core.evaluateSystemStatus(
    engine,
    [{ pid: 0x05, value: 25, name: 'Coolant temp', updatedAt: now }],
    [],
    true,
    now,
  ).status, 'warning');
  assert.equal(core.evaluateSystemStatus(
    electrical,
    [{ pid: 0x42, value: 11.9, name: 'Module voltage', updatedAt: now }],
    [],
    true,
    now,
  ).status, 'critical');
});

test('diagnostic system gives MIL precedence over stored-code warnings', () => {
  const diagnostics = core.VEHICLE_SYSTEMS.find((system) => system.id === 'diagnostics');
  const now = 100000;
  assert.equal(core.evaluateSystemStatus(
    diagnostics, [], [{ mil: false, dtc_count: 2, updatedAt: now }], true, now,
  ).status, 'warning');
  assert.equal(core.evaluateSystemStatus(
    diagnostics, [], [{ mil: true, dtc_count: 1, updatedAt: now }], true, now,
  ).status, 'critical');
});

test('overall system status reports the most important observed state', () => {
  assert.equal(core.overallSystemStatus(
    [{ status: 'healthy' }, { status: 'no-data' }], true,
  ), 'healthy');
  assert.equal(core.overallSystemStatus(
    [{ status: 'healthy' }, { status: 'warning' }], true,
  ), 'warning');
  assert.equal(core.overallSystemStatus(
    [{ status: 'critical' }], false,
  ), 'offline');
});

test('operator alerts order critical systems before warnings', () => {
  const snapshots = [
    {
      system: { id: 'engine', label: 'Engine', domain: 'Powertrain' },
      status: 'warning',
      summary: 'Coolant temperature is elevated.',
    },
    {
      system: { id: 'electrical', label: 'Electrical', domain: 'Vehicle' },
      status: 'critical',
      summary: 'Module voltage is critically low.',
    },
    {
      system: { id: 'body', label: 'Body / Cabin', domain: 'Body' },
      status: 'healthy',
      summary: 'No flags.',
    },
  ];
  assert.deepEqual(
    core.systemAlerts(snapshots, true).map((alert) => alert.systemId),
    ['electrical', 'engine'],
  );
});

test('operator alerts show one connection message while telemetry is offline', () => {
  const alerts = core.systemAlerts([], false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].status, 'offline');
  assert.equal(alerts[0].systemId, null);
});

test('HTML escaping protects generated report text', () => {
  assert.equal(core.escapeHtml('<CAN & "OBD">'), '&lt;CAN &amp; &quot;OBD&quot;&gt;');
});
