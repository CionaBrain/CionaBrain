// src/server.ts
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

// src/connectome.ts
function neuronClass(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith("pr")) return "photoreceptor";
  if (name.startsWith("MN")) return "motor neuron";
  if (["MGIN", "ACIN", "AMG", "PMGN", "aaIN", "ddN"].some((prefix) => name.startsWith(prefix))) return "interneuron";
  if (name.startsWith("Ant")) return "sensory neuron";
  if (lower.startsWith("coronet")) return "coronet cell";
  return "CNS neuron";
}
function parseConnectome(nodesText, edgesText) {
  const nodeRows = nodesText.trim().split(/\r?\n/).slice(1).map((line) => {
    const [id, name, color] = line.split(",");
    return { id: Number(id), name, color: `#${color.slice(-6)}` };
  });
  const rawEdges = edgesText.trim().split(/\r?\n/).slice(1).map((line) => {
    const [source, target, depth] = line.split(",");
    return { source: Number(source), target: Number(target), weight: Number(depth) };
  });
  const kept = nodeRows.filter((row) => row.id >= 24 && !row.name.toLowerCase().startsWith("midtail"));
  if (kept.length !== 177) throw new Error(`Expected 177 CNS neurons, found ${kept.length}`);
  const remap = new Map(kept.map((row, index) => [row.id, index]));
  const neurons = kept.map((row, id) => ({
    id,
    source_id: row.id,
    name: row.name,
    color: row.color,
    side: row.name.endsWith("L") ? "left" : row.name.endsWith("R") ? "right" : "unlabelled",
    class: neuronClass(row.name)
  }));
  const adjacency = new Float32Array(177 * 177);
  const peripheral = new Float32Array(177);
  for (const edge of rawEdges) {
    const source = remap.get(edge.source), target = remap.get(edge.target);
    if (source !== void 0 && target !== void 0) adjacency[target * 177 + source] += edge.weight;
    if (edge.source < 24 && target !== void 0) peripheral[target] += edge.weight;
  }
  const edges = [];
  const outgoing = Array.from({ length: 177 }, () => []);
  for (let target = 0; target < 177; target++) for (let source = 0; source < 177; source++) {
    const weight = adjacency[target * 177 + source];
    if (weight > 0) {
      const edge = { source, target, weight };
      edges.push(edge);
      outgoing[source].push(edge);
    }
  }
  const touchTargets = [...peripheral.keys()].filter((i) => peripheral[i] > 0).sort((a, b) => peripheral[b] - peripheral[a]).slice(0, 12);
  return { neurons, adjacency, edges, outgoing, touchTargets, fullNodes: nodeRows.length, fullEdges: rawEdges.length };
}

// src/simulator.ts
var SIGN_RULES = {
  all_excitatory: { label: "All excitatory", description: "Compatibility mode: every observed edge is positive.", experimental: false },
  heuristic_inhibition: { label: "Heuristic inhibition", description: "Edges from high-out-degree named interneurons are negative. This is a transparent heuristic, not physiological annotation.", experimental: true },
  random_20_inhibitory: { label: "Random 20% inhibitory", description: "A deterministic random 20% of observed edges is negative for comparison.", experimental: true }
};
var GAIN_PROFILES = {
  original: { label: "Source-derived weights", description: "Ryan et al. contact depth after fixed log scaling; no fitted gain multipliers.", experimental: false },
  optimized: { label: "Calibrated class gains", description: "Experimental class-level multipliers selected on a synthetic left/right touch benchmark.", experimental: true }
};
function rngFrom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 1831565813;
    let t = value;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function normal(rng) {
  return Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(2 * Math.PI * rng());
}
var clamp = (value, low, high) => Math.max(low, Math.min(high, value));
var Simulator = class {
  constructor(connectome, seed = 7) {
    this.connectome = connectome;
    this.seed = seed;
    this.rng = rngFrom(seed);
    const nonzero = [...connectome.adjacency].filter((value) => value > 0).sort((a, b) => a - b);
    const scale = nonzero[Math.floor(nonzero.length * 0.95)] || 1;
    for (let i = 0; i < this.baseWeights.length; i++) this.baseWeights[i] = Math.log1p(connectome.adjacency[i] / scale) * 0.75;
    this.leftMotor = connectome.neurons.filter((n) => n.name.startsWith("MN") && n.name.endsWith("L")).map((n) => n.id);
    this.rightMotor = connectome.neurons.filter((n) => n.name.startsWith("MN") && n.name.endsWith("R")).map((n) => n.id);
    this.motorGroups = {
      left: connectome.neurons.filter((n) => n.name.endsWith("L") && (n.name.startsWith("MN") || n.name.startsWith("MGIN"))).map((n) => n.id),
      right: connectome.neurons.filter((n) => n.name.endsWith("R") && (n.name.startsWith("MN") || n.name.startsWith("MGIN"))).map((n) => n.id)
    };
    const light = connectome.neurons.filter((n) => n.name.toLowerCase().startsWith("pr")).map((n) => n.id);
    const antenna = connectome.neurons.filter((n) => n.name === "Ant1" || n.name === "Ant2").map((n) => n.id);
    const antennaTargets = connectome.edges.filter((e) => antenna.includes(e.source)).sort((a, b) => b.weight - a.weight).slice(0, 8).map((e) => e.target);
    const [touchLeft, touchRight] = this.splitTouch(connectome.touchTargets);
    this.targets = { light, gravity: [.../* @__PURE__ */ new Set([...antenna, ...antennaTargets])], touch_left: touchLeft, touch_right: touchRight, touch: connectome.touchTargets };
    this.lightLeft = light.filter((_, i) => i % 2 === 0);
    this.lightRight = light.filter((_, i) => i % 2 === 1);
    const motorTargets = /* @__PURE__ */ new Set([...this.motorGroups.left, ...this.motorGroups.right]);
    this.plasticEdges = connectome.edges.filter((edge) => motorTargets.has(edge.target) && ["photoreceptor", "sensory neuron", "interneuron", "CNS neuron"].includes(connectome.neurons[edge.source].class)).map((edge) => edge.target * this.n + edge.source);
    this.rebuildWeights();
  }
  connectome;
  n = 177;
  dt = 5;
  seed;
  rng;
  voltage = new Float32Array(177);
  current = new Float32Array(177);
  spikes = new Uint8Array(177);
  refractory = new Int16Array(177);
  rate = new Float32Array(177);
  ablated = new Uint8Array(177);
  baseWeights = new Float32Array(177 * 177);
  weights = new Float32Array(177 * 177);
  signs = new Int8Array(177 * 177).fill(1);
  signRule = "all_excitatory";
  inhibitoryEdges = 0;
  gainProfile = "original";
  gainParameters = { sensory: 1, interneuron: 1, motor: 1, other: 1 };
  gainObjective = null;
  learningEnabled = false;
  plasticFactors = new Float32Array(177 * 177).fill(1);
  eligibility = new Float32Array(177 * 177);
  plasticEdges = [];
  learningReward = 0;
  learningUpdates = 0;
  learnedEdgeCount = 0;
  learningMeanChange = 0;
  timeMs = 0;
  active = /* @__PURE__ */ new Map();
  leftMotor;
  rightMotor;
  motorGroups;
  targets;
  lightLeft;
  lightRight;
  world = { x: 0.5, y: 0.54, heading: -Math.PI / 2, light_x: 0.76, light_y: 0.28, light_strength: 0.38, gravity_angle: Math.PI / 2, touch_x: null, touch_y: null, touch_remaining_ms: 0, touch_side: null };
  splitTouch(touch) {
    const score = (source, motors) => motors.reduce((sum, motor) => {
      let value = this.connectome.adjacency[motor * this.n + source];
      for (let mid = 0; mid < this.n; mid++) value += this.connectome.adjacency[motor * this.n + mid] * this.connectome.adjacency[mid * this.n + source];
      return sum + value;
    }, 0);
    const left = [], right = [];
    for (const id of touch) (score(id, this.leftMotor) >= score(id, this.rightMotor) ? left : right).push(id);
    if (!left.length || !right.length) {
      const mid = Math.max(1, Math.floor(touch.length / 2));
      return [touch.slice(mid), touch.slice(0, mid)];
    }
    return [left, right];
  }
  setSeed(seed) {
    this.seed = clamp(Math.floor(seed), 0, 2147483647);
    this.resetDynamic(true);
  }
  resetDynamic(resetTime) {
    this.voltage.fill(0);
    this.current.fill(0);
    this.spikes.fill(0);
    this.refractory.fill(0);
    this.rate.fill(0);
    this.active.clear();
    if (resetTime) {
      this.timeMs = 0;
      this.rng = rngFrom(this.seed);
      Object.assign(this.world, { x: 0.5, y: 0.54, heading: -Math.PI / 2 });
    }
  }
  reset() {
    this.resetDynamic(true);
    this.ablated.fill(0);
    this.clearLearning();
  }
  stimulate(kind, intensity, duration = 650) {
    if (!this.targets[kind]) throw new Error(`Unknown stimulus: ${kind}`);
    this.active.set(kind, { intensity: clamp(intensity, 0, 1), remaining_ms: clamp(duration, 20, 5e3) });
  }
  setWorld(changes) {
    for (const [key, value] of Object.entries(changes)) {
      if (!["light_x", "light_y", "light_strength", "gravity_angle"].includes(key) || typeof value !== "number") throw new Error(`Unknown world field: ${key}`);
      this.world[key] = key === "gravity_angle" ? value % (2 * Math.PI) : clamp(value, 0, 1);
    }
  }
  touchWorld(x, y, intensity) {
    x = clamp(x, 0, 1);
    y = clamp(y, 0, 1);
    const dx = x - this.world.x, dy = y - this.world.y, hx = Math.cos(this.world.heading), hy = Math.sin(this.world.heading);
    const side = hx * dy - hy * dx < 0 ? "left" : "right";
    Object.assign(this.world, { touch_x: x, touch_y: y, touch_remaining_ms: 650, touch_side: side });
    this.stimulate(`touch_${side}`, intensity);
    return side;
  }
  setAblation(id, value) {
    if (id < 0 || id >= this.n) throw new Error("Neuron id out of range");
    this.ablated[id] = value ? 1 : 0;
    if (value) {
      this.voltage[id] = this.current[id] = this.rate[id] = this.spikes[id] = 0;
    }
  }
  setMotorAblation(side, value) {
    for (const id of this.motorGroups[side]) this.setAblation(id, value);
  }
  setLearning(enabled) {
    this.learningEnabled = enabled;
    this.eligibility.fill(0);
    this.learningReward = 0;
  }
  clearLearning() {
    this.plasticFactors.fill(1);
    this.eligibility.fill(0);
    this.learningReward = 0;
    this.learningUpdates = 0;
    this.learnedEdgeCount = 0;
    this.learningMeanChange = 0;
    this.rebuildWeights();
  }
  setSignRule(rule) {
    if (!SIGN_RULES[rule]) throw new Error(`Unknown sign rule: ${rule}`);
    this.signs.fill(1);
    if (rule === "heuristic_inhibition") {
      const candidates = this.connectome.neurons.filter((n) => n.class === "interneuron").map((n) => ({ id: n.id, degree: this.connectome.outgoing[n.id].length })).filter((x) => x.degree);
      const degrees = candidates.map((x) => x.degree).sort((a, b) => a - b);
      const threshold = degrees[Math.floor(degrees.length * 0.75)] || Infinity;
      for (const { id, degree } of candidates) if (degree >= threshold) for (const edge of this.connectome.outgoing[id]) this.signs[edge.target * this.n + id] = -1;
    } else if (rule === "random_20_inhibitory") {
      const random = rngFrom(2016), shuffled = [...this.connectome.edges];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      for (const edge of shuffled.slice(0, Math.round(shuffled.length * 0.2))) this.signs[edge.target * this.n + edge.source] = -1;
    }
    this.signRule = rule;
    this.rebuildWeights();
    this.resetDynamic(false);
  }
  setGainProfile(profile) {
    if (profile === "original") {
      this.gainParameters = { sensory: 1, interneuron: 1, motor: 1, other: 1 };
      this.gainObjective = null;
    } else if (this.gainObjective === null) this.gainParameters = { sensory: 1.2, interneuron: 1.1, motor: 1, other: 0.9 };
    this.gainProfile = profile;
    this.rebuildWeights();
    this.resetDynamic(false);
  }
  optimizeGains() {
    let best = { sensory: 1, interneuron: 1, motor: 1, other: 1 }, bestScore = -Infinity;
    for (const sensory of [0.8, 1, 1.2]) for (const interneuron of [0.8, 1, 1.2]) for (const motor of [0.8, 1, 1.2]) {
      const candidate = { sensory, interneuron, motor, other: 1 };
      const score = this.gainBenchmark(candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    this.gainParameters = best;
    this.gainProfile = "optimized";
    this.gainObjective = +bestScore.toFixed(5);
    this.rebuildWeights();
    this.resetDynamic(false);
    return { profile: this.gainProfile, parameters: this.gainParameters, objective: this.gainObjective };
  }
  gainBenchmark(parameters) {
    const effective = (target, source) => this.baseWeights[target * this.n + source] * this.signs[target * this.n + source] * parameters[this.gainClass(source)];
    const influence = (sources, motors) => sources.reduce((total, source) => motors.reduce((sum, motor) => {
      let value = effective(motor, source);
      for (let mid = 0; mid < this.n; mid++) value += effective(motor, mid) * effective(mid, source);
      return sum + value;
    }, total), 0);
    const leftInputBias = influence(this.targets.touch_left, this.leftMotor) - influence(this.targets.touch_left, this.rightMotor);
    const rightInputBias = influence(this.targets.touch_right, this.rightMotor) - influence(this.targets.touch_right, this.leftMotor);
    const scalePenalty = 0.01 * (Math.abs(parameters.sensory - 1) + Math.abs(parameters.interneuron - 1) + Math.abs(parameters.motor - 1));
    return (leftInputBias + rightInputBias) / 100 - scalePenalty;
  }
  gainClass(source) {
    const c = this.connectome.neurons[source].class;
    return c === "photoreceptor" || c === "sensory neuron" ? "sensory" : c === "interneuron" ? "interneuron" : c === "motor neuron" ? "motor" : "other";
  }
  rebuildWeights() {
    this.inhibitoryEdges = 0;
    for (let target = 0; target < this.n; target++) for (let source = 0; source < this.n; source++) {
      const i = target * this.n + source;
      this.weights[i] = this.baseWeights[i] * this.signs[i] * this.gainParameters[this.gainClass(source)] * this.plasticFactors[i];
      if (this.weights[i] < 0) this.inhibitoryEdges++;
    }
  }
  step() {
    const distanceBefore = Math.hypot(this.world.light_x - this.world.x, this.world.light_y - this.world.y);
    const previousSpikes = this.spikes;
    const recurrent = new Float32Array(this.n);
    for (let source = 0; source < this.n; source++) if (this.spikes[source]) for (const edge of this.connectome.outgoing[source]) recurrent[edge.target] += this.weights[edge.target * this.n + source];
    const external = new Float32Array(this.n);
    this.worldInput(external);
    for (const [kind, state] of this.active) {
      for (const id of this.targets[kind]) external[id] += 1.95 * state.intensity;
      state.remaining_ms -= this.dt;
      if (state.remaining_ms <= 0) this.active.delete(kind);
    }
    const next = new Uint8Array(this.n), decay = Math.exp(-this.dt / 12);
    for (let i = 0; i < this.n; i++) {
      this.current[i] = this.current[i] * decay + recurrent[i];
      const available = this.refractory[i] <= 0 && !this.ablated[i];
      if (available) this.voltage[i] += 0.25 * (-this.voltage[i] + this.current[i] + external[i] + normal(this.rng) * 0.018);
      else this.voltage[i] = 0;
      this.refractory[i]--;
      if (available && this.voltage[i] >= 1) {
        next[i] = 1;
        this.voltage[i] = 0;
        this.refractory[i] = 2;
      }
      if (this.ablated[i]) this.current[i] = 0;
      this.rate[i] = 0.92 * this.rate[i] + 0.08 * next[i];
    }
    this.spikes = next;
    this.advanceWorld();
    if (this.learningEnabled) {
      const distanceAfter = Math.hypot(this.world.light_x - this.world.x, this.world.light_y - this.world.y);
      this.applyLearning(distanceBefore, distanceAfter, previousSpikes, next);
    }
    this.timeMs += this.dt;
  }
  worldInput(out) {
    const w = this.world, dx = w.light_x - w.x, dy = w.light_y - w.y;
    const distance = Math.hypot(dx, dy);
    const bearing = Math.atan2(Math.sin(Math.atan2(dy, dx) - w.heading), Math.cos(Math.atan2(dy, dx) - w.heading));
    const light = w.light_strength * Math.max(0, 1 - distance / 1.25), contrast = Math.sin(bearing);
    for (const id of this.lightLeft) out[id] += 0.86 + light * (1.25 + 0.75 * Math.max(0, contrast));
    for (const id of this.lightRight) out[id] += 0.86 + light * (1.25 + 0.75 * Math.max(0, -contrast));
    const ant = this.targets.gravity.slice(0, 2), tilt = Math.sin(w.gravity_angle - w.heading);
    if (ant[0] !== void 0) out[ant[0]] += 0.86 + 0.42 * Math.max(0, tilt);
    if (ant[1] !== void 0) out[ant[1]] += 0.86 + 0.42 * Math.max(0, -tilt);
  }
  mean(ids) {
    return ids.reduce((sum, id) => sum + this.rate[id], 0) / Math.max(1, ids.length);
  }
  advanceWorld() {
    const left = this.mean(this.leftMotor), right = this.mean(this.rightMotor), direction = (right - left) / (right + left + 0.02), dt = this.dt / 1e3;
    this.world.heading = (this.world.heading + direction * 2.4 * dt) % (2 * Math.PI);
    const speed = 0.012 + 0.075 * Math.min(1, (left + right) * 4);
    this.world.x = (this.world.x + Math.cos(this.world.heading) * speed * dt + 1) % 1;
    this.world.y = (this.world.y + Math.sin(this.world.heading) * speed * dt + 1) % 1;
    if (this.world.touch_remaining_ms > 0 && (this.world.touch_remaining_ms -= this.dt) <= 0) Object.assign(this.world, { touch_x: null, touch_y: null, touch_side: null });
  }
  applyLearning(distanceBefore, distanceAfter, previous, next) {
    const instantaneous = clamp((distanceBefore - distanceAfter) * 700, -1, 1);
    this.learningReward = 0.96 * this.learningReward + 0.04 * instantaneous;
    let changed = 0, totalChange = 0;
    for (const index of this.plasticEdges) {
      const source = index % this.n, target = Math.floor(index / this.n);
      const coactivity = previous[source] ? next[target] ? 1 : 0.12 : 0;
      const eligibility = this.eligibility[index] = 0.985 * this.eligibility[index] + coactivity;
      if (eligibility > 1e-3 && Math.abs(this.learningReward) > 1e-4) {
        this.plasticFactors[index] = clamp(this.plasticFactors[index] + 15e-4 * this.learningReward * eligibility, 0.7, 1.3);
        this.weights[index] = this.baseWeights[index] * this.signs[index] * this.gainParameters[this.gainClass(source)] * this.plasticFactors[index];
      }
      const delta = Math.abs(this.plasticFactors[index] - 1);
      if (delta > 1e-3) changed++;
      totalChange += delta;
    }
    this.learningUpdates++;
    this.learnedEdgeCount = changed;
    this.learningMeanChange = totalChange / Math.max(1, this.plasticEdges.length);
  }
  snapshot() {
    const left = this.mean(this.leftMotor), right = this.mean(this.rightMotor), direction = clamp((right - left) / (right + left + 0.02), -1, 1);
    const spikeIds = [...this.spikes.keys()].filter((i) => this.spikes[i]);
    return { type: "state", time_ms: this.timeMs, spikes: spikeIds, firing_count: spikeIds.length, direction: +direction.toFixed(3), motor: { left: +left.toFixed(3), right: +right.toFixed(3) }, active_stimuli: [...this.active.keys()], ablated: [...this.ablated.keys()].filter((i) => this.ablated[i]), sign_rule: this.signRule, sign_rule_label: SIGN_RULES[this.signRule].label, inhibitory_edges: this.inhibitoryEdges, seed: this.seed, gain_profile: this.gainProfile, gain_profile_label: GAIN_PROFILES[this.gainProfile].label, gain_parameters: this.gainParameters, gain_objective: this.gainObjective, learning: { enabled: this.learningEnabled, rule: "reward_modulated_eligibility", task: "Modeled light-approach proxy", plastic_edges: this.plasticEdges.length, modified_edges: this.learnedEdgeCount, mean_abs_change: +this.learningMeanChange.toFixed(5), reward: +this.learningReward.toFixed(5), updates: this.learningUpdates, assumption: "Experimental rule; topology is measured, plasticity and reward are modeled." }, world: Object.fromEntries(Object.entries(this.world).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(5) : v])) };
  }
  metadata() {
    return { type: "metadata", neurons: this.connectome.neurons, stimulus_targets: Object.fromEntries(Object.entries(this.targets).map(([k, ids]) => [k, ids.map((id) => this.connectome.neurons[id].name)])), connections: this.connectome.edges, sign_rules: SIGN_RULES, gain_profiles: GAIN_PROFILES, motor_groups: this.motorGroups, source: { dataset: "Ryan et al. 2016 / Netzschleuder cintestinalis", graph_nodes: this.connectome.fullNodes, graph_edges: this.connectome.fullEdges, simulated_cns_neurons: 177, synapse_note: "Synaptic signs are not fully annotated in the original connectome; all inhibition and learning modes are explicit assumptions.", provenance: { measured: ["Neuron identities and directed edges", "Cumulative presynaptic contact depth", "Explicit L/R suffixes in source labels"], derived: ["Log-scaled LIF connection magnitudes", "Motor-pool laterality score", "Two-hop touch target partition"], heuristic: ["Synaptic signs", "World-to-sensory transduction", "Retinal left/right proxy banks", "Larval movement physics and reward-modulated plasticity"] } } };
  }
  tracePath(target, stimulus2) {
    const sources = new Set(this.targets[stimulus2]), queue = [...sources].map((id) => [id]);
    let path = [];
    while (queue.length) {
      const candidate = queue.shift();
      const node = candidate.at(-1);
      if (node === target) {
        path = candidate;
        break;
      }
      if (candidate.length >= 8) continue;
      for (const edge of [...this.connectome.outgoing[node]].sort((a, b) => b.weight - a.weight)) if (!candidate.includes(edge.target)) queue.push([...candidate, edge.target]);
    }
    return { type: "path", stimulus: stimulus2, target, found: !!path.length, nodes: path.map((id) => ({ id, name: this.connectome.neurons[id].name })), edges: path.slice(1).map((id, i) => ({ source: path[i], target: id, source_name: this.connectome.neurons[path[i]].name, target_name: this.connectome.neurons[id].name, source_weight: this.connectome.adjacency[id * this.n + path[i]], effective_weight: this.weights[id * this.n + path[i]] })), note: "Topology is measured; stimulus membership, signs, scaling and effective weights may be model-derived or heuristic." };
  }
};
function runComparison(current, stimulus2, intensity) {
  const trial = (intervention2) => {
    const sim = new Simulator(current.connectome, current.seed);
    if (intervention2) {
      sim.setSignRule(current.signRule);
      sim.gainParameters = { ...current.gainParameters };
      sim.gainProfile = current.gainProfile;
      sim.plasticFactors.set(current.plasticFactors);
      sim.rebuildWeights();
      current.ablated.forEach((v, i) => {
        if (v) sim.setAblation(i, true);
      });
    }
    sim.stimulate(stimulus2, intensity, 700);
    const values = [], left = [], right = [];
    for (let i = 0; i < 220; i++) {
      sim.step();
      if (sim.timeMs >= 250) {
        const state = sim.snapshot();
        values.push(state.direction);
        left.push(state.motor.left);
        right.push(state.motor.right);
      }
    }
    const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
    return { laterality: +mean(values).toFixed(4), left_motor: +mean(left).toFixed(4), right_motor: +mean(right).toFixed(4) };
  };
  const baseline = trial(false), intervention = trial(true);
  return { type: "comparison", stimulus: stimulus2, baseline, intervention, delta: +(intervention.laterality - baseline.laterality).toFixed(4), baseline_config: "All excitatory \xB7 source-derived gains \xB7 original weights \xB7 no ablations", intervention_config: `${SIGN_RULES[current.signRule].label} \xB7 ${GAIN_PROFILES[current.gainProfile].label} \xB7 ${current.learnedEdgeCount} learned edges \xB7 ${current.ablated.reduce((a, b) => a + b, 0)} ablated` };
}

// src/live-runtime.ts
var PUBLIC_COMMANDS = /* @__PURE__ */ new Set(["stimulate", "world", "world_touch", "trace_path", "run_comparison"]);
var STIMULI = /* @__PURE__ */ new Set(["light", "gravity", "touch_left", "touch_right", "touch"]);
function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`);
  return number;
}
function stimulus(value) {
  const name = String(value || "");
  if (!STIMULI.has(name)) throw new Error("Unknown stimulus.");
  return name;
}
var LiveCionaRuntime = class {
  simulator;
  bornAt = (/* @__PURE__ */ new Date()).toISOString();
  generation = Date.now().toString(36);
  viewers = 0;
  lastHumanAt = 0;
  nextTouchMs = 9e3;
  touchLeft = true;
  lastEvent = "Larva entered the shared world";
  lastEventAt = 0;
  constructor(connectome, seed = 2016) {
    this.simulator = new Simulator(connectome, seed);
    this.simulator.setSignRule("heuristic_inhibition");
    this.simulator.setLearning(true);
  }
  metadata() {
    return {
      ...this.simulator.metadata(),
      runtime: {
        mode: "shared_live",
        label: "Shared live Ciona",
        autonomous_world: true,
        public_commands: [...PUBLIC_COMMANDS],
        note: "Neural state is server-authoritative and shared. World autonomy and sensory transduction are model assumptions."
      }
    };
  }
  state() {
    return {
      ...this.simulator.snapshot(),
      paused: false,
      speed: 1,
      experiment: { active: false, replaying: false, event_count: 0 },
      live: {
        mode: "shared_live",
        generation: this.generation,
        born_at: this.bornAt,
        age_seconds: +(this.simulator.timeMs / 1e3).toFixed(1),
        viewer_count: this.viewers,
        autonomous: this.isAutonomous(),
        last_event: this.lastEvent,
        last_event_at_ms: this.lastEventAt
      }
    };
  }
  tick(steps = 10) {
    for (let i = 0; i < steps; i++) {
      this.driveAutonomousWorld();
      this.simulator.step();
    }
  }
  /** Apply the deliberately small set of public, non-destructive commands. */
  command(command) {
    const type = String(command.type || "");
    if (!PUBLIC_COMMANDS.has(type)) {
      throw new Error("This changes the shared organism. Switch to Local lab for model changes, ablation, replay, pause, or reset.");
    }
    if (type === "trace_path") {
      const neuron = finite(command.neuron_id, "neuron_id");
      if (!Number.isInteger(neuron) || neuron < 0 || neuron >= this.simulator.n) throw new Error("neuron_id is out of range.");
      return [this.simulator.tracePath(neuron, stimulus(command.stimulus))];
    }
    if (type === "run_comparison") {
      return [runComparison(this.simulator, stimulus(command.stimulus), finite(command.intensity, "intensity"))];
    }
    this.lastHumanAt = this.simulator.timeMs;
    if (type === "stimulate") {
      const kind = stimulus(command.stimulus);
      this.simulator.stimulate(kind, finite(command.intensity, "intensity"), finite(command.duration_ms ?? 650, "duration_ms"));
      this.note(`Visitor applied ${kind.replaceAll("_", " ")}`);
    } else if (type === "world") {
      if (!command.changes || typeof command.changes !== "object" || Array.isArray(command.changes)) throw new Error("changes must be an object.");
      const changes = Object.fromEntries(Object.entries(command.changes).map(([key, value]) => [key, finite(value, key)]));
      this.simulator.setWorld(changes);
      this.note("Visitor changed the sensory field");
    } else if (type === "world_touch") {
      const side = this.simulator.touchWorld(finite(command.x, "x"), finite(command.y, "y"), finite(command.intensity, "intensity"));
      this.note(`Visitor touched the ${side} side`);
    }
    return [this.state()];
  }
  isAutonomous() {
    return this.simulator.timeMs - this.lastHumanAt >= 8e3;
  }
  driveAutonomousWorld() {
    if (!this.isAutonomous()) return;
    const seconds = this.simulator.timeMs / 1e3;
    this.simulator.setWorld({
      light_x: 0.5 + 0.34 * Math.cos(seconds / 10.5),
      light_y: 0.5 + 0.29 * Math.sin(seconds / 13),
      light_strength: 0.42 + 0.12 * Math.sin(seconds / 17),
      gravity_angle: Math.PI / 2 + 0.35 * Math.sin(seconds / 23)
    });
    if (this.simulator.timeMs >= this.nextTouchMs) {
      const heading = this.simulator.world.heading;
      const normal2 = this.touchLeft ? -1 : 1;
      const x = this.simulator.world.x + Math.cos(heading + normal2 * Math.PI / 2) * 0.035;
      const y = this.simulator.world.y + Math.sin(heading + normal2 * Math.PI / 2) * 0.035;
      const side = this.simulator.touchWorld(x, y, 0.48);
      this.note(`Autonomous world contact \xB7 ${side}`);
      this.touchLeft = !this.touchLeft;
      this.nextTouchMs += 17e3;
    }
  }
  note(value) {
    this.lastEvent = value;
    this.lastEventAt = this.simulator.timeMs;
  }
};

// src/server.ts
var root = join(process.cwd(), "static");
var port = Number(process.env.PORT || 8765);
var mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json" };
var graph = parseConnectome(readFileSync(join(process.cwd(), "data/nodes.csv"), "utf8"), readFileSync(join(process.cwd(), "data/edges.csv"), "utf8"));
var live = new LiveCionaRuntime(graph);
var server = createServer(async (request, response) => {
  try {
    if (request.url === "/api/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", runtime: "shared-live-ciona", neurons: 177, edges: 2903, viewers: live.viewers, generation: live.generation, age_seconds: +(live.simulator.timeMs / 1e3).toFixed(1) }));
      return;
    }
    const urlPath = request.url === "/" ? "index.html" : (request.url || "/").split("?")[0].replace(/^\/static\//, "");
    const file = normalize(join(root, urlPath));
    if (!file.startsWith(root) || !(await stat(file)).isFile()) throw new Error("not found");
    response.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    response.setHeader("cache-control", extname(file) === ".html" ? "no-cache" : "public, max-age=3600");
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
});
var sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url || "/", "http://localhost").pathname !== "/ws") {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
});
function send(client, message) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}
function broadcast(message) {
  const encoded = JSON.stringify(message);
  for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(encoded);
}
sockets.on("connection", (client) => {
  live.viewers = sockets.clients.size;
  let nextCommandAt = 0;
  send(client, live.metadata());
  broadcast(live.state());
  client.on("message", (raw) => {
    try {
      const now = Date.now();
      if (now < nextCommandAt) throw new Error("Interaction rate limit: wait a moment and try again.");
      nextCommandAt = now + 180;
      const command = JSON.parse(raw.toString());
      for (const message of live.command(command)) send(client, message);
    } catch (error) {
      send(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
  client.on("close", () => {
    live.viewers = sockets.clients.size;
    broadcast(live.state());
  });
});
var broadcasts = 0;
setInterval(() => {
  live.tick(10);
  if (++broadcasts % 2 === 0) broadcast(live.state());
}, 50);
server.listen(port, "0.0.0.0", () => console.log(`CionaBrain shared organism listening on :${port}`));
