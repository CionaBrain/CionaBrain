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

    Ryan et al.'s edge value is contact depth, not a signed conductance. Signs are
    therefore supplied by an explicit, switchable rule instead of being presented
    as measured physiology.
    """

    SIGN_RULES = {
        "all_excitatory": {
            "label": "All excitatory",
            "description": "Compatibility mode: every observed edge is positive.",
            "experimental": False,
        },
        "heuristic_inhibition": {
            "label": "Heuristic inhibition",
            "description": (
                "Edges from high-out-degree named interneurons are negative. "
                "This is a transparent heuristic, not physiological annotation."
            ),
            "experimental": True,
        },
        "random_20_inhibitory": {
            "label": "Random 20% inhibitory",
            "description": (
                "A deterministic random 20% of observed edges is negative for comparison."
            ),
            "experimental": True,
        },
    }

    def __init__(self, connectome: Connectome, config: LIFConfig | None = None):
        self.connectome = connectome
        self.config = config or LIFConfig()
        self.rng = np.random.default_rng(7)
        self.n = connectome.size
        names = connectome.names

        nonzero = connectome.adjacency[connectome.adjacency > 0]
        scale = float(np.percentile(nonzero, 95)) if nonzero.size else 1.0
        weights = np.log1p(connectome.adjacency / max(scale, 1e-6))
        self.base_weights = (weights * self.config.recurrent_gain).astype(np.float32)
        self.weights = self.base_weights.copy()
        self.edge_signs = np.ones_like(self.base_weights, dtype=np.float32)
        self.sign_rule = "all_excitatory"
        self.inhibitory_edges = 0
        self.heuristic_inhibitory_neurons: list[int] = []

        self.voltage = np.zeros(self.n, dtype=np.float32)
        self.synaptic_current = np.zeros(self.n, dtype=np.float32)
        self.spikes = np.zeros(self.n, dtype=bool)
        self.refractory_steps = np.zeros(self.n, dtype=np.int16)
        self.rate_ema = np.zeros(self.n, dtype=np.float32)
        self.ablated = np.zeros(self.n, dtype=bool)
        self.active_stimuli: dict[str, dict[str, float]] = {}
        self.time_ms = 0.0
        self.set_sign_rule("all_excitatory", reset_state=False)

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

    def set_sign_rule(self, rule: str, reset_state: bool = True) -> None:
        """Apply an explicit sign model to the observed, positive edge depths.

        Heuristic mode follows a deliberately simple and auditable rule: among
        neurons identified as interneurons by existing name patterns, neurons in
        the top quartile of observed out-degree are treated as inhibitory sources.
        All of their outgoing edges become negative. This does *not* claim that
        these cells have been physiologically identified as inhibitory.

        Random mode negates exactly 20% of observed edges using a fixed seed, so
        comparisons are reproducible across browser sessions.
        """
        if rule not in self.SIGN_RULES:
            raise ValueError(f"Unknown sign rule: {rule}")

        signs = np.ones_like(self.base_weights, dtype=np.float32)
        self.heuristic_inhibitory_neurons = []
        if rule == "heuristic_inhibition":
            out_degree = np.count_nonzero(self.connectome.adjacency, axis=0)
            candidates = np.asarray(
                [
                    i
                    for i, name in enumerate(self.connectome.names)
                    if self._neuron_class(name) == "interneuron" and out_degree[i] > 0
                ],
                dtype=np.int32,
            )
            if candidates.size:
                threshold = float(np.percentile(out_degree[candidates], 75))
                inhibitory = candidates[out_degree[candidates] >= threshold]
                signs[:, inhibitory] = np.where(
                    self.base_weights[:, inhibitory] > 0, -1.0, 1.0
                )
                self.heuristic_inhibitory_neurons = inhibitory.tolist()
        elif rule == "random_20_inhibitory":
            observed = np.argwhere(self.base_weights > 0)
            count = round(len(observed) * 0.20)
            chosen = np.random.default_rng(2016).choice(len(observed), count, replace=False)
            inhibitory_edges = observed[chosen]
            signs[inhibitory_edges[:, 0], inhibitory_edges[:, 1]] = -1.0

        self.sign_rule = rule
        self.edge_signs = signs
        self.weights = self.base_weights * signs
        self.inhibitory_edges = int(np.count_nonzero(self.weights < 0))
        if reset_state:
            # Switching sign models clears dynamic state but preserves elapsed
            # experiment time and any deliberate ablations.
            self._clear_dynamic_state(reset_time=False)

    def stimulate(self, kind: str, intensity: float, duration_ms: float = 650.0) -> None:
        kind = kind.lower()
        if kind not in self.stimulus_indices:
            raise ValueError(f"Unknown stimulus: {kind}")
        self.active_stimuli[kind] = {
            "intensity": float(np.clip(intensity, 0.0, 1.0)),
            "remaining_ms": float(np.clip(duration_ms, 20.0, 5000.0)),
        }

    def _clear_dynamic_state(self, reset_time: bool) -> None:
        self.voltage.fill(0)
        self.synaptic_current.fill(0)
        self.spikes.fill(False)
        self.refractory_steps.fill(0)
        self.rate_ema.fill(0)
        self.active_stimuli.clear()
        if reset_time:
            self.time_ms = 0.0

    def reset(self) -> None:
        self._clear_dynamic_state(reset_time=True)
        self.ablated.fill(False)

    def set_ablation(self, neuron_id: int, ablated: bool) -> None:
        if neuron_id < 0 or neuron_id >= self.n:
            raise ValueError(f"Neuron id out of range: {neuron_id}")
        self.ablated[neuron_id] = bool(ablated)
        if ablated:
            self.voltage[neuron_id] = self.config.reset_voltage
            self.synaptic_current[neuron_id] = 0.0
            self.spikes[neuron_id] = False
            self.rate_ema[neuron_id] = 0.0

    def motor_related_indices(self, side: str) -> np.ndarray:
        """Return explicitly side-labelled motor-circuit neurons.

        The source data provides no separate laterality field, so this relies on
        names ending in L/R. `MN*` motor neurons and `MGIN*` motor-ganglion
        interneurons are considered motor-related; other sided cells are excluded.
        """
        suffix = {"left": "L", "right": "R"}.get(side)
        if suffix is None:
            raise ValueError(f"Unknown motor side: {side}")
        return np.asarray(
            [
                i
                for i, name in enumerate(self.connectome.names)
                if name.endswith(suffix) and name.startswith(("MN", "MGIN"))
            ],
            dtype=np.int32,
        )

    def set_motor_group_ablation(self, side: str, ablated: bool) -> list[int]:
        indices = self.motor_related_indices(side)
        for neuron_id in indices:
            self.set_ablation(int(neuron_id), ablated)
        return indices.tolist()

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
            "sign_rule": self.sign_rule,
            "sign_rule_label": self.SIGN_RULES[self.sign_rule]["label"],
            "inhibitory_edges": self.inhibitory_edges,
        }

    def metadata(self) -> dict:
        side = []
        for name in self.connectome.names:
            if name.endswith("L"):
                side.append("left")
            elif name.endswith("R"):
                side.append("right")
            else:
                side.append("unlabelled")
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
            "sign_rules": self.SIGN_RULES,
            "motor_groups": {
                side_name: self.motor_related_indices(side_name).tolist()
                for side_name in ("left", "right")
            },
            "source": {
                "dataset": "Ryan et al. 2016 / Netzschleuder cintestinalis",
                "graph_nodes": self.connectome.full_node_count,
                "graph_edges": self.connectome.full_edge_count,
                "simulated_cns_neurons": self.n,
                "synapse_note": (
                    "Synaptic signs are not fully annotated in the original connectome; "
                    "all inhibition modes are explicit assumptions."
                ),
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
