"""
example_client.py - Example CLI client for the Dual-Provider AI Grid Agent API
"""

import json
import requests

BACKEND_URL = "http://localhost:8000"


def main():
    s = requests.Session()
    print("1. Health:", s.get(f"{BACKEND_URL}/health").json())
    print("2. Agent Config:", json.dumps(s.get(f"{BACKEND_URL}/agent/config").json(), indent=2))
    decision = s.post(
        f"{BACKEND_URL}/agent/decide",
        json={"query": "Analyze evening peak readiness and renewable utilization."},
    ).json()
    print("3. Grid AI Decision:\n", decision.get("decision"))


if __name__ == "__main__":
    main()
