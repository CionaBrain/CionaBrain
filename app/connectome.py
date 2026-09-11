from __future__ import annotations

import csv
import io
import shutil
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np


DATA_URL = (
    "https://networks.skewed.de/net/cintestinalis/files/"
    "cintestinalis.csv.zip"
)
EXPECTED_GRAPH_NODES = 205
EXPECTED_CNS_NEURONS = 177


@dataclass(frozen=True)
class Connectome:
    """The 177-neuron CNS subgraph and provenance needed by the simulator."""

    names: list[str]
    original_ids: np.ndarray
    adjacency: np.ndarray  # adjacency[post, pre], raw contact depth in micrometres
    colors: list[str]
    touch_targets: list[int]
    full_node_count: int
    full_edge_count: int

    @property
    def size(self) -> int:
        return len(self.names)


def download_connectome(data_dir: Path, force: bool = False) -> tuple[Path, Path]:
    """Download and safely extract Netzschleuder's public CSV archive.

    Existing extracted files are used as an offline cache. No graph-tool or
    NetworkX dependency is required.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    nodes_path = data_dir / "nodes.csv"
    edges_path = data_dir / "edges.csv"
    if not force and nodes_path.exists() and edges_path.exists():
        return nodes_path, edges_path

    archive_path = data_dir / "cintestinalis.csv.zip"
    request = urllib.request.Request(
        DATA_URL, headers={"User-Agent": "CionaBrain/0.1 (research demo)"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            with archive_path.open("wb") as destination:
                shutil.copyfileobj(response, destination)
        with zipfile.ZipFile(archive_path) as archive:
            for filename in ("nodes.csv", "edges.csv", "gprops.csv"):
                if filename in archive.namelist():
                    target = data_dir / filename
                    with archive.open(filename) as source, target.open("wb") as output:
                        shutil.copyfileobj(source, output)
    except Exception as exc:
        raise RuntimeError(
            f"Could not download the connectome from {DATA_URL}. "
            "Check the network, or place nodes.csv and edges.csv in "
            f"{data_dir}. Original error: {exc}"
        ) from exc

    if not nodes_path.exists() or not edges_path.exists():
        raise RuntimeError("The downloaded archive did not contain nodes.csv and edges.csv")
    return nodes_path, edges_path


def _rows(path: Path) -> list[dict[str, str]]:
    # Netzschleuder prefixes CSV headers with '# '. Strip it without changing data.
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    if not lines:
        raise ValueError(f"Empty CSV: {path}")
    lines[0] = lines[0].lstrip("# ")
    return list(csv.DictReader(io.StringIO("\n".join(lines)), skipinitialspace=True))


def _is_cns_neuron(original_id: int, name: str) -> bool:
    """Reproduce the paper's 177-neuron CNS subset from the 205-node graph.

    Netzschleuder includes 24 peripheral sensory input nodes at indices 0..23
    and four mid-tail effector/target nodes. They remain useful for deriving
    touch input, but are not integrated as CNS neurons.
    """
    return original_id >= 24 and not name.lower().startswith("midtail")


def load_connectome(data_dir: Path, download: bool = True) -> Connectome:
    nodes_path = data_dir / "nodes.csv"
    edges_path = data_dir / "edges.csv"
    if download:
        nodes_path, edges_path = download_connectome(data_dir)
    elif not nodes_path.exists() or not edges_path.exists():
        raise FileNotFoundError(f"Missing cached connectome CSV files in {data_dir}")

    node_rows = _rows(nodes_path)
    edge_rows = _rows(edges_path)
    if len(node_rows) != EXPECTED_GRAPH_NODES:
        raise ValueError(f"Expected 205 graph nodes, found {len(node_rows)}")

    all_names = {int(row["index"]): row["name"] for row in node_rows}
    kept = [
        int(row["index"])
        for row in node_rows
        if _is_cns_neuron(int(row["index"]), row["name"])
    ]
    if len(kept) != EXPECTED_CNS_NEURONS:
        raise ValueError(f"Expected 177 CNS neurons after filtering, found {len(kept)}")

    old_to_new = {old: new for new, old in enumerate(kept)}
    adjacency = np.zeros((len(kept), len(kept)), dtype=np.float32)
    peripheral_drive = np.zeros(len(kept), dtype=np.float32)

    for row in edge_rows:
        source, target = int(row["source"]), int(row["target"])
        depth = float(row["depth"])
        if source in old_to_new and target in old_to_new:
            adjacency[old_to_new[target], old_to_new[source]] += depth
        # PNS nodes are virtual sensory inputs, not part of the 177 LIF states.
        if source < 24 and target in old_to_new:
            peripheral_drive[old_to_new[target]] += depth

    touch_targets = np.argsort(peripheral_drive)[-12:][::-1]
    touch_targets = [int(i) for i in touch_targets if peripheral_drive[i] > 0]
    row_by_id = {int(row["index"]): row for row in node_rows}
    colors = ["#" + row_by_id[i]["color"][-6:] for i in kept]

    return Connectome(
        names=[all_names[i] for i in kept],
        original_ids=np.asarray(kept, dtype=np.int32),
        adjacency=adjacency,
        colors=colors,
        touch_targets=touch_targets,
        full_node_count=len(node_rows),
        full_edge_count=len(edge_rows),
    )

