"""
ml_model.py - Pure-Python ML Model for Multi-Entity Grid Load & Renewable Prediction

Uses smooth piecewise interpolation across 6 distinct smart-grid zones plus
a solar/wind renewable generation curve based on time of day (0.0 to 24.0):
  - Hospital:    24/7 critical operations (high constant baseline)
  - Industry:    Active 05:00 - 19:00, two heavy production shifts
  - School:      Active 07:00 - 17:00, daytime campus operations
  - Commercial:  Active 08:00 - 21:00, downtown towers, servers & HVAC
  - Residential: Morning rush (06:00 - 08:30) + heavy evening peak (18:00 - 22:30)
  - EV Hub:      Commuter fast-charging spikes (07:30 - 09:30 & 17:30 - 22:00)
"""

# Realistic 24-hour demand anchor curves (hour -> load in MW)
PROFILES = {
    "hospital": {
        0: 76, 5: 78, 8: 94, 12: 108, 16: 102, 20: 90, 24: 76
    },
    "industry": {
        0: 24, 5: 32, 6: 138, 9: 162, 12: 170, 15: 160, 18: 72, 20: 28, 24: 24
    },
    "school": {
        0: 6, 6: 10, 7: 35, 8: 92, 12: 118, 15: 98, 17: 22, 19: 8, 24: 6
    },
    "commercial": {
        0: 22, 6: 28, 8: 85, 11: 132, 14: 145, 18: 120, 21: 58, 23: 26, 24: 22
    },
    "residential": {
        0: 34, 5: 30, 7: 86, 9: 56, 14: 52, 17: 95, 19: 178, 21: 198, 23: 72, 24: 34
    },
    "ev_hub": {
        0: 14, 6: 18, 8: 68, 10: 42, 14: 38, 17: 74, 19: 112, 21: 92, 23: 28, 24: 14
    },
}

# Clean renewable output curve (Solar PV + Wind Farm combined capacity up to 280 MW)
RENEWABLE_PROFILE = {
    0: 48,   # Night wind baseline
    5: 52,
    6: 68,   # Dawn
    8: 135,  # Morning solar ramp
    11: 238,
    13: 262, # Solar noon + afternoon breeze
    15: 228,
    17: 130,
    18: 72,  # Dusk solar drop-off
    20: 58,  # Evening wind
    24: 48,
}


def _interpolate(hour: float, curve: dict) -> float:
    """Smooth cosine-assisted interpolation between anchor points in a 24h curve."""
    import math

    hour = hour % 24.0
    times = sorted(curve.keys())
    for i in range(len(times) - 1):
        t1, t2 = times[i], times[i + 1]
        if t1 <= hour <= t2:
            v1, v2 = curve[t1], curve[t2]
            fraction = (hour - t1) / (t2 - t1) if (t2 - t1) > 0 else 0.0
            # Cosine smoothing avoids jagged linear corners on charts
            smooth_t = (1.0 - math.cos(fraction * math.pi)) * 0.5
            return v1 + smooth_t * (v2 - v1)
    return float(curve[times[0]])


def predict_load(hour: float, entity_type: str) -> float:
    """Predict the expected load (MW) for an entity at a given hour of day."""
    if entity_type not in PROFILES:
        return 0.0
    return round(max(0.0, _interpolate(hour, PROFILES[entity_type])), 2)


def predict_renewable_output(hour: float) -> float:
    """Predict combined Solar PV + Wind renewable generation (MW) at a given hour."""
    return round(max(0.0, _interpolate(hour, RENEWABLE_PROFILE)), 2)


def predict_all(hour: float, horizon_hours: float = 1.0) -> dict:
    """Predict load for all entities for `hour + horizon_hours` (default +1h forecast)."""
    target_hour = (hour + horizon_hours) % 24.0
    return {
        entity: predict_load(target_hour, entity)
        for entity in PROFILES.keys()
    }


def get_24h_forecast_series() -> dict:
    """Return full 24-hour curves for dashboard forecasting charts."""
    hours = list(range(24))
    by_entity = {
        entity: [predict_load(float(h), entity) for h in hours]
        for entity in PROFILES.keys()
    }
    total = [
        round(sum(by_entity[e][i] for e in PROFILES.keys()), 2)
        for i in range(24)
    ]
    renewable = [predict_renewable_output(float(h)) for h in hours]
    return {
        "hours": [f"{h:02d}:00" for h in hours],
        "total_mw": total,
        "renewable_mw": renewable,
        "by_entity": by_entity,
    }
