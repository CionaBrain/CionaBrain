from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .connectome import Connectome


@dataclass
class LIFConfig:
    dt_ms: float = 5.0
    membrane_tau_ms: float = 20.0
    synapse_tau_ms: float = 12.0
    threshold: float = 1.0
    reset_voltage: float = 0.0
    refractory_ms: float = 10.0
    recurrent_gain: float = 1.5
    noise_std: float = 0.018


class CionaSimulator:
    """Vectorised LIF simulation of all 177 CNS neurons.

    Ryan et al.'s edge value is contact depth, not a signed conductance. Version
    one therefore treats every chemical edge as excitatory and rescales robustly.
    `synaptic_signs` is deliberately separate so transmitter annotations can be
    plugged in later without changing the integration code.
    """

    def __init__(self, connectome: Connectome, config: LIFConfig | None = None):
        self.connectome = connectome
        self.config = config or LIFConfig()
        self.rng = np.random.default_rng(7)
        self.n = connectome.size

        nonzero = connectome.adjacency[connectome.adjacency > 0]
        scale = float(np.percentile(nonzero, 95)) if nonzero.size else 1.0
        weights = np.log1p(connectome.adjacency / max(scale, 1e-6))
        self.synaptic_signs = np.ones(self.n, dtype=np.float32)  # placeholder
        self.weights = (
            weights * self.synaptic_signs[np.newaxis, :] * self.config.recurrent_gain
        ).astype(np.float32)

        self.voltage = np.zeros(self.n, dtype=np.float32)
        self.synaptic_current = np.zeros(self.n, dtype=np.float32)
        self.spikes = np.zeros(self.n, dtype=bool)
        self.refractory_steps = np.zeros(self.n, dtype=np.int16)
        self.rate_ema = np.zeros(self.n, dtype=np.float32)
        self.ablated = np.zeros(self.n, dtype=bool)
        self.active_stimuli: dict[str, dict[str, float]] = {}
        self.time_ms = 0.0

        names = connectome.names
        antenna = np.asarray(
            [i for i, name in enumerate(names) if name in {"Ant1", "Ant2"}],
            dtype=np.int32,
        )
        antenna_output = connectome.adjacency[:, antenna].sum(axis=1)
        antenna_downstream = np.argsort(antenna_output)[-8:]
        antenna_downstream = antenna_downstream[antenna_output[antenna_downstream] > 0]
        self.left_motor = np.asarray(
            [i for i, name in enumerate(names) if name.startswith("MN") and name.endswith("L")],
            dtype=np.int32,
        )
        self.right_motor = np.asarray(
            [i for i, name in enumerate(names) if name.startswith("MN") and name.endswith("R")],
            dtype=np.int32,
        )
        touch = np.asarray(connectome.touch_targets, dtype=np.int32)
        touch_left, touch_right = self._split_touch_by_motor_influence(touch)
        self.stimulus_indices = {
            # Photoreceptors are explicitly named pr1..pr23 and pra..prg.
            "light": np.asarray(
                [i for i, name in enumerate(names) if name.lower().startswith("pr")],
                dtype=np.int32,
            ),
            # Ant1/Ant2 plus their eight strongest real postsynaptic targets form
            # a minimal graviceptive proxy. Replace with a curated otolith map.
            "gravity": np.unique(np.concatenate((antenna, antenna_downstream))),
            # Touch enters through excluded PNS afferents. The strongest real CNS
            # targets are split by their downstream influence on the L/R motor
            # pools. This is data-derived, but remains a sensory-map placeholder.
            "touch_left": touch_left,
            "touch_right": touch_right,
            "touch": touch,
        }

    def _split_touch_by_motor_influence(
        self, touch: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """Partition touch targets using two-hop weighted motor influence."""
        raw = self.connectome.adjacency.astype(np.float64)
        column_scale = np.maximum(raw.sum(axis=0, keepdims=True), 1e-9)
        transition = raw / column_scale
        propagated = transition + transition @ transition
        left_score = propagated[self.left_motor, :].sum(axis=0)
        right_score = propagated[self.right_motor, :].sum(axis=0)
        left = touch[left_score[touch] >= right_score[touch]]
        right = touch[left_score[touch] < right_score[touch]]
        # Keep both controls usable if all candidates happen to prefer one pool.
        if not left.size or not right.size:
            ranked = touch[np.argsort(left_score[touch] - right_score[touch])]
            midpoint = max(1, len(ranked) // 2)
            right, left = ranked[:midpoint], ranked[midpoint:]
        return left.astype(np.int32), right.astype(np.int32)

    def stimulate(self, kind: str, intensity: float, duration_ms: float = 650.0) -> None:
        kind = kind.lower()
        if kind not in self.stimulus_indices:
            raise ValueError(f"Unknown stimulus: {kind}")
        self.active_stimuli[kind] = {
            "intensity": float(np.clip(intensity, 0.0, 1.0)),
            "remaining_ms": float(np.clip(duration_ms, 20.0, 5000.0)),
        }

    def reset(self) -> None:
        self.voltage.fill(0)
        self.synaptic_current.fill(0)
        self.spikes.fill(False)
        self.refractory_steps.fill(0)
        self.rate_ema.fill(0)
        self.active_stimuli.clear()
        self.ablated.fill(False)
        self.time_ms = 0.0

    def set_ablation(self, neuron_id: int, ablated: bool) -> None:
        if neuron_id < 0 or neuron_id >= self.n:
            raise ValueError(f"Neuron id out of range: {neuron_id}")
        self.ablated[neuron_id] = bool(ablated)
        if ablated:
            self.voltage[neuron_id] = self.config.reset_voltage
            self.synaptic_current[neuron_id] = 0.0
            self.spikes[neuron_id] = False
            self.rate_ema[neuron_id] = 0.0

    def step(self) -> np.ndarray:
        cfg = self.config
        recurrent = self.weights @ self.spikes.astype(np.float32)
        decay = np.exp(-cfg.dt_ms / cfg.synapse_tau_ms)
        self.synaptic_current = self.synaptic_current * decay + recurrent

        external = np.zeros(self.n, dtype=np.float32)
        expired: list[str] = []
        for kind, state in self.active_stimuli.items():
            indices = self.stimulus_indices[kind]
            # Above-threshold current at full strength; intensity remains linear.
            external[indices] += 1.55 * state["intensity"]
            state["remaining_ms"] -= cfg.dt_ms
            if state["remaining_ms"] <= 0:
                expired.append(kind)
        for kind in expired:
            del self.active_stimuli[kind]

        noise = self.rng.normal(0.0, cfg.noise_std, self.n).astype(np.float32)
        available = (self.refractory_steps <= 0) & ~self.ablated
        dv = (cfg.dt_ms / cfg.membrane_tau_ms) * (
            -self.voltage + self.synaptic_current + external + noise
        )
        self.voltage[available] += dv[available]
        self.voltage[~available] = cfg.reset_voltage
        self.refractory_steps -= 1

        self.spikes = available & (self.voltage >= cfg.threshold)
        self.voltage[self.ablated] = cfg.reset_voltage
        self.synaptic_current[self.ablated] = 0.0
        self.voltage[self.spikes] = cfg.reset_voltage
        self.refractory_steps[self.spikes] = max(
            1, round(cfg.refractory_ms / cfg.dt_ms)
        )
        self.rate_ema = 0.92 * self.rate_ema + 0.08 * self.spikes
        self.time_ms += cfg.dt_ms
        return self.spikes

    def snapshot(self) -> dict:
        left = float(self.rate_ema[self.left_motor].mean()) if self.left_motor.size else 0.0
        right = float(self.rate_ema[self.right_motor].mean()) if self.right_motor.size else 0.0
        # Positive means stronger right motor-pool activity; this is a behavioural
        # proxy, not a biomechanical prediction of the actual turn direction.
        direction = (right - left) / (right + left + 0.02)
        return {
            "type": "state",
            "time_ms": round(self.time_ms, 1),
            "spikes": np.flatnonzero(self.spikes).tolist(),
            "firing_count": int(self.spikes.sum()),
            "direction": round(float(np.clip(direction, -1.0, 1.0)), 3),
            "motor": {"left": round(left, 3), "right": round(right, 3)},
            "active_stimuli": list(self.active_stimuli),
            "ablated": np.flatnonzero(self.ablated).tolist(),
        }

    def metadata(self) -> dict:
        side = []
        for name in self.connectome.names:
            if name.endswith("L"):
                side.append("left")
            elif name.endswith("R"):
                side.append("right")
            else:
                side.append("unassigned")
        return {
            "type": "metadata",
            "neurons": [
                {
                    "id": i,
                    "source_id": int(self.connectome.original_ids[i]),
                    "name": name,
                    "color": self.connectome.colors[i],
                    "side": side[i],
                    "class": self._neuron_class(name),
                }
                for i, name in enumerate(self.connectome.names)
            ],
            "stimulus_targets": {
                key: [self.connectome.names[i] for i in indices]
                for key, indices in self.stimulus_indices.items()
            },
            "connections": [
                {
                    "source": int(source),
                    "target": int(target),
                    "weight": round(float(self.connectome.adjacency[target, source]), 3),
                }
                for target, source in np.argwhere(self.connectome.adjacency > 0)
            ],
            "source": {
                "dataset": "Ryan et al. 2016 / Netzschleuder cintestinalis",
                "graph_nodes": self.connectome.full_node_count,
                "graph_edges": self.connectome.full_edge_count,
                "simulated_cns_neurons": self.n,
                "synapse_assumption": "all edges excitatory (contact-depth weights)",
            },
        }

    @staticmethod
    def _neuron_class(name: str) -> str:
        lower = name.lower()
        if lower.startswith("pr"):
            return "photoreceptor"
        if name.startswith("MN"):
            return "motor neuron"
        if name.startswith(("MGIN", "ACIN", "AMG", "PMGN", "aaIN", "ddN")):
            return "interneuron"
        if name.startswith("Ant"):
            return "sensory neuron"
        if lower.startswith("coronet"):
            return "coronet cell"
        return "CNS neuron"
