'use strict';

// Pure telemetry helpers shared by the browser renderer and Node's test runner.
(function exposeTelemetryCore(global) {
  function telemetryKey(ecu, pid, metric = null) {
    const base = `${Number.isInteger(ecu) ? ecu : 'unknown'}:${pid}`;
    return metric ? `${base}:${metric}` : base;
  }

  function compareTelemetryEntries(a, b) {
    const pa = a[1];
    const pb = b[1];
    const ecuA = Number.isInteger(pa.ecu) ? pa.ecu : Number.MAX_SAFE_INTEGER;
    const ecuB = Number.isInteger(pb.ecu) ? pb.ecu : Number.MAX_SAFE_INTEGER;
    return ecuA - ecuB || pa.pid - pb.pid ||
      String(pa.metric || '').localeCompare(String(pb.metric || ''));
  }

  function decimalsFor(pid, unit) {
    if (pid === 0x42) return 2;
    if (pid === 0x24 || pid === 0x44 || unit === 'λ') return 3;
    if (['rpm', 'km/h', '°C', 'kPa', 'km', '', 's', 'Nm'].includes(unit)) return 0;
    return 1;
  }

  function formatValue(value, pid, unit) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return Number(value).toFixed(decimalsFor(pid, unit));
  }

  function computeBusLoad(frames, linkBps = 500000) {
    let bits = 0;
    for (const frame of frames) bits += 47 + 8 * frame.dlc;
    return Math.min(100, (bits / linkBps) * 100);
  }

  function classifyCanId(id, extended = false) {
    if (extended || id > 0x7FF) {
      return { format: '29-bit', role: 'Extended / manufacturer-specific' };
    }
    if (id === 0x7DF) {
      return { format: '11-bit', role: 'Functional OBD request' };
    }
    if (id >= 0x7E0 && id <= 0x7E7) {
      return { format: '11-bit', role: 'Physical diagnostic request' };
    }
    if (id >= 0x7E8 && id <= 0x7EF) {
      return { format: '11-bit', role: 'Diagnostic ECU response' };
    }
    return { format: '11-bit', role: 'Broadcast / not decoded' };
  }

  // VSS-inspired domains, adapted to the service groupings commonly used for
  // this Sprinter. "manufacturer-overlay" paths are intentionally explicit:
  // they describe this app's grouping, not claims about standard VSS branches.
  const VEHICLE_SYSTEMS = Object.freeze([
    {
      id: 'engine',
      label: 'Engine',
      domain: 'Powertrain',
      path: 'Vehicle.Powertrain.CombustionEngine',
      description: 'Engine operating state, air path, temperatures and torque.',
      pids: [0x04, 0x05, 0x0B, 0x0C, 0x0F, 0x10, 0x11, 0x23, 0x24, 0x33,
        0x3C, 0x43, 0x44, 0x5C, 0x5D, 0x61, 0x62, 0x63],
    },
    {
      id: 'fuel',
      label: 'Fuel / Emissions',
      domain: 'Powertrain',
      path: 'Vehicle.Powertrain.FuelSystem + Sprinter.Emissions',
      description: 'Fuel delivery, tank level, EGR and available exhaust evidence.',
      pids: [0x06, 0x07, 0x0A, 0x10, 0x21, 0x24, 0x2C, 0x2D, 0x2F,
        0x30, 0x31, 0x3C, 0x44, 0x5E],
    },
    {
      id: 'electrical',
      label: 'Electrical',
      domain: 'Vehicle / ControlUnit',
      path: 'Vehicle.Battery + Vehicle.ControlUnit',
      description: '12-volt supply and control-module electrical evidence.',
      pids: [0x42],
    },
    {
      id: 'controls',
      label: 'Driver Controls',
      domain: 'Driver / Powertrain',
      path: 'Vehicle.Driver + Vehicle.Powertrain',
      description: 'Accelerator, throttle and driver torque-demand signals.',
      pids: [0x0D, 0x11, 0x45, 0x47, 0x49, 0x4A, 0x4B, 0x4C,
        0x5A, 0x61, 0x62],
    },
    {
      id: 'chassis',
      label: 'Chassis',
      domain: 'Chassis',
      path: 'Vehicle.Chassis',
      description: 'Vehicle motion evidence; brake, steering and suspension require richer diagnostics.',
      pids: [0x0D],
    },
    {
      id: 'body',
      label: 'Body / Cabin',
      domain: 'Body / Cabin',
      path: 'Vehicle.Body + Vehicle.Cabin',
      description: 'Body and cabin systems; standard OBD exposes very little in this domain.',
      pids: [0x46],
    },
    {
      id: 'diagnostics',
      label: 'Diagnostics',
      domain: 'Diagnostics',
      path: 'Vehicle.Diagnostics',
      description: 'MIL state, stored-DTC count and diagnostic module presence.',
      pids: [0x21, 0x30, 0x31],
      usesMonitors: true,
    },
  ]);

  const PID_DETAILS = Object.freeze({
    0x04: {
      summary: 'Calculated engine load reported by the engine control module.',
      watch: 'Useful for comparing engine demand at idle, cruise, and acceleration.',
    },
    0x05: {
      summary: 'Engine coolant temperature reported by the temperature sensor.',
      watch: 'Watch the warm-up trend and investigate sustained high readings.',
    },
    0x06: {
      summary: 'Short-term fuel correction for bank 1.',
      watch: 'This gasoline-oriented PID may be unsupported or less meaningful on a diesel.',
    },
    0x07: {
      summary: 'Long-term learned fuel correction for bank 1.',
      watch: 'This gasoline-oriented PID may be unsupported or less meaningful on a diesel.',
    },
    0x0A: {
      summary: 'Fuel pressure from the standard low-pressure OBD parameter.',
      watch: 'This is not the high-pressure common-rail reading; compare it with PID 0x23.',
    },
    0x0B: {
      summary: 'Intake manifold absolute pressure measured after atmospheric pressure is included.',
      watch: 'Compare with barometric pressure to estimate turbo boost under load.',
    },
    0x0C: {
      summary: 'Current engine crankshaft speed.',
      watch: 'Useful for idle stability, shift behavior, and matching load changes.',
    },
    0x0D: {
      summary: 'Vehicle road speed reported through the diagnostic powertrain data.',
      watch: 'Useful for correlating engine load, RPM, and fuel rate.',
    },
    0x0E: {
      summary: 'Timing advance value exposed through standard OBD.',
      watch: 'Interpret cautiously on a diesel; manufacturer-specific timing data is richer.',
    },
    0x0F: {
      summary: 'Temperature of air entering the engine.',
      watch: 'Compare with ambient temperature and engine load to spot heat soak.',
    },
    0x10: {
      summary: 'Mass airflow entering the engine in grams per second.',
      watch: 'Useful for evaluating air-path response, EGR behavior, and engine load.',
    },
    0x11: {
      summary: 'Intake throttle-valve position.',
      watch: 'On this diesel it is not the accelerator pedal and may remain mostly open.',
    },
    0x1F: {
      summary: 'Elapsed engine run time since the current start.',
      watch: 'Useful as a timeline reference for warm-up and drive-session events.',
    },
    0x21: {
      summary: 'Distance traveled while the malfunction indicator lamp was on.',
      watch: 'A non-zero value records accumulated distance, not the current MIL state.',
    },
    0x23: {
      summary: 'High-pressure diesel common-rail fuel pressure.',
      watch: 'Compare at similar RPM and load; diagnosis needs manufacturer targets.',
    },
    0x24: {
      summary: 'Wide-range oxygen sensor 1 air-fuel equivalence ratio and voltage.',
      watch: 'Trend lambda and voltage together; diesel interpretation depends strongly on load and aftertreatment state.',
    },
    0x2C: {
      summary: 'EGR position or flow requested by the engine controller.',
      watch: 'Compare with EGR error and airflow; commanded position alone does not prove flow.',
    },
    0x2D: {
      summary: 'Difference between commanded and observed EGR behavior.',
      watch: 'Persistent large error can justify deeper EGR and air-path diagnostics.',
    },
    0x2F: {
      summary: 'Fuel-tank level reported as a percentage.',
      watch: 'Treat rapid movement as sensor or vehicle-angle variation, not fuel consumption.',
    },
    0x30: {
      summary: 'Number of completed warm-up cycles since diagnostic codes were cleared.',
      watch: 'Helps establish how much drive history exists after a reset.',
    },
    0x31: {
      summary: 'Distance traveled since diagnostic codes were cleared.',
      watch: 'A small value means readiness and learned values may still be rebuilding.',
    },
    0x33: {
      summary: 'Atmospheric barometric pressure reported by the engine controller.',
      watch: 'Use as the baseline when interpreting intake manifold pressure.',
    },
    0x3C: {
      summary: 'Catalyst temperature for bank 1, sensor 1.',
      watch: 'Exhaust temperature varies widely with load and regeneration activity.',
    },
    0x42: {
      summary: 'Voltage seen by the reporting control module.',
      watch: 'Useful for charging-system trends and detecting undervoltage events.',
    },
    0x43: {
      summary: 'Absolute engine load calculated by the controller.',
      watch: 'Useful for comparing operating points across drives and elevations.',
    },
    0x44: {
      summary: 'Commanded equivalence ratio, displayed here as lambda.',
      watch: 'Diesel operation is normally lean; manufacturer data is needed for full context.',
    },
    0x45: {
      summary: 'Relative throttle position reported by the controller.',
      watch: 'Compare with accelerator-pedal and commanded-throttle signals.',
    },
    0x46: {
      summary: 'Outside ambient-air temperature reported through OBD.',
      watch: 'Useful as context for coolant, intake-air, and warm-up behavior.',
    },
    0x47: {
      summary: 'Absolute throttle-position sensor B.',
      watch: 'A redundant channel used to compare throttle position and plausibility.',
    },
    0x49: {
      summary: 'Accelerator-pedal position sensor D.',
      watch: 'Compare redundant pedal channels for smooth, consistent movement.',
    },
    0x4A: {
      summary: 'Accelerator-pedal position sensor E.',
      watch: 'Compare redundant pedal channels for smooth, consistent movement.',
    },
    0x4B: {
      summary: 'Accelerator-pedal position sensor F.',
      watch: 'Compare redundant pedal channels for smooth, consistent movement.',
    },
    0x4C: {
      summary: 'Throttle-actuator position commanded by the controller.',
      watch: 'Compare with observed throttle position when investigating air-path behavior.',
    },
    0x5A: {
      summary: 'Relative accelerator-pedal position.',
      watch: 'Represents driver demand and should change smoothly through pedal travel.',
    },
    0x5C: {
      summary: 'Engine oil temperature reported by the engine controller.',
      watch: 'Oil typically warms more slowly than coolant; watch for sustained high values.',
    },
    0x5D: {
      summary: 'Fuel-injection timing relative to the engine cycle.',
      watch: 'Changes with RPM and load; manufacturer targets are needed for diagnosis.',
    },
    0x5E: {
      summary: 'Current fuel-use rate reported in liters per hour.',
      watch: 'Useful for idle consumption and comparing similar operating conditions.',
    },
    0x61: {
      summary: 'Engine torque percentage requested by the driver.',
      watch: 'Compare with actual torque to see how controller limits affect demand.',
    },
    0x62: {
      summary: 'Actual engine torque expressed relative to reference torque.',
      watch: 'Compare with driver demand, RPM, and load during acceleration.',
    },
    0x63: {
      summary: 'Reference torque used as the basis for percentage torque PIDs.',
      watch: 'This provides scale for demanded and actual torque percentages.',
    },
  });

  const PID_CATALOG = Object.freeze({
    0x01: 'Monitor status',
    0x04: 'Engine load',
    0x05: 'Coolant temp',
    0x06: 'STFT bank 1',
    0x07: 'LTFT bank 1',
    0x0A: 'Fuel pressure',
    0x0B: 'Intake MAP',
    0x0C: 'Engine RPM',
    0x0D: 'Vehicle speed',
    0x0E: 'Timing advance',
    0x0F: 'Intake air temp',
    0x10: 'MAF rate',
    0x11: 'Throttle valve',
    0x13: 'O2 sensors present',
    0x1C: 'OBD standard',
    0x1F: 'Run time',
    0x21: 'Dist w/ MIL on',
    0x23: 'Fuel rail press',
    0x24: 'O2 sensor 1',
    0x2C: 'Commanded EGR',
    0x2D: 'EGR error',
    0x2F: 'Fuel level',
    0x30: 'Warm-ups since clr',
    0x31: 'Dist since clear',
    0x33: 'Baro pressure',
    0x3C: 'Cat temp B1S1',
    0x41: 'Monitor this cycle',
    0x42: 'Module voltage',
    0x43: 'Absolute load',
    0x44: 'Lambda',
    0x45: 'Rel throttle pos',
    0x46: 'Ambient air temp',
    0x47: 'Abs throttle B',
    0x49: 'Accel pedal D',
    0x4A: 'Accel pedal E',
    0x4B: 'Accel pedal F',
    0x4C: 'Cmd throttle act',
    0x51: 'Fuel type',
    0x5A: 'Rel accel pedal',
    0x5C: 'Engine oil temp',
    0x5D: 'Injection timing',
    0x5E: 'Fuel rate',
    0x61: 'Driver dmd torque',
    0x62: 'Actual torque',
    0x63: 'Ref torque',
    0x64: 'Engine torque points',
    0x65: 'Aux input/output support',
    0x66: 'Mass airflow sensors',
    0x67: 'Coolant temp sensors',
    0x68: 'Intake air temp sensors',
    0x69: 'EGR command/error',
    0x6A: 'Diesel intake airflow',
    0x6B: 'EGR temperature',
    0x6C: 'Throttle control/position',
    0x6D: 'Fuel pressure control',
    0x6E: 'Injection pressure control',
    0x6F: 'Turbo inlet pressure',
    0x70: 'Boost pressure control',
    0x71: 'VGT control',
    0x72: 'Wastegate control',
    0x73: 'Exhaust pressure',
    0x74: 'Turbocharger RPM',
    0x75: 'Turbo temperature 1',
    0x76: 'Turbo temperature 2',
    0x77: 'Charge-air cooler temp',
    0x78: 'EGT bank 1',
    0x79: 'EGT bank 2',
    0x7A: 'DPF differential pressure',
    0x7B: 'DPF pressure',
    0x7C: 'DPF temperature',
    0x7D: 'NOx NTE status',
    0x7E: 'PM NTE status',
    0x7F: 'Engine run-time data',
    0x81: 'AECD run time 1–5',
    0x82: 'AECD run time 6–10',
    0x83: 'NOx sensor',
    0x84: 'Manifold surface temp',
    0x85: 'NOx reagent system',
    0x86: 'Particulate matter sensor',
    0x87: 'Intake MAP sensors',
    0x88: 'SCR inducement system',
    0x89: 'AECD run time 11–15',
    0x8A: 'AECD run time 16–20',
    0x8B: 'Diesel aftertreatment',
  });

  function pidSupportBlock(pid) {
    return Math.floor((pid - 1) / 0x20) * 0x20;
  }

  function buildPidAvailability(supportedPids, observedBlocks) {
    const supported = supportedPids instanceof Map
      ? supportedPids
      : new Map(supportedPids || []);
    const blocks = observedBlocks instanceof Set
      ? observedBlocks
      : new Set(observedBlocks || []);
    const displayed = new Set(supported.keys());

    for (const key of Object.keys(PID_CATALOG)) {
      const pid = Number(key);
      if (blocks.has(pidSupportBlock(pid))) displayed.add(pid);
    }

    return [...displayed].sort((a, b) => a - b).map((pid) => {
      const catalogName = PID_CATALOG[pid] || null;
      if (!supported.has(pid)) {
        return { pid, name: catalogName, status: 'unavailable' };
      }
      const decoderName = supported.get(pid) || null;
      return {
        pid,
        name: decoderName || catalogName,
        status: decoderName !== null ? 'decoded' : 'undecoded',
      };
    });
  }

  function telemetryDetailFor(pid) {
    const detail = PID_DETAILS[pid] || {
      summary: 'A live SAE J1979 Mode 01 parameter reported by a vehicle control module.',
      watch: 'Use the trend and operating context; no app-specific interpretation is available.',
    };
    return {
      ...detail,
      source: 'SAE J1979 · Mode 01',
      systems: VEHICLE_SYSTEMS
        .filter((system) => system.pids.includes(pid))
        .map((system) => system.label),
    };
  }

  const STATUS_LABELS = Object.freeze({
    healthy: 'HEALTHY',
    warning: 'WARNING',
    critical: 'CRITICAL',
    'no-data': 'NO DATA',
    offline: 'OFFLINE',
  });

  // Light heuristic ranges for the exported health report.
  function healthFor(pid, value) {
    const result = (level, note) => ({ level, note });
    switch (pid) {
      case 0x05:
      case 0x67:
        if (value >= 75 && value <= 105) return result('ok', 'normal operating temp');
        if (value > 105 && value <= 110) return result('low', 'running warm');
        if (value > 110) return result('med', 'over-temperature');
        return result('low', 'below operating temp (warming up)');
      case 0x5C:
        if (value >= 70 && value <= 120) return result('ok', 'normal');
        if (value > 120) return result('med', 'oil over-temperature');
        return result('info', 'below operating temp');
      case 0x42:
        if (value >= 13.2 && value <= 14.8) return result('ok', 'charging system OK');
        if (value >= 12.4 && value < 13.2) return result('low', 'low — alternator/idle?');
        if (value < 12.4) return result('med', 'undervoltage — check charging');
        if (value > 15.0) return result('med', 'overvoltage — check regulator');
        return result('info', '');
      case 0x2F:
        if (value < 10) return result('low', 'low fuel');
        return result('ok', '');
      case 0x06:
      case 0x07:
        if (Math.abs(value) <= 10) return result('ok', 'within ±10%');
        if (Math.abs(value) <= 25) return result('low', 'elevated trim');
        return result('med', 'large fuel trim');
      default:
        return result('info', '');
    }
  }

  function evaluateSystemStatus(
    system,
    readings,
    monitors,
    connected,
    now = Date.now(),
    staleMs = 10000,
  ) {
    const relevant = readings.filter((reading) => system.pids.includes(reading.pid));
    const freshReadings = relevant.filter((reading) =>
      !Number.isFinite(reading.updatedAt) || now - reading.updatedAt <= staleMs);
    const relevantMonitors = system.usesMonitors ? monitors : [];
    const freshMonitors = relevantMonitors.filter((monitor) =>
      !Number.isFinite(monitor.updatedAt) || now - monitor.updatedAt <= staleMs);

    if (!connected) {
      return {
        status: 'offline',
        summary: 'CAN adapter is not connected; cached values are not treated as current.',
        readings: [],
        monitors: [],
        allReadings: relevant,
      };
    }

    if (!freshReadings.length && !freshMonitors.length) {
      const stale = relevant.length > 0 || relevantMonitors.length > 0;
      return {
        status: stale ? 'offline' : 'no-data',
        summary: stale
          ? 'Previously observed evidence is stale. Resume polling to refresh it.'
          : 'No supported signals have been observed for this system.',
        readings: [],
        monitors: [],
        allReadings: relevant,
      };
    }

    if (freshMonitors.some((monitor) => monitor.mil)) {
      return {
        status: 'critical',
        summary: 'The malfunction indicator lamp is reported ON.',
        readings: freshReadings,
        monitors: freshMonitors,
        allReadings: relevant,
      };
    }
    const dtcCount = freshMonitors.reduce((sum, monitor) => sum + monitor.dtc_count, 0);
    if (dtcCount > 0) {
      return {
        status: 'warning',
        summary: `${dtcCount} stored diagnostic trouble code(s) reported.`,
        readings: freshReadings,
        monitors: freshMonitors,
        allReadings: relevant,
      };
    }

    const evaluated = freshReadings.map((reading) => ({
      reading,
      health: healthFor(reading.pid, reading.value),
    }));
    const critical = evaluated.find((item) => item.health.level === 'med');
    if (critical) {
      return {
        status: 'critical',
        summary: `${critical.reading.name}: ${critical.health.note || 'outside expected range'}.`,
        readings: freshReadings,
        monitors: freshMonitors,
        allReadings: relevant,
      };
    }
    const warning = evaluated.find((item) => item.health.level === 'low');
    if (warning) {
      return {
        status: 'warning',
        summary: `${warning.reading.name}: ${warning.health.note || 'needs attention'}.`,
        readings: freshReadings,
        monitors: freshMonitors,
        allReadings: relevant,
      };
    }

    const evidenceCount = freshReadings.length + (freshMonitors.length ? 1 : 0);
    return {
      status: 'healthy',
      summary: `${evidenceCount} live evidence source(s); no heuristic flags detected.`,
      readings: freshReadings,
      monitors: freshMonitors,
      allReadings: relevant,
    };
  }

  function overallSystemStatus(snapshots, connected) {
    if (!connected) return 'offline';
    if (snapshots.some((snapshot) => snapshot.status === 'critical')) return 'critical';
    if (snapshots.some((snapshot) => snapshot.status === 'warning')) return 'warning';
    if (snapshots.some((snapshot) => snapshot.status === 'healthy')) return 'healthy';
    if (snapshots.some((snapshot) => snapshot.status === 'offline')) return 'offline';
    return 'no-data';
  }

  function systemAlerts(snapshots, connected) {
    if (!connected) {
      return [{
        id: 'connection',
        systemId: null,
        status: 'offline',
        title: 'Vehicle data offline',
        domain: 'Connection',
        summary: 'The CAN adapter is not connected; live system warnings are unavailable.',
      }];
    }

    const priority = { critical: 0, warning: 1 };
    return snapshots
      .filter((snapshot) => snapshot.status in priority)
      .map((snapshot) => ({
        id: snapshot.system.id,
        systemId: snapshot.system.id,
        status: snapshot.status,
        title: snapshot.system.label,
        domain: snapshot.system.domain,
        summary: snapshot.summary,
      }))
      .sort((a, b) =>
        priority[a.status] - priority[b.status] ||
        a.title.localeCompare(b.title));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  }

  const api = {
    telemetryKey,
    compareTelemetryEntries,
    decimalsFor,
    formatValue,
    computeBusLoad,
    classifyCanId,
    VEHICLE_SYSTEMS,
    PID_DETAILS,
    PID_CATALOG,
    pidSupportBlock,
    buildPidAvailability,
    telemetryDetailFor,
    STATUS_LABELS,
    healthFor,
    evaluateSystemStatus,
    overallSystemStatus,
    systemAlerts,
    escapeHtml,
  };

  global.TelemetryCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
