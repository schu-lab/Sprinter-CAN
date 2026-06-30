import functools
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from sprinter_can.service import CollectorService, ServiceHandler, ServiceHTTPServer


class CollectorHTTPServiceTests(unittest.TestCase):
    def test_status_static_ui_and_recording_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            service = CollectorService(demo=True, log_directory=temporary)
            renderer = Path(__file__).resolve().parents[1] / "renderer"
            handler = functools.partial(ServiceHandler, directory=str(renderer))
            server = ServiceHTTPServer(("127.0.0.1", 0), handler, service)
            service.http_server = server
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_address[1]}"

            try:
                with urllib.request.urlopen(base + "/api/status") as response:
                    status = json.load(response)
                self.assertEqual(status["mode"], "demo")

                with urllib.request.urlopen(base + "/") as response:
                    page = response.read().decode("utf-8")
                self.assertIn("SPRINTER", page)

                started = self._post(base, {"cmd": "record", "on": True})
                self.assertTrue(started["recording"]["active"])
                stopped = self._post(base, {"cmd": "record", "on": False})
                self.assertFalse(stopped["recording"]["active"])
                self.assertTrue(Path(stopped["recording"]["path"]).exists())

                with self.assertRaises(urllib.error.HTTPError) as raised:
                    self._post(base, [])
                with raised.exception as response:
                    self.assertEqual(response.code, 400)
                    self.assertEqual(
                        json.load(response)["error"],
                        "command must be a JSON object",
                    )
            finally:
                service.close()
                thread.join(timeout=1)
                server.server_close()

    @staticmethod
    def _post(base, command):
        request = urllib.request.Request(
            base + "/api/command",
            data=json.dumps(command).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            return json.load(response)


class AutoPollTests(unittest.TestCase):
    def test_auto_poll_controls_initial_polling_intent(self):
        with tempfile.TemporaryDirectory() as temporary:
            enabled = CollectorService(
                demo=True, log_directory=temporary, auto_poll=True)
            try:
                # Auto-poll arms polling so the live views populate on connect.
                self.assertTrue(enabled._desired_poll)
                # Turning polling off is still honored and remembered.
                result = enabled.command({"cmd": "poll", "on": False})
                self.assertTrue(result["ok"])
                self.assertFalse(enabled._desired_poll)
            finally:
                enabled.close()

            disabled = CollectorService(
                demo=True, log_directory=temporary, auto_poll=False)
            try:
                self.assertFalse(disabled._desired_poll)
            finally:
                disabled.close()


if __name__ == "__main__":
    unittest.main()
