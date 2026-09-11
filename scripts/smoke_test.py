"""Start a temporary server and exercise HTTP plus WebSocket end to end."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets


ROOT = Path(__file__).resolve().parents[1]
PORT = 8766


async def check_websocket() -> dict:
    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws") as socket:
        metadata = json.loads(await socket.recv())
        await socket.send(
            json.dumps(
                {"type": "stimulate", "stimulus": "light", "intensity": 1.0}
            )
        )
        state = json.loads(await socket.recv())
        await socket.send(json.dumps({"type": "playback", "action": "pause"}))
        paused = json.loads(await socket.recv())
        await socket.send(json.dumps({"type": "playback", "action": "step"}))
        stepped = json.loads(await socket.recv())
        await socket.send(
            json.dumps({"type": "ablate", "neuron_id": 0, "ablated": True})
        )
        ablated = json.loads(await socket.recv())
        await socket.send(
            json.dumps({"type": "sign_rule", "rule": "heuristic_inhibition"})
        )
        signed = json.loads(await socket.recv())
        await socket.send(
            json.dumps(
                {"type": "ablate_motor_group", "side": "left", "ablated": True}
            )
        )
        grouped = json.loads(await socket.recv())
        return {
            "metadata_neurons": len(metadata["neurons"]),
            "connections": len(metadata["connections"]),
            "state": state["type"],
            "active": state["active_stimuli"],
            "paused": paused["paused"],
            "single_step_ms": stepped["time_ms"] - paused["time_ms"],
            "ablated": 0 in ablated["ablated"],
            "sign_rule": signed["sign_rule"],
            "inhibitory_edges": signed["inhibitory_edges"],
            "left_motor_group_ablated": all(
                neuron_id in grouped["ablated"]
                for neuron_id in metadata["motor_groups"]["left"]
            ),
        }


if __name__ == "__main__":
    live = "--live" in sys.argv
    if live:
        PORT = 8765
        process = None
    else:
        process = subprocess.Popen(
            [str(ROOT / ".venv/bin/uvicorn"), "app.main:app", "--port", str(PORT)],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    try:
        health = None
        for _ in range(50):
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT}/api/health", timeout=1
                ) as response:
                    health = json.load(response)
                break
            except OSError:
                time.sleep(0.1)
        if health is None:
            raise RuntimeError("Temporary server did not start")
        print({"health": health, "websocket": asyncio.run(check_websocket())})
    finally:
        if process is not None:
            process.terminate()
            process.wait(timeout=5)
