from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.connectome import download_connectome, load_connectome  # noqa: E402


if __name__ == "__main__":
    data_dir = Path(__file__).resolve().parents[1] / "data"
    download_connectome(data_dir, force="--force" in sys.argv)
    graph = load_connectome(data_dir, download=False)
    print(
        f"Loaded {graph.size} CNS neurons from "
        f"{graph.full_node_count} nodes and {graph.full_edge_count} edges."
    )

