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

const localSim = {
  backendOnline: false,
  hour: 8.5,
  paused: false,
  speed: 1,
  battery: 220,
  plants: { solar_wind: true, plant1: true, plant2: true },
  plantCaps: { solar_wind: 280, plant1: 300, plant2: 300 },
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

  const supplied = { ...demand };
  const isPeak = (h >= 8 && h < 9) || (h >= 18 && h < 21);
  let battDelta = 0;
  if (isPeak && localSim.battery > 80) {
    battDelta = -Math.min(70, localSim.battery * 0.25);
    actions.push(`[PEAK] Peak shaving active: BESS discharging ${Math.abs(battDelta).toFixed(1)} MW.`);
  }

  const renAvail = localSim.plants.solar_wind ? +interpCurve(h, LOCAL_RENEWABLE).toFixed(1) : 0;
  const p1Cap = localSim.plants.plant1 ? localSim.plantCaps.plant1 : 0;
  const p2Cap = localSim.plants.plant2 ? localSim.plantCaps.plant2 : 0;
  const thermCap = p1Cap + p2Cap;
  const maxCap = +(renAvail + thermCap).toFixed(1);

  const totalRaw = Object.values(supplied).reduce((a, b) => a + b, 0);
  const netNeeded = Math.max(0, totalRaw + battDelta);
  let deficit = 0;

  if (netNeeded <= maxCap) {
    const excess = maxCap - netNeeded;
    if (battDelta === 0 && excess > 2 && localSim.battery < 400) {
      battDelta = Math.min(excess, 100, 400 - localSim.battery);
      actions.push(`[BESS] Surplus clean capacity: charging reserve +${battDelta.toFixed(1)} MW.`);
    } else if (actions.length === 0) {
      actions.push("[OK] All 6 smart-grid zones balanced within nominal tolerances.");
    }
  } else {
    deficit = netNeeded - maxCap;
    const fromBatt = Math.min(deficit, 120 + battDelta, Math.max(0, localSim.battery + battDelta));
    if (fromBatt > 0.5) {
      battDelta -= fromBatt;
      deficit -= fromBatt;
      actions.push(`[BESS] Reserve discharging ${fromBatt.toFixed(1)} MW to cover deficit.`);
    }
    for (let i = ZONES.length - 1; i >= 0; i--) {
      const z = ZONES[i];
      if (deficit <= 0.1) break;
      if (z === "hospital") {
        actions.unshift("[CRITICAL] Deficit exceeds sheddable load — Medical Center at risk!");
        break;
      }
      const shed = Math.min(supplied[z], deficit);
      if (shed > 0) {
        supplied[z] = +(supplied[z] - shed).toFixed(1);
        deficit -= shed;
        const pct = Math.round((shed / Math.max(1, demand[z])) * 100);
        actions.push(`[SHED] Shedding ${pct}% (-${shed.toFixed(1)} MW) from ${ZONE_META[z].label}.`);
      }
    }
  }

  if (advanceBatt) {
    localSim.battery = Math.max(0, Math.min(400, localSim.battery + battDelta * 0.08));
  }

  const totalSup = +Object.values(supplied).reduce((a, b) => a + b, 0).toFixed(1);
  const totalDem = +Object.values(demand).reduce((a, b) => a + b, 0).toFixed(1);
  const genNeed = Math.max(0, totalSup + battDelta);
  const renUsed = +Math.min(renAvail, genNeed).toFixed(1);
  const thermNeed = Math.max(0, genNeed - renUsed);
  const p1 = p1Cap > 0 && thermCap > 0 ? +Math.min(p1Cap, thermNeed * (p1Cap / thermCap)).toFixed(1) : 0;
  const p2 = p2Cap > 0 && thermCap > 0 ? +Math.min(p2Cap, thermNeed * (p2Cap / thermCap)).toFixed(1) : 0;

  const hasShed = actions.some((a) => a.startsWith("[SHED]"));
  const status = deficit > 0.5 || maxCap === 0 ? "CRITICAL" : hasShed ? "WARNING" : isPeak ? "PEAK" : "NORMAL";

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
    },
    manual_loads: { ...localSim.spikes },
    renewable_share_pct: +((renUsed / Math.max(1, totalSup)) * 100).toFixed(1),
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
  scene.background = new THREE.Color(0x070d0b);
  scene.fog = new THREE.FogExp2(0x070d0b, 0.0038);

  const camera = new THREE.PerspectiveCamera(40, sz.w / sz.h, 1, 950);
  camera.position.set(...CAMERA_PRESETS.overview.pos);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(sz.w, sz.h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  // Post-Processing Composer with subtle UnrealBloom
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(sz.w, sz.h), 0.36, 0.35, 0.78);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // Smooth Damped OrbitControls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.maxPolarAngle = Math.PI * 0.465;
  controls.minDistance = 24;
  controls.maxDistance = 220;
  controls.target.set(...CAMERA_PRESETS.overview.target);

  const camLerpGoal = { active: false, pos: new THREE.Vector3(), target: new THREE.Vector3() };
  controls.addEventListener("start", () => { camLerpGoal.active = false; });

  // ── High-DPI Procedural Architectural Facade Texture Generator ──
  function makeFacadeMaterial({ baseHex, mullionHex, litPalette, cols = 8, rows = 14, litRatio = 0.65, metalness = 0.55, roughness = 0.25 }) {
    const cDiff = document.createElement("canvas");
    const cEmis = document.createElement("canvas");
    cDiff.width = cEmis.width = 256;
    cDiff.height = cEmis.height = 512;
    const dCtx = cDiff.getContext("2d");
    const eCtx = cEmis.getContext("2d");

    dCtx.fillStyle = baseHex;
    dCtx.fillRect(0, 0, 256, 512);
    eCtx.fillStyle = "#000000";
    eCtx.fillRect(0, 0, 256, 512);

    const padX = 5, padY = 6;
    const cellW = 256 / cols;
    const cellH = 512 / rows;

    // Seeded pseudo-random for crisp deterministic floors
    let seed = cols * 97 + rows * 31;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

    for (let r = 0; r < rows; r++) {
      const floorLitBoost = rnd() > 0.25 ? 1 : 0.3;
      for (let c = 0; c < cols; c++) {
        const x = c * cellW + padX * 0.5;
        const y = r * cellH + padY * 0.5;
        const w = cellW - padX;
        const h = cellH - padY;

        dCtx.fillStyle = mullionHex;
        dCtx.fillRect(x - 1, y - 1, w + 2, h + 2);

        if (rnd() < litRatio * floorLitBoost) {
          const col = litPalette[Math.floor(rnd() * litPalette.length)];
          dCtx.fillStyle = col;
          dCtx.fillRect(x, y, w, h);
          eCtx.fillStyle = col;
          eCtx.fillRect(x, y, w, h);
        } else {
          dCtx.fillStyle = "#0c1318";
          dCtx.fillRect(x, y, w, h);
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
      emissiveIntensity: 0.45,
      metalness,
      roughness,
    });
  }

  const zoneMats = {
    hospital:    makeFacadeMaterial({ baseHex: "#dbe5e0", mullionHex: "#94a39c", litPalette: ["#a7f3d0", "#ecfdf5", "#6ee7b7"], cols: 8, rows: 12, litRatio: 0.85, metalness: 0.3, roughness: 0.35 }),
    commercial:  makeFacadeMaterial({ baseHex: "#0d1a16", mullionHex: "#1b2e27", litPalette: ["#00e676", "#bbf7d0", "#dcfce7"], cols: 10, rows: 22, litRatio: 0.72, metalness: 0.78, roughness: 0.16 }),
    residential: makeFacadeMaterial({ baseHex: "#1c2421", mullionHex: "#2a3530", litPalette: ["#fde68a", "#fef3c7", "#fcd34d"], cols: 6, rows: 12, litRatio: 0.68, metalness: 0.2, roughness: 0.6 }),
    industry:    makeFacadeMaterial({ baseHex: "#1e2623", mullionHex: "#2d3833", litPalette: ["#fde047", "#a7f3d0"], cols: 8, rows: 5, litRatio: 0.6, metalness: 0.45, roughness: 0.55 }),
    school:      makeFacadeMaterial({ baseHex: "#5c3422", mullionHex: "#3e2216", litPalette: ["#fef08a", "#fde68a"], cols: 10, rows: 6, litRatio: 0.75, metalness: 0.12, roughness: 0.7 }),
    ev_hub:      new THREE.MeshStandardMaterial({ color: 0x00e676, emissive: 0x00e676, emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.5 }),
    battery:     new THREE.MeshStandardMaterial({ color: 0x00e676, emissive: 0x00e676, emissiveIntensity: 0.85, roughness: 0.2, metalness: 0.5 }),
  };

  // Lighting
  const hemiLight = new THREE.HemisphereLight(0xa7f3d0, 0x0b120f, 0.55);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff5e4, 1.45);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -100;
  sunLight.shadow.camera.right = 100;
  sunLight.shadow.camera.top = 100;
  sunLight.shadow.camera.bottom = -100;
  sunLight.shadow.camera.near = 10;
  sunLight.shadow.camera.far = 290;
  sunLight.shadow.bias = -0.0005;
  scene.add(sunLight);

  const rimLight = new THREE.DirectionalLight(0x00e676, 0.26);
  rimLight.position.set(-75, 42, -65);
  scene.add(rimLight);

  // Starfield Dome
  const starPos = new Float32Array(500 * 3);
  for (let i = 0; i < 500; i++) {
    const r = 270 + Math.random() * 80;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.random() * Math.PI * 0.45;
    starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    starPos[i * 3 + 1] = r * Math.cos(ph) + 20;
    starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xd1fae5, size: 1.4, transparent: true, opacity: 0.0 });
  scene.add(new THREE.Points(starGeo, starMat));

  // Shared Materials
  const matGround = new THREE.MeshStandardMaterial({ color: 0x080c0a, roughness: 0.94, metalness: 0.04 });
  const matPark   = new THREE.MeshStandardMaterial({ color: 0x0d2618, roughness: 0.9 });
  const matRoad   = new THREE.MeshStandardMaterial({ color: 0x131916, roughness: 0.86 });
  const matCurb   = new THREE.MeshStandardMaterial({ color: 0x222c27, roughness: 0.8 });
  const matWater  = new THREE.MeshStandardMaterial({ color: 0x062824, roughness: 0.12, metalness: 0.82, transparent: true, opacity: 0.88 });
  const matSteel  = new THREE.MeshStandardMaterial({ color: 0x607068, roughness: 0.35, metalness: 0.78 });
  const matDark   = new THREE.MeshStandardMaterial({ color: 0x141b18, roughness: 0.45, metalness: 0.6 });
  const matGreenTrim = new THREE.MeshStandardMaterial({ color: 0x00e676, emissive: 0x00e676, emissiveIntensity: 0.95 });
  const matSolar  = new THREE.MeshStandardMaterial({ color: 0x0b2942, emissive: 0x061a2b, emissiveIntensity: 0.25, roughness: 0.18, metalness: 0.85 });
  const matCapRoof = new THREE.MeshStandardMaterial({ color: 0x0c1210, roughness: 0.5, metalness: 0.4 });

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

  function makeBuildingBox(w, h, d, wallMat) {
    const mats = [wallMat, wallMat, matCapRoof, matCapRoof, wallMat, wallMat];
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // Terrain, River & Road Grid
  const ground = new THREE.Mesh(new THREE.BoxGeometry(280, 3, 260), matGround);
  ground.position.y = -1.5;
  ground.receiveShadow = true;
  scene.add(ground);

  const river = new THREE.Mesh(new THREE.PlaneGeometry(11, 240), matWater);
  river.rotation.x = -Math.PI / 2;
  river.position.set(-43, 0.06, 0);
  scene.add(river);

  function addRoad(x, z, w, d) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(w + 2.2, 0.16, d + 2.2), matCurb);
    curb.position.set(x, 0.08, z);
    curb.receiveShadow = true;
    scene.add(curb);

    const r = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matRoad);
    r.rotation.x = -Math.PI / 2;
    r.position.set(x, 0.18, z);
    r.receiveShadow = true;
    scene.add(r);

    const dashMat = new THREE.MeshBasicMaterial({ color: 0x3b4d44 });
    const horiz = w > d;
    const len = horiz ? w : d;
    for (let p = -len / 2 + 4; p < len / 2 - 4; p += 7.5) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(horiz ? 3.2 : 0.25, horiz ? 0.25 : 3.2), dashMat);
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

  [-4.7, 4.7].forEach((zOff) => {
    const bridgeTrim = new THREE.Mesh(new THREE.BoxGeometry(15, 0.9, 0.35), matGreenTrim);
    bridgeTrim.position.set(-43, 0.65, zOff);
    scene.add(bridgeTrim);
  });

  // Streetlamps
  function addLamp(x, z) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 5.2, 8), matSteel);
    pole.position.y = 2.6;
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0x64748b });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), bulbMat);
    bulb.position.set(0.6, 5.1, 0);
    const haloMat = new THREE.MeshBasicMaterial({ color: 0xa7f3d0, transparent: true, opacity: 0, depthWrite: false });
    const halo = new THREE.Mesh(new THREE.CircleGeometry(3.2, 16), haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(0.6, 0.21, 0);
    g.add(pole, bulb, halo);
    g.position.set(x, 0, z);
    streetLamps.push({ bulbMat, haloMat });
    scene.add(g);
  }
  for (let lx = -34; lx <= 56; lx += 18) { addLamp(lx, 5.4); addLamp(lx, -5.4); }

  // ── 1. MEDICAL CENTER COMPLEX (North-West [-26, 0, -23]) ──
  const hospG = new THREE.Group();
  const hMain = makeBuildingBox(15, 23, 11, zoneMats.hospital);
  hMain.position.set(-26, 11.5, -23);
  const hWing = makeBuildingBox(11, 13, 10, zoneMats.hospital);
  hWing.position.set(-18, 6.5, -16);
  const hLobby = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.5, 4.5), matGreenTrim);
  hLobby.position.set(-26, 3.8, -15.5);
  const hPad = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.45, 24), matDark);
  hPad.position.set(-26, 23.25, -23);
  const crossMat = new THREE.MeshStandardMaterial({ color: 0xff3b5c, emissive: 0xff3b5c, emissiveIntensity: 0.9 });
  const c1 = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.35, 1.2), crossMat);
  c1.position.set(-26, 23.6, -23);
  const c2 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.35, 4.2), crossMat);
  c2.position.set(-26, 23.6, -23);
  const hBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff3b5c }));
  hBeacon.position.set(-32.5, 23.8, -27.5);
  beacons.push(hBeacon);
  hospG.add(hMain, hWing, hLobby, hPad, c1, c2, hBeacon);
  tagZone(hospG, "hospital");
  scene.add(hospG);
  addPin("label-hospital", -26, 28, -23);

  // ── 2. COMMERCIAL & TECH SKYSCRAPER CORE (Center-North [5, 0, -24]) ──
  const comG = new THREE.Group();
  // Tower 1: 36m Stepped Flagship Skyscraper
  const t1Base = makeBuildingBox(11.5, 30, 11.5, zoneMats.commercial);
  t1Base.position.set(5, 15, -27);
  const t1Top = makeBuildingBox(8.4, 7, 8.4, zoneMats.commercial);
  t1Top.position.set(5, 33.5, -27);
  const t1Crown = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.45, 8.8), matGreenTrim);
  t1Crown.position.set(5, 37.2, -27);
  const t1Spire = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.32, 7.5, 8), matSteel);
  t1Spire.position.set(5, 41, -27);
  // Tower 2: Twin Financial High-Rise
  const t2 = makeBuildingBox(9.5, 24, 9.5, zoneMats.commercial);
  t2.position.set(-4.5, 12, -18);
  const t2Crown = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.35, 9.8), matGreenTrim);
  t2Crown.position.set(-4.5, 24.2, -18);
  // Tower 3: Mid-Rise Tech Block
  const t3 = makeBuildingBox(9, 18, 9, zoneMats.commercial);
  t3.position.set(14.5, 9, -26);
  // Tower 4: Hyperscale Data Center
  const dc = makeBuildingBox(11, 9.5, 8.5, zoneMats.commercial);
  dc.position.set(13, 4.75, -15);
  comG.add(t1Base, t1Top, t1Crown, t1Spire, t2, t2Crown, t3, dc);
  tagZone(comG, "commercial");
  scene.add(comG);
  addPin("label-commercial", 5, 44, -27);

  // ── 3. RESIDENTIAL DISTRICT (North-East [42, 0, -22]) ──
  const resG = new THREE.Group();
  const resPark = new THREE.Mesh(new THREE.BoxGeometry(30, 0.22, 28), matPark);
  resPark.position.set(42, 0.11, -22);
  resPark.receiveShadow = true;
  resG.add(resPark);

  [
    { x: 32, z: -31, w: 8.5, h: 17, d: 8.5 },
    { x: 43, z: -32, w: 9,   h: 21, d: 8.5 },
    { x: 53, z: -29, w: 8,   h: 15, d: 8 },
    { x: 54, z: -18, w: 8,   h: 13, d: 8 },
  ].forEach((a) => {
    const b = makeBuildingBox(a.w, a.h, a.d, zoneMats.residential);
    b.position.set(a.x, a.h / 2, a.z);
    resG.add(b);
  });

  const matTownRoof = new THREE.MeshStandardMaterial({ color: 0x1f2924, roughness: 0.7 });
  for (let tx = 31; tx <= 46; tx += 7.2) {
    for (let tz = -19; tz <= -12; tz += 7) {
      const h = 5.6 + ((tx + tz) % 2) * 1.4;
      const th = makeBuildingBox(5.2, h, 5.2, zoneMats.residential);
      th.position.set(tx, h / 2, tz);
      const rf = new THREE.Mesh(new THREE.ConeGeometry(4.1, 2.0, 4), matTownRoof);
      rf.rotation.y = Math.PI / 4;
      rf.position.set(tx, h + 1.0, tz);
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
  const fac2 = makeBuildingBox(13, 7, 12, zoneMats.industry);
  fac2.position.set(-22, 3.5, 34);
  indG.add(fac1, fac2);

  for (let sz = 14; sz <= 28; sz += 4.5) {
    const saw = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.2, 4), matDark);
    saw.rotation.y = Math.PI / 4;
    saw.scale.set(2.9, 1, 0.8);
    saw.position.set(-28, 10.6, sz);
    indG.add(saw);
  }

  [0x00e676, 0xf59e0b, 0x334155, 0x10b981].forEach((col, i) => {
    const cont = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.2, 2.2), new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, metalness: 0.4 }));
    cont.position.set(-34, 1.1 + (i % 2) * 2.2, 32 + Math.floor(i / 2) * 2.6);
    cont.castShadow = true;
    indG.add(cont);
  });

  [-33, -28.5, -24].forEach((sx) => {
    const st = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.5, 16.5, 16), matSteel);
    st.position.set(sx, 8.25, 11.5);
    st.castShadow = true;
    indG.add(st);
  });
  tagZone(indG, "industry");
  scene.add(indG);
  addPin("label-industry", -28, 19, 21);

  // ── 5. UNIVERSITY CAMPUS (South-East [40, 0, 22]) ──
  const schG = new THREE.Group();
  const quad = new THREE.Mesh(new THREE.BoxGeometry(30, 0.2, 28), matPark);
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
  const towerCap = new THREE.Mesh(new THREE.ConeGeometry(3.5, 4.2, 4), matDark);
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
  const evPad = new THREE.Mesh(new THREE.BoxGeometry(23, 0.25, 18), matCurb);
  evPad.position.set(5, 0.12, 22);
  evPad.receiveShadow = true;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(18.5, 0.5, 9.2), matSolar);
  canopy.position.set(5, 5.5, 20.5);
  canopy.castShadow = true;
  const canopyEdge = new THREE.Mesh(new THREE.BoxGeometry(18.8, 0.22, 9.5), zoneMats.ev_hub);
  canopyEdge.position.set(5, 5.8, 20.5);
  [-2.5, 5, 12.5].forEach((px) => {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 5.4, 10), matSteel);
    col.position.set(px, 2.7, 20.5);
    evG.add(col);
  });
  for (let sx = -2.5; sx <= 12.5; sx += 3) {
    const ped = new THREE.Mesh(new THREE.BoxGeometry(0.75, 2.2, 0.5), matDark);
    ped.position.set(sx, 1.1, 20.5);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.45, 0.56), zoneMats.ev_hub);
    bar.position.set(sx, 1.2, 20.5);
    evG.add(ped, bar);
  }
  const lounge = makeBuildingBox(10, 4.5, 4.8, zoneMats.commercial);
  lounge.position.set(5, 2.25, 28.5);
  evG.add(evPad, canopy, canopyEdge, lounge);
  tagZone(evG, "ev_hub");
  scene.add(evG);
  addPin("label-ev_hub", 5, 10, 21);

  // ── 7. UTILITY BESS MEGAPACK SUBSTATION & PYLONS (West [-60, 0, -2]) ──
  const bessG = new THREE.Group();
  const bessPad = new THREE.Mesh(new THREE.BoxGeometry(24, 0.3, 26), matCurb);
  bessPad.position.set(-60, 0.15, -2);
  const matPack = new THREE.MeshStandardMaterial({ color: 0xdbe5e0, roughness: 0.35, metalness: 0.45 });
  for (let bx = -67; bx <= -53; bx += 6.5) {
    for (let bz = -10; bz <= 6; bz += 4.2) {
      const pk = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3.1, 2.1), matPack);
      pk.position.set(bx, 1.7, bz);
      pk.castShadow = true;
      const led = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.42, 2.18), zoneMats.battery);
      led.position.set(bx, 2.45, bz);
      bessG.add(pk, led);
    }
  }
  // High-Voltage Transmission Pylons across river
  [-51, -35].forEach((px) => {
    const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 1.1, 15, 4), matSteel);
    pylon.position.set(px, 7.5, -8);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.3, 6.5), matSteel);
    arm.position.set(px, 13.5, -8);
    bessG.add(pylon, arm);
  });
  scene.add(bessG);
  addPin("label-battery", -60, 11, -2);

  // ── 8. CLEAN RENEWABLE FARM: 5 WIND TURBINES + 16 SOLAR ARRAYS ([-68, 0, -34]) ──
  const renG = new THREE.Group();
  const matWhite = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.28, metalness: 0.3 });
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
    const cool = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 4.9, 14.5, 20), matSteel);
    cool.position.set(-5.5, 7.25, -4);
    cool.castShadow = true;
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00e676 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.35, 0.22, 8, 24), ringMat);
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

  // Trees & Vehicles
  const matTrunk = new THREE.MeshStandardMaterial({ color: 0x3b2314, roughness: 0.9 });
  const matCrown = new THREE.MeshStandardMaterial({ color: 0x166534, roughness: 0.78 });
  [
    [-36, -34], [-18, -35], [26, -34], [58, -34], [58, -10],
    [56, 14], [56, 34], [26, 35], [-18, 36], [39, -22], [45, -24],
  ].forEach(([tx, tz], i) => {
    const s = 0.9 + (i % 3) * 0.16;
    const tg = new THREE.Group();
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * s, 0.38 * s, 2.3 * s, 7), matTrunk);
    tr.position.y = 1.15 * s;
    const cr = new THREE.Mesh(new THREE.ConeGeometry(1.75 * s, 4.2 * s, 8), matCrown);
    cr.position.y = 3.6 * s;
    cr.castShadow = true;
    tg.add(tr, cr);
    tg.position.set(tx, 0, tz);
    scene.add(tg);
  });

  function addCar(start, end, speed, hex) {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.9, 1.4), new THREE.MeshStandardMaterial({ color: hex, roughness: 0.25, metalness: 0.65 }));
    b.position.y = 0.62;
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 1.1), new THREE.MeshBasicMaterial({ color: 0xd1fae5 }));
    hl.position.set(1.38, 0.65, 0);
    g.add(b, hl);
    const dir = new THREE.Vector3().subVectors(end, start);
    g.rotation.y = Math.atan2(-dir.z, dir.x);
    scene.add(g);
    cars.push({ mesh: g, start, end, speed, progress: Math.random() });
  }
  addCar(new THREE.Vector3(-54, 0.18, 1.8), new THREE.Vector3(64, 0.18, 1.8), 13, 0x00e676);
  addCar(new THREE.Vector3(64, 0.18, -1.8), new THREE.Vector3(-54, 0.18, -1.8), 11, 0xf8fafc);
  addCar(new THREE.Vector3(-10.2, 0.18, -52), new THREE.Vector3(-10.2, 0.18, 52), 10, 0x10b981);
  addCar(new THREE.Vector3(23.8, 0.18, 52), new THREE.Vector3(23.8, 0.18, -52), 11.5, 0xe2e8f0);

  // Energy Flow Conduits (Bold Electric Green!)
  function addConduit(sVec, eVec, hex, key) {
    const mid = new THREE.Vector3((sVec.x + eVec.x) * 0.5, 1.5, (sVec.z + eVec.z) * 0.5);
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(sVec.x, 0.65, sVec.z),
      mid,
      new THREE.Vector3(eVec.x, 0.65, eVec.z)
    );
    const lineMat = new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.45 });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(28)), lineMat);
    scene.add(line);

    const pCount = 9;
    const positions = new Float32Array(pCount * 3);
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const pMat = new THREE.PointsMaterial({ color: hex, size: 0.9, transparent: true, opacity: 0.95 });
    const pts = new THREE.Points(pGeo, pMat);
    scene.add(pts);

    energyPaths.push({ key, baseColor: hex, curve, lineMat, pMat, pts, positions, pCount, isActive: true });
  }

  const hubVec = new THREE.Vector3(-60, 0, -2);
  addConduit(new THREE.Vector3(-66, 0, -34), hubVec, 0x00e676, "gen_solar_wind");
  addConduit(p1Obj.pos, hubVec, 0xf59e0b, "gen_plant1");
  addConduit(p2Obj.pos, hubVec, 0xf59e0b, "gen_plant2");
  addConduit(hubVec, new THREE.Vector3(-26, 0, -23), 0x00e676, "zone_hospital");
  addConduit(hubVec, new THREE.Vector3(-28, 0, 21),  0x00e676, "zone_industry");
  addConduit(hubVec, new THREE.Vector3(40, 0, 18),   0x00e676, "zone_school");
  addConduit(hubVec, new THREE.Vector3(5, 0, -27),   0x00e676, "zone_commercial");
  addConduit(hubVec, new THREE.Vector3(43, 0, -26),  0x00e676, "zone_residential");
  addConduit(hubVec, new THREE.Vector3(5, 0, 21),    0x00e676, "zone_ev_hub");

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

  // Sky Colors
  const SKY_NIGHT = new THREE.Color(0x030605);
  const SKY_DAWN  = new THREE.Color(0x162922);
  const SKY_DAY   = new THREE.Color(0x193833);
  const SKY_DUSK  = new THREE.Color(0x12211d);
  const tmpSky = new THREE.Color();
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
    controls.autoRotateSpeed = 0.7;
    controls.update();

    // Sun & Sky
    const sunAng = ((currentHour - 6) / 12) * Math.PI;
    sunLight.position.set(Math.cos(sunAng) * -95, Math.max(6, Math.sin(sunAng) * 95), Math.cos(sunAng) * 38);
    const isNight = currentHour < 6.2 || currentHour >= 19.0;
    sunLight.intensity += ((isNight ? 0.08 : 1.45) - sunLight.intensity) * 0.1;
    hemiLight.intensity += ((isNight ? 0.28 : 0.65) - hemiLight.intensity) * 0.1;

    if (currentHour < 5.5 || currentHour >= 19.5) tmpSky.copy(SKY_NIGHT);
    else if (currentHour < 7.2) tmpSky.lerpColors(SKY_NIGHT, SKY_DAWN, (currentHour - 5.5) / 1.7);
    else if (currentHour < 9.0) tmpSky.lerpColors(SKY_DAWN, SKY_DAY, (currentHour - 7.2) / 1.8);
    else if (currentHour < 17.0) tmpSky.copy(SKY_DAY);
    else if (currentHour < 18.4) tmpSky.lerpColors(SKY_DAY, SKY_DUSK, (currentHour - 17.0) / 1.4);
    else tmpSky.lerpColors(SKY_DUSK, SKY_NIGHT, (currentHour - 18.4) / 1.1);

    scene.background.lerp(tmpSky, 0.12);
    scene.fog.color.copy(scene.background);
    starMat.opacity += ((isNight ? 0.85 : 0.0) - starMat.opacity) * 0.08;

    streetLamps.forEach((sl) => {
      sl.bulbMat.color.setHex(isNight ? 0xa7f3d0 : 0x475569);
      sl.haloMat.opacity = isNight ? 0.2 : 0.0;
    });

    // Wind Rotors & Beacons
    const renOn = latestGridState?.plants_state?.solar_wind?.active ?? true;
    windRotors.forEach((r, i) => { r.rotation.z -= (renOn ? 0.034 : 0.002) * (1 + i * 0.06); });
    const pulse = 0.5 + 0.5 * Math.sin(now * 5);
    beacons.forEach((b) => b.scale.setScalar(0.85 + pulse * 0.45));

    // Energy Particles
    energyPaths.forEach((ep) => {
      ep.lineMat.opacity = ep.isActive ? 0.5 : 0.08;
      ep.pMat.opacity = ep.isActive ? 0.95 : 0.0;
      if (!ep.isActive) return;
      for (let i = 0; i < ep.pCount; i++) {
        const pt = ep.curve.getPoint((now * 0.36 + i / ep.pCount) % 1.0);
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

    // Project 3D Floating Pins WITH Smart HUD Occlusion Culling!
    if (pinsVisible) {
      const { w, h } = getSize();
      const simEl = document.getElementById("sim-page");
      const dockOpen = simEl && !simEl.classList.contains("dock-closed");
      const inspOpen = document.getElementById("zone-inspector")?.classList.contains("open");
      const copilotOpen = document.getElementById("copilot-drawer")?.classList.contains("open");

      floatingLabels.forEach((lbl) => {
        projV.copy(lbl.pos).project(camera);
        const x = (projV.x * 0.5 + 0.5) * w;
        const y = (projV.y * -0.5 + 0.5) * h;
        lbl.el.style.left = `${x}px`;
        lbl.el.style.top = `${y}px`;

        let occluded = projV.z >= 1.0 || x < 40 || x > w - 40 || y < 82 || y > h - 80;
        if (!occluded && dockOpen && x < 355 && y > 10 && y < h - 70) occluded = true;
        if (!occluded && inspOpen && x > w - 330 && y < 340) occluded = true;
        if (!occluded && copilotOpen && x > w - 405) occluded = true;

        lbl.el.style.opacity = occluded ? "0" : "1";
        lbl.el.style.pointerEvents = occluded ? "none" : "auto";
      });
    }

    composer.render();
  }

  threeCtx = { zoneMats, energyPaths, p1Obj, p2Obj, camLerpGoal, onResize };
  if (latestGridState) sync3DWithState(latestGridState);
  renderLoop();
};

function sync3DWithState(state) {
  if (!threeCtx) return;
  const isNight = currentHour < 7.0 || currentHour >= 17.8;
  const { zoneMats, energyPaths, p1Obj, p2Obj } = threeCtx;

  ZONES.forEach((z) => {
    const mat = zoneMats[z];
    const d = state.demand?.[z] ?? 0;
    const s = state.supplied?.[z] ?? 0;
    const shed = d > 1 && s < d - 0.5;
    document.getElementById(`label-${z}`)?.classList.toggle("shedding", shed);
    if (!mat) return;
    if (d > 1 && s < d * 0.15) {
      mat.emissive.setHex(0xff3b5c);
      mat.emissiveIntensity = 0.25;
    } else if (shed) {
      mat.emissive.setHex(0xf59e0b);
      mat.emissiveIntensity = 0.85;
    } else {
      mat.emissive.setHex(z === "ev_hub" ? 0x00e676 : 0xffffff);
      mat.emissiveIntensity = isNight ? 0.95 : 0.35;
    }
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
      const col = shed ? 0xff3b5c : ep.baseColor;
      ep.lineMat.color.setHex(col);
      ep.pMat.color.setHex(col);
    }
  });

  p1Obj.ringMat.color.setHex(ps.plant1?.active ?? true ? 0x00e676 : 0xff3b5c);
  p2Obj.ringMat.color.setHex(ps.plant2?.active ?? true ? 0x00e676 : 0xff3b5c);
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
const history24 = {
  hours: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`),
  demand: Array.from({ length: 24 }, (_, h) => ZONES.reduce((acc, z) => acc + interpCurve(h, LOCAL_PROFILES[z]), 0)),
  renewable: Array.from({ length: 24 }, (_, h) => interpCurve(h, LOCAL_RENEWABLE)),
  soc: Array.from({ length: 24 }, (_, h) => Math.round(45 + 25 * Math.sin(((h - 8) / 24) * Math.PI * 2))),
  byEntity: Object.fromEntries(ZONES.map((z) => [z, Array.from({ length: 24 }, (_, h) => +interpCurve(h, LOCAL_PROFILES[z]).toFixed(1))])),
};

if (window.Chart) {
  Chart.defaults.color = "#8e9e95";
  Chart.defaults.borderColor = "rgba(255, 255, 255, 0.06)";
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
          { label: "Total Demand (MW)", data: [...history24.demand], borderColor: "#ffffff", backgroundColor: "rgba(255,255,255,0.06)", fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 },
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
        datasets: [{ data: [180, 0, 320], backgroundColor: ["#00e676", "#ffffff", "#f59e0b"], borderWidth: 0 }],
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
          { label: "Demand", data: [], backgroundColor: "rgba(255,255,255,0.22)", borderRadius: 4 },
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
          { label: "Medical", data: [], borderColor: "#ffffff", tension: 0.35, pointRadius: 0, borderWidth: 1.8 },
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
          { label: "Predicted Total Demand (MW)", data: [...history24.demand], borderColor: "#ffffff", backgroundColor: "rgba(255,255,255,0.06)", fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 },
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
          { label: "Medical", data: history24.byEntity.hospital, borderColor: "#ffffff", pointRadius: 0, tension: 0.4, borderWidth: 1.8 },
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
  ctx.fillStyle = "#060908";
  ctx.fillRect(0, 0, w, h);

  const hub = { x: w * 0.48, y: h * 0.5, label: "BESS HUB", val: `${Math.round(state.battery_soc_pct ?? 55)}% SoC`, col: "#00e676" };
  const nodes = [
    { x: w * 0.14, y: h * 0.24, label: "Medical", val: `${(state.supplied?.hospital ?? 0).toFixed(0)} MW`, col: "#ffffff" },
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
    ctx.fillStyle = "#f4f7f5";
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
