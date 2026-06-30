import unittest

from sprinter_can.broker import EventBroker


class EventBrokerTests(unittest.TestCase):
    def test_new_subscriber_receives_current_state_snapshot(self):
        broker = EventBroker()
        broker.publish({"type": "status", "connected": True})
        broker.publish({"type": "pid", "ecu": 0x7E8, "pid": 0x0C, "value": 900})
        broker.publish({"type": "pid", "ecu": 0x7E8, "pid": 0x0C, "value": 950})
        broker.publish({"type": "recording", "active": True})

        subscriber = broker.subscribe()
        events = [subscriber.get_nowait() for _ in range(subscriber.qsize())]
        broker.unsubscribe(subscriber)

        self.assertEqual(sum(event["type"] == "pid" for event in events), 1)
        latest_pid = next(event for event in events if event["type"] == "pid")
        self.assertEqual(latest_pid["value"], 950)
        self.assertEqual(broker.summary()["subscribers"], 0)

    def test_slow_subscriber_drops_oldest_event_without_blocking(self):
        broker = EventBroker(queue_size=1)
        subscriber = broker.subscribe()
        broker.publish({"type": "log", "msg": "first"})
        broker.publish({"type": "log", "msg": "second"})
        self.assertEqual(subscriber.get_nowait()["msg"], "second")
        self.assertGreaterEqual(broker.dropped_events, 1)

    def test_snapshot_respects_bounded_subscriber_queue(self):
        broker = EventBroker(queue_size=1)
        broker.publish({"type": "status", "connected": True})
        broker.publish({"type": "recording", "active": False})

        subscriber = broker.subscribe()

        self.assertEqual(subscriber.qsize(), 1)
        self.assertEqual(subscriber.get_nowait()["type"], "recording")
        self.assertGreaterEqual(broker.dropped_events, 1)

    def test_compound_pid_metrics_are_retained_separately(self):
        broker = EventBroker()
        broker.publish({
            "type": "pid", "ecu": 0x7E8, "pid": 0x24,
            "metric": "lambda", "value": 1.0,
        })
        broker.publish({
            "type": "pid", "ecu": 0x7E8, "pid": 0x24,
            "metric": "voltage", "value": 2.0,
        })
        subscriber = broker.subscribe()
        events = [subscriber.get_nowait() for _ in range(subscriber.qsize())]
        pid_events = [event for event in events if event["type"] == "pid"]
        self.assertEqual(len(pid_events), 2)
        self.assertEqual(
            {event["metric"] for event in pid_events},
            {"lambda", "voltage"},
        )


if __name__ == "__main__":
    unittest.main()
