from pathlib import Path

from app.connectome import load_connectome
from app.simulator import CionaSimulator


DATA_DIR = Path(__file__).resolve().parents[1] / "data"


def test_real_connectome_shape():
    graph = load_connectome(DATA_DIR, download=False)
    assert graph.size == 177
    assert graph.full_node_count == 205
    assert graph.full_edge_count == 2903
    assert graph.adjacency.shape == (177, 177)
    assert "MN1L" in graph.names and "MN1R" in graph.names


def test_stimulus_and_lif():
    sim = CionaSimulator(load_connectome(DATA_DIR, download=False))
    sim.stimulate("light", 1.0, 1000)
    fired = set()
    for _ in range(200):
        sim.step()
        fired.update(sim.snapshot()["spikes"])
    assert fired
    assert set(sim.stimulus_indices["light"]).intersection(fired)
    assert -1 <= sim.snapshot()["direction"] <= 1


def test_lateral_touch_and_reversible_ablation():
    sim = CionaSimulator(load_connectome(DATA_DIR, download=False))
    assert sim.stimulus_indices["touch_left"].size
    assert sim.stimulus_indices["touch_right"].size
    neuron_id = int(sim.stimulus_indices["touch_left"][0])
    sim.set_ablation(neuron_id, True)
    sim.stimulate("touch_left", 1.0, 500)
    for _ in range(100):
        sim.step()
        assert not sim.spikes[neuron_id]
    assert neuron_id in sim.snapshot()["ablated"]
    sim.set_ablation(neuron_id, False)
    assert neuron_id not in sim.snapshot()["ablated"]


def test_metadata_exposes_real_connectivity():
    sim = CionaSimulator(load_connectome(DATA_DIR, download=False))
    metadata = sim.metadata()
    assert len(metadata["connections"]) == int((sim.connectome.adjacency > 0).sum())
    assert {"source", "target", "weight"} <= metadata["connections"][0].keys()
    assert all("class" in neuron for neuron in metadata["neurons"])
