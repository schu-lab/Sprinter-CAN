"""Local collector service: CAN acquisition, recording, SSE, and static UI."""

from __future__ import annotations

import argparse
import functools
import json
import os
import queue
import signal
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import can_bridge

from .broker import EventBroker
from .recording import SessionRecorder


class CollectorService:
    def __init__(
        self,
        *,
        channel=0,
        demo=False,
        replay=None,
        replay_speed=1.0,
        poll_period=1.25,
        inter_frame=0.025,
        log_directory=None,
        raw_format="blf",
        auto_record=False,
        auto_poll=True,
        retry_seconds=3.0,
    ):
        self.channel = channel
        self.demo = demo
        self.replay = replay
        self.replay_speed = replay_speed
        self.poll_period = poll_period
        self.inter_frame = inter_frame
        self.auto_record = auto_record
        # Auto-poll: start polling as soon as the bus is open and keep that
        # intent across hot-plug reconnects, so the live views populate without
        # a manual toggle. The user can still switch polling off (and that
        # choice is preserved too).
        self.auto_poll = auto_poll
        self.retry_seconds = retry_seconds
        self.broker = EventBroker()
        self.recorder = SessionRecorder(
            log_directory or Path.home() / "Sprinter CAN Sessions",
            raw_format=raw_format,
        )
        self.shutdown_event = threading.Event()
        self._lock = threading.Lock()
        self._collector_state = None
        self._desired_poll = bool(auto_poll)
        self._pending_discover = False
        self.http_server = None
        can_bridge.set_emit_sink(self.publish)
        self.broker.publish(self.recorder.status())

    def publish(self, event: dict) -> None:
        try:
            self.recorder.handle(event)
        except Exception as error:  # noqa: BLE001
            try:
                status = self.recorder.stop("recording failure")
            except Exception:  # noqa: BLE001
                status = self.recorder.status()
            self.broker.publish({
                "type": "error",
                "msg": "Session recording failed: %s" % error,
                "retryable": False,
            })
            self.broker.publish(status)
        self.broker.publish(event)

    def command(self, command: dict) -> dict:
        if not isinstance(command, dict):
            return {"ok": False, "error": "command must be a JSON object"}
        name = command.get("cmd")
        if name == "poll" and isinstance(command.get("on"), bool):
            with self._lock:
                self._desired_poll = command["on"]
                if self._collector_state is not None:
                    self._collector_state["poll"] = command["on"]
            event = {
                "type": "status",
                "msg": "polling " + ("on" if command["on"] else "off"),
                "poll": command["on"],
            }
            self.publish(event)
            return {"ok": True, "poll": command["on"]}
        if name == "discover":
            with self._lock:
                self._pending_discover = True
                if self._collector_state is not None:
                    self._collector_state["discover"] = True
                    self._pending_discover = False
            return {"ok": True}
        if name == "record" and isinstance(command.get("on"), bool):
            try:
                if command["on"]:
                    status = self.recorder.start({
                        "mode": "replay" if self.replay else ("demo" if self.demo else "live"),
                        "channel": self.channel,
                    })
                else:
                    status = self.recorder.stop("user")
            except Exception as error:  # noqa: BLE001
                event = {
                    "type": "error",
                    "msg": "Could not change recording state: %s" % error,
                    "retryable": False,
                }
                self.publish(event)
                return {"ok": False, "error": str(error)}
            self.broker.publish(status)
            return {"ok": True, "recording": status}
        if name == "status":
            return self.status()
        if name == "quit":
            threading.Thread(target=self.request_shutdown, daemon=True).start()
            return {"ok": True}
        return {"ok": False, "error": "invalid command"}

    def status(self) -> dict:
        return {
            "ok": True,
            "service": self.broker.summary(),
            "recording": self.recorder.status(),
            "mode": "replay" if self.replay else ("demo" if self.demo else "live"),
        }

    def collector_loop(self) -> None:
        if self.auto_record:
            try:
                self.broker.publish(self.recorder.start({"auto_record": True}))
            except Exception as error:  # noqa: BLE001
                self.publish({
                    "type": "error",
                    "msg": "Auto-record could not start: %s" % error,
                    "retryable": False,
                })

        while not self.shutdown_event.is_set():
            with self._lock:
                state = {
                    "poll": self._desired_poll,
                    "stop": False,
                    "discover": self._pending_discover,
                }
                self._pending_discover = False
                self._collector_state = state
            try:
                if self.replay:
                    can_bridge.run_replay(
                        self.replay, state, speed=self.replay_speed,
                    )
                    break
                if self.demo:
                    can_bridge.run_demo(state, self.poll_period)
                    break
                can_bridge.run_real(
                    self.channel, state, self.poll_period, self.inter_frame,
                )
            except Exception as error:  # noqa: BLE001
                self.publish({
                    "type": "error",
                    "msg": "Collector failed: %s" % error,
                    "retryable": not bool(self.replay),
                })
            finally:
                with self._lock:
                    self._collector_state = None

            if self.demo or self.replay or self.shutdown_event.is_set():
                break
            # After a device loss, reconnect and search for the adapter. With
            # auto-poll on, the polling intent is preserved so the live views
            # resume automatically on replug; otherwise transmission stays off
            # until explicitly re-enabled.
            with self._lock:
                if not self.auto_poll:
                    self._desired_poll = False
                resumed_poll = self._desired_poll
            self.publish({
                "type": "status",
                "connected": False,
                "searching": True,
                "poll": resumed_poll,
                "msg": "searching for Kvaser device…",
            })
            self.shutdown_event.wait(self.retry_seconds)

    def request_shutdown(self) -> None:
        if self.shutdown_event.is_set():
            return
        self.shutdown_event.set()
        with self._lock:
            if self._collector_state is not None:
                self._collector_state["stop"] = True
        if self.recorder.active:
            status = self.recorder.stop("service shutdown")
            self.broker.publish(status)
        if self.http_server is not None:
            self.http_server.shutdown()

    def close(self) -> None:
        self.request_shutdown()
        can_bridge.set_emit_sink(None)


class ServiceHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, handler, service):
        self.service = service
        super().__init__(server_address, handler)

    def handle_error(self, request, client_address):
        # Browsers routinely reset their long-lived SSE socket while the
        # collector is shutting down. Keep that expected disconnect quiet.
        error = sys.exc_info()[1]
        if isinstance(
            error,
            (BrokenPipeError, ConnectionAbortedError, ConnectionResetError),
        ):
            return
        super().handle_error(request, client_address)


class ServiceHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def service(self) -> CollectorService:
        return self.server.service

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/events":
            self._serve_events()
            return
        if path in {"/api/status", "/api/health"}:
            self._send_json(self.service.status())
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802
        if urlparse(self.path).path != "/api/command":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0:
                raise ValueError
        except ValueError:
            self._send_json({"ok": False, "error": "invalid Content-Length"}, status=400)
            return
        if length > 65536:
            # Do not leave an unread request body on a persistent connection.
            self.close_connection = True
            self._send_json({"ok": False, "error": "request body too large"}, status=413)
            return
        try:
            command = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send_json({"ok": False, "error": "invalid JSON"}, status=400)
            return
        result = self.service.command(command)
        self._send_json(result, status=200 if result.get("ok") else 400)

    def _serve_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        subscriber = self.service.broker.subscribe()
        try:
            while not self.service.shutdown_event.is_set():
                try:
                    event = subscriber.get(timeout=15)
                    payload = json.dumps(event, separators=(",", ":"))
                    self.wfile.write(("data: " + payload + "\n\n").encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.service.broker.unsubscribe(subscriber)

    def _send_json(self, payload, status=200) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; connect-src 'self'; script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            "object-src 'none'; frame-ancestors 'none'",
        )
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("SPRINTER_CAN_HTTP_LOG") == "1":
            super().log_message(fmt, *args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sprinter CAN collector service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--channel", default=os.environ.get("KVASER_CHANNEL", "0"))
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--replay")
    parser.add_argument("--replay-speed", type=float, default=1.0)
    parser.add_argument("--poll-period", type=float, default=1.25)
    parser.add_argument("--inter-frame", type=float, default=0.025)
    parser.add_argument("--log-dir")
    parser.add_argument("--raw-format", choices=("blf", "asc", "log"), default="blf")
    parser.add_argument("--auto-record", action="store_true")
    parser.add_argument(
        "--auto-poll",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Start polling automatically when the bus connects (default on; "
             "use --no-auto-poll to stay hardware-silent until toggled).",
    )
    parser.add_argument(
        "--renderer-dir",
        default=str(Path(__file__).resolve().parents[1] / "renderer"),
    )
    return parser


def run(args=None) -> int:
    options = build_parser().parse_args(args)
    if options.demo and options.replay:
        raise SystemExit("--demo and --replay are mutually exclusive")
    if options.replay_speed <= 0:
        raise SystemExit("--replay-speed must be greater than zero")
    try:
        channel = int(options.channel)
    except (TypeError, ValueError):
        channel = options.channel

    service = CollectorService(
        channel=channel,
        demo=options.demo,
        replay=options.replay,
        replay_speed=options.replay_speed,
        poll_period=options.poll_period,
        inter_frame=options.inter_frame,
        log_directory=options.log_dir,
        raw_format=options.raw_format,
        auto_record=options.auto_record,
        auto_poll=options.auto_poll,
    )
    handler = functools.partial(ServiceHandler, directory=options.renderer_dir)
    server = ServiceHTTPServer((options.host, options.port), handler, service)
    service.http_server = server

    def stop_handler(_signum=None, _frame=None):
        threading.Thread(target=service.request_shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop_handler)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop_handler)

    def stdin_loop():
        for raw in sys.stdin:
            try:
                command = json.loads(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            if command.get("cmd") == "quit":
                service.request_shutdown()
                return

    threading.Thread(target=stdin_loop, daemon=True).start()
    collector = threading.Thread(target=service.collector_loop, daemon=True)
    collector.start()

    actual_host, actual_port = server.server_address[:2]
    print(json.dumps({
        "type": "ready",
        "url": "http://%s:%s" % (actual_host, actual_port),
        "pid": os.getpid(),
    }), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        service.close()
        collector.join(timeout=2.0)
        server.server_close()
    return 0
