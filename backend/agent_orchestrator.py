"""
agent_orchestrator.py - Dual-Provider AI Agent for Smart Grid Management

Supports seamless switching via environment variables or runtime API between:
  1. Google Gemini API (`AI_PROVIDER=gemini`) using `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_ENDPOINT`
  2. Ollama (`AI_PROVIDER=ollama`) using `OLLAMA_ENDPOINT`, `OLLAMA_MODEL`

Capabilities:
  - Intelligent load prioritization across 6 smart-grid zones
  - Renewable-first load balancing & carbon/cost accounting
  - Live transformer thermal management
  - Spinning / non-spinning reserve adequacy checks
  - Time-aware peak & off-peak scheduling advisories
"""

import asyncio
import json
import os
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


def _load_env_file() -> None:
    """Load backend/.env via python-dotenv if installed, else lightweight stdlib parser."""
    env_path = Path(__file__).resolve().parent / ".env"
    try:
        from dotenv import load_dotenv
        load_dotenv(env_path if env_path.exists() else None)
        return
    except ImportError:
        pass

    if env_path.exists():
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


_load_env_file()

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    httpx = None
    HTTPX_AVAILABLE = False

try:
    from google import genai
    from google.genai import types as genai_types
    GOOGLE_GENAI_AVAILABLE = True
except ImportError:
    genai = None
    genai_types = None
    GOOGLE_GENAI_AVAILABLE = False


# ─────────────────────────────────────────────────────────────────────────────
# Dual-Provider Configuration (Gemini 3.8 / 4 via google-genai + Ollama)
# ─────────────────────────────────────────────────────────────────────────────

DEFAULT_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta"
PLACEHOLDER_KEYS = {"", "your_gemini_api_key_here", "your-api-key", "changeme"}


class AgentConfig(BaseModel):
    """Unified configuration supporting Google Gen AI (Gemini 3.8 / 4) and Ollama."""

    provider: str = Field(
        default_factory=lambda: os.getenv("AI_PROVIDER", "gemini").strip().lower()
    )
    gemini_api_key: str = Field(
        default_factory=lambda: os.getenv("GEMINI_API_KEY", "").strip()
    )
    gemini_model: str = Field(
        default_factory=lambda: os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip()
    )
    gemini_endpoint: str = Field(
        default_factory=lambda: os.getenv(
            "GEMINI_ENDPOINT", DEFAULT_GEMINI_ENDPOINT
        ).strip()
    )
    ollama_endpoint: str = Field(
        default_factory=lambda: os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434").strip()
    )
    ollama_model: str = Field(
        default_factory=lambda: os.getenv("OLLAMA_MODEL", "gemma3:4b").strip()
    )

    # Backward-compatible properties for legacy Ollama callers
    @property
    def endpoint(self) -> str:
        return self.gemini_endpoint if self.provider == "gemini" else self.ollama_endpoint

    @property
    def model_name(self) -> str:
        return self.gemini_model if self.provider == "gemini" else self.ollama_model

    def has_valid_gemini_key(self) -> bool:
        return bool(self.gemini_api_key) and self.gemini_api_key not in PLACEHOLDER_KEYS

    def masked_key(self) -> str:
        if not self.has_valid_gemini_key():
            return "not_configured"
        k = self.gemini_api_key
        if len(k) <= 8:
            return "****"
        return f"{k[:4]}...{k[-4:]}"

    def safe_dict(self) -> Dict[str, Any]:
        """Serialize configuration without exposing raw API keys."""
        return {
            "provider": self.provider,
            "active_model": self.model_name,
            "active_endpoint": self.endpoint,
            "gemini": {
                "endpoint": self.gemini_endpoint,
                "model": self.gemini_model,
                "api_key_configured": self.has_valid_gemini_key(),
                "api_key_preview": self.masked_key(),
            },
            "ollama": {
                "endpoint": self.ollama_endpoint,
                "model": self.ollama_model,
            },
        }

    def update(
        self,
        provider: Optional[str] = None,
        gemini_api_key: Optional[str] = None,
        gemini_model: Optional[str] = None,
        gemini_endpoint: Optional[str] = None,
        ollama_endpoint: Optional[str] = None,
        ollama_model: Optional[str] = None,
        endpoint: Optional[str] = None,
        model_name: Optional[str] = None,
    ) -> None:
        """Update provider/model/endpoint settings at runtime."""
        if provider and provider.strip().lower() in ("gemini", "ollama"):
            self.provider = provider.strip().lower()
        if gemini_api_key is not None and gemini_api_key.strip():
            self.gemini_api_key = gemini_api_key.strip()
        if gemini_model:
            self.gemini_model = gemini_model.strip()
        if gemini_endpoint:
            self.gemini_endpoint = gemini_endpoint.strip()
        if ollama_endpoint:
            self.ollama_endpoint = ollama_endpoint.strip()
        if ollama_model:
            self.ollama_model = ollama_model.strip()

        # Legacy aliases (`endpoint` / `model_name`) map to active provider
        if endpoint:
            if self.provider == "gemini":
                self.gemini_endpoint = endpoint.strip()
            else:
                self.ollama_endpoint = endpoint.strip()
        if model_name:
            if self.provider == "gemini":
                self.gemini_model = model_name.strip()
            else:
                self.ollama_model = model_name.strip()


# Backward compatibility alias
OllamaConfig = AgentConfig


# ─────────────────────────────────────────────────────────────────────────────
# Energy Source, Thermal, Reserve & Optimization Subsystems
# ─────────────────────────────────────────────────────────────────────────────

class EnergySource(BaseModel):
    name: str
    source_type: str  # "renewable" or "non-renewable"
    capacity_mw: float
    current_output_mw: float
    efficiency: float
    is_available: bool = True
    maintenance_due: bool = False
    co2_per_mwh: float
    cost_per_mwh: float


class EnergyPool:
    """Manages renewable and non-renewable energy sources."""

    def __init__(self):
        self.sources: Dict[str, EnergySource] = {
            "solar_farm": EnergySource(
                name="Solar PV Array",
                source_type="renewable",
                capacity_mw=180.0,
                current_output_mw=0.0,
                efficiency=0.95,
                co2_per_mwh=0.0,
                cost_per_mwh=28.0,
            ),
            "wind_farm": EnergySource(
                name="Offshore/Ridge Wind Farm",
                source_type="renewable",
                capacity_mw=100.0,
                current_output_mw=0.0,
                efficiency=0.92,
                co2_per_mwh=0.0,
                cost_per_mwh=32.0,
            ),
            "battery_storage": EnergySource(
                name="Utility BESS Megapack",
                source_type="renewable",
                capacity_mw=400.0,
                current_output_mw=50.0,
                efficiency=0.91,
                co2_per_mwh=0.0,
                cost_per_mwh=45.0,
            ),
            "gas_plant_1": EnergySource(
                name="Combined-Cycle Plant 1",
                source_type="non-renewable",
                capacity_mw=300.0,
                current_output_mw=0.0,
                efficiency=0.92,
                co2_per_mwh=410.0,
                cost_per_mwh=58.0,
            ),
            "gas_plant_2": EnergySource(
                name="Combined-Cycle Plant 2",
                source_type="non-renewable",
                capacity_mw=300.0,
                current_output_mw=0.0,
                efficiency=0.90,
                co2_per_mwh=430.0,
                cost_per_mwh=62.0,
            ),
        }

    def sync_from_grid(self, grid_state: Dict[str, Any]) -> None:
        """Sync live generation outputs from optimizer telemetry."""
        gen = grid_state.get("generation", {}) or {}
        ren_out = float(gen.get("solar_wind", grid_state.get("renewable_available_mw", 0.0)) or 0.0)
        hour = float(grid_state.get("simulated_hour", 12.0)) % 24.0
        is_day = 6.0 <= hour <= 18.5
        solar_share = min(180.0, ren_out * (0.72 if is_day else 0.0))
        wind_share = min(100.0, max(0.0, ren_out - solar_share))

        self.sources["solar_farm"].current_output_mw = round(solar_share, 1)
        self.sources["wind_farm"].current_output_mw = round(wind_share, 1)
        self.sources["gas_plant_1"].current_output_mw = round(float(gen.get("plant1", 0.0) or 0.0), 1)
        self.sources["gas_plant_2"].current_output_mw = round(float(gen.get("plant2", 0.0) or 0.0), 1)
        self.sources["battery_storage"].current_output_mw = round(
            max(0.0, -float(grid_state.get("battery_delta", 0.0) or 0.0)), 1
        )

        plants_state = grid_state.get("plants_state", {}) or {}
        if "plant1" in plants_state:
            self.sources["gas_plant_1"].is_available = bool(plants_state["plant1"].get("active", True))
            if "capacity" in plants_state["plant1"]:
                self.sources["gas_plant_1"].capacity_mw = float(plants_state["plant1"]["capacity"])
        if "plant2" in plants_state:
            self.sources["gas_plant_2"].is_available = bool(plants_state["plant2"].get("active", True))
            if "capacity" in plants_state["plant2"]:
                self.sources["gas_plant_2"].capacity_mw = float(plants_state["plant2"]["capacity"])
        if "solar_wind" in plants_state:
            ren_active = bool(plants_state["solar_wind"].get("active", True))
            self.sources["solar_farm"].is_available = ren_active
            self.sources["wind_farm"].is_available = ren_active

    def get_available_renewable(self) -> float:
        return round(
            sum(
                max(0.0, s.capacity_mw - s.current_output_mw)
                for s in self.sources.values()
                if s.source_type == "renewable" and s.is_available
            ),
            2,
        )

    def get_available_nonrenewable(self) -> float:
        return round(
            sum(
                max(0.0, s.capacity_mw - s.current_output_mw)
                for s in self.sources.values()
                if s.source_type == "non-renewable" and s.is_available
            ),
            2,
        )

    def get_status(self) -> Dict[str, Any]:
        return {
            "sources": {
                k: (v.model_dump() if hasattr(v, "model_dump") else v.dict())
                for k, v in self.sources.items()
            },
            "total_renewable_available": self.get_available_renewable(),
            "total_nonrenewable_available": self.get_available_nonrenewable(),
            "total_capacity": sum(s.capacity_mw for s in self.sources.values()),
            "total_output": round(sum(s.current_output_mw for s in self.sources.values()), 2),
        }


class ThermalManager:
    """Manages substation & transformer thermal limits."""

    def __init__(self):
        self.current_temp_celsius = 28.0
        self.max_safe_temp = 45.0
        self.critical_temp = 55.0
        self.cooling_capacity_mw = 150.0
        self.cooling_efficiency = 0.92

    def sync_from_load(self, total_load_mw: float) -> None:
        self.current_temp_celsius = round(25.0 + (max(0.0, total_load_mw) / 850.0) * 22.0, 1)

    def get_thermal_status(self) -> Dict[str, Any]:
        temp_ratio = self.current_temp_celsius / self.max_safe_temp
        status = "NORMAL"
        if self.current_temp_celsius >= self.critical_temp:
            status = "CRITICAL"
        elif self.current_temp_celsius >= self.max_safe_temp:
            status = "WARNING"

        return {
            "current_temp_celsius": self.current_temp_celsius,
            "max_safe_temp": self.max_safe_temp,
            "critical_temp": self.critical_temp,
            "temp_ratio": round(temp_ratio, 2),
            "status": status,
            "cooling_capacity_mw": self.cooling_capacity_mw,
            "cooling_efficiency": self.cooling_efficiency,
        }

    def update_temperature(self, delta: float):
        self.current_temp_celsius = max(0.0, self.current_temp_celsius + delta)

    def calculate_temp_impact(self, load_mw: float) -> float:
        return (load_mw / 100.0) * 0.8


class ReserveManager:
    """Manages spinning/non-spinning reserves and emergency backup power."""

    def __init__(self):
        self.spinning_reserve_mw = 100.0
        self.non_spinning_reserve_mw = 150.0
        self.min_reserve_percentage = 0.15
        self.backup_fuel_days = 30
        self.is_backup_active = False

    def check_reserve_adequacy(self, demand_mw: float, supply_mw: float, battery_mw: float = 0.0) -> Dict[str, Any]:
        deficit = max(0.0, demand_mw - supply_mw)
        reserve_needed = demand_mw * self.min_reserve_percentage
        total_available = self.spinning_reserve_mw + self.non_spinning_reserve_mw + battery_mw * 0.5
        reserve_adequate = total_available >= reserve_needed and deficit <= 0.5

        return {
            "deficit_mw": round(deficit, 2),
            "reserve_needed_mw": round(reserve_needed, 2),
            "reserve_available_mw": round(total_available, 2),
            "reserve_adequate": reserve_adequate,
            "backup_fuel_days": self.backup_fuel_days,
            "backup_active": self.is_backup_active,
        }

    def activate_backup(self) -> str:
        self.is_backup_active = True
        return f"Backup power activated. Fuel reserves: {self.backup_fuel_days} days"

    def deactivate_backup(self) -> str:
        self.is_backup_active = False
        return "Backup power deactivated."


class LoadPrioritizer:
    """Intelligent load prioritization across all smart-grid zones."""

    PRIORITY_LEVELS = {
        "hospital": 1,
        "emergency_services": 1,
        "industry": 2,
        "school": 3,
        "commercial": 4,
        "residential": 5,
        "ev_hub": 6,
    }

    def prioritize(self, loads: Dict[str, float], conditions: Dict[str, Any]) -> Dict[str, Any]:
        temp_status = conditions.get("thermal_status", {})
        reserve_status = conditions.get("reserve_status", {})
        demand_mw = conditions.get("total_demand", 0.0)

        actions = []
        urgency = "NORMAL"
        if temp_status.get("status") == "CRITICAL":
            urgency = "CRITICAL_THERMAL"
        elif not reserve_status.get("reserve_adequate", True):
            urgency = "RESERVE_LOW"
        elif demand_mw > 720:
            urgency = "HIGH_DEMAND"

        if urgency == "NORMAL":
            actions.append("All zone loads satisfied within safe thermal and reserve envelopes.")
            shedding_plan = {entity: 0.0 for entity in loads.keys()}
        elif urgency == "HIGH_DEMAND":
            actions.append("High demand detected: throttling deferrable EV & non-essential commercial HVAC.")
            shedding_plan = self._calculate_shedding(loads, 0.06)
        elif urgency == "RESERVE_LOW":
            actions.append("Reserve margin low: moderate priority load curtailment recommended.")
            shedding_plan = self._calculate_shedding(loads, 0.12)
        else:
            actions.append("Critical thermal threshold: aggressive non-critical shedding activated.")
            shedding_plan = self._calculate_shedding(loads, 0.25)

        return {
            "urgency_level": urgency,
            "actions": actions,
            "shedding_plan": shedding_plan,
            "priority_order": sorted(
                loads.items(), key=lambda x: self.PRIORITY_LEVELS.get(x[0], 99)
            ),
        }

    def _calculate_shedding(self, loads: Dict[str, float], percentage: float) -> Dict[str, float]:
        shedding = {entity: 0.0 for entity in loads}
        remaining_to_shed = sum(loads.values()) * percentage
        sorted_entities = sorted(
            loads.items(),
            key=lambda x: self.PRIORITY_LEVELS.get(x[0], 99),
            reverse=True,
        )
        for entity, load in sorted_entities:
            if remaining_to_shed <= 0:
                break
            if self.PRIORITY_LEVELS.get(entity, 99) <= 1:
                continue
            shed_amount = min(load, remaining_to_shed)
            shedding[entity] = round(shed_amount, 2)
            remaining_to_shed -= shed_amount
        return shedding


class LoadBalancer:
    """Balances demand across renewable and thermal resources."""

    def balance(self, demand: float, energy_pool: EnergyPool, preferences: Dict[str, Any]) -> Dict[str, Any]:
        renewable_available = energy_pool.get_available_renewable()
        nonrenewable_available = energy_pool.get_available_nonrenewable()

        renewable_preference = preferences.get("renewable_preference", 0.70)
        renewable_target = demand * renewable_preference
        renewable_used = min(renewable_target, renewable_available)
        remaining_demand = demand - renewable_used
        nonrenewable_used = min(remaining_demand, nonrenewable_available)
        unmet_demand = max(0.0, demand - renewable_used - nonrenewable_used)

        allocation = {}
        remaining_ren = renewable_used
        for source_name in ["solar_farm", "wind_farm", "battery_storage"]:
            if source_name not in energy_pool.sources or remaining_ren <= 0:
                continue
            src = energy_pool.sources[source_name]
            if not src.is_available:
                continue
            alloc = min(remaining_ren, max(0.0, src.capacity_mw - src.current_output_mw))
            allocation[source_name] = round(alloc, 2)
            remaining_ren -= alloc

        remaining_nonren = nonrenewable_used
        for source_name in ["gas_plant_1", "gas_plant_2"]:
            if source_name not in energy_pool.sources or remaining_nonren <= 0:
                continue
            src = energy_pool.sources[source_name]
            if not src.is_available:
                continue
            alloc = min(remaining_nonren, max(0.0, src.capacity_mw - src.current_output_mw))
            allocation[source_name] = round(alloc, 2)
            remaining_nonren -= alloc

        cost = sum(
            allocation.get(name, 0.0) * energy_pool.sources[name].cost_per_mwh
            for name in energy_pool.sources
        )
        co2 = sum(
            allocation.get(name, 0.0) * energy_pool.sources[name].co2_per_mwh
            for name in energy_pool.sources
        )

        return {
            "allocation": allocation,
            "renewable_used_mw": round(renewable_used, 2),
            "nonrenewable_used_mw": round(nonrenewable_used, 2),
            "unmet_demand_mw": round(unmet_demand, 2),
            "total_cost_usd": round(cost, 2),
            "total_co2_kg": round(co2, 2),
            "efficiency_score": round((renewable_used / demand * 100.0) if demand > 0 else 0.0, 2),
        }


class ScheduleOptimizer:
    """Optimizes grid operations based on time of day."""

    @staticmethod
    def get_optimal_schedule(hour: float, predicted_load: float) -> Dict[str, Any]:
        hour = hour % 24.0
        if 6 <= hour < 9:
            period = "MORNING_PEAK"
            recommendation = "Ramp solar intake + proactive BESS support for industrial & EV morning surge."
            opt_ren = 0.60
        elif 9 <= hour < 17:
            period = "DAYTIME_SOLAR"
            recommendation = "Maximize Solar PV + Wind dispatch and charge BESS to >=85% SoC before dusk."
            opt_ren = 0.80
        elif 17 <= hour < 21:
            period = "EVENING_PEAK"
            recommendation = "Discharge BESS for peak shaving; throttle deferrable EV fast-charging if needed."
            opt_ren = 0.45
        elif hour >= 21 or hour < 6:
            period = "NIGHT_OFFPEAK"
            recommendation = "Maintain wind baseline + overnight BESS trickle recharge while school/industry rest."
            opt_ren = 0.55
        else:
            period = "TRANSITION"
            recommendation = "Balanced renewable-thermal transition."
            opt_ren = 0.60

        return {
            "period": period,
            "hour": round(hour, 2),
            "predicted_load_mw": round(predicted_load, 2),
            "recommendation": recommendation,
            "optimal_renewable_percentage": opt_ren,
        }


# Shared subsystem instances
energy_pool = EnergyPool()
thermal_mgr = ThermalManager()
reserve_mgr = ReserveManager()
load_prioritizer = LoadPrioritizer()
load_balancer = LoadBalancer()


# ─────────────────────────────────────────────────────────────────────────────
# HTTP Transport Helpers (httpx async/sync with urllib fallback)
# ─────────────────────────────────────────────────────────────────────────────

def _post_json_stdlib(url: str, payload: dict, headers: dict, timeout: float = 30.0) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {err_body[:300]}") from exc


async def _post_json_async(url: str, payload: dict, headers: dict, timeout: float = 30.0) -> dict:
    if HTTPX_AVAILABLE:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
            return resp.json()
    return await asyncio.to_thread(_post_json_stdlib, url, payload, headers, timeout)


# ─────────────────────────────────────────────────────────────────────────────
# Dual-Provider GridAgent (Gemini + Ollama)
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_INSTRUCTION = (
    "You are the Syntaxed-IEGMS Smart Grid AI Agent. "
    "Analyze live multi-zone telemetry, renewable generation, BESS battery reserves, "
    "and time-of-day schedules. Give crisp, authoritative, actionable operator guidance "
    "referencing exact MW figures, priority tiers (Hospital > Industry > School > Commercial > Residential > EV Hub), "
    "and time windows. Use concise markdown bullet points and bold key metrics."
)


class GridAgent:
    """AI Agent for Smart Grid Management supporting Gemini API and Ollama."""

    def __init__(self, config: Optional[AgentConfig] = None):
        self.config = config or AgentConfig()
        self._log_init()

    def _log_init(self) -> None:
        if self.config.provider == "gemini":
            key_state = "API key configured" if self.config.has_valid_gemini_key() else "waiting for GEMINI_API_KEY"
            print(
                f"[AI] GridAgent ready -> Provider: GEMINI | Model: {self.config.gemini_model} "
                f"| Endpoint: {self.config.gemini_endpoint} ({key_state})"
            )
        else:
            print(
                f"[AI] GridAgent ready -> Provider: OLLAMA | Model: {self.config.ollama_model} "
                f"| Endpoint: {self.config.ollama_endpoint}"
            )

    def reconfigure(self, **kwargs) -> Dict[str, Any]:
        self.config.update(**kwargs)
        self._log_init()
        return self.config.safe_dict()

    @staticmethod
    def sources_cap(key: str) -> float:
        src = energy_pool.sources.get(key)
        return src.capacity_mw if src else 300.0

    def _build_context(self, grid_state: Dict[str, Any]) -> str:
        total_demand = float(grid_state.get("total_demand", 0.0) or 0.0)
        total_supply = float(grid_state.get("total_supply", 0.0) or 0.0)
        battery_energy = float(grid_state.get("battery_energy", 50.0) or 0.0)

        energy_pool.sync_from_grid(grid_state)
        thermal_mgr.sync_from_load(total_supply)

        thermal_status = thermal_mgr.get_thermal_status()
        energy_status = energy_pool.get_status()
        reserve_status = reserve_mgr.check_reserve_adequacy(
            total_demand, total_supply, battery_energy
        )

        hour = float(grid_state.get("simulated_hour", 12.0) or 12.0) % 24.0
        h = int(hour)
        m = int((hour % 1) * 60)
        time_str = f"{h:02d}:{m:02d}"

        schedule = grid_state.get("schedule_status", {}) or {}
        schedule_lines = []
        for entity, info in schedule.items():
            st = "ACTIVE" if info.get("active") else "STANDBY"
            cap = info.get("cap_pct", 100)
            label = info.get("label", entity.capitalize())
            schedule_lines.append(f"  - {label:22} [{st}] {cap}% cap — {info.get('reason', '')}")
        schedule_block = "\n".join(schedule_lines) if schedule_lines else "  (no schedule data)"

        demand_by = grid_state.get("demand_by_entity", {}) or {}
        supplied_by = grid_state.get("supplied_by_entity", {}) or {}
        entity_lines = []
        for entity in ["hospital", "industry", "school", "commercial", "residential", "ev_hub"]:
            if entity in demand_by or entity in supplied_by:
                d = float(demand_by.get(entity, 0.0) or 0.0)
                s = float(supplied_by.get(entity, 0.0) or 0.0)
                entity_lines.append(f"  - {entity:14} demand={d:6.1f} MW | supplied={s:6.1f} MW")
        entity_block = "\n".join(entity_lines) if entity_lines else "  (no entity data)"

        gen = grid_state.get("generation", {}) or {}
        recent_actions = grid_state.get("recent_actions", []) or []
        actions_block = "\n".join(f"  - {a}" for a in recent_actions[-6:]) if recent_actions else "  - Nominal"

        return f"""SMART GRID LIVE TELEMETRY — Simulated Clock: {time_str}
=========================================================
GRID STATUS: {grid_state.get('status_code', 'NORMAL')}
  Total Demand     : {total_demand:.1f} MW (1h Forecast: {grid_state.get('predicted_demand', 0.0):.1f} MW)
  Total Supplied   : {total_supply:.1f} MW (Max Available Capacity: {grid_state.get('max_capacity_mw', 600.0):.1f} MW)
  Renewable Output : {gen.get('solar_wind', 0.0):.1f} MW ({grid_state.get('renewable_share_pct', 0.0):.1f}% of load)
  Thermal Plant 1  : {gen.get('plant1', 0.0):.1f} MW / {self.sources_cap('gas_plant_1'):.0f} MW
  Thermal Plant 2  : {gen.get('plant2', 0.0):.1f} MW / {self.sources_cap('gas_plant_2'):.0f} MW
  BESS Reserve     : {battery_energy:.1f} / 400.0 MWh (Delta: {grid_state.get('battery_delta', 0.0):+.1f} MW)
  Peak Boost Active: {grid_state.get('peak_boost_active', False)}
  Schedule Freed   : {grid_state.get('freed_mw', 0.0):.1f} MW

TRANSFORMER THERMAL & RESERVES:
  Transformer Temp : {thermal_status['current_temp_celsius']}C ({thermal_status['status']}, max safe {thermal_status['max_safe_temp']}C)
  Reserve Adequate : {reserve_status['reserve_adequate']} (Available: {reserve_status['reserve_available_mw']:.1f} MW vs Needed: {reserve_status['reserve_needed_mw']:.1f} MW)

ZONE TELEMETRY (Priority Order):
{entity_block}

TIME-OF-DAY POLICY ({time_str}):
{schedule_block}

RECENT ORCHESTRATOR ACTIONS:
{actions_block}
"""

    def _build_deterministic_advisory(self, grid_state: Dict[str, Any], query: str) -> str:
        """Built-in rule-engine synthesis used as instant fallback if API key / local Ollama is offline."""
        hour = float(grid_state.get("simulated_hour", 12.0) or 12.0) % 24.0
        h, m = int(hour), int((hour % 1) * 60)
        demand = float(grid_state.get("total_demand", 0.0) or 0.0)
        supply = float(grid_state.get("total_supply", 0.0) or 0.0)
        batt = float(grid_state.get("battery_energy", 50.0) or 0.0)
        ren_pct = float(grid_state.get("renewable_share_pct", 0.0) or 0.0)
        sched_opt = ScheduleOptimizer.get_optimal_schedule(hour, float(grid_state.get("predicted_demand", demand) or demand))
        deficit = max(0.0, demand - supply)

        bullets = [
            f"- **Grid Snapshot ({h:02d}:{m:02d} — {sched_opt['period']})**: Serving **{supply:.1f} MW** of **{demand:.1f} MW** demand (**{ren_pct:.1f}%** clean renewable mix, BESS at **{batt:.1f} / 400 MWh**).",
            f"- **Time-Window Strategy**: {sched_opt['recommendation']}",
        ]
        if deficit > 1.0:
            bullets.append(
                f"- **Deficit Mitigation ({deficit:.1f} MW unmet)**: Keep **Medical Center** protected at 100%; throttle **EV Supercharger Hub** and **Residential/Commercial** non-essential HVAC first, or bring any offline thermal unit back online."
            )
        elif batt < 120.0:
            bullets.append(
                f"- **Reserve Recovery**: BESS reserve is relatively low (**{batt:.1f} MWh**). Prioritize charging during solar/off-peak surplus before the **18:00–21:00** evening surge."
            )
        else:
            bullets.append(
                f"- **Thermal & Reserve Margin**: Substation transformer is at **{thermal_mgr.current_temp_celsius}°C ({thermal_mgr.get_thermal_status()['status']})** with healthy spinning reserve."
            )
        return "\n".join(bullets)

    def _build_gemini_request(self, user_prompt: str) -> tuple[str, dict, dict]:
        base = self.config.gemini_endpoint.rstrip("/")
        model = self.config.gemini_model
        if model.startswith("models/"):
            model = model[len("models/"):]
        url = f"{base}/models/{model}:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.config.gemini_api_key,
        }
        payload = {
            "systemInstruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {"temperature": 0.25, "maxOutputTokens": 900},
        }
        return url, payload, headers

    @staticmethod
    def _extract_gemini_text(data: dict) -> str:
        candidates = data.get("candidates") or []
        if not candidates:
            raise RuntimeError(f"Gemini returned no candidates: {json.dumps(data)[:250]}")
        parts = candidates[0].get("content", {}).get("parts", [])
        texts = [p.get("text", "") for p in parts if p.get("text")]
        if not texts:
            raise RuntimeError("Gemini candidate contained no text output.")
        return "\n".join(texts).strip()

    def _build_ollama_request(self, user_prompt: str) -> tuple[str, dict, dict]:
        base = self.config.ollama_endpoint.rstrip("/")
        url = f"{base}/api/generate"
        headers = {"Content-Type": "application/json"}
        payload = {
            "model": self.config.ollama_model,
            "system": SYSTEM_INSTRUCTION,
            "prompt": user_prompt,
            "stream": False,
            "options": {"temperature": 0.25},
        }
        return url, payload, headers

    def _context_summary(self) -> Dict[str, Any]:
        t = thermal_mgr.get_thermal_status()
        return {
            "provider": self.config.provider,
            "model": self.config.model_name,
            "temperature_celsius": t["current_temp_celsius"],
            "thermal_status": t["status"],
            "renewable_available_mw": energy_pool.get_available_renewable(),
            "nonrenewable_available_mw": energy_pool.get_available_nonrenewable(),
        }

    def _make_genai_client(self):
        """Create official google-genai Client honoring custom GEMINI_ENDPOINT if provided."""
        ep = self.config.gemini_endpoint.rstrip("/")
        if ep and ep != DEFAULT_GEMINI_ENDPOINT:
            base_url = ep[:-7] if ep.endswith("/v1beta") else ep
            return genai.Client(
                api_key=self.config.gemini_api_key,
                http_options=genai_types.HttpOptions(base_url=base_url),
            )
        return genai.Client(api_key=self.config.gemini_api_key)

    async def make_decision_async(self, grid_state: Dict[str, Any], query: str) -> Dict[str, Any]:
        """Async LLM decision call supporting Gemini (google-genai SDK / REST) and Ollama."""
        context = self._build_context(grid_state)
        user_prompt = (
            f"{context}\nOPERATOR QUERY:\n{query}\n\n"
            "Provide a clear, data-backed recommendation in 3-5 concise bullet points."
        )

        if self.config.provider == "gemini" and not self.config.has_valid_gemini_key():
            return {
                "status": "fallback",
                "provider": "gemini",
                "model": self.config.gemini_model,
                "notice": (
                    "GEMINI_API_KEY is not set in backend/.env yet (or configure it in AI Copilot Settings). "
                    "Showing deterministic telemetry analysis below — or set AI_PROVIDER=ollama to use Ollama."
                ),
                "decision": self._build_deterministic_advisory(grid_state, query),
                "grid_context": self._context_summary(),
                "timestamp": datetime.now().isoformat(),
            }

        try:
            if self.config.provider == "gemini":
                if GOOGLE_GENAI_AVAILABLE:
                    client = self._make_genai_client()
                    resp = await client.aio.models.generate_content(
                        model=self.config.gemini_model,
                        contents=user_prompt,
                        config=genai_types.GenerateContentConfig(
                            system_instruction=SYSTEM_INSTRUCTION,
                            temperature=0.25,
                            max_output_tokens=900,
                        ),
                    )
                    text = (resp.text or "").strip()
                    if not text:
                        raise RuntimeError("Gemini SDK returned empty response text.")
                else:
                    url, payload, headers = self._build_gemini_request(user_prompt)
                    data = await _post_json_async(url, payload, headers, timeout=30.0)
                    text = self._extract_gemini_text(data)
            else:
                url, payload, headers = self._build_ollama_request(user_prompt)
                data = await _post_json_async(url, payload, headers, timeout=45.0)
                text = (data.get("response") or "").strip()
                if not text:
                    raise RuntimeError("Empty response from Ollama endpoint.")

            return {
                "status": "success",
                "provider": self.config.provider,
                "model": self.config.model_name,
                "decision": text,
                "grid_context": self._context_summary(),
                "timestamp": datetime.now().isoformat(),
            }
        except Exception as exc:
            return {
                "status": "fallback",
                "provider": self.config.provider,
                "model": self.config.model_name,
                "error": str(exc),
                "notice": (
                    f"{self.config.provider.upper()} endpoint unreachable ({exc}). "
                    "Showing live rule-engine advisory fallback."
                ),
                "decision": self._build_deterministic_advisory(grid_state, query),
                "grid_context": self._context_summary(),
                "timestamp": datetime.now().isoformat(),
            }

    def _execute_sync_http(self, user_prompt: str) -> str:
        if self.config.provider == "gemini":
            if GOOGLE_GENAI_AVAILABLE:
                client = self._make_genai_client()
                resp = client.models.generate_content(
                    model=self.config.gemini_model,
                    contents=user_prompt,
                    config=genai_types.GenerateContentConfig(
                        system_instruction=SYSTEM_INSTRUCTION,
                        temperature=0.25,
                        max_output_tokens=900,
                    ),
                )
                text = (resp.text or "").strip()
                if not text:
                    raise RuntimeError("Gemini SDK returned empty response text.")
                return text

            url, payload, headers = self._build_gemini_request(user_prompt)
            if HTTPX_AVAILABLE:
                with httpx.Client(timeout=30.0) as client:
                    resp = client.post(url, json=payload, headers=headers)
                    if resp.status_code >= 400:
                        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
                    data = resp.json()
            else:
                data = _post_json_stdlib(url, payload, headers, timeout=30.0)
            return self._extract_gemini_text(data)

        url, payload, headers = self._build_ollama_request(user_prompt)
        if HTTPX_AVAILABLE:
            with httpx.Client(timeout=45.0) as client:
                resp = client.post(url, json=payload, headers=headers)
                if resp.status_code >= 400:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
                data = resp.json()
        else:
            data = _post_json_stdlib(url, payload, headers, timeout=45.0)
        text = (data.get("response") or "").strip()
        if not text:
            raise RuntimeError("Empty response from Ollama endpoint.")
        return text

    def make_decision(self, grid_state: Dict[str, Any], query: str) -> Dict[str, Any]:
        """Synchronous LLM decision call for CLI scripts and unit tests."""
        context = self._build_context(grid_state)
        user_prompt = (
            f"{context}\nOPERATOR QUERY:\n{query}\n\n"
            "Provide a clear, data-backed recommendation in 3-5 concise bullet points."
        )

        if self.config.provider == "gemini" and not self.config.has_valid_gemini_key():
            return {
                "status": "fallback",
                "provider": "gemini",
                "model": self.config.gemini_model,
                "notice": (
                    "GEMINI_API_KEY is not set in backend/.env yet (or configure it in AI Copilot Settings). "
                    "Showing deterministic telemetry analysis below — or set AI_PROVIDER=ollama to use Ollama."
                ),
                "decision": self._build_deterministic_advisory(grid_state, query),
                "grid_context": self._context_summary(),
                "timestamp": datetime.now().isoformat(),
            }

        try:
            text = self._execute_sync_http(user_prompt)
            return {
                "status": "success",
                "provider": self.config.provider,
                "model": self.config.model_name,
                "decision": text,
                "grid_context": self._context_summary(),
                "timestamp": datetime.now().isoformat(),
            }
        except Exception as exc:
            return {
                "status": "fallback",
                "provider": self.config.provider,
                "model": self.config.model_name,
                "error": str(exc),
                "notice": (
                    f"{self.config.provider.upper()} endpoint unreachable ({exc}). "
                    "Showing live rule-engine advisory fallback."
                ),
                "decision": self._build_deterministic_advisory(grid_state, query),
                "grid_context": self._context_summary(),
                "timestamp": datetime.now().isoformat(),
            }


def create_grid_agent(
    provider: Optional[str] = None,
    endpoint: Optional[str] = None,
    model_name: Optional[str] = None,
    gemini_api_key: Optional[str] = None,
    gemini_model: Optional[str] = None,
    gemini_endpoint: Optional[str] = None,
    ollama_endpoint: Optional[str] = None,
    ollama_model: Optional[str] = None,
) -> GridAgent:
    """Factory function to create a GridAgent configured for Gemini or Ollama."""
    cfg = AgentConfig()
    cfg.update(
        provider=provider,
        endpoint=endpoint,
        model_name=model_name,
        gemini_api_key=gemini_api_key,
        gemini_model=gemini_model,
        gemini_endpoint=gemini_endpoint,
        ollama_endpoint=ollama_endpoint,
        ollama_model=ollama_model,
    )
    return GridAgent(cfg)


if __name__ == "__main__":
    agent = create_grid_agent()
    sample_state = {
        "simulated_hour": 18.5,
        "total_demand": 680.0,
        "total_supply": 640.0,
        "predicted_demand": 720.0,
        "battery_energy": 180.0,
        "peak_boost_active": True,
    }
    res = agent.make_decision(
        sample_state,
        "How should we handle the evening surge while preserving battery reserves?",
    )
    print(json.dumps(res, indent=2))
