"""Thread-safe event fan-out for SSE clients."""

from __future__ import annotations

import queue
import threading


class EventBroker:
    """Broadcast protocol objects and retain enough state for new clients."""

    def __init__(self, queue_size: int = 2000):
        self.queue_size = queue_size
        self._lock = threading.Lock()
        self._subscribers: set[queue.Queue] = set()
        self._latest_status = None
        self._latest_recording = None
        self._pids = {}
        self._monitors = {}
        self._supported = {}
        self.dropped_events = 0

    def publish(self, event: dict) -> None:
        event_type = event.get("type")
        with self._lock:
            if event_type == "status":
                self._latest_status = event
            elif event_type == "recording":
                self._latest_recording = event
            elif event_type == "pid":
                self._pids[(
                    event.get("ecu"),
                    event.get("pid"),
                    event.get("metric"),
                )] = event
            elif event_type == "monitors":
                self._monitors[event.get("ecu")] = event
            elif event_type == "supported":
                self._supported[(event.get("ecu"), event.get("base"))] = event
            subscribers = tuple(self._subscribers)

        for subscriber in subscribers:
            try:
                subscriber.put_nowait(event)
            except queue.Full:
                try:
                    subscriber.get_nowait()
                    subscriber.put_nowait(event)
                except (queue.Empty, queue.Full):
                    pass
                with self._lock:
                    self.dropped_events += 1

    def subscribe(self) -> queue.Queue:
        subscriber = queue.Queue(maxsize=self.queue_size)
        with self._lock:
            snapshot = [
                self._latest_status,
                self._latest_recording,
                *self._supported.values(),
                *self._monitors.values(),
                *self._pids.values(),
            ]
            self._subscribers.add(subscriber)
        for event in snapshot:
            if event is not None:
                subscriber.put_nowait(event)
        return subscriber

    def unsubscribe(self, subscriber: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    def summary(self) -> dict:
        with self._lock:
            return {
                "subscribers": len(self._subscribers),
                "dropped_events": self.dropped_events,
                "pid_count": len(self._pids),
                "module_count": len(self._monitors),
                "recording": self._latest_recording,
                "status": self._latest_status,
            }
