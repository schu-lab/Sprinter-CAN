import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from sprinter_can.recording import SessionRecorder


class SessionRecorderTests(unittest.TestCase):
    def test_records_raw_frames_decoded_samples_and_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            recorder = SessionRecorder(temporary, raw_format="blf")
            started = recorder.start({"mode": "test"})
            self.assertTrue(started["active"])

            recorder.handle({
                "type": "frame",
                "id": 0x7E8,
                "ext": False,
                "dlc": 8,
                "data": "04410c1af8555555",
                "t": 1000.0,
            })
            recorder.handle({
                "type": "pid",
                "ecu": 0x7E8,
                "pid": 0x0C,
                "metric": "speed",
                "name": "Engine RPM",
                "value": 1726.0,
                "unit": "rpm",
                "t": 1000.0,
            })
            recorder.handle({
                "type": "monitors",
                "ecu": 0x7E8,
                "mil": False,
                "dtc_count": 0,
                "b": 0,
                "c": 0,
                "d": 0,
                "t": 1000.0,
            })
            recorder.handle({"type": "warn", "msg": "test warning", "t": 1000.1})
            stopped = recorder.stop("test complete")

            self.assertFalse(stopped["active"])
            session_dir = Path(stopped["path"])
            self.assertGreater((session_dir / "raw.blf").stat().st_size, 0)

            connection = sqlite3.connect(session_dir / "telemetry.sqlite3")
            try:
                self.assertEqual(connection.execute(
                    "SELECT COUNT(*) FROM samples"
                ).fetchone()[0], 1)
                self.assertEqual(connection.execute(
                    "SELECT metric FROM samples"
                ).fetchone()[0], "speed")
                self.assertEqual(connection.execute(
                    "SELECT COUNT(*) FROM monitors"
                ).fetchone()[0], 1)
                self.assertEqual(connection.execute(
                    "SELECT stop_reason FROM session"
                ).fetchone()[0], "test complete")
            finally:
                connection.close()

            metadata = json.loads(
                (session_dir / "metadata.json").read_text(encoding="utf-8")
            )
            self.assertFalse(metadata["active"])
            self.assertEqual(metadata["frames"], 1)
            self.assertEqual(metadata["samples"], 1)

    def test_start_and_stop_are_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            recorder = SessionRecorder(temporary)
            first = recorder.start()
            second = recorder.start()
            self.assertEqual(first["session_id"], second["session_id"])
            recorder.stop()
            self.assertFalse(recorder.stop()["active"])


if __name__ == "__main__":
    unittest.main()
