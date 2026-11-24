# Syntaxed-IEGMS AI Grid Agent Setup Guide (Gemini + Ollama Switchable)

## Overview

The **Syntaxed-IEGMS AI Grid Agent** ([`agent_orchestrator.py`](backend/agent_orchestrator.py)) supports **instant provider switching** between **Google Gemini API** (cloud API key) and **Ollama** (local or remote self-hosted model) via a single environment variable (`AI_PROVIDER`) or at runtime via `/agent/configure` and the UI Settings modal.

---

## 1. Environment Variable Configuration (`backend/.env`)

```env
# ── AI Provider Switch ("gemini" or "ollama") ───────────────────────────────
AI_PROVIDER=gemini

# ── Option A: Google Gemini API via google-genai SDK (Default) ──────────────
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.8-flash
GEMINI_ENDPOINT=https://generativelanguage.googleapis.com/v1beta

# ── Option B: Ollama (Revert anytime by setting AI_PROVIDER=ollama) ─────────
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=gemma3:4b
```

---

## 2. Reverting to Ollama or Switching at Runtime

### Method 1: Persistent `.env` Switch
Change `AI_PROVIDER=ollama` in `backend/.env` and restart Uvicorn:
```bash
ollama serve
ollama pull gemma3:4b
```

### Method 2: Live Runtime API Switch (No Restart Needed)
Switch to **Gemini**:
```bash
curl -X POST http://localhost:8000/agent/configure \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "gemini",
    "gemini_api_key": "YOUR_KEY",
    "gemini_model": "gemini-3.8-flash",
    "gemini_endpoint": "https://generativelanguage.googleapis.com/v1beta"
  }'
```

Revert to **Ollama**:
```bash
curl -X POST http://localhost:8000/agent/configure \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "ollama",
    "ollama_endpoint": "http://localhost:11434",
    "ollama_model": "gemma3:4b"
  }'
```

### Method 3: In-App UI Modal
Click the **Grid AI** button in the top navigation bar → click the **Settings** gear icon → toggle between **Google Gemini** and **Ollama Local/Remote**.
