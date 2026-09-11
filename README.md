# CionaBrain

CionaBrain is a minimum viable web simulator for the larval *Ciona intestinalis*
CNS. It loads the real directed, weighted connectome from Ryan, Lu, and
Meinertzhagen (2016), advances 177 LIF neurons in real time on the server, and
streams firing states and a left–right motor readout to the browser over WebSocket.

## Project structure

```text
CionaBrain/
├── app/
│   ├── connectome.py       # Download, cache, filter, and build the adjacency matrix
│   ├── simulator.py        # NumPy LIF, stimulus maps, and left–right motor readout
│   └── main.py             # FastAPI and WebSocket service
├── data/                   # Cached Netzschleuder CSV files
├── scripts/
│   ├── download_connectome.py
│   └── smoke_test.py
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── tests/test_core.py
├── ecosystem.config.cjs   # PM2 deployment configuration
└── requirements.txt
```

## Connectome data

Netzschleuder's `cintestinalis.csv.zip` contains 205 graph nodes and 2,903
directed edges. The `depth` edge property is cumulative presynaptic contact depth
in micrometres. Nodes 0–23 are peripheral sensory inputs, while four `midtail*`
nodes are tail targets. Excluding these 28 nodes leaves the 177 CNS neurons
described in the paper.

The peripheral nodes are not discarded entirely: their real connections into
the CNS are used to derive the downstream targets of the Touch stimulus.

Download or refresh the local cache manually:

```bash
python3 scripts/download_connectome.py
python3 scripts/download_connectome.py --force
```

The server also downloads the data automatically on its first start. Source URL:
`https://networks.skewed.de/net/cintestinalis/files/cintestinalis.csv.zip`.

## Model and placeholder assumptions

- All 177 neural states are updated by a vectorized LIF model with a 5 ms step.
  WebSocket state updates are sent at approximately 20 FPS.
- The source `depth` values are not signed conductances. Version 0.1 applies a
  `log1p` scaling and treats all connections as excitatory. The separate
  `synaptic_signs` vector is ready for future neurotransmitter annotations.
- Light targets the `pr*` photoreceptors in the source data.
- Gravity currently targets `Ant1`, `Ant2`, and their eight strongest downstream
  targets in the real matrix. This is an explicit placeholder implementation.
- Touch uses the 12 strongest CNS targets of the 24 peripheral sensory nodes.
  Left/right controls partition them by two-hop influence on the real motor pools;
  the sensory laterality map remains a documented placeholder.
- Motor output reads exponentially smoothed activity from `MN*L` and `MN*R`.
  A positive score means stronger right motor-pool activity. It is an asymmetric
  activity proxy, not a biomechanical prediction of the animal's exact turn.

## Interactive tools

- Click any neuron to inspect its class, source ID, weighted degree, and real
  upstream/downstream neighborhood.
- Reversibly ablate individual neurons and observe the resulting network activity.
- Pause, resume, single-step, or run the simulation at 0.25×–2× speed.
- View both population activity and a six-second spike raster for all 177 neurons.
- Export the browser's current experiment record as JSON or spike-level CSV.

## Local development

Python 3.10 or newer is required:

```bash
cd CionaBrain
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 scripts/download_connectome.py
uvicorn app.main:app --reload
```

Open <http://127.0.0.1:8000>. To run the core tests:

```bash
pip install pytest
pytest -q
```

For the complete HTTP and WebSocket smoke test:

```bash
python3 scripts/smoke_test.py
```

## Production process

The included PM2 configuration exposes the service on `0.0.0.0:8765`:

```bash
pm2 start ecosystem.config.cjs --only cionabrain
pm2 save
```

Data citation: Ryan K, Lu Z, Meinertzhagen IA. *The CNS connectome of a tadpole
larva of Ciona intestinalis (L.) highlights sidedness in the brain of a chordate
sibling.* eLife 5:e16962 (2016), CC BY 4.0.
