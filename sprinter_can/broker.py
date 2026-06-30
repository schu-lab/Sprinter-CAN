"""Thread-safe event fan-out for SSE clients."""

from __future__ import annotations

import queue
import threading


def _enqueue_latest(subscriber: queue.Queue, event: dict) -> int:
    """Enqueue an event without blocking, dropping the oldest item if full."""
    try:
        subscriber.put_nowait(event)
        return 0
    except queue.Full:
        dropped = 0
        try:
            subscriber.get_nowait()
            dropped += 1
        except queue.Empty:
            # A consumer drained the queue after put_nowait reported it full.
            pass
        try:
            subscriber.put_nowait(event)
        except queue.Full:
            # Another publisher filled the newly available slot.
            dropped += 1
        return dropped


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

        dropped = sum(
            _enqueue_latest(subscriber, event)
            for subscriber in subscribers
        )
        if dropped:
            with self._lock:
                self.dropped_events += dropped

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
            self.dropped_events += sum(
                _enqueue_latest(subscriber, event)
                for event in snapshot
                if event is not None
            )
            # Add the subscriber only after its snapshot is queued. Otherwise a
            # concurrent publish could arrive before an older snapshot event.
            self._subscribers.add(subscriber)
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
