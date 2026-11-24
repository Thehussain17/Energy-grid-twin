from optimizer import optimize_grid, get_entity_schedule_status, _is_peak_hour

# Test 1: school closed at 19h
sched = get_entity_schedule_status(19.0)
school = sched["school"]
print(f"School at 19h: active={school['active']} cap={school['cap_pct']}%")
assert not school["active"], "School should be closed at 19h"
assert school["cap_pct"] == 5, "School cap should be 5% when closed"

# Test 2: residential off-peak sleep window at 02:00h (fixed bug!)
sched_night = get_entity_schedule_status(2.0)
assert not sched_night["residential"]["active"], "Residential should be in sleep off-peak at 02:00"
assert sched_night["residential"]["cap_pct"] == 50

# Test 3: peak hour check
assert _is_peak_hour(8.5) is True
assert _is_peak_hour(18.5) is True
assert _is_peak_hour(14.0) is False

# Test 4: 6-zone optimizer at 19h (evening — school closed, peak active)
loads = {
    "hospital": 90,
    "industry": 140,
    "school": 100,
    "commercial": 120,
    "residential": 180,
    "ev_hub": 95,
}
result = optimize_grid(loads, loads, 220.0, hour=19.0)
print(f"Hour=19 school_supplied={result['supplied']['school']:.1f} MW")
print(f"Freed MW: {result['freed_mw']} | Peak boost: {result['peak_boost_active']} | Status: {result['status_code']}")
assert result["supplied"]["school"] < 10, "School should have minimal supply at 19h"
assert result["freed_mw"] > 80, "Should have freed significant MW from school & industry at 19h"

# Test 5: Manual load spike stress test actually increases demand & triggers shedding when overloaded
spike_res = optimize_grid(
    loads,
    loads,
    40.0,
    hour=14.0,
    plants={
        "plant1": {"active": True, "capacity": 300.0},
        "plant2": {"active": False, "capacity": 300.0},
        "solar_wind": {"active": False, "capacity": 280.0},
    },
    manual_loads={"residential": 350.0, "ev_hub": 200.0},
)
print(f"Stress test status={spike_res['status_code']} | EV supplied={spike_res['supplied']['ev_hub']:.1f} / {spike_res['demand']['ev_hub']:.1f}")
assert spike_res["demand"]["residential"] > 450.0, "Manual spike must raise residential demand"
assert spike_res["supplied"]["ev_hub"] < spike_res["demand"]["ev_hub"], "EV Hub should shed first under stress"
assert spike_res["supplied"]["hospital"] == spike_res["demand"]["hospital"], "Hospital must stay protected"

print("\nALL OPTIMIZER & SCHEDULE TESTS PASSED")
