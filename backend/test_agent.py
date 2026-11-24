"""
test_agent.py - Test suite for Dual-Provider AI Grid Agent (Gemini + Ollama)
"""

import os
import sys

from agent_orchestrator import (
    AgentConfig,
    EnergyPool,
    LoadBalancer,
    LoadPrioritizer,
    ReserveManager,
    ScheduleOptimizer,
    ThermalManager,
    create_grid_agent,
)


def print_section(title: str):
    print("\n" + "=" * 76)
    print(f"  {title}")
    print("=" * 76)


def test_energy_pool():
    print_section("1. Energy Pool & Live Sync")
    pool = EnergyPool()
    pool.sync_from_grid({
        "simulated_hour": 13.0,
        "generation": {"solar_wind": 240.0, "plant1": 160.0, "plant2": 160.0},
        "battery_delta": 35.0,
    })
    status = pool.get_status()
    assert status["total_capacity"] > 1000
    assert status["total_output"] > 0
    print(f"Total Capacity: {status['total_capacity']} MW | Live Output: {status['total_output']} MW")


def test_thermal_and_reserve():
    print_section("2. Thermal & Reserve Adequacy")
    thermal = ThermalManager()
    thermal.sync_from_load(620.0)
    t_status = thermal.get_thermal_status()
    assert t_status["status"] == "NORMAL"

    reserve = ReserveManager()
    r_status = reserve.check_reserve_adequacy(650.0, 650.0, battery_mw=220.0)
    assert r_status["reserve_adequate"] is True
    print(f"Temp: {t_status['current_temp_celsius']}C ({t_status['status']}) | Reserve Adequate: {r_status['reserve_adequate']}")


def test_load_prioritization_and_balancing():
    print_section("3. 6-Zone Load Prioritization & Balancing")
    prioritizer = LoadPrioritizer()
    loads = {
        "hospital": 95.0,
        "industry": 160.0,
        "school": 110.0,
        "commercial": 135.0,
        "residential": 180.0,
        "ev_hub": 95.0,
    }
    conditions = {
        "total_demand": sum(loads.values()),
        "thermal_status": {"status": "WARNING", "current_temp_celsius": 47.0},
        "reserve_status": {"reserve_adequate": False},
    }
    res = prioritizer.prioritize(loads, conditions)
    assert res["shedding_plan"]["hospital"] == 0.0, "Hospital must never be shed"
    assert res["shedding_plan"]["ev_hub"] > 0.0, "Deferrable EV Hub should be shed first"
    print(f"Urgency: {res['urgency_level']} | Shed Plan: {res['shedding_plan']}")

    balancer = LoadBalancer()
    pool = EnergyPool()
    bal = balancer.balance(650.0, pool, {"renewable_preference": 0.70})
    assert bal["unmet_demand_mw"] == 0.0
    print(f"Balanced 650 MW -> Renewable: {bal['renewable_used_mw']} MW, Thermal: {bal['nonrenewable_used_mw']} MW")


def test_schedule_optimizer_night_fix():
    print_section("4. Time-Aware Schedule (Including Night Wrap Fix)")
    s_night_late = ScheduleOptimizer.get_optimal_schedule(22.5, 420.0)
    s_night_early = ScheduleOptimizer.get_optimal_schedule(2.5, 310.0)
    assert s_night_late["period"] == "NIGHT_OFFPEAK"
    assert s_night_early["period"] == "NIGHT_OFFPEAK"
    print(f"22:30 -> {s_night_late['period']} | 02:30 -> {s_night_early['period']}")


def test_dual_provider_switching():
    print_section("5. Dual-Provider Switching (Gemini 3.8 <-> Ollama)")
    agent = create_grid_agent(
        provider="gemini",
        gemini_endpoint="https://generativelanguage.googleapis.com/v1beta",
        gemini_model="gemini-3.8-flash",
    )
    cfg_gem = agent.config.safe_dict()
    assert cfg_gem["provider"] == "gemini"
    assert cfg_gem["active_model"] == "gemini-3.8-flash"
    print(f"Primary Provider : {cfg_gem['provider']} ({cfg_gem['active_model']} @ {cfg_gem['active_endpoint']})")

    # Test deterministic fallback when placeholder API key is present
    out = agent.make_decision(
        {"simulated_hour": 19.0, "total_demand": 710.0, "total_supply": 680.0, "battery_energy": 190.0},
        "Analyze evening peak status.",
    )
    assert out["status"] in ("success", "fallback")
    assert len(out["decision"]) > 40

    # Instant switch back to Ollama
    cfg_oll = agent.reconfigure(
        provider="ollama",
        ollama_endpoint="http://localhost:11434",
        ollama_model="gemma3:4b",
    )
    assert cfg_oll["provider"] == "ollama"
    assert cfg_oll["active_model"] == "gemma3:4b"
    print(f"Switched Provider: {cfg_oll['provider']} ({cfg_oll['active_model']} @ {cfg_oll['active_endpoint']})")


def main():
    print_section("SYNTAXED-IEGMS V3 AI Grid Agent Test Suite")
    test_energy_pool()
    test_thermal_and_reserve()
    test_load_prioritization_and_balancing()
    test_schedule_optimizer_night_fix()
    test_dual_provider_switching()
    print_section("All AI Agent Tests Completed Successfully")


if __name__ == "__main__":
    main()
