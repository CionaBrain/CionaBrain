from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .connectome import load_connectome
from .simulator import CionaSimulator


ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Parsing the cached 50 KiB CSV is fast and keeping startup synchronous also
    # makes the application lifecycle deterministic in embedded/test servers.
    app.state.connectome = load_connectome(DATA_DIR)
    yield


app = FastAPI(title="CionaBrain", version="0.2.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health() -> dict:
    connectome = app.state.connectome
    return {"status": "ok", "neurons": connectome.size, "edges": connectome.full_edge_count}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    # Each browser gets independent membrane state and stimulus controls.
    simulator = CionaSimulator(app.state.connectome)
    await websocket.send_json(simulator.metadata())
    running = True
    speed = 1.0

    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive_text(), timeout=0.05)
                command = json.loads(message)
                if command.get("type") == "stimulate":
                    simulator.stimulate(
                        command.get("stimulus", ""),
                        float(command.get("intensity", 0.7)),
                        float(command.get("duration_ms", 650)),
                    )
                elif command.get("type") == "reset":
                    simulator.reset()
                elif command.get("type") == "playback":
                    action = command.get("action")
                    if action == "pause":
                        running = False
                    elif action == "resume":
                        running = True
                    elif action == "step":
                        running = False
                        simulator.step()
                    else:
                        raise ValueError(f"Unknown playback action: {action}")
                elif command.get("type") == "speed":
                    requested = float(command.get("value", 1.0))
                    if requested not in {0.25, 0.5, 1.0, 2.0}:
                        raise ValueError(f"Unsupported simulation speed: {requested}")
                    speed = requested
                elif command.get("type") == "ablate":
                    simulator.set_ablation(
                        int(command.get("neuron_id", -1)),
                        bool(command.get("ablated", True)),
                    )
                elif command.get("type") == "ablate_motor_group":
                    simulator.set_motor_group_ablation(
                        str(command.get("side", "")),
                        bool(command.get("ablated", True)),
                    )
                elif command.get("type") == "sign_rule":
                    simulator.set_sign_rule(str(command.get("rule", "")))
            except asyncio.TimeoutError:
                pass
            except (ValueError, json.JSONDecodeError) as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})

            # At 1×, advance 50 ms of biological time per ~50 ms wall time.
            if running:
                for _ in range(max(1, round(10 * speed))):
                    simulator.step()
            state = simulator.snapshot()
            state.update({"paused": not running, "speed": speed})
            await websocket.send_json(state)
    except WebSocketDisconnect:
        return
