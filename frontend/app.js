/**
 * app.js - Syntaxed-IEGMS V4 Smart Grid Digital Twin Engine
 *
 * Stack:
 *  - Modern Three.js r187 (0.187.0) ES Modules + OrbitControls + UnrealBloomPass
 *  - High-DPI Procedural CanvasTexture Architectural Building Facades (30+ Structures)
 *  - Isomorphic Simulation Engine (syncs to FastAPI :8000 OR runs live standalone)
 *  - Carbon Pitch-Black & Modern Bold Electric Green (#00e676) Design Language
 *  - Dual-Provider Syntaxed Grid AI (Google Gen AI SDK gemini-3.8-flash <-> Ollama)
 */

const API = (() => {
  const { protocol, hostname } = window.location;
  if (!hostname || protocol === "file:") return "http://localhost:8000";
  return `${protocol}//${hostname}:8000`;
})();

const ZONES = ["hospital", "industry", "school", "commercial", "residential", "ev_hub"];
const ZONE_META = {
  hospital:    { label: "Medical Center",       tier: "Tier 1 · Critical",    shortKey: "hosp", cam: "hospital" },
  industry:    { label: "Industrial Park",      tier: "Tier 2 · High",        shortKey: "ind",  cam: "industrial" },
  school:      { label: "University Campus",    tier: "Tier 3 · Medium-High", shortKey: "sch",  cam: "campus" },
  commercial:  { label: "Commercial Core",      tier: "Tier 4 · Medium",      shortKey: "com",  cam: "downtown" },
  residential: { label: "Residential District", tier: "Tier 5 · Standard",    shortKey: "res",  cam: "residential" },
  ev_hub:      { label: "EV Supercharger Hub",  tier: "Tier 6 · Deferrable",  shortKey: "ev",   cam: "ev_hub" },
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. ISOMORPHIC LOCAL SIMULATION ENGINE (ENSURES 100% LIVE UI EVEN OFFLINE)
// ═══════════════════════════════════════════════════════════════════════════

const LOCAL_PROFILES = {
  hospital:    { 0: 76, 5: 78, 8: 94, 12: 108, 16: 102, 20: 90, 24: 76 },
  industry:    { 0: 24, 5: 32, 6: 138, 9: 162, 12: 170, 15: 160, 18: 72, 20: 28, 24: 24 },
  school:      { 0: 6, 6: 10, 7: 35, 8: 92, 12: 118, 15: 98, 17: 22, 19: 8, 24: 6 },
  commercial:  { 0: 22, 6: 28, 8: 85, 11: 132, 14: 145, 18: 120, 21: 58, 23: 26, 24: 22 },
  residential: { 0: 34, 5: 30, 7: 86, 9: 56, 14: 52, 17: 95, 19: 178, 21: 198, 23: 72, 24: 34 },
  ev_hub:      { 0: 14, 6: 18, 8: 68, 10: 42, 14: 38, 17: 74, 19: 112, 21: 92, 23: 28, 24: 14 },
};
const LOCAL_RENEWABLE = {
  0: 48, 5: 52, 6: 68, 8: 135, 11: 238, 13: 262, 15: 228, 17: 130, 18: 72, 20: 58, 24: 48,
};
const LOCAL_SCHED = {
  hospital:    { active: [0, 24], cap: 1.0,  reason: "24/7 Critical Care — protected 100%." },
  industry:    { active: [5, 19], cap: 0.10, reason: "Off-shift — 10% security/HVAC baseline." },
  school:      { active: [7, 17], cap: 0.05, reason: "Campus closed — 5% standby power." },
  commercial:  { active: [8, 21], cap: 0.15, reason: "Overnight — 15% server & safety baseline." },
  residential: { active: [6, 23], cap: 0.50, reason: "Sleep window — 50% off-peak cap." },
  ev_hub:      { active: [7, 22], cap: 0.25, reason: "Overnight smart-trickle charging (25%)." },
};

function interpCurve(hour, curve) {
  const h = ((hour % 24) + 24) % 24;
  const keys = Object.keys(curve).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < keys.length - 1; i++) {
    const t1 = keys[i], t2 = keys[i + 1];
    if (h >= t1 && h <= t2) {
      const f = t2 > t1 ? (h - t1) / (t2 - t1) : 0;
      const s = (1 - Math.cos(f * Math.PI)) * 0.5;
      return curve[t1] + s * (curve[t2] - curve[t1]);
    }
  }
  return curve[keys[0]];
}

const BESS_PROTECTED_ZONES = ["hospital", "industry", "school"];

const localSim = {
  backendOnline: false,
  hour: 8.5,
  paused: false,
  speed: 1,
  battery: 220,
  plants: { solar_wind: true, plant1: true, plant2: true, bess: true },
  plantCaps: { solar_wind: 280, plant1: 300, plant2: 300, bess: 400 },
  spikes: { hospital: 0, industry: 0, school: 0, commercial: 0, residential: 0, ev_hub: 0 },
};

function computeLocalState(advanceBatt = false) {
  const h = ((localSim.hour % 24) + 24) % 24;
  const demand = {};
  const schedStatus = {};
  let freed = 0;
  const actions = [];

  ZONES.forEach((z) => {
    const base = interpCurve(h, LOCAL_PROFILES[z]);
    const [s, e] = LOCAL_SCHED[z].active;
    const isAct = z === "hospital" || (h >= s && h < e);
    const cap = isAct ? 1.0 : LOCAL_SCHED[z].cap;
    const capped = base * cap;
    if (base - capped > 1) freed += base - capped;
    const spike = localSim.spikes[z] || 0;
    demand[z] = +(capped + spike).toFixed(1);
    if (spike > 0) actions.push(`[STRESS] ${ZONE_META[z].label}: +${spike} MW manual demand spike.`);
    schedStatus[z] = {
      label: ZONE_META[z].label,
      tier: ZONE_META[z].tier,
      active: isAct,
      cap_pct: Math.round(cap * 100),
      reason: isAct ? `${ZONE_META[z].label} active window (${String(s).padStart(2, "0")}:00–${String(e).padStart(2, "0")}:00).` : LOCAL_SCHED[z].reason,
    };
  });

  const renAvail = localSim.plants.solar_wind ? +interpCurve(h, LOCAL_RENEWABLE).toFixed(1) : 0;
  const p1Cap = localSim.plants.plant1 ? localSim.plantCaps.plant1 : 0;
  const p2Cap = localSim.plants.plant2 ? localSim.plantCaps.plant2 : 0;
  const thermCap = p1Cap + p2Cap;
  const maxCap = +(renAvail + thermCap).toFixed(1);
  const bessOn = !!localSim.plants.bess;

  if (maxCap <= 0.1 && (!bessOn || localSim.battery <= 0.1)) {
    actions.unshift("[CRITICAL] TOTAL BLACKOUT — All generation sources & BESS offline/empty!");
  } else if (maxCap <= 0.1) {
    actions.unshift("[CRITICAL] ALL Grid Generation Sources OFFLINE — BESS islanding protected tiers only!");
  }

  // Strict conservation-of-energy allocation in PRIORITY order
  const supplied = {};
  let remGen = maxCap;
  ZONES.forEach((z) => {
    const alloc = Math.min(demand[z], remGen);
    supplied[z] = +alloc.toFixed(1);
    remGen = Math.max(0, remGen - alloc);
  });

  const isPeak = (h >= 8 && h < 9) || (h >= 18 && h < 21);
  let battDelta = 0;

  if (remGen > 0.5) {
    if (bessOn) {
      if (isPeak && localSim.battery > 80 && thermCap > 0) {
        const protTherm = Math.max(0, BESS_PROTECTED_ZONES.reduce((a, z) => a + supplied[z], 0) - renAvail);
        const boost = Math.min(70, localSim.battery * 0.25, protTherm);
        if (boost > 1) {
          battDelta = -boost;
          actions.push(`[PEAK] Peak shaving: BESS discharging ${boost.toFixed(1)} MW to offset thermal load for critical tiers.`);
        }
      }
      if (battDelta === 0 && localSim.battery < 400) {
        battDelta = Math.min(remGen, 100, 400 - localSim.battery);
        actions.push(`[BESS] Surplus clean capacity: charging reserve +${battDelta.toFixed(1)} MW.`);
      } else if (battDelta === 0 && actions.length === 0) {
        actions.push("[OK] All 6 smart-grid zones balanced within nominal tolerances.");
      }
    } else if (actions.length === 0) {
      actions.push("[OK] Grid balanced (BESS reserve breaker disconnected).");
    }
  } else {
    // Generation deficit: BESS ONLY discharges for protected tiers (Hospital, Industry, School)
    if (bessOn && localSim.battery > 0.1) {
      let bessBudget = Math.min(120, localSim.battery);
      let bessUsed = 0;
      BESS_PROTECTED_ZONES.forEach((z) => {
        const unmet = demand[z] - supplied[z];
        if (unmet > 0.05 && bessBudget > 0.05) {
          const fromBess = Math.min(unmet, bessBudget);
          supplied[z] = +(supplied[z] + fromBess).toFixed(1);
          bessBudget -= fromBess;
          battDelta -= fromBess;
          bessUsed += fromBess;
        }
      });
      if (bessUsed > 0.1) {
        actions.push(`[BESS] Discharging ${bessUsed.toFixed(1)} MW reserve strictly for protected tiers (Hospital/Industry/School).`);
      }
    }

    // Log all shed zones including Hospital if generation + BESS couldn't cover it
    for (let i = ZONES.length - 1; i >= 0; i--) {
      const z = ZONES[i];
      const unmet = demand[z] - supplied[z];
      if (unmet > 0.05) {
        const pct = Math.round((unmet / Math.max(1, demand[z])) * 100);
        if (z === "hospital") {
          actions.unshift(`[CRITICAL] Medical Center lost ${pct}% (-${unmet.toFixed(1)} MW) — insufficient generation & BESS reserve!`);
        } else {
          const tag = BESS_PROTECTED_ZONES.includes(z) ? "" : " (BESS reserved for critical tiers)";
          actions.push(`[SHED] Shedding ${pct}% (-${unmet.toFixed(1)} MW) from ${ZONE_META[z].label}${tag}.`);
        }
      }
    }
  }

  if (advanceBatt) {
    localSim.battery = Math.max(0, Math.min(400, localSim.battery + battDelta * 0.08));
  }

  const totalSup = +Object.values(supplied).reduce((a, b) => a + b, 0).toFixed(1);
  const totalDem = +Object.values(demand).reduce((a, b) => a + b, 0).toFixed(1);
  const deficit = Math.max(0, totalDem - totalSup);
  const hospDeficit = Math.max(0, demand.hospital - supplied.hospital);
  const genNeed = Math.min(maxCap, Math.max(0, totalSup + battDelta));
  const renUsed = +Math.min(renAvail, genNeed).toFixed(1);
  const thermNeed = Math.max(0, genNeed - renUsed);
  const p1 = p1Cap > 0 && thermCap > 0 ? +Math.min(p1Cap, thermNeed * (p1Cap / thermCap)).toFixed(1) : 0;
  const p2 = p2Cap > 0 && thermCap > 0 ? +Math.min(p2Cap, thermNeed * (p2Cap / thermCap)).toFixed(1) : 0;

  const hasShed = actions.some((a) => a.startsWith("[SHED]") || a.startsWith("[CRITICAL]"));
  const status = hospDeficit > 0.1 || maxCap <= 0.1 ? "CRITICAL" : hasShed ? "WARNING" : isPeak ? "PEAK" : "NORMAL";

  return {
    status_code: status,
    simulated_hour: +h.toFixed(2),
    sim_paused: localSim.paused,
    sim_speed: localSim.speed,
    demand,
    supplied,
    total_demand: totalDem,
    total_supplied: totalSup,
    battery_energy: +localSim.battery.toFixed(1),
    battery_soc_pct: +((localSim.battery / 400) * 100).toFixed(1),
    battery_delta: +battDelta.toFixed(1),
    generation: { solar_wind: renUsed, plant1: p1, plant2: p2 },
    plants_state: {
      solar_wind: { active: localSim.plants.solar_wind, capacity: localSim.plantCaps.solar_wind },
      plant1: { active: localSim.plants.plant1, capacity: localSim.plantCaps.plant1 },
      plant2: { active: localSim.plants.plant2, capacity: localSim.plantCaps.plant2 },
      bess: { active: localSim.plants.bess, capacity: 400 },
    },
    manual_loads: { ...localSim.spikes },
    renewable_share_pct: totalSup > 0.1 ? +((renUsed / totalSup) * 100).toFixed(1) : 0,
    co2_avoided_tons: +(renUsed * 0.52).toFixed(1),
    transformer_temp_c: +(25 + (totalSup / 850) * 22).toFixed(1),
    max_capacity_mw: maxCap,
    freed_mw: +freed.toFixed(1),
    schedule_status: schedStatus,
    predicted_loads: Object.fromEntries(ZONES.map((z) => [z, +interpCurve(h + 1, LOCAL_PROFILES[z]).toFixed(1)])),
    actions,
    mqtt_connected: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. MODERN THREE.JS r187 SCENE + PROCEDURAL ARCHITECTURAL FACADES + BLOOM
// ═══════════════════════════════════════════════════════════════════════════

let threeCtx = null;
let currentHour = 8.5;
let latestGridState = null;
let latestReadings = [];
let selectedZoneId = null;
let pinsVisible = true;
let autoOrbit = false;

const CAMERA_PRESETS = {
  overview:    { pos: [42, 68, 92],   target: [-6, 6, 0] },
  downtown:    { pos: [34, 34, 18],   target: [4, 14, -22] },
  hospital:    { pos: [-4, 28, 12],   target: [-26, 10, -22] },
  industrial:  { pos: [-2, 26, 52],   target: [-28, 6, 22] },
  campus:      { pos: [66, 28, 52],   target: [38, 6, 20] },
  residential: { pos: [70, 30, 10],   target: [40, 8, -22] },
  ev_hub:      { pos: [26, 20, 48],   target: [4, 4, 22] },
  renewables:  { pos: [-34, 32, -4],  target: [-68, 10, -34] },
  substation:  { pos: [-28, 24, 22],  target: [-60, 4, -2] },
  plants:      { pos: [-28, 28, 62],  target: [-60, 6, 32] },
};

window.__bootSmartGrid3D = function ({
  THREE,
  OrbitControls,
  Sky,
  RoomEnvironment,
  EffectComposer,
  RenderPass,
  UnrealBloomPass,
  OutputPass,
}) {
  const container = document.getElementById("canvas-container");
  if (!container) return;

  function getSize() {
    const simPage = document.getElementById("sim-page");
    return {
      w: (simPage && simPage.clientWidth) || window.innerWidth,
      h: (simPage && simPage.clientHeight) || Math.max(400, window.innerHeight - 60),
    };
  }

  const sz = getSize();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b8de);
  scene.fog = new THREE.FogExp2(0x9ec5e6, 0.0022);

  const camera = new THREE.PerspectiveCamera(40, sz.w / sz.h, 1, 1400);
  camera.position.set(...CAMERA_PRESETS.overview.pos);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(sz.w, sz.h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  // Realistic PBR Environment Reflections (for glass curtain walls, water & steel)
  if (RoomEnvironment) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    if ("environmentIntensity" in scene) scene.environmentIntensity = 0.45;
  }

  // Physically-Based Preetham Atmospheric Sky Shader
  let sky = null;
  if (Sky) {
    sky = new Sky();
    sky.scale.setScalar(4500);
    scene.add(sky);
    const u = sky.material.uniforms;
    u.turbidity.value = 4.5;
    u.rayleigh.value = 1.8;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.82;
  }

  // Subtle Post-Processing Composer (gentle night bloom only on bright lights)
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(sz.w, sz.h), 0.22, 0.3, 0.88);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // Smooth Damped OrbitControls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.maxPolarAngle = Math.PI * 0.465;
  controls.minDistance = 24;
  controls.maxDistance = 230;
  controls.target.set(...CAMERA_PRESETS.overview.target);

  const camLerpGoal = { active: false, pos: new THREE.Vector3(), target: new THREE.Vector3() };
  controls.addEventListener("start", () => { camLerpGoal.active = false; });

  // ── Realistic Architectural Facade Generator (Day Reflective Glass + Warm Night Interior) ──
  function makeFacadeMaterial({
    wallHex,
    mullionHex,
    dayGlassHex = "#3d5a73",
    nightLitPalette = ["#fff1c9", "#ffe29e", "#e8f1fa"],
    cols = 8,
    rows = 14,
    litRatio = 0.65,
    metalness = 0.45,
    roughness = 0.28,
  }) {
    const cDiff = document.createElement("canvas");
    const cEmis = document.createElement("canvas");
    cDiff.width = cEmis.width = 256;
    cDiff.height = cEmis.height = 512;
    const dCtx = cDiff.getContext("2d");
    const eCtx = cEmis.getContext("2d");

    dCtx.fillStyle = wallHex;
    dCtx.fillRect(0, 0, 256, 512);
    eCtx.fillStyle = "#000000";
    eCtx.fillRect(0, 0, 256, 512);

    const padX = 6, padY = 7;
    const cellW = 256 / cols;
    const cellH = 512 / rows;

    let seed = cols * 97 + rows * 31;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

    for (let r = 0; r < rows; r++) {
      const floorWeight = rnd() > 0.22 ? 1.0 : 0.35;
      for (let c = 0; c < cols; c++) {
        const x = c * cellW + padX * 0.5;
        const y = r * cellH + padY * 0.5;
        const w = cellW - padX;
        const h = cellH - padY;

        dCtx.fillStyle = mullionHex;
        dCtx.fillRect(x - 1, y - 1, w + 2, h + 2);

        // Daytime diffuse always shows realistic tinted architectural glass!
        const glassShade = rnd() > 0.5 ? dayGlassHex : "#2c4459";
        dCtx.fillStyle = glassShade;
        dCtx.fillRect(x, y, w, h);

        // Emissive map lights up interior rooms naturally at dusk/night!
        if (rnd() < litRatio * floorWeight) {
          eCtx.fillStyle = nightLitPalette[Math.floor(rnd() * nightLitPalette.length)];
          eCtx.fillRect(x, y, w, h);
        }
      }
    }

    const diffTex = new THREE.CanvasTexture(cDiff);
    const emisTex = new THREE.CanvasTexture(cEmis);
    diffTex.colorSpace = THREE.SRGBColorSpace;
    emisTex.colorSpace = THREE.SRGBColorSpace;
    diffTex.anisotropy = 4;
    emisTex.anisotropy = 4;

    return new THREE.MeshStandardMaterial({
      map: diffTex,
      emissiveMap: emisTex,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.0, // Controlled naturally by sun elevation!
      metalness,
      roughness,
    });
  }

  const zoneMats = {
    hospital: makeFacadeMaterial({
      wallHex: "#e8edf2", mullionHex: "#cbd5e1", dayGlassHex: "#6495b8",
      nightLitPalette: ["#f8fafc", "#fffbeb", "#e0f2fe"], cols: 8, rows: 12, litRatio: 0.85, metalness: 0.25, roughness: 0.35,
    }),
    commercial: makeFacadeMaterial({
      wallHex: "#334e68", mullionHex: "#829ab1", dayGlassHex: "#486581",
      nightLitPalette: ["#fff3d1", "#fef9c3", "#e2f1ff"], cols: 10, rows: 22, litRatio: 0.72, metalness: 0.75, roughness: 0.16,
    }),
    residential: makeFacadeMaterial({
      wallHex: "#c9b8a8", mullionHex: "#8d7b6d", dayGlassHex: "#3b5266",
      nightLitPalette: ["#ffd88a", "#ffe8b3", "#ffcf70"], cols: 6, rows: 12, litRatio: 0.68, metalness: 0.12, roughness: 0.68,
    }),
    residentialBrick: makeFacadeMaterial({
      wallHex: "#9e5a47", mullionHex: "#d6ccc2", dayGlassHex: "#334756",
      nightLitPalette: ["#ffd88a", "#ffe8b3"], cols: 5, rows: 9, litRatio: 0.65, metalness: 0.1, roughness: 0.75,
    }),
    industry: makeFacadeMaterial({
      wallHex: "#64748b", mullionHex: "#475569", dayGlassHex: "#334155",
      nightLitPalette: ["#fef08a", "#fde68a"], cols: 8, rows: 5, litRatio: 0.6, metalness: 0.45, roughness: 0.58,
    }),
    school: makeFacadeMaterial({
      wallHex: "#9c4a35", mullionHex: "#dfd7ce", dayGlassHex: "#3d566e",
      nightLitPalette: ["#fff1c2", "#fde68a"], cols: 10, rows: 6, litRatio: 0.75, metalness: 0.1, roughness: 0.72,
    }),
    ev_hub: new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0ea5e9, emissiveIntensity: 0.5, roughness: 0.25, metalness: 0.4 }),
    battery: new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x16a34a, emissiveIntensity: 0.55, roughness: 0.25, metalness: 0.4 }),
  };

  // Natural Sunlight + Sky Bounce Hemisphere Light
  const hemiLight = new THREE.HemisphereLight(0x9bd3ff, 0x4f5d4e, 0.75);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff7e8, 2.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -105;
  sunLight.shadow.camera.right = 105;
  sunLight.shadow.camera.top = 105;
  sunLight.shadow.camera.bottom = -105;
  sunLight.shadow.camera.near = 10;
  sunLight.shadow.camera.far = 310;
  sunLight.shadow.bias = -0.0005;
  scene.add(sunLight);

  // Night Starfield Dome (natural white/blue-white stars)
  const starPos = new Float32Array(550 * 3);
  for (let i = 0; i < 550; i++) {
    const r = 360 + Math.random() * 90;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.random() * Math.PI * 0.44;
    starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    starPos[i * 3 + 1] = r * Math.cos(ph) + 25;
    starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xf1f5f9, size: 1.5, transparent: true, opacity: 0.0 });
  scene.add(new THREE.Points(starGeo, starMat));

  // Natural World Materials
  const matTerrain  = new THREE.MeshStandardMaterial({ color: 0x486b43, roughness: 0.95, metalness: 0.02 });
  const matCityPad  = new THREE.MeshStandardMaterial({ color: 0x6c757d, roughness: 0.9, metalness: 0.04 });
  const matPark     = new THREE.MeshStandardMaterial({ color: 0x4f7a49, roughness: 0.88 });
  const matRoad     = new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.85, metalness: 0.05 });
  const matSidewalk = new THREE.MeshStandardMaterial({ color: 0xadb5bd, roughness: 0.82 });
  const matWater    = new THREE.MeshStandardMaterial({ color: 0x1e6091, roughness: 0.08, metalness: 0.72, transparent: true, opacity: 0.9 });
  const matSteel    = new THREE.MeshStandardMaterial({ color: 0x8d99ae, roughness: 0.35, metalness: 0.75 });
  const matConcrete = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.78, metalness: 0.1 });
  const matDarkRoof = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.65, metalness: 0.25 });
  const matSolar    = new THREE.MeshStandardMaterial({ color: 0x172a45, roughness: 0.18, metalness: 0.82 });
  const matCrownLit = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, emissive: 0xfff3d1, emissiveIntensity: 0.2, roughness: 0.3, metalness: 0.6 });

  const pickableMeshes = [];
  const floatingLabels = [];
  const windRotors = [];
  const streetLamps = [];
  const beacons = [];
  const cars = [];
  const energyPaths = [];

  function tagZone(group, zoneId) {
    group.traverse((ch) => {
      if (ch.isMesh) {
        ch.userData.zoneId = zoneId;
        pickableMeshes.push(ch);
      }
    });
  }

  function addPin(id, x, y, z) {
    const el = document.getElementById(id);
    if (el) floatingLabels.push({ el, pos: new THREE.Vector3(x, y, z) });
  }

  function makeBuildingBox(w, h, d, wallMat, roofMat = matDarkRoof) {
    const mats = [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat];
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // Expansive Natural Countryside Terrain (1600x1600 — no floating box edges!)
  const terrain = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), matTerrain);
  terrain.rotation.x = -Math.PI / 2;
  terrain.position.y = -0.05;
  terrain.receiveShadow = true;
  scene.add(terrain);

  // Urban Concrete Base Apron under downtown blocks
  const urbanApron = new THREE.Mesh(new THREE.BoxGeometry(132, 0.12, 110), matCityPad);
  urbanApron.position.set(10, 0.01, 0);
  urbanApron.receiveShadow = true;
  scene.add(urbanApron);

  // Scenic Blue River Channel
  const river = new THREE.Mesh(new THREE.PlaneGeometry(12, 1600), matWater);
  river.rotation.x = -Math.PI / 2;
  river.position.set(-43, 0.04, 0);
  scene.add(river);

  // Riverbank stone embankments
  [-49.3, -36.7].forEach((rx) => {
    const bank = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.3, 260), matConcrete);
    bank.position.set(rx, 0.1, 0);
    bank.receiveShadow = true;
    scene.add(bank);
  });

  function addRoad(x, z, w, d) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(w + 2.4, 0.16, d + 2.4), matSidewalk);
    curb.position.set(x, 0.08, z);
    curb.receiveShadow = true;
    scene.add(curb);

    const r = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matRoad);
    r.rotation.x = -Math.PI / 2;
    r.position.set(x, 0.18, z);
    r.receiveShadow = true;
    scene.add(r);

    const dashMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
    const horiz = w > d;
    const len = horiz ? w : d;
    for (let p = -len / 2 + 4; p < len / 2 - 4; p += 7.5) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(horiz ? 3.2 : 0.22, horiz ? 0.22 : 3.2), dashMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(horiz ? x + p : x, 0.2, horiz ? z : z + p);
      scene.add(dash);
    }
  }

  addRoad(6, 0, 155, 8.2);
  addRoad(-12, 0, 8.2, 136);
  addRoad(22, 0, 8.2, 136);
  addRoad(8, -42, 114, 6);
  addRoad(8, 42, 114, 6);

  // Realistic Steel Highway Bridge Guardrails
  [-4.8, 4.8].forEach((zOff) => {
    const bridgeRail = new THREE.Mesh(new THREE.BoxGeometry(15, 0.85, 0.35), matSteel);
    bridgeRail.position.set(-43, 0.65, zOff);
    bridgeRail.castShadow = true;
    scene.add(bridgeRail);
  });

  // Warm Streetlamps (off by day, warm golden glow at night)
  function addLamp(x, z) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 5.2, 8), matSteel);
    pole.position.y = 2.6;
    pole.castShadow = true;
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), bulbMat);
    bulb.position.set(0.55, 5.1, 0);
    const haloMat = new THREE.MeshBasicMaterial({ color: 0xffdfa0, transparent: true, opacity: 0, depthWrite: false });
    const halo = new THREE.Mesh(new THREE.CircleGeometry(3.4, 16), haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(0.55, 0.21, 0);
    g.add(pole, bulb, halo);
    g.position.set(x, 0, z);
    streetLamps.push({ bulbMat, haloMat });
    scene.add(g);
  }
  for (let lx = -34; lx <= 56; lx += 18) { addLamp(lx, 5.4); addLamp(lx, -5.4); }

  // ── 1. MEDICAL CENTER COMPLEX (North-West [-26, 0, -23]) ──
  const hospG = new THREE.Group();
  const matWhiteRoof = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.7 });
  const hMain = makeBuildingBox(15, 23, 11, zoneMats.hospital, matWhiteRoof);
  hMain.position.set(-26, 11.5, -23);
  const hWing = makeBuildingBox(11, 13, 10, zoneMats.hospital, matWhiteRoof);
  hWing.position.set(-18, 6.5, -16);
  const hCanopy = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.5, 4.5), new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.35 }));
  hCanopy.position.set(-26, 3.8, -15.5);
  const hPad = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.45, 24), matDarkRoof);
  hPad.position.set(-26, 23.25, -23);
  const crossMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, emissive: 0xdc2626, emissiveIntensity: 0.35 });
  const c1 = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.35, 1.2), crossMat);
  c1.position.set(-26, 23.6, -23);
  const c2 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.35, 4.2), crossMat);
  c2.position.set(-26, 23.6, -23);
  const hBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.38, 8, 8), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
  hBeacon.position.set(-32.5, 23.8, -27.5);
  beacons.push(hBeacon);
  hospG.add(hMain, hWing, hCanopy, hPad, c1, c2, hBeacon);
  tagZone(hospG, "hospital");
  scene.add(hospG);
  addPin("label-hospital", -26, 28, -23);

  // ── 2. COMMERCIAL & TECH SKYSCRAPER CORE (Center-North [5, 0, -24]) ──
  const comG = new THREE.Group();
  const t1Base = makeBuildingBox(11.5, 30, 11.5, zoneMats.commercial);
  t1Base.position.set(5, 15, -27);
  const t1Top = makeBuildingBox(8.4, 7, 8.4, zoneMats.commercial);
  t1Top.position.set(5, 33.5, -27);
  const t1Crown = new THREE.Mesh(new THREE.BoxGeometry(8.7, 0.45, 8.7), matCrownLit);
  t1Crown.position.set(5, 37.2, -27);
  const t1Spire = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.32, 7.5, 8), matSteel);
  t1Spire.position.set(5, 41, -27);

  const t2 = makeBuildingBox(9.5, 24, 9.5, zoneMats.commercial);
  t2.position.set(-4.5, 12, -18);
  const t2Crown = new THREE.Mesh(new THREE.BoxGeometry(9.7, 0.35, 9.7), matCrownLit);
  t2Crown.position.set(-4.5, 24.2, -18);

  const t3 = makeBuildingBox(9, 18, 9, zoneMats.commercial);
  t3.position.set(14.5, 9, -26);
  const dc = makeBuildingBox(11, 9.5, 8.5, zoneMats.industry, matWhiteRoof);
  dc.position.set(13, 4.75, -15);
  comG.add(t1Base, t1Top, t1Crown, t1Spire, t2, t2Crown, t3, dc);
  tagZone(comG, "commercial");
  scene.add(comG);
  addPin("label-commercial", 5, 44, -27);

  // ── 3. RESIDENTIAL DISTRICT (North-East [42, 0, -22]) ──
  const resG = new THREE.Group();
  const resPark = new THREE.Mesh(new THREE.BoxGeometry(32, 0.22, 29), matPark);
  resPark.position.set(42, 0.11, -22);
  resPark.receiveShadow = true;
  resG.add(resPark);

  [
    { x: 32, z: -31, w: 8.5, h: 17, d: 8.5, mat: zoneMats.residential },
    { x: 43, z: -32, w: 9,   h: 21, d: 8.5, mat: zoneMats.residentialBrick },
    { x: 53, z: -29, w: 8,   h: 15, d: 8,   mat: zoneMats.residential },
    { x: 54, z: -18, w: 8,   h: 13, d: 8,   mat: zoneMats.residentialBrick },
  ].forEach((a) => {
    const b = makeBuildingBox(a.w, a.h, a.d, a.mat);
    b.position.set(a.x, a.h / 2, a.z);
    resG.add(b);
  });

  const matTerraRoof = new THREE.MeshStandardMaterial({ color: 0x7f4f3e, roughness: 0.8 });
  for (let tx = 31; tx <= 46; tx += 7.2) {
    for (let tz = -19; tz <= -12; tz += 7) {
      const h = 5.6 + ((tx + tz) % 2) * 1.4;
      const th = makeBuildingBox(5.2, h, 5.2, (tx + tz) % 2 ? zoneMats.residential : zoneMats.residentialBrick);
      th.position.set(tx, h / 2, tz);
      const rf = new THREE.Mesh(new THREE.ConeGeometry(4.1, 2.1, 4), matTerraRoof);
      rf.rotation.y = Math.PI / 4;
      rf.position.set(tx, h + 1.05, tz);
      rf.castShadow = true;
      resG.add(th, rf);
    }
  }
  tagZone(resG, "residential");
  scene.add(resG);
  addPin("label-residential", 43, 25, -26);

  // ── 4. INDUSTRIAL & LOGISTICS PARK (South-West [-27, 0, 22]) ──
  const indG = new THREE.Group();
  const fac1 = makeBuildingBox(16, 9.5, 18, zoneMats.industry);
  fac1.position.set(-28, 4.75, 21);
  const fac2 = makeBuildingBox(13, 7, 12, zoneMats.industry, matWhiteRoof);
  fac2.position.set(-22, 3.5, 34);
  indG.add(fac1, fac2);

  for (let sz = 14; sz <= 28; sz += 4.5) {
    const saw = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.2, 4), matDarkRoof);
    saw.rotation.y = Math.PI / 4;
    saw.scale.set(2.9, 1, 0.8);
    saw.position.set(-28, 10.6, sz);
    indG.add(saw);
  }

  [0x1d4ed8, 0xb45309, 0x991b1b, 0x0f766e].forEach((col, i) => {
    const cont = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.2, 2.2), new THREE.MeshStandardMaterial({ color: col, roughness: 0.55, metalness: 0.3 }));
    cont.position.set(-34, 1.1 + (i % 2) * 2.2, 32 + Math.floor(i / 2) * 2.6);
    cont.castShadow = true;
    indG.add(cont);
  });

  [-33, -28.5, -24].forEach((sx) => {
    const st = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.5, 16.5, 16), matConcrete);
    st.position.set(sx, 8.25, 11.5);
    st.castShadow = true;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.04, 1.08, 1.4, 16), new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.6 }));
    band.position.set(sx, 15.2, 11.5);
    indG.add(st, band);
  });
  tagZone(indG, "industry");
  scene.add(indG);
  addPin("label-industry", -28, 19, 21);

  // ── 5. UNIVERSITY CAMPUS (South-East [40, 0, 22]) ──
  const schG = new THREE.Group();
  const quad = new THREE.Mesh(new THREE.BoxGeometry(32, 0.2, 29), matPark);
  quad.position.set(40, 0.1, 23);
  quad.receiveShadow = true;
  const hall = makeBuildingBox(21, 8.5, 7.5, zoneMats.school);
  hall.position.set(40, 4.25, 14.5);
  const wL = makeBuildingBox(6.5, 7.5, 14, zoneMats.school);
  wL.position.set(31, 3.75, 25);
  const wR = makeBuildingBox(6.5, 7.5, 14, zoneMats.school);
  wR.position.set(49, 3.75, 25);
  const tower = makeBuildingBox(4.4, 17, 4.4, zoneMats.school);
  tower.position.set(40, 8.5, 14.5);
  const towerCap = new THREE.Mesh(new THREE.ConeGeometry(3.5, 4.2, 4), matDarkRoof);
  towerCap.rotation.y = Math.PI / 4;
  towerCap.position.set(40, 19.1, 14.5);
  for (let spx = 32; spx <= 48; spx += 5) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.2, 4.2), matSolar);
    sp.rotation.x = 0.25;
    sp.position.set(spx, 8.8, 14.5);
    schG.add(sp);
  }
  schG.add(quad, hall, wL, wR, tower, towerCap);
  tagZone(schG, "school");
  scene.add(schG);
  addPin("label-school", 40, 23, 18);

  // ── 6. EV SUPERCHARGER & TRANSIT PLAZA (Center-South [5, 0, 22]) ──
  const evG = new THREE.Group();
  const evPad = new THREE.Mesh(new THREE.BoxGeometry(23, 0.25, 18), matSidewalk);
  evPad.position.set(5, 0.12, 22);
  evPad.receiveShadow = true;
  const canopyFrame = new THREE.Mesh(new THREE.BoxGeometry(18.8, 0.45, 9.5), matWhiteRoof);
  canopyFrame.position.set(5, 5.45, 20.5);
  canopyFrame.castShadow = true;
  const canopySolar = new THREE.Mesh(new THREE.BoxGeometry(18.2, 0.15, 8.9), matSolar);
  canopySolar.position.set(5, 5.72, 20.5);
  [-2.5, 5, 12.5].forEach((px) => {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 5.4, 10), matSteel);
    col.position.set(px, 2.7, 20.5);
    evG.add(col);
  });
  for (let sx = -2.5; sx <= 12.5; sx += 3) {
    const ped = new THREE.Mesh(new THREE.BoxGeometry(0.75, 2.2, 0.5), matWhiteRoof);
    ped.position.set(sx, 1.1, 20.5);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.3, 0.54), zoneMats.ev_hub);
    bar.position.set(sx, 1.2, 20.5);
    evG.add(ped, bar);
  }
  const lounge = makeBuildingBox(10, 4.5, 4.8, zoneMats.hospital, matWhiteRoof);
  lounge.position.set(5, 2.25, 28.5);
  evG.add(evPad, canopyFrame, canopySolar, lounge);
  tagZone(evG, "ev_hub");
  scene.add(evG);
  addPin("label-ev_hub", 5, 10, 21);

  // ── 7. UTILITY BESS MEGAPACK SUBSTATION & PYLONS (West [-60, 0, -2]) ──
  const bessG = new THREE.Group();
  const bessPad = new THREE.Mesh(new THREE.BoxGeometry(24, 0.28, 26), matSidewalk);
  bessPad.position.set(-60, 0.14, -2);
  bessPad.receiveShadow = true;
  const matPack = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.4, metalness: 0.3 });
  for (let bx = -67; bx <= -53; bx += 6.5) {
    for (let bz = -10; bz <= 6; bz += 4.2) {
      const pk = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3.1, 2.1), matPack);
      pk.position.set(bx, 1.7, bz);
      pk.castShadow = true;
      pk.receiveShadow = true;
      const led = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.32, 2.16), zoneMats.battery);
      led.position.set(bx, 2.45, bz);
      bessG.add(pk, led);
    }
  }
  [-51, -35].forEach((px) => {
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 1.1, 15, 4), matSteel);
    pylon.position.set(px, 7.5, -8);
    pylon.castShadow = true;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 6.5), matSteel);
    arm.position.set(px, 13.5, -8);
    bessG.add(pylon, arm);
  });
  bessG.add(bessPad);
  scene.add(bessG);
  addPin("label-battery", -60, 11, -2);

  // ── 8. CLEAN RENEWABLE FARM: 5 WIND TURBINES + 16 SOLAR ARRAYS ([-68, 0, -34]) ──
  const renG = new THREE.Group();
  const matWhite = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.32, metalness: 0.2 });
  function addTurbine(x, z) {
    const g = new THREE.Group();
    const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.95, 22, 14), matWhite);
    tw.position.y = 11;
    tw.castShadow = true;
    const nac = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.5, 3.2), matWhite);
    nac.position.set(0, 22.2, 0.4);
    const rotor = new THREE.Group();
    rotor.position.set(0, 22.2, 2.1);
    rotor.add(new THREE.Mesh(new THREE.SphereGeometry(0.65, 10, 10), matWhite));
    for (let b = 0; b < 3; b++) {
      const piv = new THREE.Group();
      piv.rotation.z = (b * Math.PI * 2) / 3;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.44, 9.2, 0.15), matWhite);
      blade.position.y = 4.6;
      blade.castShadow = true;
      piv.add(blade);
      rotor.add(piv);
    }
    windRotors.push(rotor);
    g.add(tw, nac, rotor);
    g.position.set(x, 0, z);
    renG.add(g);
  }
  [[-76, -46], [-62, -48], [-78, -30], [-64, -33], [-52, -42]].forEach(([x, z]) => addTurbine(x, z));
  for (let sx = -74; sx <= -56; sx += 6) {
    for (let sz = -23; sz <= -14; sz += 3) {
      const pv = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.18, 2.2), matSolar);
      pv.rotation.x = 0.35;
      pv.position.set(sx, 1.2, sz);
      pv.castShadow = true;
      renG.add(pv);
    }
  }
  scene.add(renG);
  addPin("label-solar_wind", -66, 26, -36);

  // ── 9. THERMAL PLANTS 1 & 2 (South-West [-64, 0, 28]) ──
  function addPlant(x, z, pinId) {
    const g = new THREE.Group();
    const hall = makeBuildingBox(11, 8, 10, zoneMats.industry);
    hall.position.y = 4;
    const cool = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 4.9, 14.5, 20), matConcrete);
    cool.position.set(-5.5, 7.25, -4);
    cool.castShadow = true;
    cool.receiveShadow = true;
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.35, 0.18, 8, 24), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(-5.5, 14.55, -4);
    g.add(hall, cool, ring);
    g.position.set(x, 0, z);
    scene.add(g);
    addPin(pinId, x - 2, 17, z - 2);
    return { ringMat, pos: new THREE.Vector3(x, 0, z) };
  }
  const p1Obj = addPlant(-65, 24, "label-plant1");
  const p2Obj = addPlant(-56, 42, "label-plant2");

  // Varied Natural Trees & Realistic Vehicles
  const matTrunk = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.9 });
  const leafShades = [
    new THREE.MeshStandardMaterial({ color: 0x2d6a4f, roughness: 0.82 }),
    new THREE.MeshStandardMaterial({ color: 0x40916c, roughness: 0.82 }),
    new THREE.MeshStandardMaterial({ color: 0x386641, roughness: 0.85 }),
  ];
  [
    [-36, -34], [-18, -35], [26, -34], [58, -34], [58, -10],
    [56, 14], [56, 34], [26, 35], [-18, 36], [39, -22], [45, -24],
    [36, 23], [44, 25], [-55, -20], [-72, 8],
  ].forEach(([tx, tz], i) => {
    const s = 0.9 + (i % 3) * 0.18;
    const tg = new THREE.Group();
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * s, 0.38 * s, 2.3 * s, 7), matTrunk);
    tr.position.y = 1.15 * s;
    const cr = new THREE.Mesh(new THREE.ConeGeometry(1.8 * s, 4.3 * s, 8), leafShades[i % 3]);
    cr.position.y = 3.65 * s;
    cr.castShadow = true;
    tg.add(tr, cr);
    tg.position.set(tx, 0, tz);
    scene.add(tg);
  });

  function addCar(start, end, speed, hex) {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.85, 1.4), new THREE.MeshStandardMaterial({ color: hex, roughness: 0.3, metalness: 0.6 }));
    b.position.y = 0.6;
    b.castShadow = true;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 1.25), new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.2, metalness: 0.7 }));
    cab.position.set(-0.1, 1.2, 0);
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 1.1), new THREE.MeshBasicMaterial({ color: 0xfffbeb }));
    hl.position.set(1.38, 0.62, 0);
    g.add(b, cab, hl);
    const dir = new THREE.Vector3().subVectors(end, start);
    g.rotation.y = Math.atan2(-dir.z, dir.x);
    scene.add(g);
    cars.push({ mesh: g, start, end, speed, progress: Math.random() });
  }
  addCar(new THREE.Vector3(-54, 0.18, 1.8), new THREE.Vector3(64, 0.18, 1.8), 13, 0xe2e8f0);
  addCar(new THREE.Vector3(64, 0.18, -1.8), new THREE.Vector3(-54, 0.18, -1.8), 11, 0xdc2626);
  addCar(new THREE.Vector3(-10.2, 0.18, -52), new THREE.Vector3(-10.2, 0.18, 52), 10, 0x2563eb);
  addCar(new THREE.Vector3(23.8, 0.18, 52), new THREE.Vector3(23.8, 0.18, -52), 11.5, 0x475569);

  // Subtle Power Conduits
  function addConduit(sVec, eVec, hex, key) {
    const mid = new THREE.Vector3((sVec.x + eVec.x) * 0.5, 0.9, (sVec.z + eVec.z) * 0.5);
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(sVec.x, 0.35, sVec.z),
      mid,
      new THREE.Vector3(eVec.x, 0.35, eVec.z)
    );
    const lineMat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.28 });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(28)), lineMat);
    scene.add(line);

    const pCount = 7;
    const positions = new Float32Array(pCount * 3);
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const pMat = new THREE.PointsMaterial({ color: hex, size: 0.75, transparent: true, opacity: 0.8 });
    const pts = new THREE.Points(pGeo, pMat);
    scene.add(pts);

    energyPaths.push({ key, baseColor: hex, curve, lineMat, pMat, pts, positions, pCount, isActive: true });
  }

  const hubVec = new THREE.Vector3(-60, 0, -2);
  addConduit(new THREE.Vector3(-66, 0, -34), hubVec, 0x38bdf8, "gen_solar_wind");
  addConduit(p1Obj.pos, hubVec, 0xf59e0b, "gen_plant1");
  addConduit(p2Obj.pos, hubVec, 0xf59e0b, "gen_plant2");
  addConduit(hubVec, new THREE.Vector3(-26, 0, -23), 0x38bdf8, "zone_hospital");
  addConduit(hubVec, new THREE.Vector3(-28, 0, 21),  0x38bdf8, "zone_industry");
  addConduit(hubVec, new THREE.Vector3(40, 0, 18),   0x38bdf8, "zone_school");
  addConduit(hubVec, new THREE.Vector3(5, 0, -27),   0x38bdf8, "zone_commercial");
  addConduit(hubVec, new THREE.Vector3(43, 0, -26),  0x38bdf8, "zone_residential");
  addConduit(hubVec, new THREE.Vector3(5, 0, 21),    0x38bdf8, "zone_ev_hub");

  // Raycast Click-to-Inspect
  const raycaster = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let downPos = { x: 0, y: 0 };
  renderer.domElement.addEventListener("pointerdown", (e) => { downPos = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ptr.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ptr.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ptr, camera);
    const hits = raycaster.intersectObjects(pickableMeshes, false);
    if (hits.length > 0 && hits[0].object.userData.zoneId) {
      window.inspectZone(hits[0].object.userData.zoneId);
    }
  });

  function onResize() {
    const s = getSize();
    camera.aspect = s.w / s.h;
    camera.updateProjectionMatrix();
    renderer.setSize(s.w, s.h);
    composer.setSize(s.w, s.h);
  }
  window.addEventListener("resize", onResize);

  // Natural Atmospheric Palette Across 24 Hours
  const FOG_NIGHT  = new THREE.Color(0x070c18);
  const FOG_DAWN   = new THREE.Color(0xd98a6c);
  const FOG_DAY    = new THREE.Color(0xb8d8f2);
  const FOG_SUNSET = new THREE.Color(0xc97b5d);

  const SUN_NIGHT  = new THREE.Color(0x64748b);
  const SUN_GOLDEN = new THREE.Color(0xff9e5e);
  const SUN_NOON   = new THREE.Color(0xfff8eb);

  const tmpFog = new THREE.Color();
  const tmpSunCol = new THREE.Color();
  const sunDir = new THREE.Vector3();
  const projV = new THREE.Vector3();

  function renderLoop() {
    requestAnimationFrame(renderLoop);
    const now = performance.now() * 0.001;

    if (camLerpGoal.active) {
      camera.position.lerp(camLerpGoal.pos, 0.08);
      controls.target.lerp(camLerpGoal.target, 0.08);
      if (camera.position.distanceTo(camLerpGoal.pos) < 0.4) camLerpGoal.active = false;
    }
    controls.autoRotate = autoOrbit;
    controls.autoRotateSpeed = 0.65;
    controls.update();

    // Physically Natural Sun Arc & Color Temperature
    const dayPhase = ((currentHour - 6.0) / 12.0) * Math.PI; // 0 at 06:00, PI/2 at 12:00, PI at 18:00
    const sunElev = Math.sin(dayPhase); // > 0 during 06:00 - 18:00
    const azimuth = -Math.cos(dayPhase);

    sunDir.set(azimuth * 0.88, Math.max(-0.25, sunElev), 0.38).normalize();
    sunLight.position.copy(sunDir).multiplyScalar(120);
    if (sunLight.position.y < 8) sunLight.position.y = 8; // Moon/twilight grazing shadow angle

    if (sky) {
      sky.material.uniforms.sunPosition.value.copy(sunDir);
      sky.visible = sunElev > -0.14;
    }

    const isNight = sunElev <= -0.06;
    const isGolden = sunElev > -0.06 && sunElev < 0.32;

    if (isNight) {
      tmpFog.copy(FOG_NIGHT);
      tmpSunCol.copy(SUN_NIGHT);
      scene.background.lerp(FOG_NIGHT, 0.12);
    } else if (isGolden) {
      const t = (sunElev + 0.06) / 0.38;
      tmpFog.lerpColors(currentHour < 12 ? FOG_DAWN : FOG_SUNSET, FOG_DAY, t);
      tmpSunCol.lerpColors(SUN_GOLDEN, SUN_NOON, t);
      scene.background.lerp(tmpFog, 0.12);
    } else {
      tmpFog.copy(FOG_DAY);
      tmpSunCol.copy(SUN_NOON);
      scene.background.lerp(FOG_DAY, 0.12);
    }

    sunLight.color.lerp(tmpSunCol, 0.12);
    const targetSunInt = isNight ? 0.14 : isGolden ? 1.35 : 2.25;
    sunLight.intensity += (targetSunInt - sunLight.intensity) * 0.1;

    hemiLight.color.setHex(isNight ? 0x334155 : isGolden ? 0xfed7aa : 0x9bd3ff);
    hemiLight.groundColor.setHex(isNight ? 0x0f172a : 0x4f6349);
    hemiLight.intensity += ((isNight ? 0.32 : 0.78) - hemiLight.intensity) * 0.1;

    if ("environmentIntensity" in scene) {
      scene.environmentIntensity = isNight ? 0.12 : isGolden ? 0.32 : 0.5;
    }
    renderer.toneMappingExposure = isNight ? 0.95 : 1.02;
    bloomPass.strength = isNight ? 0.32 : 0.12;

    scene.fog.color.lerp(tmpFog, 0.12);
    starMat.opacity += ((sunElev < -0.08 ? 0.9 : 0.0) - starMat.opacity) * 0.08;

    const lightsOn = sunElev < 0.12;
    matCrownLit.emissiveIntensity = lightsOn ? 0.85 : 0.0;
    streetLamps.forEach((sl) => {
      sl.bulbMat.color.setHex(lightsOn ? 0xffe4a0 : 0x94a3b8);
      sl.haloMat.opacity = lightsOn ? 0.24 : 0.0;
    });

    if (latestGridState) updateBuildingWindowsForSun(latestGridState, sunElev);

    // Wind Rotors & Beacons
    const renOn = latestGridState?.plants_state?.solar_wind?.active ?? true;
    windRotors.forEach((r, i) => { r.rotation.z -= (renOn ? 0.034 : 0.002) * (1 + i * 0.06); });
    const pulse = 0.5 + 0.5 * Math.sin(now * 5);
    beacons.forEach((b) => b.scale.setScalar(0.85 + pulse * 0.45));

    // Subtle Energy Particles
    energyPaths.forEach((ep) => {
      ep.lineMat.opacity = ep.isActive ? (lightsOn ? 0.42 : 0.22) : 0.05;
      ep.pMat.opacity = ep.isActive ? (lightsOn ? 0.9 : 0.65) : 0.0;
      if (!ep.isActive) return;
      for (let i = 0; i < ep.pCount; i++) {
        const pt = ep.curve.getPoint((now * 0.34 + i / ep.pCount) % 1.0);
        ep.positions[i * 3] = pt.x;
        ep.positions[i * 3 + 1] = pt.y;
        ep.positions[i * 3 + 2] = pt.z;
      }
      ep.pts.geometry.attributes.position.needsUpdate = true;
    });

    // Vehicles
    cars.forEach((c) => {
      c.progress = (c.progress + (c.speed * 0.016) / c.start.distanceTo(c.end)) % 1.0;
      c.mesh.position.lerpVectors(c.start, c.end, c.progress);
    });

    // Project 3D Pins WITH HUD Occlusion + 2D Anti-Overlap Separation!
    if (pinsVisible) {
      const { w, h } = getSize();
      const simEl = document.getElementById("sim-page");
      const dockOpen = simEl && !simEl.classList.contains("dock-closed");
      const inspOpen = document.getElementById("zone-inspector")?.classList.contains("open");
      const copilotOpen = document.getElementById("copilot-drawer")?.classList.contains("open");

      const visiblePins = [];
      floatingLabels.forEach((lbl) => {
        projV.copy(lbl.pos).project(camera);
        const x = (projV.x * 0.5 + 0.5) * w;
        const y = (projV.y * -0.5 + 0.5) * h;

        let occluded = projV.z >= 1.0 || x < 45 || x > w - 45 || y < 82 || y > h - 80;
        if (!occluded && dockOpen && x < 355 && y > 10 && y < h - 70) occluded = true;
        if (!occluded && inspOpen && x > w - 330 && y < 340) occluded = true;
        if (!occluded && copilotOpen && x > w - 405) occluded = true;

        if (occluded) {
          lbl.el.style.opacity = "0";
          lbl.el.style.pointerEvents = "none";
        } else {
          visiblePins.push({ lbl, x, y });
        }
      });

      // Push apart overlapping pins in screen space
      visiblePins.sort((a, b) => a.y - b.y);
      for (let i = 0; i < visiblePins.length; i++) {
        for (let j = i + 1; j < visiblePins.length; j++) {
          const dx = Math.abs(visiblePins[i].x - visiblePins[j].x);
          const dy = visiblePins[j].y - visiblePins[i].y;
          if (dx < 155 && dy < 29) {
            const shift = (29 - dy) * 0.5;
            visiblePins[i].y -= shift;
            visiblePins[j].y += shift;
          }
        }
      }

      visiblePins.forEach(({ lbl, x, y }) => {
        lbl.el.style.left = `${x}px`;
        lbl.el.style.top = `${y}px`;
        lbl.el.style.opacity = "1";
        lbl.el.style.pointerEvents = "auto";
      });
    }

    composer.render();
  }

  function updateBuildingWindowsForSun(state, sunElev) {
    // Windows off in bright daylight (0.0), warming up smoothly at dusk/night (0.9)
    const nightGlow = sunElev > 0.2 ? 0.0 : sunElev < -0.05 ? 0.92 : ((0.2 - sunElev) / 0.25) * 0.92;
    ZONES.forEach((z) => {
      const mat = zoneMats[z];
      const d = state.demand?.[z] ?? 0;
      const s = state.supplied?.[z] ?? 0;
      const shed = d > 1 && s < d - 0.5;
      if (!mat) return;
      if (d > 1 && s < d * 0.15) {
        // Blackout: interior & stall lights go completely off
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0.0;
      } else if (shed) {
        // Partial shedding (brownout): dim naturally in proportion to remaining supply
        const ratio = Math.max(0.0, Math.min(1.0, s / Math.max(1.0, d)));
        mat.emissive.setHex(z === "ev_hub" ? 0x0ea5e9 : 0xffffff);
        mat.emissiveIntensity = (z === "ev_hub" ? (nightGlow * 0.6 + 0.25) : nightGlow) * ratio * 0.55;
      } else {
        mat.emissive.setHex(z === "ev_hub" ? 0x0ea5e9 : 0xffffff);
        mat.emissiveIntensity = z === "ev_hub" ? (nightGlow * 0.6 + 0.25) : nightGlow;
      }
      if (z === "residential" && zoneMats.residentialBrick) {
        zoneMats.residentialBrick.emissive.copy(mat.emissive);
        zoneMats.residentialBrick.emissiveIntensity = mat.emissiveIntensity;
      }
    });
  }

  threeCtx = { zoneMats, energyPaths, p1Obj, p2Obj, camLerpGoal, onResize, updateBuildingWindowsForSun };
  if (latestGridState) sync3DWithState(latestGridState);
  renderLoop();
};

function sync3DWithState(state) {
  if (!threeCtx) return;
  const { energyPaths, p1Obj, p2Obj } = threeCtx;

  ZONES.forEach((z) => {
    const d = state.demand?.[z] ?? 0;
    const s = state.supplied?.[z] ?? 0;
    const shed = d > 1 && s < d - 0.5;
    document.getElementById(`label-${z}`)?.classList.toggle("shedding", shed);
  });

  const ps = state.plants_state || {};
  energyPaths.forEach((ep) => {
    if (ep.key === "gen_solar_wind") ep.isActive = (state.generation?.solar_wind ?? 0) > 1 && (ps.solar_wind?.active ?? true);
    else if (ep.key === "gen_plant1") ep.isActive = (state.generation?.plant1 ?? 0) > 1 && (ps.plant1?.active ?? true);
    else if (ep.key === "gen_plant2") ep.isActive = (state.generation?.plant2 ?? 0) > 1 && (ps.plant2?.active ?? true);
    else if (ep.key.startsWith("zone_")) {
      const z = ep.key.replace("zone_", "");
      const shed = (state.demand?.[z] ?? 0) > 1 && (state.supplied?.[z] ?? 0) < (state.demand?.[z] ?? 0) - 0.5;
      ep.isActive = (state.supplied?.[z] ?? 0) > 1;
      const col = shed ? 0xef4444 : ep.baseColor;
      ep.lineMat.color.setHex(col);
      ep.pMat.color.setHex(col);
    }
  });

  p1Obj.ringMat.color.setHex(ps.plant1?.active ?? true ? 0x22c55e : 0xef4444);
  p2Obj.ringMat.color.setHex(ps.plant2?.active ?? true ? 0x22c55e : 0xef4444);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. UI CONTROLS, CAMERA PRESETS, INSPECTOR & ISOMORPHIC DISPATCH
// ═══════════════════════════════════════════════════════════════════════════

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setBar(id, pct, color) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (color) el.style.background = color;
}
function formatClock(hr) {
  const h = Math.floor(((hr % 24) + 24) % 24);
  const m = Math.floor((hr % 1) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

window.focusCameraPreset = function (name, btn) {
  const p = CAMERA_PRESETS[name] || CAMERA_PRESETS.overview;
  if (threeCtx) {
    threeCtx.camLerpGoal.pos.set(...p.pos);
    threeCtx.camLerpGoal.target.set(...p.target);
    threeCtx.camLerpGoal.active = true;
  }
  if (btn) {
    document.querySelectorAll(".cam-btn:not(#btn-auto-orbit):not(#btn-toggle-pins)").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  }
};

window.toggleMapLabels = function (btn) {
  pinsVisible = !pinsVisible;
  document.getElementById("labels-container")?.classList.toggle("labels-hidden", !pinsVisible);
  if (btn) btn.classList.toggle("active", pinsVisible);
};

window.toggleAutoOrbit = function (btn) {
  autoOrbit = !autoOrbit;
  if (btn) btn.classList.toggle("active", autoOrbit);
};

window.toggleLeftDock = function () {
  document.getElementById("sim-page")?.classList.toggle("dock-closed");
};

window.switchDockTab = function (tabName, btn) {
  document.querySelectorAll(".dock-pane").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".dock-tab").forEach((b) => b.classList.remove("active"));
  document.getElementById(`dock-${tabName}`)?.classList.add("active");
  if (btn) btn.classList.add("active");
};

window.inspectZone = function (zoneId) {
  const meta = ZONE_META[zoneId];
  if (!meta) return;
  selectedZoneId = zoneId;
  document.querySelectorAll(".map-label").forEach((el) => el.classList.remove("selected"));
  document.getElementById(`label-${zoneId}`)?.classList.add("selected");
  window.focusCameraPreset(meta.cam);
  document.getElementById("zone-inspector")?.classList.add("open");
  refreshInspectorCard();
};

window.closeInspector = function () {
  selectedZoneId = null;
  document.querySelectorAll(".map-label").forEach((el) => el.classList.remove("selected"));
  document.getElementById("zone-inspector")?.classList.remove("open");
};

function refreshInspectorCard() {
  if (!selectedZoneId || !latestGridState) return;
  const meta = ZONE_META[selectedZoneId];
  const dem = latestGridState.demand?.[selectedZoneId] ?? 0;
  const sup = latestGridState.supplied?.[selectedZoneId] ?? 0;
  const sched = latestGridState.schedule_status?.[selectedZoneId];
  const spike = latestGridState.manual_loads?.[selectedZoneId] ?? localSim.spikes[selectedZoneId] ?? 0;

  setText("zi-tier", meta.tier.toUpperCase());
  setText("zi-title", meta.label);
  setText("zi-demand", dem.toFixed(1));
  setText("zi-supplied", sup.toFixed(1));
  setText("zi-reason", sched?.reason || "Operating under active grid dispatch policy.");
  setText("zi-spike-lbl", Math.round(spike));
  const slider = document.getElementById("zi-spike-slider");
  if (slider && document.activeElement !== slider) slider.value = spike;
}

window.onInspectorSpikeInput = function (val) {
  setText("zi-spike-lbl", val);
  if (!selectedZoneId) return;
  const dockSlider = document.getElementById(`load-${selectedZoneId}`);
  if (dockSlider) dockSlider.value = val;
  window.setManualLoad(selectedZoneId, val);
};

window.askCopilotAboutZone = function () {
  if (!selectedZoneId) return;
  const meta = ZONE_META[selectedZoneId];
  window.toggleCopilot(true);
  window.sendQuickPrompt(`Give a detailed dispatch and priority assessment for ${meta.label} right now.`);
};

// Isomorphic Controls (Update Local Engine Immediately + Sync to Backend if Online)
function renderPlayPauseIcon() {
  const svg = document.getElementById("ico-play-pause");
  if (!svg) return;
  svg.innerHTML = localSim.paused
    ? '<polygon points="6 4 20 12 6 20 6 4"></polygon>'
    : '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
}

window.toggleSimPause = async function () {
  localSim.paused = !localSim.paused;
  renderPlayPauseIcon();
  try {
    await fetch(`${API}/api/sim/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: localSim.paused }),
    });
  } catch (_) {}
};

window.setSimSpeed = async function (speed, btn) {
  localSim.speed = speed;
  document.querySelectorAll(".speed-pill").forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  try {
    await fetch(`${API}/api/sim/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speed }),
    });
  } catch (_) {}
};

window.togglePlant = async function (plantId, isActive) {
  localSim.plants[plantId] = isActive;
  if (!localSim.backendOnline) applyState(computeLocalState(false));
  try {
    const res = await fetch(`${API}/api/plant/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plant_id: plantId, active: isActive }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.state) applyState(data.state);
    }
  } catch (_) {}
};

window.setPlantCapacity = async function (plantId, rawMw) {
  const cap = Math.max(0, Math.min(1500, parseFloat(rawMw) || 0));
  localSim.plantCaps[plantId] = cap;
  const idx = plantId === "plant1" ? "1" : "2";
  setText(`cap-p${idx}-val`, Math.round(cap));
  setText(`cap-p${idx}-lbl`, Math.round(cap));
  setText(`info-${plantId}-cap`, Math.round(cap));
  const sl = document.getElementById(`cap-slider-${plantId}`);
  if (sl && document.activeElement !== sl) sl.value = cap;
  const num = document.getElementById(`ctrl-cap-${plantId}`);
  if (num && document.activeElement !== num) num.value = Math.round(cap);

  if (!localSim.backendOnline) applyState(computeLocalState(false));
  try {
    const res = await fetch(`${API}/api/plant/capacity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plant_id: plantId, capacity: cap }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.state) applyState(data.state);
    }
  } catch (_) {}
};

window.setManualLoad = async function (zoneId, amount) {
  const mw = parseFloat(amount) || 0;
  setText(`lbl-load-${zoneId}`, Math.round(mw));
  localSim.spikes[zoneId] = mw;
  if (!localSim.backendOnline) applyState(computeLocalState(false));
  try {
    const res = await fetch(`${API}/api/load/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zone: zoneId, mw }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.state) applyState(data.state);
    }
  } catch (_) {}
};

window.resetManualLoads = async function () {
  ZONES.forEach((z) => {
    localSim.spikes[z] = 0;
    const s = document.getElementById(`load-${z}`);
    if (s) s.value = 0;
    setText(`lbl-load-${z}`, "0");
  });
  setText("zi-spike-lbl", "0");
  const ziS = document.getElementById("zi-spike-slider");
  if (ziS) ziS.value = 0;
  if (!localSim.backendOnline) applyState(computeLocalState(false));
  try {
    const res = await fetch(`${API}/api/load/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zone: "reset", mw: 0 }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.state) applyState(data.state);
    }
  } catch (_) {}
};

const elSlider = document.getElementById("time-slider");
if (elSlider) {
  elSlider.addEventListener("input", (e) => {
    const hr = parseFloat(e.target.value);
    localSim.hour = hr;
    currentHour = hr;
    if (!localSim.backendOnline) {
      applyState(computeLocalState(false));
    } else {
      const clk = formatClock(hr);
      setText("clock-display", clk);
      setText("top-sim-clock", clk);
    }
  });
  elSlider.addEventListener("change", async (e) => {
    const hr = parseFloat(e.target.value);
    localSim.hour = hr;
    try {
      const res = await fetch(`${API}/set_time`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hour: hr }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.state) applyState(data.state);
      }
    } catch (_) {}
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. SYNTAXED GRID AI DRAWER & PROVIDER MODAL (GEMINI 3.8 / 4 <-> OLLAMA)
// ═══════════════════════════════════════════════════════════════════════════

let modalSelectedProvider = "gemini";

window.toggleCopilot = function (forceState) {
  const drawer = document.getElementById("copilot-drawer");
  if (!drawer) return;
  const open = typeof forceState === "boolean" ? forceState : !drawer.classList.contains("open");
  drawer.classList.toggle("open", open);
};

function renderMarkdownLite(md) {
  const escaped = String(md || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="mono">$1</code>');

  const lines = escaped.split(/\r?\n/);
  let html = "", inList = false;
  lines.forEach((raw) => {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${line.replace(/^[-*•]\s+/, "")}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line) html += `<p style="margin-bottom:6px">${line}</p>`;
    }
  });
  if (inList) html += "</ul>";
  return html || escaped;
}

function appendChatMessage(role, contentHtml, noticeText = "") {
  const box = document.getElementById("copilot-messages");
  if (!box) return null;
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  const noticeBlock = noticeText ? `<div class="chat-notice">${noticeText}</div>` : "";
  div.innerHTML = `${noticeBlock}${contentHtml}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function buildStandaloneAdvisory(state) {
  const clk = formatClock(state.simulated_hour ?? 8.5);
  const deficit = Math.max(0, (state.total_demand ?? 0) - (state.total_supplied ?? 0));
  const items = [
    `- **Grid Telemetry (${clk})**: Serving **${(state.total_supplied ?? 0).toFixed(1)} MW** of **${(state.total_demand ?? 0).toFixed(1)} MW** demand (**${(state.renewable_share_pct ?? 0).toFixed(1)}%** clean Solar + Wind, BESS at **${(state.battery_energy ?? 220).toFixed(0)} / 400 MWh**).`,
    deficit > 1
      ? `- **Priority Shedding Active (${deficit.toFixed(1)} MW deficit)**: **Medical Center** remains 100% protected; deferrable **EV Supercharger Hub** and lower-tier loads are curtailed first.`
      : `- **Reserve & Thermal Health**: Transformer operating at **${(state.transformer_temp_c ?? 29).toFixed(1)}°C** with full priority fulfillment across all 6 districts.`,
    `- **Next Window Recommendation**: Maintain BESS target >=70% SoC ahead of the **18:00–21:00** residential & EV evening surge.`,
  ];
  return items.join("\n");
}

window.sendQuickPrompt = function (promptText) {
  runCopilotQuery(promptText);
};

window.submitCopilotQuery = function (e) {
  e.preventDefault();
  const input = document.getElementById("copilot-input");
  if (!input || !input.value.trim()) return;
  const q = input.value.trim();
  input.value = "";
  runCopilotQuery(q);
};

async function runCopilotQuery(query) {
  window.toggleCopilot(true);
  appendChatMessage("user", query.replace(/</g, "&lt;"));
  const btn = document.getElementById("copilot-send-btn");
  if (btn) btn.disabled = true;
  const pending = appendChatMessage("ai", '<span class="mono" style="color:var(--text-secondary)">Analyzing live grid telemetry...</span>');

  try {
    const res = await fetch(`${API}/agent/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (pending) pending.remove();
    appendChatMessage("ai", renderMarkdownLite(data.decision || data.message), data.notice || "");
  } catch (_) {
    if (pending) pending.remove();
    const st = latestGridState || computeLocalState(false);
    appendChatMessage(
      "ai",
      renderMarkdownLite(buildStandaloneAdvisory(st)),
      "Running in Standalone Twin mode. Start FastAPI (`uvicorn main:app --port 8000`) with GEMINI_API_KEY for live Gemini 3.8 Flash / Ollama inference."
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

window.selectModalProvider = function (prov) {
  modalSelectedProvider = prov;
  document.getElementById("opt-gemini")?.classList.toggle("active", prov === "gemini");
  document.getElementById("opt-ollama")?.classList.toggle("active", prov === "ollama");
  const fg = document.getElementById("fields-gemini");
  const fo = document.getElementById("fields-ollama");
  if (fg) fg.style.display = prov === "gemini" ? "block" : "none";
  if (fo) fo.style.display = prov === "ollama" ? "block" : "none";
};

window.openAiConfigModal = async function () {
  await syncAgentConfigUI();
  document.getElementById("ai-config-modal")?.classList.add("open");
};
window.closeAiConfigModal = function () {
  document.getElementById("ai-config-modal")?.classList.remove("open");
};

window.saveAiConfig = async function () {
  const payload = {
    provider: modalSelectedProvider,
    gemini_model: document.getElementById("cfg-gemini-model")?.value.trim() || "gemini-3.8-flash",
    gemini_endpoint: document.getElementById("cfg-gemini-endpoint")?.value.trim(),
    ollama_endpoint: document.getElementById("cfg-ollama-endpoint")?.value.trim(),
    ollama_model: document.getElementById("cfg-ollama-model")?.value.trim() || "gemma3:4b",
  };
  const keyVal = document.getElementById("cfg-gemini-key")?.value.trim();
  if (keyVal) payload.gemini_api_key = keyVal;

  applyAgentConfigBadge({
    provider: payload.provider,
    active_model: payload.provider === "gemini" ? payload.gemini_model : payload.ollama_model,
    active_endpoint: payload.provider === "gemini" ? payload.gemini_endpoint : payload.ollama_endpoint,
  });

  try {
    const res = await fetch(`${API}/agent/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      applyAgentConfigBadge(data.config);
      if (document.getElementById("cfg-gemini-key")) document.getElementById("cfg-gemini-key").value = "";
    }
  } catch (_) {}
  window.closeAiConfigModal();
};

function applyAgentConfigBadge(cfg) {
  if (!cfg || !cfg.provider) return;
  const pUp = cfg.provider.toUpperCase();
  const summary = `${pUp} · ${cfg.active_model || "gemini-3.8-flash"}`;
  setText("top-ai-provider", pUp);
  setText("ctrl-ai-badge", pUp);
  setText("copilot-sub-model", summary);
  setText("ctrl-ai-summary", `${summary} (${cfg.active_endpoint || ""})`);
  window.selectModalProvider(cfg.provider);

  if (cfg.gemini) {
    const gm = document.getElementById("cfg-gemini-model");
    const ge = document.getElementById("cfg-gemini-endpoint");
    if (gm && cfg.gemini.model) gm.value = cfg.gemini.model;
    if (ge && cfg.gemini.endpoint) ge.value = cfg.gemini.endpoint;
    setText("cfg-key-status", cfg.gemini.api_key_configured ? `configured: ${cfg.gemini.api_key_preview}` : "not set yet in .env");
  }
  if (cfg.ollama) {
    const oe = document.getElementById("cfg-ollama-endpoint");
    const om = document.getElementById("cfg-ollama-model");
    if (oe && cfg.ollama.endpoint) oe.value = cfg.ollama.endpoint;
    if (om && cfg.ollama.model) om.value = cfg.ollama.model;
  }
}

async function syncAgentConfigUI() {
  try {
    const res = await fetch(`${API}/agent/config`);
    if (res.ok) {
      const data = await res.json();
      applyAgentConfigBadge(data.config);
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. PAGE SWITCHING & BLACK-GREEN 2D CHART.JS ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════

const charts = {};
// ??? THEME (DARK / LIGHT) ???
const isLight = () => document.documentElement.getAttribute("data-theme") === "light";
const INK = () => (isLight() ? "#1f2937" : "#ffffff");
const GRID = () => (isLight() ? "rgba(15, 23, 42, 0.08)" : "rgba(255, 255, 255, 0.06)");
const TICK = () => (isLight() ? "#475569" : "#8e9e95");

function applyChartTheme() {
  if (!window.Chart) return;
  Chart.defaults.color = TICK();
  Chart.defaults.borderColor = GRID();
}

window.toggleTheme = function () {
  const next = isLight() ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("iegms-theme", next); } catch (_) {}
  applyChartTheme();
  Object.keys(charts).forEach((k) => { try { charts[k].destroy(); } catch (_) {} delete charts[k]; });
  const active = document.querySelector(".page.active")?.id?.replace("page-", "");
  if (active && active !== "simulation") {
    if (active === "dashboard") initDashboardCharts();
    if (active === "monitoring") initMonitoringCharts();
    if (active === "forecast") initForecastCharts();
    if (active === "battery") initBatteryCharts();
    if (active === "control") initControlCharts();
    if (latestGridState) refresh2DViews(latestGridState);
  }
};

const history24 = {
  hours: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`),
  demand: Array.from({ length: 24 }, (_, h) => ZONES.reduce((acc, z) => acc + interpCurve(h, LOCAL_PROFILES[z]), 0)),
  renewable: Array.from({ length: 24 }, (_, h) => interpCurve(h, LOCAL_RENEWABLE)),
  soc: Array.from({ length: 24 }, (_, h) => Math.round(45 + 25 * Math.sin(((h - 8) / 24) * Math.PI * 2))),
  byEntity: Object.fromEntries(ZONES.map((z) => [z, Array.from({ length: 24 }, (_, h) => +interpCurve(h, LOCAL_PROFILES[z]).toFixed(1))])),
};

if (window.Chart) {
  Chart.defaults.color = TICK();
  Chart.defaults.borderColor = GRID();
  Chart.defaults.font.family = "'JetBrains Mono', monospace";
  Chart.defaults.font.size = 10.5;
}

window.showPage = function (name, btn) {
  document.body.classList.toggle("mode-3d", name === "simulation");
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
  document.getElementById(`page-${name}`)?.classList.add("active");
  if (btn) btn.classList.add("active");

  setTimeout(() => {
    if (name === "simulation" && threeCtx) threeCtx.onResize();
    if (name === "dashboard") initDashboardCharts();
    if (name === "monitoring") initMonitoringCharts();
    if (name === "forecast") initForecastCharts();
    if (name === "battery") initBatteryCharts();
    if (name === "control") initControlCharts();
    if (latestGridState) refresh2DViews(latestGridState);
  }, 30);
};

function initDashboardCharts() {
  const c1 = document.getElementById("energyChart");
  if (c1 && !charts.energy) {
    charts.energy = new Chart(c1, {
      type: "line",
      data: {
        labels: history24.hours,
        datasets: [
          { label: "Total Demand (MW)", data: [...history24.demand], borderColor: INK(), backgroundColor: isLight() ? "rgba(15,23,42,0.05)" : "rgba(255,255,255,0.06)", fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 },
          { label: "Clean Renewable (MW)", data: [...history24.renewable], borderColor: "#00e676", backgroundColor: "rgba(0,230,118,0.14)", fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2.2 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
    });
  } else if (charts.energy) charts.energy.resize();

  const c2 = document.getElementById("mixChart");
  if (c2 && !charts.mix) {
    charts.mix = new Chart(c2, {
      type: "doughnut",
      data: {
        labels: ["Solar + Wind", "BESS Discharge", "Thermal CCGT"],
        datasets: [{ data: [180, 0, 320], backgroundColor: ["#00e676", INK(), "#f59e0b"], borderWidth: 0 }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: "68%", plugins: { legend: { display: false } } },
    });
  } else if (charts.mix) charts.mix.resize();

  const c3 = document.getElementById("todayChart");
  if (c3 && !charts.today) {
    charts.today = new Chart(c3, {
      type: "bar",
      data: {
        labels: ["Medical", "Industry", "Campus", "Comm.", "Resid.", "EV Hub"],
        datasets: [
          { label: "Demand", data: [], backgroundColor: isLight() ? "rgba(15,23,42,0.22)" : "rgba(255,255,255,0.22)", borderRadius: 4 },
          { label: "Supplied", data: [], backgroundColor: "#00e676", borderRadius: 4 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  } else if (charts.today) charts.today.resize();

  const c4 = document.getElementById("savingsChart");
  if (c4 && !charts.savings) {
    charts.savings = new Chart(c4, {
      type: "bar",
      data: {
        labels: ["Solar+Wind", "Thermal 1", "Thermal 2", "BESS Flow"],
        datasets: [{ label: "MW", data: [], backgroundColor: ["#00e676", "#f59e0b", "#d97706", "#5efc82"], borderRadius: 5 }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
  } else if (charts.savings) charts.savings.resize();
}

function initMonitoringCharts() {
  const cs = document.getElementById("sensorChart");
  if (cs && !charts.sensor) {
    charts.sensor = new Chart(cs, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "Medical", data: [], borderColor: INK(), tension: 0.35, pointRadius: 0, borderWidth: 1.8 },
          { label: "Industry", data: [], borderColor: "#f59e0b", tension: 0.35, pointRadius: 0, borderWidth: 1.8 },
          { label: "Commercial", data: [], borderColor: "#00e676", tension: 0.35, pointRadius: 0, borderWidth: 2 },
          { label: "Residential", data: [], borderColor: "#5efc82", tension: 0.35, pointRadius: 0, borderWidth: 1.8 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  } else if (charts.sensor) charts.sensor.resize();
}

function initForecastCharts() {
  const cf = document.getElementById("forecastChart");
  if (cf && !charts.forecast) {
    charts.forecast = new Chart(cf, {
      type: "line",
      data: {
        labels: history24.hours,
        datasets: [
          { label: "Predicted Total Demand (MW)", data: [...history24.demand], borderColor: INK(), backgroundColor: isLight() ? "rgba(15,23,42,0.05)" : "rgba(255,255,255,0.06)", fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 },
          { label: "Predicted Solar + Wind (MW)", data: [...history24.renewable], borderColor: "#00e676", borderDash: [5, 4], tension: 0.4, pointRadius: 0, borderWidth: 2.2 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  } else if (charts.forecast) charts.forecast.resize();

  const cw = document.getElementById("weeklyChart");
  if (cw && !charts.weekly) {
    charts.weekly = new Chart(cw, {
      type: "line",
      data: {
        labels: history24.hours,
        datasets: [
          { label: "Medical", data: history24.byEntity.hospital, borderColor: INK(), pointRadius: 0, tension: 0.4, borderWidth: 1.8 },
          { label: "Industry", data: history24.byEntity.industry, borderColor: "#f59e0b", pointRadius: 0, tension: 0.4, borderWidth: 1.8 },
          { label: "Commercial", data: history24.byEntity.commercial, borderColor: "#00e676", pointRadius: 0, tension: 0.4, borderWidth: 2 },
          { label: "Residential", data: history24.byEntity.residential, borderColor: "#5efc82", pointRadius: 0, tension: 0.4, borderWidth: 1.8 },
          { label: "EV Hub", data: history24.byEntity.ev_hub, borderColor: "#ff3b5c", pointRadius: 0, tension: 0.4, borderWidth: 1.8 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  } else if (charts.weekly) charts.weekly.resize();
}

function initBatteryCharts() {
  const cs = document.getElementById("socChart");
  if (cs && !charts.soc) {
    charts.soc = new Chart(cs, {
      type: "line",
      data: {
        labels: history24.hours,
        datasets: [{ label: "BESS State of Charge (%)", data: [...history24.soc], borderColor: "#00e676", backgroundColor: "rgba(0,230,118,0.14)", fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2.2 }],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } },
    });
  } else if (charts.soc) charts.soc.resize();
}

function initControlCharts() {
  const cp = document.getElementById("peakChart");
  if (cp && !charts.peak) {
    charts.peak = new Chart(cp, {
      type: "line",
      data: {
        labels: history24.hours,
        datasets: [
          { label: "Demand Profile (MW)", data: [...history24.demand], borderColor: "#00e676", tension: 0.4, pointRadius: 0, borderWidth: 2.2 },
          { label: "Thermal Baseline Ceiling (600 MW)", data: Array(24).fill(600), borderColor: "rgba(255,59,92,0.7)", borderDash: [6, 4], pointRadius: 0, borderWidth: 1.6 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false },
    });
  } else if (charts.peak) charts.peak.resize();
}

function drawTopologyMap(state) {
  const canvas = document.getElementById("nodeMap");
  if (!canvas || !canvas.offsetWidth) return;
  const ctx = canvas.getContext("2d");
  const w = (canvas.width = canvas.offsetWidth);
  const h = (canvas.height = 220);
  ctx.fillStyle = isLight() ? "#eef2f0" : "#060908";
  ctx.fillRect(0, 0, w, h);

  const hub = { x: w * 0.48, y: h * 0.5, label: "BESS HUB", val: `${Math.round(state.battery_soc_pct ?? 55)}% SoC`, col: "#00e676" };
  const nodes = [
    { x: w * 0.14, y: h * 0.24, label: "Medical", val: `${(state.supplied?.hospital ?? 0).toFixed(0)} MW`, col: INK() },
    { x: w * 0.14, y: h * 0.76, label: "Industry", val: `${(state.supplied?.industry ?? 0).toFixed(0)} MW`, col: "#f59e0b" },
    { x: w * 0.48, y: h * 0.15, label: "Renewables", val: `${(state.generation?.solar_wind ?? 0).toFixed(0)} MW`, col: "#00e676" },
    { x: w * 0.82, y: h * 0.22, label: "Commercial", val: `${(state.supplied?.commercial ?? 0).toFixed(0)} MW`, col: "#5efc82" },
    { x: w * 0.85, y: h * 0.54, label: "Residential", val: `${(state.supplied?.residential ?? 0).toFixed(0)} MW`, col: "#00e676" },
    { x: w * 0.78, y: h * 0.83, label: "EV + Campus", val: `${((state.supplied?.ev_hub ?? 0) + (state.supplied?.school ?? 0)).toFixed(0)} MW`, col: "#a7f3d0" },
  ];

  ctx.strokeStyle = "rgba(0, 230, 118, 0.28)";
  ctx.lineWidth = 1.5;
  nodes.forEach((n) => { ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.lineTo(n.x, n.y); ctx.stroke(); });
  [hub, ...nodes].forEach((n) => {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n === hub ? 13 : 9, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 230, 118, 0.14)";
    ctx.fill();
    ctx.strokeStyle = n.col;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = isLight() ? "#0f172a" : "#f4f7f5";
    ctx.font = "600 10px 'Plus Jakarta Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(n.label, n.x, n.y + 22);
    ctx.fillStyle = n.col;
    ctx.font = "700 9.5px 'JetBrains Mono', monospace";
    ctx.fillText(n.val, n.x, n.y + 34);
  });
}

function refresh2DViews(state) {
  const totalDem = state.total_demand ?? 0;
  const totalSup = state.total_supplied ?? 0;
  const renOut = state.generation?.solar_wind ?? 0;
  const socPct = state.battery_soc_pct ?? 55;
  const battOut = Math.max(0, -(state.battery_delta ?? 0));
  const thermOut = (state.generation?.plant1 ?? 0) + (state.generation?.plant2 ?? 0);
  const hrIdx = Math.floor(state.simulated_hour ?? 8) % 24;

  history24.demand[hrIdx] = totalDem;
  history24.renewable[hrIdx] = renOut;
  history24.soc[hrIdx] = socPct;

  setText("kpi-load", totalDem.toFixed(0));
  setText("kpi-solar", renOut.toFixed(0));
  setText("kpi-ren-share", `${(state.renewable_share_pct ?? 0).toFixed(0)}%`);
  setText("kpi-soc", Math.round(socPct));
  setText("kpi-batt-mode", `${(state.battery_energy ?? 0).toFixed(0)} / 400 MWh · ${(state.battery_delta ?? 0) >= 0 ? "Charging/Idle" : "Discharging"}`);
  setText("kpi-shaved", (state.freed_mw ?? 0).toFixed(0));
  setText("kpi-co2", (state.co2_avoided_tons ?? 0).toFixed(1));
  setText("fc-peak-mw", `${Math.round(Math.max(...history24.demand))} MW`);
  setText("fc-ren-peak", `${Math.round(Math.max(...history24.renewable))} MW`);

  const mixTot = Math.max(1, renOut + battOut + thermOut);
  setText("mix-solar", `${renOut.toFixed(0)} MW`);
  setText("mix-batt", `${battOut.toFixed(0)} MW`);
  setText("mix-grid", `${thermOut.toFixed(0)} MW`);
  setBar("bar-solar", (renOut / mixTot) * 100);
  setBar("bar-batt", (battOut / mixTot) * 100);
  setBar("bar-grid", (thermOut / mixTot) * 100);
  setText("fn-solar-v", `${renOut.toFixed(0)} MW`);
  setText("fn-bms-v", `${Math.round(socPct)}%`);
  setText("fn-grid-v", `${totalSup.toFixed(0)} MW`);

  const alertEl = document.getElementById("alert-list");
  if (alertEl && Array.isArray(state.actions)) {
    const clk = formatClock(state.simulated_hour ?? 8.5);
    alertEl.innerHTML = state.actions.slice(0, 4).map((msg) => {
      const cls = /CRITICAL/.test(msg) ? "error" : /SHED|STRESS|derated/.test(msg) ? "warn" : "success";
      return `<div class="alert-item ${cls}"><div><div class="alert-time">${clk} SIM</div><div class="alert-msg">${msg}</div></div></div>`;
    }).join("");
    setText("alert-count", `${state.actions.length} Events`);
  }

  const fill = document.getElementById("battery-fill");
  if (fill) {
    fill.style.height = `${socPct}%`;
    fill.className = `battery-fill ${socPct > 50 ? "soc-high" : socPct > 25 ? "soc-mid" : "soc-low"}`;
  }
  setText("soc-pct", Math.round(socPct));
  setText("bess-mwh-lbl", (state.battery_energy ?? 0).toFixed(1));
  setText("soc-status", (state.battery_delta ?? 0) > 0.5 ? "CHARGING" : (state.battery_delta ?? 0) < -0.5 ? "DISCHARGING" : "STANDBY");
  setText("batt-temp", `${(state.transformer_temp_c ?? 29).toFixed(1)}°C`);
  setBar("bar-temp", ((state.transformer_temp_c ?? 29) / 55) * 100);

  const schedTbody = document.getElementById("schedule-table");
  if (schedTbody && state.schedule_status) {
    schedTbody.innerHTML = ZONES.map((z) => {
      const sc = state.schedule_status[z] || {};
      return `<tr>
        <td><strong>${ZONE_META[z].label}</strong></td>
        <td class="mono">${sc.tier || ZONE_META[z].tier}</td>
        <td><span class="panel-badge ${sc.active ? "badge-green" : "badge-amber"}">${sc.active ? "ACTIVE" : "STANDBY"}</span></td>
        <td class="mono">${sc.cap_pct ?? 100}%</td>
        <td class="mono">${(state.supplied?.[z] ?? 0).toFixed(1)} / ${(state.demand?.[z] ?? 0).toFixed(1)} MW</td>
        <td style="color:var(--text-secondary)">${sc.reason || ""}</td>
      </tr>`;
    }).join("");
  }

  setText("mqtt-conn-badge", state.mqtt_connected ? "MQTT BROKER LIVE" : localSim.backendOnline ? "BACKEND TWIN STREAM" : "STANDALONE TWIN STREAM");
  const devTable = document.getElementById("device-table");
  if (devTable) {
    const transport = state.mqtt_connected ? "MQTT v5" : "Twin Bus";
    devTable.innerHTML = ZONES.map((z, idx) => `<tr>
      <td class="mono">NODE-0${idx + 1}</td>
      <td>${ZONE_META[z].label}</td>
      <td class="mono" style="color:var(--green)">${transport}</td>
      <td>${ZONE_META[z].tier}</td>
      <td class="mono">${(state.demand?.[z] ?? 0).toFixed(1)} MW</td>
      <td class="mono" style="color:var(--green)">Live (2s)</td>
    </tr>`).join("");
  }

  const hm = document.getElementById("heatmap");
  if (hm) {
    const maxV = Math.max(1, ...history24.demand);
    hm.innerHTML = history24.demand.map((v, h) => {
      const r = v / maxV;
      return `<div class="hm-cell" title="${String(h).padStart(2, "0")}:00 — ${Math.round(v)} MW" style="background:rgba(0,230,118,${(0.12 + r * 0.85).toFixed(2)})"></div>`;
    }).join("");
  }

  const predSum = Object.values(state.predicted_loads || {}).reduce((a, b) => a + b, 0);
  if (predSum > 0) setText("fc-next-hr", `${Math.round(predSum)} MW`);

  if (charts.energy) {
    charts.energy.data.datasets[0].data = [...history24.demand];
    charts.energy.data.datasets[1].data = [...history24.renewable];
    charts.energy.update("none");
  }
  if (charts.mix) {
    charts.mix.data.datasets[0].data = [Math.round(renOut), Math.round(battOut), Math.round(thermOut)];
    charts.mix.update("none");
  }
  if (charts.today) {
    charts.today.data.datasets[0].data = ZONES.map((z) => state.demand?.[z] ?? 0);
    charts.today.data.datasets[1].data = ZONES.map((z) => state.supplied?.[z] ?? 0);
    charts.today.update("none");
  }
  if (charts.savings) {
    charts.savings.data.datasets[0].data = [renOut, state.generation?.plant1 ?? 0, state.generation?.plant2 ?? 0, Math.abs(state.battery_delta ?? 0)];
    charts.savings.update("none");
  }
  if (charts.sensor && latestReadings.length) {
    const tail = latestReadings.slice(-25);
    charts.sensor.data.labels = tail.map((r) => formatClock(r.simulated_hour ?? 8.5));
    charts.sensor.data.datasets[0].data = tail.map((r) => r.loads?.hospital ?? 0);
    charts.sensor.data.datasets[1].data = tail.map((r) => r.loads?.industry ?? 0);
    charts.sensor.data.datasets[2].data = tail.map((r) => r.loads?.commercial ?? 0);
    charts.sensor.data.datasets[3].data = tail.map((r) => r.loads?.residential ?? 0);
    charts.sensor.update("none");
  }
  if (charts.soc) { charts.soc.data.datasets[0].data = [...history24.soc]; charts.soc.update("none"); }
  if (charts.peak) {
    const c1 = state.plants_state?.plant1?.active !== false ? (state.plants_state?.plant1?.capacity ?? localSim.plantCaps.plant1) : 0;
    const c2 = state.plants_state?.plant2?.active !== false ? (state.plants_state?.plant2?.capacity ?? localSim.plantCaps.plant2) : 0;
    charts.peak.data.datasets[0].data = [...history24.demand];
    charts.peak.data.datasets[1].data = Array(24).fill(c1 + c2);
    charts.peak.data.datasets[1].label = `Active Thermal Ceiling (${Math.round(c1 + c2)} MW)`;
    charts.peak.update("none");
  }
  drawTopologyMap(state);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. MASTER TELEMETRY LOOP (SEAMLESS FASTAPI <-> STANDALONE TWIN)
// ═══════════════════════════════════════════════════════════════════════════

function applyState(state) {
  if (!state || typeof state !== "object") return;
  latestGridState = state;
  currentHour = state.simulated_hour ?? 8.5;

  const clk = formatClock(currentHour);
  setText("clock-display", clk);
  setText("top-sim-clock", clk);
  if (elSlider && document.activeElement !== elSlider) elSlider.value = currentHour;

  const code = (state.status_code || "NORMAL").toUpperCase();
  setText("top-status-text", code);
  setText("grid-status", code);
  const pill = document.getElementById("top-status-pill");
  if (pill) pill.className = "status-pill " + (code === "CRITICAL" ? "critical" : code === "WARNING" ? "warning" : code === "PEAK" ? "peak" : "");

  const batt = state.battery_energy ?? 220;
  const socPct = state.battery_soc_pct ?? (batt / 400) * 100;
  setText("demand-val", (state.total_demand ?? 0).toFixed(1));
  setText("supply-val", (state.total_supplied ?? 0).toFixed(1));
  setText("max-supply-val", Math.round(state.max_capacity_mw ?? 880));
  setText("ren-val", (state.generation?.solar_wind ?? 0).toFixed(1));
  setText("ren-pct-val", Math.round(state.renewable_share_pct ?? 0));
  setText("batt-val", batt.toFixed(1));
  setText("batt-soc-ribbon", Math.round(socPct));
  setText("dock-batt-mw", batt.toFixed(0));
  setText("temp-ribbon-val", (state.transformer_temp_c ?? 29).toFixed(1));
  setBar("batt-meter", socPct, (state.battery_delta ?? 0) < 0 ? "#f59e0b" : "#00e676");

  ZONES.forEach((z) => {
    const meta = ZONE_META[z];
    const dem = state.demand?.[z] ?? 0;
    const sup = state.supplied?.[z] ?? 0;
    const pct = dem > 0.1 ? Math.min(100, (sup / dem) * 100) : 100;
    setText(`pan-${meta.shortKey}-dem`, dem.toFixed(0));
    setText(`pan-${meta.shortKey}-sup`, sup.toFixed(0));
    setBar(`pan-${meta.shortKey}-bar`, dem <= 0.1 ? 0 : pct, pct >= 98 ? "#00e676" : pct >= 45 ? "#f59e0b" : "#ff3b5c");
    setText(`pin-${z}-mw`, `${sup.toFixed(0)} MW`);
    setText(`info-${z}-demand`, dem.toFixed(1));
    setText(`info-${z}-supplied`, sup.toFixed(1));
    setText(`info-${z}-usage`, Math.round(pct));
  });

  setText("pin-battery-mw", `${batt.toFixed(0)} MWh`);
  setText("info-battery-energy", batt.toFixed(1));
  setText("info-battery-delta", `${(state.battery_delta ?? 0) >= 0 ? "+" : ""}${(state.battery_delta ?? 0).toFixed(1)}`);
  setText("info-battery-state", (state.battery_delta ?? 0) > 0.5 ? "Charging" : (state.battery_delta ?? 0) < -0.5 ? "Discharging" : "Balanced");

  const gSw = state.generation?.solar_wind ?? 0;
  const gP1 = state.generation?.plant1 ?? 0;
  const gP2 = state.generation?.plant2 ?? 0;
  const cP1 = state.plants_state?.plant1?.capacity ?? localSim.plantCaps.plant1;
  const cP2 = state.plants_state?.plant2?.capacity ?? localSim.plantCaps.plant2;
  localSim.plantCaps.plant1 = cP1;
  localSim.plantCaps.plant2 = cP2;

  setText("pin-solar_wind-mw", `${gSw.toFixed(0)} MW`);
  setText("info-solar_wind-output", gSw.toFixed(1));
  setText("info-plant1-output", gP1.toFixed(0));
  setText("info-plant1-output-dup", gP1.toFixed(1));
  setText("info-plant1-cap", Math.round(cP1));
  setText("info-plant2-output", gP2.toFixed(0));
  setText("info-plant2-output-dup", gP2.toFixed(1));
  setText("info-plant2-cap", Math.round(cP2));
  setText("gen-sw-lbl", gSw.toFixed(0));
  setText("gen-p1-lbl", gP1.toFixed(0));
  setText("gen-p2-lbl", gP2.toFixed(0));
  setText("cap-p1-lbl", Math.round(cP1));
  setText("cap-p2-lbl", Math.round(cP2));
  setText("cap-p1-val", Math.round(cP1));
  setText("cap-p2-val", Math.round(cP2));

  const sl1 = document.getElementById("cap-slider-plant1");
  if (sl1 && document.activeElement !== sl1) sl1.value = cP1;
  const sl2 = document.getElementById("cap-slider-plant2");
  if (sl2 && document.activeElement !== sl2) sl2.value = cP2;
  const nm1 = document.getElementById("ctrl-cap-plant1");
  if (nm1 && document.activeElement !== nm1) nm1.value = Math.round(cP1);
  const nm2 = document.getElementById("ctrl-cap-plant2");
  if (nm2 && document.activeElement !== nm2) nm2.value = Math.round(cP2);

  const logEl = document.getElementById("action-log");
  if (logEl && Array.isArray(state.actions) && state.actions.length) {
    logEl.innerHTML = state.actions.map((a) => `<li>${a}</li>`).join("");
  }

  sync3DWithState(state);
  refreshInspectorCard();
  refresh2DViews(state);
}

async function tickEngine() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 900);
    const [optRes, dataRes] = await Promise.all([
      fetch(`${API}/optimize`, { signal: ctrl.signal }),
      fetch(`${API}/data`, { signal: ctrl.signal }),
    ]);
    clearTimeout(timer);

    if (optRes.ok) {
      const opt = await optRes.json();
      if (dataRes.ok) {
        const d = await dataRes.json();
        latestReadings = Array.isArray(d.readings) ? d.readings : [];
      }
      if (opt && Object.keys(opt).length > 0) {
        localSim.backendOnline = true;
        localSim.hour = opt.simulated_hour ?? localSim.hour;
        setText("engine-mode-pill", "BACKEND LIVE");
        applyState(opt);
        return;
      }
    }
  } catch (_) {}

  // Standalone Live Digital Twin Fallback
  localSim.backendOnline = false;
  setText("engine-mode-pill", "STANDALONE TWIN");
  if (!localSim.paused) {
    localSim.hour = (localSim.hour + (2.0 / 60.0) * localSim.speed) % 24.0;
  }
  const st = computeLocalState(!localSim.paused);
  latestReadings.push({ simulated_hour: st.simulated_hour, loads: st.demand });
  if (latestReadings.length > 35) latestReadings.shift();
  applyState(st);
}

// Render initial frame immediately on script load
applyState(computeLocalState(false));
syncAgentConfigUI();
setInterval(tickEngine, 1800);
tickEngine();
