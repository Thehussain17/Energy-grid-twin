"""
main.py - V3 FastAPI Smart Grid Engine

Coordinates the 24-hour digital twin clock, ML load/renewable forecasting,
priority load-shedding optimizer, MQTT/internal IoT telemetry stream, and
the Dual-Provider AI Grid Agent (Gemini + Ollama).
"""

import asyncio
import os
import random
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Ensure UTF-8 console output on Windows
if getattr(sys.stdout, "encoding", "").lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Load backend/.env before importing submodules
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from mqtt_client import (
    get_recent,
    is_mqtt_connected,
    publish_time_sync,
    record_telemetry,
    start_mqtt,
)
from ml_model import get_24h_forecast_series, predict_all, predict_load, PROFILES
from optimizer import (
    BATTERY_MAX_CHARGE,
    PRIORITY,
    default_plants,
    get_entity_schedule_status,
    optimize_grid,
)
from agent_orchestrator import create_grid_agent


# ── Global Simulation State ──────────────────────────────────────────────────

class AppState:
    simulated_hour: float = 8.0          # Start at 08:00 morning ramp for rich daytime visuals
    sim_paused: bool = False
    sim_speed: float = 1.0               # 1x, 2x, 5x multiplier
    battery_energy: float = 220.0        # Start at 55% SoC (220 / 400 MWh)
    latest_opt: dict = {}
    grid_agent = None
    plants: dict = default_plants()
    manual_loads: dict = {zone: 0.0 for zone in PRIORITY}
    priority_override: Optional[list[str]] = None


def _generate_internal_loads(hour: float) -> dict:
    """Fallback realistic IoT sensor generator used when external simulator.py isn't publishing."""
    loads = {}
    for entity in PROFILES.keys():
        base = predict_load(hour, entity)
        noise = base * random.uniform(-0.03, 0.03)
        loads[entity] = round(max(0.0, base + noise), 2)
    return loads


def run_optimization_step(advance_battery: bool = True) -> dict:
    """Compute a single optimization snapshot immediately (used by loop & instant UI controls)."""
    predicted = predict_all(AppState.simulated_hour)
    recent = get_recent(1)

    use_mqtt_data = False
    if recent and is_mqtt_connected():
        last_ts = recent[0].get("timestamp")
        if last_ts:
            try:
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(last_ts)).total_seconds()
                use_mqtt_data = age < 8.0
            except Exception:
                use_mqtt_data = True

    if use_mqtt_data:
        actuals = dict(recent[0].get("loads", {}))
        # Backfill any newly added zones if an older simulator payload arrives
        for zone in PRIORITY:
            if zone not in actuals:
                actuals[zone] = predict_load(AppState.simulated_hour, zone)
    else:
        actuals = _generate_internal_loads(AppState.simulated_hour)
        record_telemetry({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "simulated_hour": round(AppState.simulated_hour, 2),
            "loads": actuals,
            "source": "internal_twin_telemetry",
        })

    result = optimize_grid(
        actuals,
        predicted,
        AppState.battery_energy,
        AppState.simulated_hour,
        plants=AppState.plants,
        manual_loads=AppState.manual_loads,
        priority_override=AppState.priority_override,
    )
    if advance_battery:
        AppState.battery_energy = result["battery_energy"]
    else:
        # Keep current battery energy when user only scrubs slider / toggles UI
        result["battery_energy"] = round(AppState.battery_energy, 2)
        result["battery_soc_pct"] = round((AppState.battery_energy / BATTERY_MAX_CHARGE) * 100.0, 1)

    result["predicted_loads"] = predicted
    result["sim_paused"] = AppState.sim_paused
    result["sim_speed"] = AppState.sim_speed
    result["mqtt_connected"] = is_mqtt_connected()
    AppState.latest_opt = result
    return result


async def simulation_loop():
    """Master 2-second simulation engine loop."""
    while True:
        await asyncio.sleep(2.0)
        if not AppState.sim_paused:
            # Base rate: 2 real seconds = 2 simulated minutes * sim_speed
            step_hours = (2.0 / 60.0) * AppState.sim_speed
            AppState.simulated_hour = (AppState.simulated_hour + step_hours) % 24.0
            publish_time_sync(AppState.simulated_hour)
        run_optimization_step(advance_battery=not AppState.sim_paused)


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_mqtt()
    AppState.grid_agent = create_grid_agent()
    # Populate initial state immediately so the first frontend poll never receives `{}`
    run_optimization_step(advance_battery=False)
    loop_task = asyncio.create_task(simulation_loop())
    try:
        yield
    finally:
        loop_task.cancel()


app = FastAPI(title="Syntaxed-IEGMS Smart Grid V3 Engine", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Core Telemetry & Control Endpoints ───────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "simulated_hour": round(AppState.simulated_hour, 2),
        "mqtt_connected": is_mqtt_connected(),
        "ai_provider": AppState.grid_agent.config.provider if AppState.grid_agent else "none",
    }


@app.get("/data")
def get_data():
    records = get_recent(30)
    return {"count": len(records), "mqtt_connected": is_mqtt_connected(), "readings": records}


@app.get("/optimize")
def get_optimize():
    if not AppState.latest_opt:
        return run_optimization_step(advance_battery=False)
    return AppState.latest_opt


@app.get("/api/forecast")
def get_forecast():
    return get_24h_forecast_series()


class TimeRequest(BaseModel):
    hour: float


@app.post("/set_time")
def set_time(req: TimeRequest):
    val = max(0.0, min(23.99, req.hour))
    AppState.simulated_hour = val
    publish_time_sync(AppState.simulated_hour)
    snapshot = run_optimization_step(advance_battery=False)
    return {"status": "success", "simulated_hour": val, "state": snapshot}


class SimControlRequest(BaseModel):
    paused: Optional[bool] = None
    speed: Optional[float] = None


@app.post("/api/sim/control")
def control_simulation(req: SimControlRequest):
    if req.paused is not None:
        AppState.sim_paused = bool(req.paused)
    if req.speed is not None:
        AppState.sim_speed = max(0.25, min(10.0, float(req.speed)))
    if AppState.latest_opt:
        AppState.latest_opt["sim_paused"] = AppState.sim_paused
        AppState.latest_opt["sim_speed"] = AppState.sim_speed
    return {
        "status": "success",
        "sim_paused": AppState.sim_paused,
        "sim_speed": AppState.sim_speed,
    }


class PlantToggleRequest(BaseModel):
    plant_id: str
    active: Optional[bool] = None
    capacity: Optional[float] = None


class PlantCapacityRequest(BaseModel):
    plant_id: str
    capacity: float


@app.post("/api/plant/toggle")
def toggle_plant(req: PlantToggleRequest):
    if req.plant_id in AppState.plants:
        if req.active is not None:
            AppState.plants[req.plant_id]["active"] = bool(req.active)
        if req.capacity is not None:
            AppState.plants[req.plant_id]["capacity"] = max(0.0, min(1500.0, float(req.capacity)))
        snapshot = run_optimization_step(advance_battery=False)
        return {"status": "success", "plants": AppState.plants, "state": snapshot}
    return {"status": "error", "message": f"Unknown plant ID: {req.plant_id}"}


@app.post("/api/plant/capacity")
def set_plant_capacity(req: PlantCapacityRequest):
    if req.plant_id in AppState.plants:
        AppState.plants[req.plant_id]["capacity"] = max(0.0, min(1500.0, float(req.capacity)))
        snapshot = run_optimization_step(advance_battery=False)
        return {"status": "success", "plants": AppState.plants, "state": snapshot}
    return {"status": "error", "message": f"Unknown plant ID: {req.plant_id}"}


class ManualLoadRequest(BaseModel):
    zone: str
    mw: float = 0.0


@app.post("/api/load/override")
def override_load(req: ManualLoadRequest):
    if req.zone == "reset":
        for z in AppState.manual_loads:
            AppState.manual_loads[z] = 0.0
        snapshot = run_optimization_step(advance_battery=False)
        return {"status": "success", "manual_loads": AppState.manual_loads, "state": snapshot}
    if req.zone in AppState.manual_loads:
        AppState.manual_loads[req.zone] = max(0.0, min(600.0, float(req.mw)))
        snapshot = run_optimization_step(advance_battery=False)
        return {"status": "success", "manual_loads": AppState.manual_loads, "state": snapshot}
    return {"status": "error", "message": f"Unknown zone ID: {req.zone}"}


class PriorityUpdateRequest(BaseModel):
    mode: str = "auto"                      # "auto" or "manual"
    order: Optional[list[str]] = None       # Ordered list of 6 zone IDs when mode == "manual"


@app.post("/api/priority/update")
def update_priority(req: PriorityUpdateRequest):
    if req.mode == "auto" or not req.order:
        AppState.priority_override = None
    else:
        cleaned = [z for z in req.order if z in PRIORITY]
        for z in PRIORITY:
            if z not in cleaned:
                cleaned.append(z)
        if "hospital" in cleaned:
            cleaned.remove("hospital")
        cleaned.insert(0, "hospital")
        AppState.priority_override = cleaned

    snapshot = run_optimization_step(advance_battery=False)
    return {
        "status": "success",
        "priority_mode": snapshot.get("priority_mode", "auto"),
        "priority_order": snapshot.get("priority_order", PRIORITY),
        "state": snapshot,
    }


# ── AI Grid Agent Endpoints (Gemini + Ollama Switchable) ─────────────────────

class AgentConfigRequest(BaseModel):
    provider: Optional[str] = None          # "gemini" or "ollama"
    gemini_api_key: Optional[str] = None
    gemini_model: Optional[str] = None
    gemini_endpoint: Optional[str] = None
    ollama_endpoint: Optional[str] = None
    ollama_model: Optional[str] = None
    # Legacy fields kept for backward compatibility
    endpoint: Optional[str] = None
    model_name: Optional[str] = None


@app.post("/agent/configure")
def configure_agent(req: AgentConfigRequest):
    if not AppState.grid_agent:
        AppState.grid_agent = create_grid_agent()

    cfg = AppState.grid_agent.reconfigure(
        provider=req.provider,
        gemini_api_key=req.gemini_api_key,
        gemini_model=req.gemini_model,
        gemini_endpoint=req.gemini_endpoint,
        ollama_endpoint=req.ollama_endpoint,
        ollama_model=req.ollama_model,
        endpoint=req.endpoint,
        model_name=req.model_name,
    )
    return {
        "status": "success",
        "message": f"AI Agent configured ({cfg['provider'].upper()} · {cfg['active_model']})",
        "config": cfg,
    }


@app.get("/agent/config")
def get_agent_config():
    if not AppState.grid_agent:
        return {"config": {}, "agent_active": False}
    return {
        "config": AppState.grid_agent.config.safe_dict(),
        "agent_active": True,
    }


class AgentQueryRequest(BaseModel):
    query: str


@app.post("/agent/decide")
async def agent_decide(req: AgentQueryRequest):
    if not AppState.grid_agent:
        AppState.grid_agent = create_grid_agent()

    opt = AppState.latest_opt or run_optimization_step(advance_battery=False)
    grid_state = {
        "simulated_hour": round(AppState.simulated_hour, 2),
        "status_code": opt.get("status_code", "NORMAL"),
        "total_demand": opt.get("total_demand", 0.0),
        "total_supply": opt.get("total_supplied", 0.0),
        "predicted_demand": sum((opt.get("predicted_loads") or {}).values()),
        "battery_energy": opt.get("battery_energy", AppState.battery_energy),
        "battery_delta": opt.get("battery_delta", 0.0),
        "max_capacity_mw": opt.get("max_capacity_mw", 600.0),
        "renewable_available_mw": opt.get("renewable_available_mw", 0.0),
        "renewable_share_pct": opt.get("renewable_share_pct", 0.0),
        "generation": opt.get("generation", {}),
        "plants_state": opt.get("plants_state", {}),
        "peak_boost_active": opt.get("peak_boost_active", False),
        "freed_mw": opt.get("freed_mw", 0.0),
        "schedule_status": opt.get(
            "schedule_status", get_entity_schedule_status(AppState.simulated_hour)
        ),
        "demand_by_entity": opt.get("demand", {}),
        "supplied_by_entity": opt.get("supplied", {}),
        "recent_actions": opt.get("actions", []),
    }

    return await AppState.grid_agent.make_decision_async(grid_state, req.query)


@app.get("/agent/schedule")
def agent_schedule():
    status = get_entity_schedule_status(AppState.simulated_hour)
    return {
        "simulated_hour": round(AppState.simulated_hour, 2),
        "schedule": status,
        "peak_hour": AppState.latest_opt.get("peak_boost_active", False)
        if AppState.latest_opt
        else False,
    }


@app.get("/agent/status")
def agent_status():
    if not AppState.grid_agent:
        return {"status": "not_initialized", "message": "Agent not initialized"}
    return {
        "status": "active",
        "config": AppState.grid_agent.config.safe_dict(),
        "latest_optimization": AppState.latest_opt,
        "simulated_hour": round(AppState.simulated_hour, 2),
    }


# Serve frontend static files LAST so API routes always take priority
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
