"""
mqtt_client.py - V2 Backend MQTT Connection

Handles subscriptions to simulated telemetry and publishes master time syncs
back to the IoT simulator using unified environment-configurable MQTT topics.
"""

import json
import os
import threading
import time
from collections import deque

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    import paho.mqtt.client as mqtt
    MQTT_AVAILABLE = True
except ImportError:
    mqtt = None
    MQTT_AVAILABLE = False

BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
PORT = int(os.getenv("MQTT_PORT", "1883"))
TOPIC_DATA = os.getenv("MQTT_TOPIC_DATA", "iegms/syntaxed/grid/data")
TOPIC_SYNC = os.getenv("MQTT_TOPIC_SYNC", "iegms/syntaxed/grid/time_sync")
MAX_RECORDS = 500
RETRY_INTERVAL = 10

data_store: deque = deque(maxlen=MAX_RECORDS)
_lock = threading.Lock()
_connected = False
_global_client = None


def is_mqtt_connected() -> bool:
    return _connected


def record_telemetry(payload: dict) -> None:
    """Thread-safe helper to append telemetry (from MQTT or built-in fallback)."""
    if "loads" in payload:
        with _lock:
            data_store.append(payload)


def on_connect(client, userdata, flags, reason_code, properties):
    global _connected
    if reason_code == 0:
        _connected = True
        print(f"[MQTT] Connected to {BROKER}:{PORT}. Subscribing to '{TOPIC_DATA}'")
        client.subscribe(TOPIC_DATA)
    else:
        print(f"[MQTT] Connection refused - reason_code={reason_code}")


def on_disconnect(client, userdata, flags, reason_code, properties):
    global _connected
    _connected = False
    print(f"[MQTT] Disconnected (reason_code={reason_code}).")


def on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
        record_telemetry(payload)
    except json.JSONDecodeError:
        pass


def get_recent(n: int = 1) -> list:
    with _lock:
        return list(data_store)[-n:]


def publish_time_sync(simulated_hour: float):
    """Broadcast the master clock to the IoT simulator."""
    global _global_client, _connected
    if _connected and _global_client:
        payload = json.dumps({"simulated_hour": round(simulated_hour, 2)})
        _global_client.publish(TOPIC_SYNC, payload)


def _run_mqtt():
    global _global_client
    if not MQTT_AVAILABLE:
        print("[MQTT] paho-mqtt not installed; running with internal telemetry generator.")
        return

    _global_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    _global_client.on_connect = on_connect
    _global_client.on_disconnect = on_disconnect
    _global_client.on_message = on_message

    while True:
        try:
            print(f"[MQTT] Connecting to {BROKER}:{PORT}...")
            _global_client.connect(BROKER, PORT, keepalive=60)
            _global_client.loop_forever()
        except Exception as exc:
            print(f"[MQTT] Down ({exc}). Retrying in {RETRY_INTERVAL}s...")
            time.sleep(RETRY_INTERVAL)


def start_mqtt() -> None:
    thread = threading.Thread(target=_run_mqtt, daemon=True, name="mqtt-listener")
    thread.start()
    print("[MQTT] Background listener thread started.")
