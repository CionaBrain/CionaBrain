export interface Edge { source: number; target: number; weight: number }
export interface Neuron { id: number; source_id: number; name: string; color: string; side: "left" | "right" | "unlabelled"; class: string }
export interface Connectome { neurons: Neuron[]; adjacency: Float32Array; edges: Edge[]; outgoing: Edge[][]; touchTargets: number[]; fullNodes: number; fullEdges: number }

function neuronClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("pr")) return "photoreceptor";
  if (name.startsWith("MN")) return "motor neuron";
  if (["MGIN", "ACIN", "AMG", "PMGN", "aaIN", "ddN"].some(prefix => name.startsWith(prefix))) return "interneuron";
  if (name.startsWith("Ant")) return "sensory neuron";
  if (lower.startsWith("coronet")) return "coronet cell";
  return "CNS neuron";
}

export function parseConnectome(nodesText: string, edgesText: string): Connectome {
  const nodeRows = nodesText.trim().split(/\r?\n/).slice(1).map(line => {
    const [id, name, color] = line.split(",");
    return { id: Number(id), name, color: `#${color.slice(-6)}` };
  });
  const rawEdges = edgesText.trim().split(/\r?\n/).slice(1).map(line => {
    const [source, target, depth] = line.split(",");
    return { source: Number(source), target: Number(target), weight: Number(depth) };
  });
  const kept = nodeRows.filter(row => row.id >= 24 && !row.name.toLowerCase().startsWith("midtail"));
  if (kept.length !== 177) throw new Error(`Expected 177 CNS neurons, found ${kept.length}`);
  const remap = new Map(kept.map((row, index) => [row.id, index]));
  const neurons: Neuron[] = kept.map((row, id) => ({ id, source_id: row.id, name: row.name, color: row.color,
    side: row.name.endsWith("L") ? "left" : row.name.endsWith("R") ? "right" : "unlabelled", class: neuronClass(row.name) }));
  const adjacency = new Float32Array(177 * 177);
  const peripheral = new Float32Array(177);
  for (const edge of rawEdges) {
    const source = remap.get(edge.source), target = remap.get(edge.target);
    if (source !== undefined && target !== undefined) adjacency[target * 177 + source] += edge.weight;
    if (edge.source < 24 && target !== undefined) peripheral[target] += edge.weight;
  }
  const edges: Edge[] = [];
  const outgoing = Array.from({ length: 177 }, () => [] as Edge[]);
  for (let target = 0; target < 177; target++) for (let source = 0; source < 177; source++) {
    const weight = adjacency[target * 177 + source];
    if (weight > 0) { const edge = { source, target, weight }; edges.push(edge); outgoing[source].push(edge); }
  }
  const touchTargets = [...peripheral.keys()].filter(i => peripheral[i] > 0).sort((a, b) => peripheral[b] - peripheral[a]).slice(0, 12);
  return { neurons, adjacency, edges, outgoing, touchTargets, fullNodes: nodeRows.length, fullEdges: rawEdges.length };
}

export async function loadConnectome(): Promise<Connectome> {
  const [nodes, edges] = await Promise.all([fetch("/static/data/nodes.csv"), fetch("/static/data/edges.csv")]);
  if (!nodes.ok || !edges.ok) throw new Error("Could not load connectome CSV files");
  return parseConnectome(await nodes.text(), await edges.text());
}
