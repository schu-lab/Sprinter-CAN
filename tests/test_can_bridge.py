import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

import can_bridge


class DecodeResponseTests(unittest.TestCase):
    def test_decodes_two_byte_rpm(self):
        decoded = can_bridge.decode_response(
            [0x04, 0x41, 0x0C, 0x1A, 0xF8, 0x55, 0x55, 0x55]
        )
        self.assertEqual(decoded, (0x0C, "Engine RPM", 1726.0, "rpm"))

    def test_decodes_one_byte_temperature(self):
        decoded = can_bridge.decode_response(
            [0x03, 0x41, 0x05, 0x5A, 0x55, 0x55, 0x55, 0x55]
        )
        self.assertEqual(decoded, (0x05, "Coolant temp", 50.0, "°C"))

    def test_rejects_unknown_or_truncated_payloads(self):
        self.assertIsNone(can_bridge.decode_response([0x03, 0x41, 0xFE, 0x00]))
        self.assertIsNone(can_bridge.decode_response([0x03, 0x41, 0x0C, 0x00]))
        self.assertIsNone(can_bridge.decode_response([0x03, 0x7F, 0x0C, 0x00]))
        self.assertIsNone(can_bridge.decode_response(
            [0x03, 0x41, 0x0C, 0x00, 0x55, 0x55, 0x55, 0x55]
        ))

    def test_decodes_both_metrics_from_wide_range_oxygen_sensor(self):
        metrics = can_bridge.decode_metrics(
            [0x06, 0x41, 0x24, 0x80, 0x00, 0x40, 0x00, 0x55]
        )
        self.assertEqual(
            [(item["metric"], item["value"], item["unit"]) for item in metrics],
            [("lambda", 1.0, "λ"), ("voltage", 2.0, "V")],
        )
        self.assertEqual(
            can_bridge.decode_response(
                [0x06, 0x41, 0x24, 0x80, 0x00, 0x40, 0x00, 0x55]
            ),
            (0x24, "O2 sensor 1 lambda", 1.0, "λ"),
        )

    def test_emits_both_compound_pid_metrics_without_overwriting_identity(self):
        emitted = []
        can_bridge.set_emit_sink(emitted.append)
        try:
            can_bridge.emit_obd_response(
                0x7E8,
                [0x06, 0x41, 0x24, 0x80, 0x00, 0x40, 0x00, 0x55],
                {},
                1000.0,
            )
        finally:
            can_bridge.set_emit_sink(None)
        pid_events = [event for event in emitted if event["type"] == "pid"]
        self.assertEqual(
            [event["metric"] for event in pid_events],
            ["lambda", "voltage"],
        )


class CapabilityDecodeTests(unittest.TestCase):
    def test_decodes_supported_mask_and_excludes_continuation_marker(self):
        # PIDs 0x01, 0x05, and 0x20 are marked. 0x20 is a continuation bit,
        # not a data PID, and should not appear in the result.
        result = can_bridge.decode_supported(
            0x7E8, [0x06, 0x41, 0x00, 0x88, 0x00, 0x00, 0x01]
        )
        self.assertEqual(result["ecu"], 0x7E8)
        self.assertEqual(result["pids"], [0x01, 0x05])
        self.assertEqual(
            result["names"],
            {"1": "Monitor status", "5": "Coolant temp"},
        )

    def test_decodes_monitor_status(self):
        result = can_bridge.decode_monitors(
            0x7E9, [0x06, 0x41, 0x01, 0x83, 0x07, 0xA0, 0x00]
        )
        self.assertEqual(
            result,
            {
                "type": "monitors",
                "ecu": 0x7E9,
                "mil": True,
                "dtc_count": 3,
                "b": 0x07,
                "c": 0xA0,
                "d": 0x00,
            },
        )


class PollingDefaultsTests(unittest.TestCase):
    def test_default_sweep_can_fit_inside_configured_period(self):
        minimum = len(can_bridge.POLL_LIST) * can_bridge.DEFAULT_INTER_FRAME
        self.assertLessEqual(minimum, can_bridge.DEFAULT_POLL_PERIOD)


class DemoValuesTests(unittest.TestCase):
    def decode_demo(self, pid):
        values = can_bridge._demo_value_bytes(pid, 30.0)
        payload = [2 + len(values), 0x41, pid, *values]
        payload.extend([can_bridge.PAD] * (8 - len(payload)))
        return can_bridge.decode_response(payload)

    def test_demo_fuel_and_emissions_values_are_plausible(self):
        expected_ranges = {
            0x06: (-10, 10),
            0x07: (-10, 10),
            0x23: (30000, 60000),
            0x2D: (-10, 10),
            0x3C: (250, 500),
            0x44: (0.9, 1.1),
            0x5E: (2, 10),
        }
        for pid, (minimum, maximum) in expected_ranges.items():
            with self.subTest(pid=pid):
                decoded = self.decode_demo(pid)
                self.assertIsNotNone(decoded)
                self.assertGreaterEqual(decoded[2], minimum)
                self.assertLessEqual(decoded[2], maximum)

    def test_demo_torque_and_timing_values_are_not_placeholder_extremes(self):
        for pid, (minimum, maximum) in {
            0x5D: (-10, 10),
            0x61: (0, 100),
            0x62: (0, 100),
            0x63: (100, 600),
        }.items():
            with self.subTest(pid=pid):
                decoded = self.decode_demo(pid)
                self.assertGreaterEqual(decoded[2], minimum)
                self.assertLessEqual(decoded[2], maximum)

    def test_demo_wide_range_oxygen_sensor_has_two_plausible_metrics(self):
        values = can_bridge._demo_value_bytes(0x24, 30.0)
        metrics = can_bridge.decode_metrics(
            [0x06, 0x41, 0x24, *values, can_bridge.PAD]
        )
        self.assertEqual(len(metrics), 2)
        self.assertEqual(metrics[0]["value"], 1.0)
        self.assertEqual(metrics[1]["value"], 2.0)


class KvaserModeTests(unittest.TestCase):
    def test_opens_hardware_silent_mode_explicitly(self):
        calls = []

        class FakeCan:
            @staticmethod
            def Bus(**kwargs):
                calls.append(kwargs)
                return object()

        can_bridge.open_kvaser_bus(FakeCan, channel=2, silent=True)
        self.assertFalse(calls[-1]["driver_mode"])
        self.assertEqual(calls[-1]["channel"], 2)

        can_bridge.open_kvaser_bus(FakeCan, channel=2, silent=False)
        self.assertTrue(calls[-1]["driver_mode"])

    def test_real_loop_switches_active_then_back_to_silent(self):
        opened = []
        sent = []
        emitted = []

        class FakeBus:
            def __init__(self, kwargs):
                self.kwargs = kwargs
                self.closed = False

            def recv(self, timeout):
                time.sleep(min(timeout, 0.005))
                return None

            def send(self, message, timeout):
                sent.append((message, timeout))

            def shutdown(self):
                self.closed = True

        def bus_factory(**kwargs):
            opened.append(kwargs)
            return FakeBus(kwargs)

        fake_can = types.SimpleNamespace(
            Bus=bus_factory,
            Message=lambda **kwargs: kwargs,
        )
        state = {"poll": False, "stop": False}

        def wait_for(predicate, timeout=1.0):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if predicate():
                    return True
                time.sleep(0.01)
            return False

        with mock.patch.dict(sys.modules, {"can": fake_can}), \
             mock.patch.object(can_bridge, "emit", emitted.append):
            worker = threading.Thread(
                target=can_bridge.run_real,
                args=(0, state, 0.05, 0.0),
            )
            worker.start()
            self.assertTrue(wait_for(lambda: len(opened) >= 1))
            self.assertFalse(opened[0]["driver_mode"])

            state["poll"] = True
            self.assertTrue(wait_for(
                lambda: any(call["driver_mode"] for call in opened)
            ))
            self.assertTrue(wait_for(lambda: len(sent) > 0))

            state["poll"] = False
            self.assertTrue(wait_for(
                lambda: len(opened) >= 3 and not opened[-1]["driver_mode"]
            ))

            state["stop"] = True
            worker.join(timeout=1.0)
            self.assertFalse(worker.is_alive())

        modes = [event.get("mode") for event in emitted if event.get("mode")]
        self.assertIn("active", modes)
        self.assertEqual(modes[-1], "silent")


class ReplayTests(unittest.TestCase):
    def test_replay_emits_frames_and_decoded_pid_events(self):
        import can

        with tempfile.TemporaryDirectory() as temporary:
            filename = f"{temporary}/capture.blf"
            writer = can.Logger(filename)
            writer.on_message_received(can.Message(
                timestamp=1000.0,
                arbitration_id=0x7E8,
                is_extended_id=False,
                data=[0x04, 0x41, 0x0C, 0x1A, 0xF8, 0x55, 0x55, 0x55],
            ))
            writer.stop()

            emitted = []
            state = {"poll": False, "stop": False}
            can_bridge.set_emit_sink(emitted.append)
            try:
                can_bridge.run_replay(filename, state, speed=1000.0)
            finally:
                can_bridge.set_emit_sink(None)

            self.assertTrue(any(event["type"] == "frame" for event in emitted))
            pid_event = next(event for event in emitted if event["type"] == "pid")
            self.assertEqual(pid_event["ecu"], 0x7E8)
            self.assertEqual(pid_event["value"], 1726.0)


class IsoTpTests(unittest.TestCase):
    # EGT bank 1: [0x41, 0x78, bitmap, s1_hi, s1_lo, s2_hi, s2_lo, …]. Sensor 1
    # raw 0x0BB8 = 3000 -> 3000/10 - 40 = 260 °C.
    SERVICE = [0x41, 0x78, 0x03, 0x0B, 0xB8, 0x0A, 0x28, 0x00, 0x00, 0x00, 0x00]

    def test_first_frame_requests_flow_control_then_completes(self):
        reassembler = can_bridge.IsoTpReassembler()
        first = [0x10, len(self.SERVICE), *self.SERVICE[0:6]]
        payload, flow_control = reassembler.feed(0x7E8, first)
        self.assertIsNone(payload)
        self.assertEqual(flow_control, 0x7E0)  # physical addr = response - 8

        consecutive = [0x21, *self.SERVICE[6:], 0x55]
        payload, flow_control = reassembler.feed(0x7E8, consecutive)
        self.assertIsNone(flow_control)
        self.assertEqual(payload, self.SERVICE)

    def test_reassembled_egt_payload_decodes(self):
        metrics = can_bridge.decode_metrics([0x00, *self.SERVICE], reassembled=True)
        self.assertEqual(len(metrics), 1)
        self.assertEqual(metrics[0]["pid"], 0x78)
        self.assertEqual(metrics[0]["unit"], "°C")
        self.assertAlmostEqual(metrics[0]["value"], 260.0)

    def test_multi_frame_pid_is_not_decoded_from_a_single_frame(self):
        # The same PID arriving as a (malformed) single frame must not decode.
        self.assertEqual(can_bridge.decode_metrics([0x03, 0x41, 0x78, 0x0B]), [])

    def test_demo_multiframe_round_trips_through_reassembler(self):
        service = can_bridge._demo_multiframe_service(0x78, 12.0)
        self.assertEqual(service[:2], [0x41, 0x78])
        reassembler = can_bridge.IsoTpReassembler()
        completed = None
        for frame in can_bridge._isotp_frames(service):
            payload, _ = reassembler.feed(0x7E8, frame)
            if payload is not None:
                completed = payload
        self.assertEqual(completed, service)
        metrics = can_bridge.decode_metrics([0x00, *completed], reassembled=True)
        self.assertTrue(metrics and metrics[0]["pid"] == 0x78)


if __name__ == "__main__":
    unittest.main()
