"""
simulator.py - V3 IoT Telemetry Simulator (6 Smart-Grid Zones + Time Sync)

Publishes live telemetry for 6 entities:
  hospital, industry, school, commercial, residential, ev_hub
Subscribes to `iegms/syntaxed/grid/time_sync` (configurable via .env) to stay
in sync with the backend's master simulation clock.
"""

import json
import math
import os
import random
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv
    env_path = Path(__file__).resolve().parent.parent / "backend" / ".env"
    load_dotenv(env_path if env_path.exists() else None)
except ImportError:
    pass

import paho.mqtt.client as mqtt

BROKER = os.getenv("MQTT_BROKER", "broker.hivemq.com")
PORT = int(os.getenv("MQTT_PORT", "1883"))
TOPIC_PUB = os.getenv("MQTT_TOPIC_DATA", "iegms/syntaxed/grid/data")
TOPIC_SYNC = os.getenv("MQTT_TOPIC_SYNC", "iegms/syntaxed/grid/time_sync")
PUBLISH_INTERVAL = 2  # seconds

simulated_hour = 6.0
_lock = threading.Lock()

PROFILES = {
    "hospital": {0: 76, 5: 78, 8: 94, 12: 108, 16: 102, 20: 90, 24: 76},
    "industry": {0: 24, 5: 32, 6: 138, 9: 162, 12: 170, 15: 160, 18: 72, 20: 28, 24: 24},
    "school": {0: 6, 6: 10, 7: 35, 8: 92, 12: 118, 15: 98, 17: 22, 19: 8, 24: 6},
    "commercial": {0: 22, 6: 28, 8: 85, 11: 132, 14: 145, 18: 120, 21: 58, 23: 26, 24: 22},
    "residential": {0: 34, 5: 30, 7: 86, 9: 56, 14: 52, 17: 95, 19: 178, 21: 198, 23: 72, 24: 34},
    "ev_hub": {0: 14, 6: 18, 8: 68, 10: 42, 14: 38, 17: 74, 19: 112, 21: 92, 23: 28, 24: 14},
}


def _interpolate(hour: float, curve: dict) -> float:
    hour = hour % 24.0
    times = sorted(curve.keys())
    for i in range(len(times) - 1):
        t1, t2 = times[i], times[i + 1]
        if t1 <= hour <= t2:
            fraction = (hour - t1) / (t2 - t1) if (t2 - t1) > 0 else 0.0
            smooth_t = (1.0 - math.cos(fraction * math.pi)) * 0.5
            return curve[t1] + smooth_t * (curve[t2] - curve[t1])
    return float(curve[times[0]])


def generate_loads(hour: float) -> dict:
    """Generate realistic IoT meter readings across all 6 zones (+/- 4% sensor noise)."""
    loads = {}
    for entity, curve in PROFILES.items():
        base = _interpolate(hour, curve)
        noise = base * random.uniform(-0.04, 0.04)
        spike = base * 0.25 if random.random() < 0.015 else 0.0
        loads[entity] = round(max(0.0, base + noise + spike), 2)
    return loads


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print(f"[SIM] Connected to {BROKER}:{PORT}. Subscribing to '{TOPIC_SYNC}'...")
        client.subscribe(TOPIC_SYNC)
    else:
        print(f"[SIM] Connection failed ({reason_code}). Retrying...")


def on_message(client, userdata, msg):
    global simulated_hour
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
        if "simulated_hour" in payload:
            with _lock:
                simulated_hour = float(payload["simulated_hour"])
            print(f"[SIM] Time sync received: {simulated_hour:.2f}h")
    except Exception:
        pass


def main():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message

    print(f"[SIM] Starting V3 IoT Simulator -> {BROKER}:{PORT} (topic: {TOPIC_PUB})")
    while True:
        try:
            client.connect(BROKER, PORT, keepalive=60)
            break
        except Exception as exc:
            print(f"[SIM] Couldn't connect ({exc}). Retrying in 5s...")
            time.sleep(5)

    client.loop_start()

    try:
        while True:
            with _lock:
                current_hr = simulated_hour

            payload = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "simulated_hour": round(current_hr, 2),
                "loads": generate_loads(current_hr),
                "source": "simulator_v3",
            }
            client.publish(TOPIC_PUB, json.dumps(payload))
            print(f"[SIM] Published @ {current_hr:05.2f}h -> {payload['loads']}")
            time.sleep(PUBLISH_INTERVAL)
    except KeyboardInterrupt:
        print("\n[SIM] Stopped.")
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
