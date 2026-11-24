# Syntaxed-IEGMS (Intelligent Energy Grid Management System)

> **Quantexera Hackathon 2026** · Autonomous 3D Smart Grid Digital Twin + ML Forecasting + Priority Load Shedding + **Dual-Provider IEGMS AI Agent (Gemini & Ollama)**

### Team Members
- Prashant Goundadkar
- Hussain Shaikh
- Abhishek A Pillai
- Jagadeesh Kadlimatti
- Yashsai Dessai

---

## Architecture

```
┌─────────────────────────┐    MQTT (broker.hivemq.com)     ┌──────────────────────────────┐
│     IoT Simulator       │ ──────────────────────────────► │       FastAPI V3 Engine      │
│   simulator.py (6 zones)│  iegms/syntaxed/grid/data       │  main.py · optimizer.py      │
│   (2s stream + fallback)│ ◄────────────────────────────── │  ml_model.py · mqtt_client.py│
└─────────────────────────┘  iegms/syntaxed/grid/time_sync  │  agent_orchestrator.py       │
                                                            └──────────────┬───────────────┘
                                                                           │ REST API
                                                              ┌────────────▼────────────┐
                                                              │  AI Provider Adapter    │
                                                              │  AI_PROVIDER=gemini     │
                                                              │  or AI_PROVIDER=ollama  │
                                                              └────────────┬────────────┘
                                                                           │
                                                            ┌──────────────▼───────────────┐
                                                            │   3D Digital Twin + SCADA UI │
                                                            │   Three.js + Chart.js + HUD  │
                                                            │   IEGMS Grid AI Drawer       │
                                                            └──────────────────────────────┘
```

---

## Quick Start

### 1. Install Dependencies
```bash
cd backend
pip install -r requirements.txt
```

### 2. Configure Environment (`backend/.env`)
Copy `backend/.env.example` to `backend/.env` and set your Gemini API key (or switch `AI_PROVIDER=ollama` anytime to revert to Ollama):

```env
# Switch between "gemini" and "ollama" anytime
AI_PROVIDER=gemini

# Google Gemini Configuration (Latest Gemini 3.8 / Gemini 4 Models)
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.8-flash
GEMINI_ENDPOINT=https://generativelanguage.googleapis.com/v1beta

# Ollama Configuration (Instant Fallback)
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=gemma3:4b

# MQTT Configuration
MQTT_BROKER=broker.hivemq.com
MQTT_PORT=1883
MQTT_TOPIC_DATA=iegms/syntaxed/grid/data
MQTT_TOPIC_SYNC=iegms/syntaxed/grid/time_sync
```

### 3. Start the Backend Engine (Serves Both API & Frontend on `:8000`)
```bash
cd backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```
- **3D Digital Twin & Dashboard**: http://localhost:8000
- **Interactive Swagger API Docs**: http://localhost:8000/docs

*(Note: The backend includes an automatic internal telemetry stream when running standalone, and seamlessly switches to live MQTT readings as soon as `simulator/simulator.py` connects.)*

### 4. Optional: Start the External MQTT IoT Simulator
```bash
cd simulator
python simulator.py
```

---

## Smart-Grid Zones & Priority Hierarchy

| Priority | Zone | Schedule Window | Off-Hours Cap | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1 (Critical)** | Medical Center | 24/7 Always On | 100% | Clinical tower, surgical wing & helipad — never shed |
| **Tier 2 (High)** | Industrial Park | 05:00 – 19:00 | 10% | Manufacturing hall, logistics warehouse & stacks |
| **Tier 3 (Med-High)** | University Campus | 07:00 – 17:00 | 5% | Academic quad, clock tower & rooftop solar |
| **Tier 4 (Medium)** | Commercial Towers | 08:00 – 21:00 | 15% | Downtown skyscrapers & data center annex |
| **Tier 5 (Standard)** | Residential District | 06:00 – 23:00 | 50% | Mid-rise apartments, townhouses & evening surge |
| **Tier 6 (Deferrable)** | EV Supercharger Hub | 07:00 – 22:00 | 25% | Solar-canopy fast chargers — throttled first on deficit |

**Generation & Storage Assets**:
- **Solar + Wind Farm (`280 MW` clean)** — Dispatched first (zero marginal CO₂), animated 3-blade wind turbines + PV arrays
- **Thermal Plants 1 & 2 (`2 × 300 MW` CCGT)** — Dispatchable combined-cycle generation with live breaker toggles
- **Utility BESS Megapack Yard (`400 MWh`)** — Charges on clean/off-peak surplus; proactively boosts morning (`08–09h`) & evening (`18–21h`) peaks

---

## API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Engine health, simulated clock, MQTT & active AI provider |
| `GET` | `/optimize` | Live 6-zone dispatch, renewable share, BESS SoC & shedding state |
| `GET` | `/data` | Recent multi-zone telemetry readings |
| `GET` | `/api/forecast` | 24-hour ML demand & clean renewable forecast curves |
| `POST` | `/set_time` | Jump simulation clock to any hour (`0.0` – `23.99`) |
| `POST` | `/api/sim/control` | Play/pause clock or set simulation speed (`1x`, `2x`, `5x`) |
| `POST` | `/api/plant/toggle` | Trip or restore `solar_wind`, `plant1`, or `plant2` |
| `POST` | `/api/load/override` | Inject manual MW load spikes on any zone (or `"reset"`) |
| `GET` | `/agent/config` | View active AI provider (`gemini` or `ollama`), model & endpoint |
| `POST` | `/agent/configure` | Switch between Gemini and Ollama or update model/endpoint at runtime |
| `POST` | `/agent/decide` | Query IEGMS Grid AI Agent with live telemetry context |
