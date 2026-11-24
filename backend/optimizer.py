"""
optimizer.py - V3 AI Smart Grid Orchestrator Logic

Time-aware multi-zone load & renewable dispatch engine:
  - 6 smart-grid zones: Hospital, Industry, School, Commercial, Residential, EV Hub
  - Per-entity schedule caps (school off after 17:00, industry overnight, EV trickle, etc.)
  - Real-time operator Manual Load Spike injection (`manual_loads`)
  - Renewable-first dispatch (Solar PV + Wind Farm prioritized before Thermal Plants 1 & 2)
  - Power redistribution from inactive to active high-priority zones
  - Proactive peak-hour BESS battery boost (morning 08-09, evening 18-21)
  - Priority load shedding cascade (EV Hub -> Residential -> Commercial -> School -> Industry; Hospital protected)
"""

import os
from ml_model import predict_renewable_output

# Grid & BESS constraints (MW)
BATTERY_MAX_CHARGE = 400.0
BATTERY_MAX_RATE = 120.0       # Max charge/discharge per cycle
PEAK_BATTERY_BOOST_MW = 80.0   # Proactive discharge during peaks

PRIORITY = [
    "hospital",
    "industry",
    "school",
    "commercial",
    "residential",
    "ev_hub",
]

# ── Time-Aware Schedule Policy ────────────────────────────────────────────────

ENTITY_SCHEDULES = {
    "hospital": {
        "label": "Medical Center",
        "tier": "Critical",
        "always_on": True,
        "active_hours": (0, 24),
        "active_cap": 1.0,
        "inactive_cap": 1.0,
        "inactive_reason": "Medical Center operates 24/7 — zero reduction allowed.",
    },
    "industry": {
        "label": "Industrial Park",
        "tier": "High",
        "always_on": False,
        "active_hours": (5, 19),
        "active_cap": 1.0,
        "inactive_cap": 0.10,
        "inactive_reason": "Industrial Park off-shift — capped at 10% security/HVAC standby.",
    },
    "school": {
        "label": "University Campus",
        "tier": "Medium-High",
        "always_on": False,
        "active_hours": (7, 17),
        "active_cap": 1.0,
        "inactive_cap": 0.05,
        "inactive_reason": "Campus closed — reduced to 5% standby power.",
    },
    "commercial": {
        "label": "Commercial Towers",
        "tier": "Medium",
        "always_on": False,
        "active_hours": (8, 21),
        "active_cap": 1.0,
        "inactive_cap": 0.15,
        "inactive_reason": "Commercial district overnight — 15% server & safety baseline.",
    },
    "residential": {
        "label": "Residential District",
        "tier": "Standard",
        "always_on": False,
        "active_hours": (6, 23),
        "active_cap": 1.0,
        "inactive_cap": 0.50,
        "inactive_reason": "Residential sleep window (23:00–06:00) — 50% off-peak cap.",
    },
    "ev_hub": {
        "label": "EV Supercharger Hub",
        "tier": "Deferrable",
        "always_on": False,
        "active_hours": (7, 22),
        "active_cap": 1.0,
        "inactive_cap": 0.25,
        "inactive_reason": "EV Hub overnight smart-trickle charging (25% cap).",
    },
}

RESIDENTIAL_PEAK_HOURS = (17, 23)


def _is_peak_hour(hour: float) -> bool:
    """Peak hours: morning rush (08–09) and evening surge (18–21)."""
    hour = hour % 24.0
    return (8.0 <= hour < 9.0) or (18.0 <= hour < 21.0)


def _is_entity_active(entity: str, hour: float) -> tuple[bool, str]:
    """Returns (is_active, reason) for a zone at `hour`."""
    hour = hour % 24.0
    sched = ENTITY_SCHEDULES[entity]

    if sched["always_on"]:
        return True, "Always active (24/7 critical load)."

    start, end = sched["active_hours"]

    if entity == "residential":
        pk_start, pk_end = RESIDENTIAL_PEAK_HOURS
        if pk_start <= hour < pk_end:
            return True, "Residential evening peak — full power priority."
        if start <= hour < end:
            return True, "Residential daytime — normal operation."
        return False, sched["inactive_reason"]

    if start <= hour < end:
        return True, f"{sched['label']} active window ({start:02.0f}:00–{end:02.0f}:00)."
    return False, sched["inactive_reason"]


def get_entity_schedule_status(hour: float) -> dict:
    """Returns per-entity schedule status at the given hour."""
    result = {}
    for entity in PRIORITY:
        sched = ENTITY_SCHEDULES[entity]
        active, reason = _is_entity_active(entity, hour)
        cap = sched["active_cap"] if active else sched["inactive_cap"]
        result[entity] = {
            "label": sched["label"],
            "tier": sched["tier"],
            "active": active,
            "cap_fraction": cap,
            "cap_pct": int(cap * 100),
            "reason": reason,
        }
    return result


def apply_time_caps(demand: dict, hour: float, manual_loads: dict = None) -> tuple[dict, float, list]:
    """
    Apply schedule-based caps to base demand, then add any explicit operator
    manual load spikes (`manual_loads`) so stress tests work at any hour.
    """
    manual_loads = manual_loads or {}
    capped = {}
    total_freed = 0.0
    notes = []

    for entity in PRIORITY:
        sched = ENTITY_SCHEDULES[entity]
        active, reason = _is_entity_active(entity, hour)
        cap = sched["active_cap"] if active else sched["inactive_cap"]
        original = demand.get(entity, 0.0)
        capped_val = original * cap
        freed = original - capped_val

        spike = max(0.0, float(manual_loads.get(entity, 0.0) or 0.0))
        capped[entity] = capped_val + spike

        if freed > 0.5:
            total_freed += freed
            notes.append(
                f"[SCHEDULE] {sched['label']}: capped to {int(cap * 100)}% "
                f"(-{round(freed, 1)} MW freed). {reason}"
            )
        if spike > 0.5:
            notes.append(
                f"[STRESS] {sched['label']}: +{round(spike, 1)} MW manual demand spike injected."
            )
    return capped, total_freed, notes


def redistribute_freed_power(capped_demand: dict, freed_mw: float, hour: float) -> tuple[dict, list]:
    """Redistribute freed MW to active higher-priority zones (up to +18% headroom)."""
    boosted = dict(capped_demand)
    notes = []
    remaining = freed_mw

    for entity in PRIORITY:
        if remaining < 0.5:
            break
        active, _ = _is_entity_active(entity, hour)
        if not active:
            continue
        sched = ENTITY_SCHEDULES[entity]
        uncapped = capped_demand.get(entity, 0.0)
        headroom = uncapped * 0.18
        if headroom < 0.5:
            continue
        boost = min(headroom, remaining)
        boosted[entity] += boost
        remaining -= boost
        notes.append(
            f"[REDIR] +{round(boost, 1)} MW reallocated to {sched['label']} "
            f"(Priority {PRIORITY.index(entity) + 1})."
        )

    return boosted, notes


def default_plants() -> dict:
    p1_cap = float(os.getenv("PLANT1_CAPACITY_MW", "300.0") or 300.0)
    p2_cap = float(os.getenv("PLANT2_CAPACITY_MW", "300.0") or 300.0)
    return {
        "plant1": {"active": True, "capacity": p1_cap, "type": "thermal", "label": "Thermal Plant 1"},
        "plant2": {"active": True, "capacity": p2_cap, "type": "thermal", "label": "Thermal Plant 2"},
        "solar_wind": {"active": True, "capacity": 280.0, "type": "renewable", "label": "Solar + Wind Farm"},
    }


def optimize_grid(
    actual_loads: dict,
    predicted_loads: dict,
    battery_energy: float,
    hour: float = 12.0,
    plants: dict = None,
    manual_loads: dict = None,
) -> dict:
    """
    Time-aware smart-grid optimizer with renewable-first dispatch & priority load shedding.
    """
    raw_demand = {}
    for entity in PRIORITY:
        act = float(actual_loads.get(entity, 0.0) or 0.0)
        pred = float(predicted_loads.get(entity, 0.0) or 0.0)
        raw_demand[entity] = max(act, pred)

    # Step 1: Schedule caps + manual load spike overrides
    capped_demand, freed_mw, cap_notes = apply_time_caps(raw_demand, hour, manual_loads)

    # Step 2: Redistribute freed capacity
    demand, redir_notes = redistribute_freed_power(capped_demand, freed_mw, hour)
    supplied = {entity: demand[entity] for entity in PRIORITY}

    battery_delta = 0.0
    deficit = 0.0
    actions = list(cap_notes) + list(redir_notes)

    # Step 3: Proactive peak-hour battery boost
    peak_boost_active = False
    if _is_peak_hour(hour) and battery_energy > PEAK_BATTERY_BOOST_MW:
        boost = min(PEAK_BATTERY_BOOST_MW, battery_energy * 0.30)
        battery_delta -= boost
        peak_boost_active = True
        if 18.0 <= (hour % 24.0) < 21.0:
            supplied["residential"] = min(
                supplied["residential"] + boost * 0.7,
                demand["residential"] * 1.15,
            )
            actions.append(
                f"[PEAK] Evening surge (18–21h): BESS discharging {round(boost, 1)} MW for peak shaving."
            )
        elif 8.0 <= (hour % 24.0) < 9.0:
            supplied["industry"] = min(
                supplied["industry"] + boost * 0.7,
                demand["industry"] * 1.15,
            )
            actions.append(
                f"[PEAK] Morning ramp (08–09h): BESS discharging {round(boost, 1)} MW -> Industrial & EV support."
            )

    # Step 4: Available generation capacity (Renewable + Thermal)
    if plants is None:
        plants = default_plants()

    # Renewable output depends on time-of-day solar irradiance + wind
    solar_wind_cfg = plants.get("solar_wind", {"active": True, "capacity": 280.0})
    renewable_available = 0.0
    if solar_wind_cfg.get("active", True):
        scale = float(solar_wind_cfg.get("capacity", 280.0)) / 280.0
        renewable_available = round(predict_renewable_output(hour) * scale, 2)

    rated_thermal_total = sum(
        float(p.get("capacity", 0.0))
        for pid, p in plants.items()
        if pid != "solar_wind"
    )
    thermal_capacity = sum(
        float(p.get("capacity", 0.0))
        for pid, p in plants.items()
        if pid != "solar_wind" and p.get("active", False)
    )
    dynamic_max_capacity = round(renewable_available + thermal_capacity, 2)

    if dynamic_max_capacity <= 0.1:
        actions.insert(0, "[CRITICAL] ALL Grid Generation Sources OFFLINE — Islanded on BESS!")
    elif thermal_capacity < rated_thermal_total:
        actions.insert(
            0,
            f"[GEN] Thermal capacity online: {round(thermal_capacity, 0):.0f}/{round(rated_thermal_total, 0):.0f} MW "
            f"(Total w/ Renewables: {round(dynamic_max_capacity, 0):.0f} MW).",
        )

    current_total = sum(supplied.values())
    # Net demand on generation after any proactive peak BESS discharge
    net_grid_demand = max(0.0, current_total + battery_delta) if battery_delta < 0 else current_total

    if net_grid_demand <= dynamic_max_capacity:
        excess = dynamic_max_capacity - net_grid_demand
        to_charge = min(excess, BATTERY_MAX_RATE, BATTERY_MAX_CHARGE - battery_energy)
        if battery_delta == 0 and to_charge > 1.0:
            battery_delta = to_charge
            actions.append(
                f"[BESS] Surplus clean/grid power: charging reserve +{round(to_charge, 1)} MW."
            )
        elif battery_delta == 0:
            actions.append("[OK] Grid balanced and nominal. BESS reserve at target.")
    else:
        deficit = net_grid_demand - dynamic_max_capacity

        # Emergency battery discharge if not already discharging at max rate
        available_discharge_room = BATTERY_MAX_RATE + battery_delta  # since battery_delta <= 0
        available_energy_room = max(0.0, battery_energy + battery_delta)
        from_battery = min(deficit, max(0.0, available_discharge_room), available_energy_room)
        if from_battery > 0.1:
            battery_delta -= from_battery
            deficit -= from_battery
            actions.append(
                f"[BESS] Discharging {round(from_battery, 1)} MW from reserve to bridge generation deficit."
            )

        # Priority load shedding (lowest priority shed first: EV Hub -> Residential -> Commercial -> School -> Industry)
        for entity in reversed(PRIORITY):
            if deficit <= 0.05:
                break
            if entity == "hospital":
                actions.append(
                    "[CRITICAL] Unmet deficit threatens Medical Center — emergency reserve required!"
                )
                break
            can_shed = supplied[entity]
            if can_shed > 0:
                shed = min(can_shed, deficit)
                supplied[entity] -= shed
                deficit -= shed
                pct = int(round((shed / demand[entity]) * 100)) if demand[entity] > 0 else 0
                actions.append(
                    f"[SHED] Shedding {pct}% (-{round(shed, 1)} MW) from {ENTITY_SCHEDULES[entity]['label']}."
                )

    # Status classification
    has_shedding = any(a.startswith("[SHED]") or a.startswith("[CRITICAL]") for a in actions)
    if deficit > 0.1 or dynamic_max_capacity <= 0.1:
        status_code = "CRITICAL"
    elif has_shedding or (battery_delta < 0 and not peak_boost_active):
        status_code = "WARNING"
    elif peak_boost_active:
        status_code = "PEAK"
    else:
        status_code = "NORMAL"

    new_battery = min(BATTERY_MAX_CHARGE, max(0.0, battery_energy + battery_delta))

    # Calculate actual generation dispatch: Renewable FIRST, then split across active thermal plants
    total_supplied_final = sum(supplied.values())
    grid_generation_needed = max(0.0, total_supplied_final + battery_delta)

    renewable_dispatched = min(renewable_available, grid_generation_needed)
    thermal_needed = max(0.0, grid_generation_needed - renewable_dispatched)

    generation = {"plant1": 0.0, "plant2": 0.0, "solar_wind": round(renewable_dispatched, 2)}
    active_thermal = [
        pid for pid in ("plant1", "plant2")
        if plants.get(pid, {}).get("active", False) and float(plants[pid].get("capacity", 0.0)) > 0
    ]
    if active_thermal and thermal_needed > 0 and thermal_capacity > 0:
        for pid in active_thermal:
            cap = float(plants[pid].get("capacity", 300.0))
            weight = cap / thermal_capacity
            generation[pid] = round(min(cap, thermal_needed * weight), 2)

    total_gen = sum(generation.values())
    renewable_share_pct = round(
        (renewable_dispatched / max(1.0, total_supplied_final)) * 100.0, 1
    )
    # Approximate CO2 avoided vs coal/gas baseline (0.52 tCO2/MWh)
    co2_avoided_tons = round(renewable_dispatched * 0.52, 2)
    # Approximate transformer thermal load temperature (ambient 25C + load heating)
    transformer_temp_c = round(25.0 + (total_supplied_final / 850.0) * 22.0, 1)

    return {
        "status_code": status_code,
        "actions": actions,
        "demand": {k: round(v, 2) for k, v in demand.items()},
        "raw_demand": {k: round(v, 2) for k, v in raw_demand.items()},
        "supplied": {k: round(v, 2) for k, v in supplied.items()},
        "total_demand": round(sum(demand.values()), 2),
        "total_supplied": round(total_supplied_final, 2),
        "battery_energy": round(new_battery, 2),
        "battery_max": BATTERY_MAX_CHARGE,
        "battery_soc_pct": round((new_battery / BATTERY_MAX_CHARGE) * 100.0, 1),
        "battery_delta": round(battery_delta, 2),
        "generation": generation,
        "renewable_available_mw": renewable_available,
        "renewable_share_pct": renewable_share_pct,
        "co2_avoided_tons": co2_avoided_tons,
        "transformer_temp_c": transformer_temp_c,
        "max_capacity_mw": dynamic_max_capacity,
        "thermal_capacity_mw": round(thermal_capacity, 2),
        "peak_boost_active": peak_boost_active,
        "freed_mw": round(freed_mw, 2),
        "deficit_mw": round(max(0.0, deficit), 2),
        "schedule_status": get_entity_schedule_status(hour),
        "plants_state": {
            pid: {"active": bool(p.get("active", True)), "capacity": float(p.get("capacity", 0.0))}
            for pid, p in plants.items()
        },
        "manual_loads": {k: round(float((manual_loads or {}).get(k, 0.0)), 1) for k in PRIORITY},
        "simulated_hour": round(hour, 2),
    }
