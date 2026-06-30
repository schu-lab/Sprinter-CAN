#!/usr/bin/env python3
"""
can_bridge.py — Sprinter CAN acquisition bridge.

Owns all hardware access via python-can (kvaser backend) and speaks
newline-delimited JSON (NDJSON) on stdout, one object per line:

  {"type":"frame","id":<int>,"ext":<bool>,"dlc":<int>,"data":"<hex>","t":<epoch>}
  {"type":"pid","ecu":<int>,"pid":<int>,"name":"<str>","value":<num>,"unit":"<str>","t":<epoch>}
  {"type":"status","msg":"<str>","poll":<bool>}
  {"type":"error","msg":"<str>"}

It reads JSON commands from stdin, one per line:

  {"cmd":"poll","on":true|false}

Bus: ISO 15765-4, classic CAN, 500 kbit/s, 11-bit IDs.
OBD-II: functional request 0x7DF, ECM response 0x7E8.

Start in hardware-silent mode. Polling and discovery deliberately reopen the
adapter in active mode because they transmit request frames onto the bus.
"""

import sys
import os
import json
import time
import math
import random
import argparse
import threading

# ---------------------------------------------------------------------------
# OBD-II Mode 01 PID table.  A = data[3], B = data[4] of the 0x7E8 response
# frame [PCI, 0x41, PID, A, B, ...].
#
# Scalar entries are (name, unit, data-byte count, decode(data)). Compound PIDs
# live in PID_METRICS so one response can produce more than one telemetry card.
# ---------------------------------------------------------------------------
PIDS = {
    0x04: ("Engine load",       "%",    1, lambda d: d[3] * 100 / 255),
    0x05: ("Coolant temp",      "°C",   1, lambda d: d[3] - 40),
    0x0B: ("Intake MAP",        "kPa",  1, lambda d: d[3]),
    0x0C: ("Engine RPM",        "rpm",  2, lambda d: (256 * d[3] + d[4]) / 4),
    0x0D: ("Vehicle speed",     "km/h", 1, lambda d: d[3]),
    0x0F: ("Intake air temp",   "°C",   1, lambda d: d[3] - 40),
    0x10: ("MAF rate",          "g/s",  2, lambda d: (256 * d[3] + d[4]) / 100),
    0x11: ("Throttle valve",    "%",    1, lambda d: d[3] * 100 / 255),
    0x2F: ("Fuel level",        "%",    1, lambda d: d[3] * 100 / 255),
    0x42: ("Module voltage",    "V",    2, lambda d: (256 * d[3] + d[4]) / 1000),
    0x46: ("Ambient air temp",  "°C",   1, lambda d: d[3] - 40),
    0x5C: ("Engine oil temp",   "°C",   1, lambda d: d[3] - 40),
    # --- Standard PIDs this van reports (found via discovery) ----------------
    0x21: ("Dist w/ MIL on",    "km",   2, lambda d: 256 * d[3] + d[4]),
    0x30: ("Warm-ups since clr", "",    1, lambda d: d[3]),
    0x31: ("Dist since clear",  "km",   2, lambda d: 256 * d[3] + d[4]),
    0x33: ("Baro pressure",     "kPa",  1, lambda d: d[3]),
    # --- Accelerator pedal / throttle variants (diesel: pedal != 0x11) -------
    # On a diesel, PID 0x11 is the intake throttle valve (mostly open); the
    # driver's pedal lives here. Not all are supported — unsupported ones
    # simply won't respond, so no card appears.
    0x45: ("Rel throttle pos",  "%",    1, lambda d: d[3] * 100 / 255),
    0x47: ("Abs throttle B",    "%",    1, lambda d: d[3] * 100 / 255),
    0x49: ("Accel pedal D",     "%",    1, lambda d: d[3] * 100 / 255),
    0x4A: ("Accel pedal E",     "%",    1, lambda d: d[3] * 100 / 255),
    0x4B: ("Accel pedal F",     "%",    1, lambda d: d[3] * 100 / 255),
    0x5A: ("Rel accel pedal",   "%",    1, lambda d: d[3] * 100 / 255),
    # --- More standard SAE J1979 single-frame PIDs (incl. diesel-relevant) --
    0x06: ("STFT bank 1",       "%",    1, lambda d: (d[3] - 128) * 100 / 128),
    0x07: ("LTFT bank 1",       "%",    1, lambda d: (d[3] - 128) * 100 / 128),
    0x0A: ("Fuel pressure",     "kPa",  1, lambda d: d[3] * 3),
    0x0E: ("Timing advance",    "°",    1, lambda d: d[3] / 2 - 64),
    0x1F: ("Run time",          "s",    2, lambda d: 256 * d[3] + d[4]),
    0x23: ("Fuel rail press",   "kPa",  2, lambda d: (256 * d[3] + d[4]) * 10),
    0x2C: ("Commanded EGR",     "%",    1, lambda d: d[3] * 100 / 255),
    0x2D: ("EGR error",         "%",    1, lambda d: (d[3] - 128) * 100 / 128),
    0x3C: ("Cat temp B1S1",     "°C",   2, lambda d: (256 * d[3] + d[4]) / 10 - 40),
    0x43: ("Absolute load",     "%",    2, lambda d: (256 * d[3] + d[4]) * 100 / 255),
    0x44: ("Lambda",            "λ",    2, lambda d: (256 * d[3] + d[4]) / 32768),
    0x4C: ("Cmd throttle act",  "%",    1, lambda d: d[3] * 100 / 255),
    0x5D: ("Injection timing",  "°",    2, lambda d: (256 * d[3] + d[4]) / 128 - 210),
    0x5E: ("Fuel rate",         "L/h",  2, lambda d: (256 * d[3] + d[4]) / 20),
    0x61: ("Driver dmd torque", "%",    1, lambda d: d[3] - 125),
    0x62: ("Actual torque",     "%",    1, lambda d: d[3] - 125),
    0x63: ("Ref torque",        "Nm",   2, lambda d: 256 * d[3] + d[4]),
    # --- Multi-frame (ISO-TP) diesel PIDs: these exceed one CAN frame, so they
    # only decode after reassembly. Byte A (d[3]) is a "supported sensor"
    # bitmap; sensor 1's temperature is the two bytes after it. Confirm the
    # exact layout against real OM642 captures before trusting more sensors.
    0x78: ("EGT bank 1 S1",     "°C",   9, lambda d: (256 * d[4] + d[5]) / 10 - 40),
}

# PID 0x24 carries two 16-bit measurements in one response. The metric key is
# part of the emitted event so the renderer and broker retain both readings.
PID_METRICS = {
    0x24: (
        "O2 sensor 1 lambda / voltage",
        4,
        (
            ("lambda", "O2 sensor 1 lambda", "λ",
             lambda d: (256 * d[3] + d[4]) / 32768),
            ("voltage", "O2 sensor 1 voltage", "V",
             lambda d: (256 * d[5] + d[6]) / 8192),
        ),
    ),
}


def decoder_name(pid):
    """Return the display name for an implemented PID decoder."""
    if pid in PIDS:
        return PIDS[pid][0]
    compound = PID_METRICS.get(pid)
    return compound[0] if compound else None


DECODABLE_PIDS = tuple((*PIDS.keys(), *PID_METRICS.keys()))

# Order in which the poller requests PIDs. 0x01 ("monitor status") rides along
# so we always learn MIL / stored-DTC-count / readiness — decoded separately.
MONITOR_PID = 0x01
POLL_LIST = [MONITOR_PID, *DECODABLE_PIDS]

REQUEST_ID = 0x7DF   # functional / broadcast request
RESPONSE_ID = 0x7E8  # ECM response
# Any module may answer a functional request in the standard 0x7E8..0x7EF range.
RESPONSE_IDS = range(0x7E8, 0x7F0)
PAD = 0x55           # request padding byte

# "Supported PIDs" probe PIDs — each returns a 32-bit bitmask of which PIDs in
# the next block the module supports (0x00 -> 0x01..0x20, 0x20 -> 0x21..0x40, …).
SUPPORT_PIDS = (0x00, 0x20, 0x40, 0x60, 0x80, 0xA0, 0xC0)

DEFAULT_POLL_PERIOD = 1.25   # minimum seconds for a full sweep
DEFAULT_INTER_FRAME = 0.025  # gap between individual request frames

_out_lock = threading.Lock()
_emit_sink = None


def set_emit_sink(sink):
    """Route emitted protocol objects to `sink`; use None for NDJSON stdout."""
    global _emit_sink
    with _out_lock:
        _emit_sink = sink


def emit(obj):
    """Emit one protocol object to the configured sink (thread-safe)."""
    with _out_lock:
        sink = _emit_sink
    if sink is not None:
        sink(obj)
        return
    line = json.dumps(obj)
    with _out_lock:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, ValueError):
            # Parent went away — nothing useful we can do.
            os._exit(0)


_last_warn = {"t": 0.0, "msg": ""}


def emit_warn(msg, throttle=3.0):
    """Emit a non-fatal warning, throttled so transient hiccups don't spam."""
    now = time.time()
    if msg == _last_warn["msg"] and now - _last_warn["t"] < throttle:
        return
    _last_warn["t"] = now
    _last_warn["msg"] = msg
    emit({"type": "warn", "msg": msg})


def _complete_single_frame(data, data_length):
    """Return True when an ISO-TP single frame contains the expected PID bytes."""
    if not data or data[0] & 0xF0:
        return False
    payload_length = data[0] & 0x0F
    return payload_length >= 2 + data_length and len(data) >= 1 + payload_length


def _payload_ready(data, data_length, reassembled):
    """True when `data` holds a PID plus its expected value bytes.

    Single frames must pass the ISO-TP single-frame length check. Reassembled
    multi-frame payloads arrive as [0x00, 0x41, pid, A, B, …] (a synthetic PCI
    byte so the same value lambdas apply), so we only need enough bytes.
    """
    if reassembled:
        return len(data) >= 3 + data_length
    return _complete_single_frame(data, data_length)


def decode_metrics(data, reassembled=False):
    """Decode a Mode-01 response into zero or more telemetry metric dictionaries."""
    if len(data) < 4 or data[1] != 0x41:
        return []
    pid = data[2]
    entry = PIDS.get(pid)
    if entry:
        name, unit, data_length, fn = entry
        if not _payload_ready(data, data_length, reassembled):
            return []
        try:
            value = round(float(fn(data)), 2)
        except (IndexError, ZeroDivisionError, ValueError):
            return []
        return [{"pid": pid, "metric": None, "name": name,
                 "value": value, "unit": unit}]

    compound = PID_METRICS.get(pid)
    if not compound:
        return []
    _, data_length, metrics = compound
    if not _payload_ready(data, data_length, reassembled):
        return []
    decoded = []
    try:
        for metric, name, unit, fn in metrics:
            decoded.append({
                "pid": pid,
                "metric": metric,
                "name": name,
                "value": round(float(fn(data)), 3),
                "unit": unit,
            })
    except (IndexError, ZeroDivisionError, ValueError):
        return []
    return decoded


# ISO-TP (ISO 15765-2) reassembly: OBD responses larger than 7 bytes arrive as a
# First Frame plus Consecutive Frames. Larger diesel PIDs (EGT, DPF, NOx, SCR)
# need this. Single frames are handled by the existing single-frame path.
FLOW_CONTROL = [0x30, 0x00, 0x00, PAD, PAD, PAD, PAD, PAD]


class IsoTpReassembler:
    """Reassemble multi-frame OBD responses, keyed by responding CAN ID."""

    def __init__(self):
        self._buffers = {}

    def feed(self, arb_id, data):
        """Feed one received frame.

        Returns (payload, flow_control_id):
          * payload — the completed service bytes [0x41, pid, …] when a transfer
            finishes (else None).
          * flow_control_id — the physical address to send a Flow Control to
            after a First Frame (else None). For response 0x7E8 that is 0x7E0.
        """
        if not data:
            return None, None
        kind = data[0] & 0xF0
        if kind == 0x10:  # First Frame: 12-bit length, 6 payload bytes follow.
            total = ((data[0] & 0x0F) << 8) | (data[1] if len(data) > 1 else 0)
            self._buffers[arb_id] = {"total": total, "bytes": list(data[2:8])}
            return None, arb_id - 8
        if kind == 0x20:  # Consecutive Frame.
            buf = self._buffers.get(arb_id)
            if buf is None:
                return None, None
            buf["bytes"].extend(data[1:8])
            if len(buf["bytes"]) >= buf["total"]:
                payload = buf["bytes"][:buf["total"]]
                del self._buffers[arb_id]
                return payload, None
            return None, None
        return None, None  # Single frame / unknown — handled elsewhere.


def decode_response(data):
    """Decode the primary metric from a Mode-01 positive response."""
    metrics = decode_metrics(data)
    if not metrics:
        return None
    primary = metrics[0]
    return (
        primary["pid"], primary["name"], primary["value"], primary["unit"],
    )


def decode_supported(ecu, data):
    """Decode a 'supported PIDs' bitmask response. Returns a dict or None.

    For a request of support-PID `base`, the 4 payload bytes form a 32-bit mask
    where the MSB maps to PID base+1 and the LSB to PID base+32. A set bit means
    that PID is supported by this module.
    """
    if len(data) < 7 or data[1] != 0x41 or data[2] not in SUPPORT_PIDS:
        return None
    base = data[2]
    mask = (data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]
    # Exclude the support-PID continuation markers (e.g. 0x20/0x40/0x80) — a set
    # bit there only means "the next block exists", not a real data PID.
    pids = [base + 1 + i for i in range(32)
            if mask & (1 << (31 - i)) and (base + 1 + i) not in SUPPORT_PIDS]
    names = {
        str(p): ("Monitor status" if p == MONITOR_PID else decoder_name(p))
        for p in pids if p == MONITOR_PID or decoder_name(p)
    }
    return {"type": "supported", "ecu": ecu, "base": base,
            "pids": pids, "names": names}


def decode_monitors(ecu, data):
    """Decode Mode-01 PID 0x01 (monitor status): MIL lamp + stored-DTC count."""
    if len(data) < 7 or data[1] != 0x41 or data[2] != MONITOR_PID:
        return None
    a = data[3]
    return {"type": "monitors", "ecu": ecu,
            "mil": bool(a & 0x80), "dtc_count": a & 0x7F,
            "b": data[4], "c": data[5], "d": data[6]}


def emit_pid_metrics(ecu, metrics, event_time):
    """Emit one 'pid' event per decoded metric dictionary."""
    for decoded in metrics:
        event = {
            "type": "pid",
            "ecu": ecu,
            "pid": decoded["pid"],
            "name": decoded["name"],
            "value": decoded["value"],
            "unit": decoded["unit"],
            "t": event_time,
        }
        if decoded["metric"]:
            event["metric"] = decoded["metric"]
        emit(event)


def emit_reassembled(ecu, payload, timestamp=None):
    """Emit telemetry from a reassembled multi-frame service payload."""
    event_time = timestamp or time.time()
    # Prepend a synthetic single-frame PCI byte so the value lambdas (which
    # index from the raw frame) apply unchanged to the reassembled bytes.
    emit_pid_metrics(ecu, decode_metrics([0x00, *payload], reassembled=True), event_time)


def emit_obd_response(ecu, data, state, timestamp=None):
    """Decode and emit all supported events found in one single-frame response."""
    event_time = timestamp or time.time()
    emit_pid_metrics(ecu, decode_metrics(data), event_time)
    supported = decode_supported(ecu, data)
    if supported:
        state.setdefault("supported_pids", set()).update(supported["pids"])
        emit(supported)
    monitors = decode_monitors(ecu, data)
    if monitors:
        monitors["t"] = event_time
        emit(monitors)


def open_kvaser_bus(can_module, channel, silent):
    """Open a classic-CAN Kvaser channel in an explicit driver mode."""
    return can_module.Bus(
        interface="kvaser",
        channel=channel,
        bitrate=500000,
        fd=False,
        driver_mode=not silent,
    )


def stdin_loop(state):
    """Read newline-delimited JSON commands from stdin."""
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("cmd") == "poll":
            state["poll"] = bool(msg.get("on"))
            emit({"type": "status", "msg": "polling " + ("on" if state["poll"] else "off"),
                  "poll": state["poll"]})
        elif msg.get("cmd") == "discover":
            # Request a one-shot supported-PID scan (handled by the worker
            # thread so all bus.send calls stay on one thread).
            state["discover"] = True
        elif msg.get("cmd") == "quit":
            state["stop"] = True
            return


# ---------------------------------------------------------------------------
# Real hardware path
# ---------------------------------------------------------------------------
def run_real(channel, state, poll_period, inter_frame):
    try:
        import can
    except Exception as e:  # noqa: BLE001
        emit({"type": "error",
              "msg": "python-can is not installed (pip install python-can). "
                     "Details: %s" % e,
              "retryable": False})
        return

    try:
        bus = open_kvaser_bus(can, channel, silent=True)
    except Exception as e:  # noqa: BLE001
        pi_help = ""
        if sys.platform.startswith("linux"):
            pi_help = (
                " On Raspberry Pi, install Kvaser LinuxCAN once with the "
                "included install-kvaser-driver-pi.sh helper, then reboot."
            )
        emit({"type": "error",
              "msg": "Could not open Kvaser channel %s at 500 kbit/s. "
                     "Is the U100 plugged in and the CANlib driver installed? "
                     "Details: %s%s" % (channel, e, pi_help),
              "retryable": True})
        return

    mode_condition = threading.Condition()
    # Serialize all transmits: the poller thread sends requests while the reader
    # thread sends ISO-TP flow-control frames, and they share one bus handle.
    tx_lock = threading.Lock()
    bus_ref = {
        "bus": bus,
        "silent": True,
        "requested_silent": True,
        "switching": False,
    }

    emit({"type": "status",
          "connected": True,
          "msg": "Kvaser channel %s open @ 500 kbit/s (hardware-silent)" % channel,
          "mode": "silent", "poll": state["poll"]})

    def request_bus_mode(silent):
        """Ask the reader thread to change mode, then wait for completion."""
        with mode_condition:
            bus_ref["requested_silent"] = silent
            mode_condition.notify_all()
            while (not state["stop"]
                   and (bus_ref["switching"] or bus_ref["silent"] != silent)):
                mode_condition.wait(timeout=0.25)
            return (not state["stop"] and not bus_ref["switching"]
                    and bus_ref["bus"] is not None
                    and bus_ref["silent"] == silent)

    def apply_requested_bus_mode():
        """Apply mode changes on the reader thread, away from bus.recv()."""
        with mode_condition:
            silent = bus_ref["requested_silent"]
            if bus_ref["bus"] is not None and bus_ref["silent"] == silent:
                return True
            old_bus = bus_ref["bus"]
            bus_ref["bus"] = None
            bus_ref["switching"] = True
        if old_bus is not None:
            try:
                old_bus.shutdown()
            except Exception:  # noqa: BLE001
                pass
        try:
            new_bus = open_kvaser_bus(can, channel, silent=silent)
        except Exception as e:  # noqa: BLE001
            with mode_condition:
                state["stop"] = True
                bus_ref["switching"] = False
                mode_condition.notify_all()
            emit({"type": "error",
                  "msg": "Could not switch Kvaser channel %s to %s mode. "
                         "Details: %s" %
                         (channel, "silent" if silent else "active", e),
                  "retryable": True})
            return False
        with mode_condition:
            bus_ref["bus"] = new_bus
            bus_ref["silent"] = silent
            bus_ref["switching"] = False
            mode_condition.notify_all()
        emit({"type": "status", "connected": True,
              "msg": "Kvaser channel %s @ 500 kbit/s (%s)" %
                     (channel, "hardware-silent" if silent else "diagnostic TX enabled"),
              "mode": "silent" if silent else "active",
              "poll": state["poll"]})
        return True

    def send_request(pid):
        """Send a functional Mode-01 request for `pid`. Returns True on success."""
        msg = can.Message(
            arbitration_id=REQUEST_ID,
            is_extended_id=False,
            data=[0x02, 0x01, pid, PAD, PAD, PAD, PAD, PAD],
        )
        try:
            # Blocking send: wait (up to timeout) for the frame to be
            # transmitted rather than overflowing the small TX FIFO. 0x7DF is a
            # low-priority ID, so on a busy bus requests can back up — letting
            # the driver pace us avoids "transmit buffer overflow" (Error -13).
            with mode_condition:
                active_bus = bus_ref["bus"]
                if active_bus is None or bus_ref["silent"]:
                    return False
            # The Kvaser backend uses separate read/write handles by default,
            # so this can run concurrently with bus.recv() without delaying
            # every request by the receive timeout.
            with tx_lock:
                active_bus.send(msg, timeout=0.2)
            return True
        except Exception as e:  # noqa: BLE001
            emit_warn("OBD request delayed (bus busy / TX full): %s" % e)
            time.sleep(0.1)
            return False

    def send_flow_control(physical_id):
        """Reply to an ISO-TP First Frame so the ECU streams the rest."""
        with mode_condition:
            active_bus = bus_ref["bus"]
            if active_bus is None or bus_ref["silent"]:
                return
        try:
            with tx_lock:
                active_bus.send(can.Message(
                    arbitration_id=physical_id, is_extended_id=False,
                    data=list(FLOW_CONTROL)), timeout=0.2)
        except Exception as e:  # noqa: BLE001
            emit_warn("ISO-TP flow control send failed: %s" % e)

    def do_discover():
        """One-shot scan: ask every module which PIDs it supports."""
        emit({"type": "status", "msg": "discovering supported PIDs…"})
        for base in SUPPORT_PIDS:
            if state["stop"]:
                break
            send_request(base)
            time.sleep(0.08)  # leave room for responses between probes
        emit({"type": "status", "msg": "discovery requests sent"})

    # --- Worker thread: discovery + (when enabled) polling -------------------
    def poller():
        while not state["stop"]:
            wants_tx = bool(state.get("discover") or state["poll"])
            if not request_bus_mode(silent=not wants_tx):
                break
            if state.get("discover"):
                state["discover"] = False
                do_discover()
            if not state["poll"]:
                if not state.get("discover") and not request_bus_mode(silent=True):
                    break
                time.sleep(0.1)
                continue
            # After a discovery, only poll PIDs the bus actually supports — no
            # point spending TX on requests nothing answers. Before discovery,
            # poll the full list.
            sup = state.get("supported_pids")
            targets = [p for p in POLL_LIST if not sup or p in sup]
            sweep_start = time.time()
            for pid in targets:
                if state["stop"] or not state["poll"]:
                    break
                send_request(pid)
                time.sleep(inter_frame)
            elapsed = time.time() - sweep_start
            remaining = max(0.0, poll_period - elapsed)
            while remaining > 0 and state["poll"] and not state["stop"]:
                wait = min(0.05, remaining)
                time.sleep(wait)
                remaining -= wait

    poll_thread = threading.Thread(target=poller, daemon=True)
    poll_thread.start()

    reassembler = IsoTpReassembler()

    # --- Reader loop ---------------------------------------------------------
    try:
        while not state["stop"]:
            if not apply_requested_bus_mode():
                break
            try:
                with mode_condition:
                    active_bus = bus_ref["bus"]
                    if active_bus is None:
                        break
                msg = active_bus.recv(timeout=0.1)
            except Exception as e:  # noqa: BLE001
                emit({"type": "error", "msg": "CAN receive failed: %s" % e,
                      "retryable": True})
                with mode_condition:
                    state["stop"] = True
                    mode_condition.notify_all()
                break
            if msg is None:
                continue
            data = list(msg.data)
            emit({
                "type": "frame",
                "id": msg.arbitration_id,
                "ext": bool(msg.is_extended_id),
                "dlc": msg.dlc,
                "data": bytes(data).hex(),
                "t": msg.timestamp or time.time(),
            })
            if msg.arbitration_id in RESPONSE_IDS:
                event_time = msg.timestamp or time.time()
                if data and data[0] & 0xF0 in (0x10, 0x20):
                    payload, flow_control_id = reassembler.feed(
                        msg.arbitration_id, data)
                    if flow_control_id is not None:
                        send_flow_control(flow_control_id)
                    if payload is not None:
                        emit_reassembled(msg.arbitration_id, payload, event_time)
                else:
                    emit_obd_response(msg.arbitration_id, data, state, event_time)
    finally:
        with mode_condition:
            state["stop"] = True
            active_bus = bus_ref["bus"]
            bus_ref["bus"] = None
            bus_ref["switching"] = False
            mode_condition.notify_all()
        poll_thread.join(timeout=0.5)
        if active_bus is not None:
            try:
                active_bus.shutdown()
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------------
# Demo / simulation path  (--demo): no hardware required
# ---------------------------------------------------------------------------
def _demo_value_bytes(pid, el):
    """Return the value data byte(s) for a simulated PID at elapsed time `el`."""
    def word(value):
        value = max(0, min(0xFFFF, int(value)))
        return [(value >> 8) & 0xFF, value & 0xFF]

    # Shared signals that animate a plausible running engine.
    warm = min(1.0, el / 60.0)                     # 0 -> 1 over first minute
    throttle = 0.20 + 0.20 * (1 + math.sin(el * 0.5)) / 2  # 0.2 .. 0.4
    load = 0.25 + 0.45 * (1 + math.sin(el * 0.45)) / 2     # 0.25 .. 0.7
    speed = max(0.0, 45 + 45 * math.sin(el * 0.18))        # 0 .. 90 km/h

    if pid == 0x04:   # engine load %
        a = int(255 * load)
        return [a & 0xFF]
    if pid == 0x05:   # coolant temp
        return [int(20 + 68 * warm) + 40 & 0xFF]
    if pid == 0x0B:   # intake MAP kPa
        return [int(100 + 90 * load) & 0xFF]
    if pid == 0x0C:   # rpm
        rpm = int(820 + 1500 * throttle + random.uniform(-25, 25))
        v = max(0, min(0xFFFF, rpm * 4))
        return [(v >> 8) & 0xFF, v & 0xFF]
    if pid == 0x0D:   # speed km/h
        return [int(speed) & 0xFF]
    if pid == 0x0F:   # intake air temp
        return [int(28 + 8 * load) + 40 & 0xFF]
    if pid == 0x10:   # MAF g/s
        return word((3 + 28 * load) * 100)
    if pid == 0x11:   # intake throttle valve % (diesel: mostly open)
        return [int(255 * (0.75 + 0.2 * load)) & 0xFF]
    if pid in (0x45, 0x47, 0x49, 0x4A, 0x4B, 0x5A):  # pedal/throttle variants
        # Simulate the driver's pedal tracking demand.
        return [int(255 * throttle) & 0xFF]
    if pid == 0x2F:   # fuel level %
        return [int(255 * 0.63) & 0xFF]
    if pid == 0x42:   # module voltage
        v = int((13.9 + 0.4 * load) * 1000)
        return [(v >> 8) & 0xFF, v & 0xFF]
    if pid == 0x46:   # ambient air temp
        return [22 + 40 & 0xFF]
    if pid == 0x5C:   # oil temp
        return [int(25 + 70 * warm) + 40 & 0xFF]
    if pid == 0x21:   # distance with MIL on (0 = no fault)
        return word(0)
    if pid == 0x30:   # warm-ups since codes cleared
        return [0x0C]
    if pid == 0x31:   # distance since codes cleared
        return word(1234)
    if pid == 0x33:   # absolute barometric pressure kPa
        return [99]
    if pid == 0x01:   # monitor status: MIL off, 0 DTCs, monitors clear
        return [0x00, 0x00, 0x00, 0x00]
    if pid == 0x06:   # short-term fuel trim, about +1.6%
        return [130]
    if pid == 0x07:   # long-term fuel trim, 0%
        return [128]
    if pid == 0x0A:   # low-side fuel pressure, 75 kPa
        return [25]
    if pid == 0x0E:   # timing advance, 8 degrees
        return [144]
    if pid == 0x1F:   # engine run time
        return word(el)
    if pid == 0x23:   # common-rail pressure, about 42 MPa
        return word(4200)
    if pid == 0x24:   # wide-range O2 sensor: lambda 1.0, 2.0 V
        return [*word(32768), *word(16384)]
    if pid == 0x2C:   # commanded EGR, 35%
        return [89]
    if pid == 0x2D:   # EGR error, 0%
        return [128]
    if pid == 0x3C:   # catalyst temperature, 300 C
        return word(3400)
    if pid == 0x43:   # absolute load, about 33%
        return word(85)
    if pid == 0x44:   # lambda 1.0
        return word(32768)
    if pid == 0x4C:   # commanded throttle actuator
        return [int(255 * throttle) & 0xFF]
    if pid == 0x5D:   # injection timing, 3 degrees
        return word((210 + 3) * 128)
    if pid == 0x5E:   # fuel rate, 4.3 L/h
        return word(86)
    if pid == 0x61:   # driver demand torque, 35%
        return [160]
    if pid == 0x62:   # actual torque, 30%
        return [155]
    if pid == 0x63:   # reference torque, 420 Nm
        return word(420)
    return [0x00]


def _demo_multiframe_service(pid, el):
    """Full service payload [0x41, pid, …] for a simulated multi-frame PID."""
    load = 0.25 + 0.45 * (1 + math.sin(el * 0.45)) / 2

    def temp_bytes(celsius):
        raw = max(0, min(0xFFFF, int((celsius + 40) * 10)))
        return [(raw >> 8) & 0xFF, raw & 0xFF]

    if pid == 0x78:  # EGT bank 1; bitmap reports sensors 1 and 2 present.
        return [0x41, 0x78, 0x03,
                *temp_bytes(210 + 360 * load),
                *temp_bytes(190 + 320 * load),
                0x00, 0x00, 0x00, 0x00]
    return None


def _isotp_frames(service):
    """Split a service payload into ISO-TP First + Consecutive CAN frames."""
    total = len(service)
    frames = [[0x10 | ((total >> 8) & 0x0F), total & 0xFF, *service[0:6]]]
    rest = service[6:]
    sequence = 1
    while rest:
        frames.append([0x20 | (sequence & 0x0F), *rest[:7]])
        rest = rest[7:]
        sequence += 1
    return [(frame + [PAD] * (8 - len(frame)))[:8] for frame in frames]


def run_demo(state, poll_period):
    emit({"type": "status", "connected": True,
          "msg": "DEMO mode — simulated frames, no hardware",
          "mode": "simulated", "poll": state["poll"]})

    # Proprietary-looking broadcast IDs (shown as raw hex; never decoded).
    broadcast_ids = [0x1A0, 0x200, 0x308, 0x420, 0x50C, 0x610]
    t0 = time.time()
    last_poll = 0.0

    while not state["stop"]:
        now = time.time()
        el = now - t0

        # Continuous broadcast traffic, ~6 frames every 50 ms (~120 fps).
        for bid in broadcast_ids:
            payload = bytes(random.getrandbits(8) for _ in range(8))
            emit({"type": "frame", "id": bid, "ext": False, "dlc": 8,
                  "data": payload.hex(), "t": now})

        # Respond to a discovery request: report our simulated PIDs as
        # "supported", split into the relevant base blocks, from two fake ECUs.
        if state.get("discover"):
            state["discover"] = False
            emit({"type": "status", "msg": "DEMO discovery"})
            for ecu in (0x7E8, 0x7E9):
                module_pids = (
                    [MONITOR_PID, *DECODABLE_PIDS, 0x13]
                    if ecu == 0x7E8
                    else [0x05, 0x0C, 0x0D]
                )
                for base in SUPPORT_PIDS:
                    block = [p for p in module_pids
                             if base < p <= base + 0x20]
                    if not block:
                        continue
                    emit({"type": "supported", "ecu": ecu, "base": base,
                          "pids": block,
                          "names": {
                              str(p): (
                                  "Monitor status"
                                  if p == MONITOR_PID else decoder_name(p)
                              )
                              for p in block
                              if p == MONITOR_PID or decoder_name(p)
                          }})

        # When polling is on, emulate the request/response round-trips.
        if state["poll"] and (now - last_poll) >= poll_period:
            last_poll = now
            for pid in POLL_LIST:
                # Outgoing functional request frame on 0x7DF.
                req = bytes([0x02, 0x01, pid, PAD, PAD, PAD, PAD, PAD])
                emit({"type": "frame", "id": REQUEST_ID, "ext": False,
                      "dlc": 8, "data": req.hex(), "t": now})

                # Multi-frame PIDs (ISO-TP): stream a First + Consecutive frame
                # pair, then decode the reassembled payload like live capture.
                service = _demo_multiframe_service(pid, el)
                if service is not None:
                    for frame in _isotp_frames(service):
                        emit({"type": "frame", "id": RESPONSE_ID, "ext": False,
                              "dlc": 8, "data": bytes(frame).hex(), "t": now})
                    emit_reassembled(RESPONSE_ID, service, now)
                    continue

                # ECM single-frame response on 0x7E8.
                vb = _demo_value_bytes(pid, el)
                pci = 2 + len(vb)
                resp = [pci, 0x41, pid] + vb
                resp = (resp + [PAD] * (8 - len(resp)))[:8]
                emit({"type": "frame", "id": RESPONSE_ID, "ext": False,
                      "dlc": 8, "data": bytes(resp).hex(), "t": now})

                emit_obd_response(RESPONSE_ID, resp, state, now)

        time.sleep(0.05)


# ---------------------------------------------------------------------------
# Log replay path: emits the same protocol as live capture, preserving timing.
# ---------------------------------------------------------------------------
def run_replay(filename, state, speed=1.0, max_gap=1.0):
    try:
        import can
    except Exception as e:  # noqa: BLE001
        emit({"type": "error",
              "msg": "python-can is required for replay. Details: %s" % e,
              "retryable": False})
        return

    try:
        reader = can.LogReader(filename)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "msg": "Could not open replay log: %s" % e,
              "retryable": False})
        return

    emit({"type": "status", "connected": True, "mode": "replay",
          "msg": "Replay: %s @ %.2fx" % (filename, speed), "poll": False})
    previous_timestamp = None
    reassembler = IsoTpReassembler()
    try:
        for msg in reader:
            if state["stop"]:
                break
            timestamp = msg.timestamp or time.time()
            if previous_timestamp is not None:
                delay = max(0.0, (timestamp - previous_timestamp) / speed)
                if delay:
                    time.sleep(min(delay, max_gap))
            previous_timestamp = timestamp
            data = list(msg.data)
            emit({
                "type": "frame",
                "id": msg.arbitration_id,
                "ext": bool(msg.is_extended_id),
                "dlc": msg.dlc,
                "data": bytes(data).hex(),
                "t": timestamp,
            })
            if msg.arbitration_id in RESPONSE_IDS:
                # No live bus to flow-control during replay; just reassemble what
                # was recorded (the original First/Consecutive frames are stored).
                if data and data[0] & 0xF0 in (0x10, 0x20):
                    payload, _ = reassembler.feed(msg.arbitration_id, data)
                    if payload is not None:
                        emit_reassembled(msg.arbitration_id, payload, timestamp)
                else:
                    emit_obd_response(msg.arbitration_id, data, state, timestamp)
    finally:
        reader.stop()
    emit({"type": "status", "connected": False, "mode": "replay",
          "msg": "Replay complete", "poll": False})


# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Sprinter CAN acquisition bridge")
    parser.add_argument("--demo", action="store_true",
                        help="Generate simulated frames + PID responses (no hardware)")
    parser.add_argument("--replay", help="Replay a python-can compatible log file")
    parser.add_argument("--replay-speed", type=float, default=1.0,
                        help="Replay speed multiplier (default 1.0)")
    parser.add_argument("--channel", default=os.environ.get("KVASER_CHANNEL", "0"),
                        help="Kvaser channel index (default 0)")
    parser.add_argument("--poll-period", type=float, default=DEFAULT_POLL_PERIOD,
                        help="Minimum seconds per complete PID sweep (default 1.25)")
    parser.add_argument("--inter-frame", type=float, default=DEFAULT_INTER_FRAME,
                        help="Seconds between OBD requests (default 0.025)")
    args = parser.parse_args()
    if args.poll_period <= 0:
        parser.error("--poll-period must be greater than zero")
    if args.inter_frame < 0:
        parser.error("--inter-frame cannot be negative")
    if args.replay_speed <= 0:
        parser.error("--replay-speed must be greater than zero")
    if args.demo and args.replay:
        parser.error("--demo and --replay are mutually exclusive")

    # Channel may be numeric or a string depending on the backend.
    channel = args.channel
    try:
        channel = int(channel)
    except (TypeError, ValueError):
        pass

    state = {"poll": False, "stop": False}

    # stdin command reader (daemon so process exits even if stdin blocks).
    threading.Thread(target=stdin_loop, args=(state,), daemon=True).start()

    try:
        if args.replay:
            run_replay(args.replay, state, args.replay_speed)
        elif args.demo:
            run_demo(state, args.poll_period)
        else:
            run_real(channel, state, args.poll_period, args.inter_frame)
    except KeyboardInterrupt:
        pass
    finally:
        state["stop"] = True


if __name__ == "__main__":
    main()
