"""Durable session recording: raw CAN plus indexed decoded telemetry."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  started_utc TEXT NOT NULL,
  ended_utc TEXT,
  vehicle TEXT,
  raw_log TEXT NOT NULL,
  stop_reason TEXT
);
CREATE TABLE IF NOT EXISTS samples (
  timestamp REAL NOT NULL,
  ecu INTEGER,
  pid INTEGER NOT NULL,
  metric TEXT,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_pid_time ON samples(pid, timestamp);
CREATE TABLE IF NOT EXISTS monitors (
  timestamp REAL NOT NULL,
  ecu INTEGER NOT NULL,
  mil INTEGER NOT NULL,
  dtc_count INTEGER NOT NULL,
  readiness_b INTEGER,
  readiness_c INTEGER,
  readiness_d INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  timestamp REAL NOT NULL,
  kind TEXT NOT NULL,
  message TEXT,
  payload_json TEXT
);
"""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SessionRecorder:
    """Record one session at a time with bounded, synchronized file writes."""

    def __init__(
        self,
        base_directory,
        vehicle="2016 Mercedes Sprinter 2500 W906",
        raw_format="blf",
    ):
        suffix = raw_format.lower().lstrip(".")
        if suffix not in {"blf", "asc", "log"}:
            raise ValueError("raw_format must be blf, asc, or log")
        self.base_directory = Path(base_directory).expanduser().resolve()
        self.vehicle = vehicle
        self.raw_format = suffix
        self._lock = threading.RLock()
        self._active = False
        self._connection = None
        self._raw_writer = None
        self._session_id = None
        self._session_directory = None
        self._started_utc = None
        self._frames = 0
        self._samples = 0
        self._events = 0
        self._pending_rows = 0
        self._last_commit = 0.0

    @property
    def active(self) -> bool:
        with self._lock:
            return self._active

    def start(self, metadata=None) -> dict:
        with self._lock:
            if self._active:
                return self.status()
            import can

            self.base_directory.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self._session_id = f"{stamp}_{uuid.uuid4().hex[:8]}"
            self._session_directory = self.base_directory / self._session_id
            self._session_directory.mkdir()
            raw_path = self._session_directory / f"raw.{self.raw_format}"
            database_path = self._session_directory / "telemetry.sqlite3"

            self._raw_writer = can.Logger(raw_path)
            self._connection = sqlite3.connect(database_path, check_same_thread=False)
            self._connection.executescript(SCHEMA)
            self._started_utc = _utc_now()
            self._connection.execute(
                "INSERT INTO session(session_id, started_utc, vehicle, raw_log) "
                "VALUES (?, ?, ?, ?)",
                (self._session_id, self._started_utc, self.vehicle, raw_path.name),
            )
            self._connection.execute(
                "INSERT INTO events(timestamp, kind, message, payload_json) "
                "VALUES (?, ?, ?, ?)",
                (time.time(), "session", "recording started", json.dumps(metadata or {})),
            )
            self._connection.commit()
            self._active = True
            self._frames = self._samples = self._events = self._pending_rows = 0
            self._last_commit = time.monotonic()
            self._write_metadata({"active": True, **(metadata or {})})
            return self.status()

    def handle(self, event: dict) -> None:
        with self._lock:
            if not self._active:
                return
            event_type = event.get("type")
            timestamp = float(event.get("t") or time.time())
            if event_type == "frame":
                self._record_frame(event, timestamp)
            elif event_type == "pid":
                self._connection.execute(
                    "INSERT INTO samples(timestamp, ecu, pid, metric, name, value, unit) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        timestamp,
                        event.get("ecu"),
                        event["pid"],
                        event.get("metric"),
                        event["name"],
                        event["value"],
                        event.get("unit", ""),
                    ),
                )
                self._samples += 1
                self._pending_rows += 1
            elif event_type == "monitors":
                self._connection.execute(
                    "INSERT INTO monitors(timestamp, ecu, mil, dtc_count, "
                    "readiness_b, readiness_c, readiness_d) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        timestamp,
                        event["ecu"],
                        int(bool(event.get("mil"))),
                        int(event.get("dtc_count", 0)),
                        event.get("b"),
                        event.get("c"),
                        event.get("d"),
                    ),
                )
                self._pending_rows += 1
            elif event_type in {"status", "warn", "error", "supported"}:
                self._connection.execute(
                    "INSERT INTO events(timestamp, kind, message, payload_json) "
                    "VALUES (?, ?, ?, ?)",
                    (
                        timestamp,
                        event_type,
                        event.get("msg"),
                        json.dumps(event, separators=(",", ":")),
                    ),
                )
                self._events += 1
                self._pending_rows += 1
            self._commit_if_needed()

    def _record_frame(self, event: dict, timestamp: float) -> None:
        import can

        message = can.Message(
            timestamp=timestamp,
            arbitration_id=int(event["id"]),
            is_extended_id=bool(event.get("ext")),
            data=bytes.fromhex(event.get("data", "")),
            is_rx=True,
        )
        self._raw_writer.on_message_received(message)
        self._frames += 1

    def _commit_if_needed(self) -> None:
        now = time.monotonic()
        if self._pending_rows >= 100 or now - self._last_commit >= 1.0:
            self._connection.commit()
            self._pending_rows = 0
            self._last_commit = now

    def stop(self, reason="user") -> dict:
        with self._lock:
            if not self._active:
                return self.status()
            ended_utc = _utc_now()
            self._connection.execute(
                "INSERT INTO events(timestamp, kind, message, payload_json) "
                "VALUES (?, ?, ?, ?)",
                (time.time(), "session", "recording stopped", json.dumps({"reason": reason})),
            )
            self._connection.execute(
                "UPDATE session SET ended_utc = ?, stop_reason = ? WHERE session_id = ?",
                (ended_utc, reason, self._session_id),
            )
            self._connection.commit()
            self._raw_writer.stop()
            self._connection.close()
            self._raw_writer = None
            self._connection = None
            self._active = False
            self._write_metadata({
                "active": False,
                "ended_utc": ended_utc,
                "stop_reason": reason,
            })
            return self.status()

    def _write_metadata(self, extra: dict) -> None:
        if self._session_directory is None:
            return
        metadata = {
            "session_id": self._session_id,
            "vehicle": self.vehicle,
            "started_utc": self._started_utc,
            "raw_format": self.raw_format,
            "frames": self._frames,
            "samples": self._samples,
            "events": self._events,
            **extra,
        }
        target = self._session_directory / "metadata.json"
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        temporary.replace(target)

    def status(self) -> dict:
        with self._lock:
            return {
                "type": "recording",
                "active": self._active,
                "session_id": self._session_id,
                "path": str(self._session_directory) if self._session_directory else None,
                "started_utc": self._started_utc,
                "frames": self._frames,
                "samples": self._samples,
                "events": self._events,
            }
