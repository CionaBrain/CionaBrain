import type { Connectome, Edge } from "./connectome";

export type SignRule = "all_excitatory" | "heuristic_inhibition" | "random_20_inhibitory";
export type GainProfile = "original" | "optimized";
type Stimulus = "light" | "gravity" | "touch_left" | "touch_right" | "touch";
type GainParameters = { sensory: number; interneuron: number; motor: number; other: number };

const SIGN_RULES = {
  all_excitatory: { label: "All excitatory", description: "Compatibility mode: every observed edge is positive.", experimental: false },
  heuristic_inhibition: { label: "Heuristic inhibition", description: "Edges from high-out-degree named interneurons are negative. This is a transparent heuristic, not physiological annotation.", experimental: true },
  random_20_inhibitory: { label: "Random 20% inhibitory", description: "A deterministic random 20% of observed edges is negative for comparison.", experimental: true },
};
const GAIN_PROFILES = {
  original: { label: "Source-derived weights", description: "Ryan et al. contact depth after fixed log scaling; no fitted gain multipliers.", experimental: false },
  optimized: { label: "Calibrated class gains", description: "Experimental class-level multipliers selected on a synthetic left/right touch benchmark.", experimental: true },
};

function rngFrom(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value += 0x6D2B79F5; let t = value; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function normal(rng: () => number): number { return Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(2 * Math.PI * rng()); }
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export class Simulator {
  readonly n = 177;
  readonly dt = 5;
  seed: number;
  rng: () => number;
  voltage = new Float32Array(177);
  current = new Float32Array(177);
  spikes = new Uint8Array(177);
  refractory = new Int16Array(177);
  rate = new Float32Array(177);
  ablated = new Uint8Array(177);
  baseWeights = new Float32Array(177 * 177);
  weights = new Float32Array(177 * 177);
  signs = new Int8Array(177 * 177).fill(1);
  signRule: SignRule = "all_excitatory";
  inhibitoryEdges = 0;
  gainProfile: GainProfile = "original";
  gainParameters: GainParameters = { sensory: 1, interneuron: 1, motor: 1, other: 1 };
  gainObjective: number | null = null;
  learningEnabled = false;
  plasticFactors = new Float32Array(177 * 177).fill(1);
  eligibility = new Float32Array(177 * 177);
  plasticEdges: number[] = [];
  learningReward = 0;
  learningUpdates = 0;
  learnedEdgeCount = 0;
  learningMeanChange = 0;
  timeMs = 0;
  // Behavioural readouts are deliberately kept separate: a larva can move
  // forward while its left/right motor output is balanced. `turnBias` is a
  // short low-pass filtered motor-pool difference; `swimSpeed` is the modeled
  // translation speed used by the world (neither is a measured kinematic).
  turnBias = 0;
  rawTurnBias = 0;
  swimSpeed = .012;
  active = new Map<Stimulus, { intensity: number; remaining_ms: number }>();
  leftMotor: number[];
  rightMotor: number[];
  motorGroups: { left: number[]; right: number[] };
  targets: Record<Stimulus, number[]>;
  lightLeft: number[];
  lightRight: number[];
  world = { x: .5, y: .54, heading: -Math.PI / 2, light_x: .76, light_y: .28, light_strength: .38, gravity_angle: Math.PI / 2, touch_x: null as number | null, touch_y: null as number | null, touch_remaining_ms: 0, touch_side: null as "left" | "right" | null };

  constructor(readonly connectome: Connectome, seed = 7) {
    this.seed = seed; this.rng = rngFrom(seed);
    const nonzero = [...connectome.adjacency].filter(value => value > 0).sort((a, b) => a - b);
    const scale = nonzero[Math.floor(nonzero.length * .95)] || 1;
    // Contact depth is not conductance. A conservative global factor keeps the
    // recurrent network responsive without turning a brief input into permanent
    // self-excitation; the original contact depths remain untouched in data/.
    for (let i = 0; i < this.baseWeights.length; i++) this.baseWeights[i] = Math.log1p(connectome.adjacency[i] / scale) * .75;
    this.leftMotor = connectome.neurons.filter(n => n.name.startsWith("MN") && n.name.endsWith("L")).map(n => n.id);
    this.rightMotor = connectome.neurons.filter(n => n.name.startsWith("MN") && n.name.endsWith("R")).map(n => n.id);
    this.motorGroups = {
      left: connectome.neurons.filter(n => n.name.endsWith("L") && (n.name.startsWith("MN") || n.name.startsWith("MGIN"))).map(n => n.id),
      right: connectome.neurons.filter(n => n.name.endsWith("R") && (n.name.startsWith("MN") || n.name.startsWith("MGIN"))).map(n => n.id),
    };
    const light = connectome.neurons.filter(n => n.name.toLowerCase().startsWith("pr")).map(n => n.id);
    const antenna = connectome.neurons.filter(n => n.name === "Ant1" || n.name === "Ant2").map(n => n.id);
    const antennaTargets = connectome.edges.filter(e => antenna.includes(e.source)).sort((a, b) => b.weight - a.weight).slice(0, 8).map(e => e.target);
    const [touchLeft, touchRight] = this.splitTouch(connectome.touchTargets);
    this.targets = { light, gravity: [...new Set([...antenna, ...antennaTargets])], touch_left: touchLeft, touch_right: touchRight, touch: connectome.touchTargets };
    this.lightLeft = light.filter((_, i) => i % 2 === 0); this.lightRight = light.filter((_, i) => i % 2 === 1);
    const motorTargets = new Set([...this.motorGroups.left, ...this.motorGroups.right]);
    this.plasticEdges = connectome.edges.filter(edge => motorTargets.has(edge.target) && ["photoreceptor", "sensory neuron", "interneuron", "CNS neuron"].includes(connectome.neurons[edge.source].class)).map(edge => edge.target * this.n + edge.source);
    this.rebuildWeights();
  }

  private splitTouch(touch: number[]): [number[], number[]] {
    const score = (source: number, motors: number[]) => motors.reduce((sum, motor) => {
      let value = this.connectome.adjacency[motor * this.n + source];
      for (let mid = 0; mid < this.n; mid++) value += this.connectome.adjacency[motor * this.n + mid] * this.connectome.adjacency[mid * this.n + source];
      return sum + value;
    }, 0);
    const left: number[] = [], right: number[] = [];
    for (const id of touch) (score(id, this.leftMotor) >= score(id, this.rightMotor) ? left : right).push(id);
    if (!left.length || !right.length) { const mid = Math.max(1, Math.floor(touch.length / 2)); return [touch.slice(mid), touch.slice(0, mid)]; }
    return [left, right];
  }

  setSeed(seed: number): void { this.seed = clamp(Math.floor(seed), 0, 2147483647); this.resetDynamic(true); }
  resetDynamic(resetTime: boolean): void { this.voltage.fill(0); this.current.fill(0); this.spikes.fill(0); this.refractory.fill(0); this.rate.fill(0); this.active.clear(); this.turnBias = this.rawTurnBias = 0; this.swimSpeed = .012; if (resetTime) { this.timeMs = 0; this.rng = rngFrom(this.seed); Object.assign(this.world, { x: .5, y: .54, heading: -Math.PI / 2 }); } }
  reset(): void { this.resetDynamic(true); this.ablated.fill(0); this.clearLearning(); }
  stimulate(kind: Stimulus, intensity: number, duration = 650): void { if (!this.targets[kind]) throw new Error(`Unknown stimulus: ${kind}`); this.active.set(kind, { intensity: clamp(intensity, 0, 1), remaining_ms: clamp(duration, 20, 5000) }); }
  setWorld(changes: Partial<typeof this.world>): void { for (const [key, value] of Object.entries(changes)) { if (!["light_x", "light_y", "light_strength", "gravity_angle"].includes(key) || typeof value !== "number") throw new Error(`Unknown world field: ${key}`); (this.world as unknown as Record<string, number>)[key] = key === "gravity_angle" ? value % (2 * Math.PI) : clamp(value, 0, 1); } }
  touchWorld(x: number, y: number, intensity: number): "left" | "right" { x = clamp(x, 0, 1); y = clamp(y, 0, 1); const dx = x - this.world.x, dy = y - this.world.y, hx = Math.cos(this.world.heading), hy = Math.sin(this.world.heading); const side = hx * dy - hy * dx < 0 ? "left" : "right"; Object.assign(this.world, { touch_x: x, touch_y: y, touch_remaining_ms: 650, touch_side: side }); this.stimulate(`touch_${side}`, intensity); return side; }
  setAblation(id: number, value: boolean): void { if (id < 0 || id >= this.n) throw new Error("Neuron id out of range"); this.ablated[id] = value ? 1 : 0; if (value) { this.voltage[id] = this.current[id] = this.rate[id] = this.spikes[id] = 0; } }
  setMotorAblation(side: "left" | "right", value: boolean): void { for (const id of this.motorGroups[side]) this.setAblation(id, value); }

  setLearning(enabled: boolean): void { this.learningEnabled = enabled; this.eligibility.fill(0); this.learningReward = 0; }
  clearLearning(): void { this.plasticFactors.fill(1); this.eligibility.fill(0); this.learningReward = 0; this.learningUpdates = 0; this.learnedEdgeCount = 0; this.learningMeanChange = 0; this.rebuildWeights(); }

  setSignRule(rule: SignRule): void {
    if (!SIGN_RULES[rule]) throw new Error(`Unknown sign rule: ${rule}`); this.signs.fill(1);
    if (rule === "heuristic_inhibition") {
      const candidates = this.connectome.neurons.filter(n => n.class === "interneuron").map(n => ({ id: n.id, degree: this.connectome.outgoing[n.id].length })).filter(x => x.degree);
      const degrees = candidates.map(x => x.degree).sort((a, b) => a - b); const threshold = degrees[Math.floor(degrees.length * .75)] || Infinity;
      for (const { id, degree } of candidates) if (degree >= threshold) for (const edge of this.connectome.outgoing[id]) this.signs[edge.target * this.n + id] = -1;
    } else if (rule === "random_20_inhibitory") {
      const random = rngFrom(2016), shuffled = [...this.connectome.edges];
      for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      for (const edge of shuffled.slice(0, Math.round(shuffled.length * .2))) this.signs[edge.target * this.n + edge.source] = -1;
    }
    this.signRule = rule; this.rebuildWeights(); this.resetDynamic(false);
  }
  setGainProfile(profile: GainProfile): void { if (profile === "original") { this.gainParameters = { sensory: 1, interneuron: 1, motor: 1, other: 1 }; this.gainObjective = null; } else if (this.gainObjective === null) this.gainParameters = { sensory: 1.2, interneuron: 1.1, motor: 1, other: .9 }; this.gainProfile = profile; this.rebuildWeights(); this.resetDynamic(false); }
  optimizeGains(): { profile: GainProfile; parameters: GainParameters; objective: number } {
    let best = { sensory: 1, interneuron: 1, motor: 1, other: 1 }, bestScore = -Infinity;
    for (const sensory of [.8, 1, 1.2]) for (const interneuron of [.8, 1, 1.2]) for (const motor of [.8, 1, 1.2]) {
      const candidate = { sensory, interneuron, motor, other: 1 };
      const score = this.gainBenchmark(candidate);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    this.gainParameters = best; this.gainProfile = "optimized"; this.gainObjective = +bestScore.toFixed(5); this.rebuildWeights(); this.resetDynamic(false);
    return { profile: this.gainProfile, parameters: this.gainParameters, objective: this.gainObjective };
  }
  private gainBenchmark(parameters: GainParameters): number {
    const effective = (target: number, source: number) => this.baseWeights[target * this.n + source] * this.signs[target * this.n + source] * parameters[this.gainClass(source)];
    const influence = (sources: number[], motors: number[]) => sources.reduce((total, source) => motors.reduce((sum, motor) => {
      let value = effective(motor, source);
      for (let mid = 0; mid < this.n; mid++) value += effective(motor, mid) * effective(mid, source);
      return sum + value;
    }, total), 0);
    const leftInputBias = influence(this.targets.touch_left, this.leftMotor) - influence(this.targets.touch_left, this.rightMotor);
    const rightInputBias = influence(this.targets.touch_right, this.rightMotor) - influence(this.targets.touch_right, this.leftMotor);
    const scalePenalty = .01 * (Math.abs(parameters.sensory - 1) + Math.abs(parameters.interneuron - 1) + Math.abs(parameters.motor - 1));
    return (leftInputBias + rightInputBias) / 100 - scalePenalty;
  }
  private gainClass(source: number): keyof GainParameters { const c = this.connectome.neurons[source].class; return c === "photoreceptor" || c === "sensory neuron" ? "sensory" : c === "interneuron" ? "interneuron" : c === "motor neuron" ? "motor" : "other"; }
  rebuildWeights(): void { this.inhibitoryEdges = 0; for (let target = 0; target < this.n; target++) for (let source = 0; source < this.n; source++) { const i = target * this.n + source; this.weights[i] = this.baseWeights[i] * this.signs[i] * this.gainParameters[this.gainClass(source)] * this.plasticFactors[i]; if (this.weights[i] < 0) this.inhibitoryEdges++; } }

  step(): void {
    const distanceBefore = Math.hypot(this.world.light_x - this.world.x, this.world.light_y - this.world.y);
    const previousSpikes = this.spikes;
    const recurrent = new Float32Array(this.n);
    for (let source = 0; source < this.n; source++) if (this.spikes[source]) for (const edge of this.connectome.outgoing[source]) recurrent[edge.target] += this.weights[edge.target * this.n + source];
    const external = new Float32Array(this.n); this.worldInput(external);
    for (const [kind, state] of this.active) { for (const id of this.targets[kind]) external[id] += 1.95 * state.intensity; state.remaining_ms -= this.dt; if (state.remaining_ms <= 0) this.active.delete(kind); }
    const next = new Uint8Array(this.n), decay = Math.exp(-this.dt / 12);
    for (let i = 0; i < this.n; i++) {
      this.current[i] = this.current[i] * decay + recurrent[i]; const available = this.refractory[i] <= 0 && !this.ablated[i];
      if (available) this.voltage[i] += .25 * (-this.voltage[i] + this.current[i] + external[i] + normal(this.rng) * .018); else this.voltage[i] = 0;
      this.refractory[i]--; if (available && this.voltage[i] >= 1) { next[i] = 1; this.voltage[i] = 0; this.refractory[i] = 2; }
      if (this.ablated[i]) this.current[i] = 0; this.rate[i] = .92 * this.rate[i] + .08 * next[i];
    }
    this.spikes = next; this.advanceWorld();
    if (this.learningEnabled) {
      const distanceAfter = Math.hypot(this.world.light_x - this.world.x, this.world.light_y - this.world.y);
      this.applyLearning(distanceBefore, distanceAfter, previousSpikes, next);
    }
    this.timeMs += this.dt;
  }
  private worldInput(out: Float32Array): void {
    const w = this.world, dx = w.light_x - w.x, dy = w.light_y - w.y;
    const distance = Math.hypot(dx, dy);
    const bearing = Math.atan2(Math.sin(Math.atan2(dy, dx) - w.heading), Math.cos(Math.atan2(dy, dx) - w.heading));
    const light = w.light_strength * Math.max(0, 1 - distance / 1.25), contrast = Math.sin(bearing);
    // Modeled sensory transduction (not measured current): tonic sub-threshold
    // drive plus a spatial component lets the autonomous world cross the LIF
    // threshold intermittently instead of requiring a visitor button press.
    for (const id of this.lightLeft) out[id] += .86 + light * (1.25 + .75 * Math.max(0, contrast));
    for (const id of this.lightRight) out[id] += .86 + light * (1.25 + .75 * Math.max(0, -contrast));
    const ant = this.targets.gravity.slice(0, 2), tilt = Math.sin(w.gravity_angle - w.heading);
    if (ant[0] !== undefined) out[ant[0]] += .86 + .42 * Math.max(0, tilt);
    if (ant[1] !== undefined) out[ant[1]] += .86 + .42 * Math.max(0, -tilt);
  }
  private mean(ids: number[]): number { return ids.reduce((sum, id) => sum + this.rate[id], 0) / Math.max(1, ids.length); }
  private advanceWorld(): void {
    const left = this.mean(this.leftMotor), right = this.mean(this.rightMotor), dt = this.dt / 1000;
    this.rawTurnBias = clamp((right - left) / (right + left + .02), -1, 1);
    // Motor spikes are sparse at 5 ms resolution. A 300 ms exponential readout
    // approximates short behavioural persistence and prevents a turn from
    // disappearing from the UI on the very next spike-free frame.
    const turnAlpha = 1 - Math.exp(-this.dt / 300);
    this.turnBias += turnAlpha * (this.rawTurnBias - this.turnBias);
    const motorDrive = Math.min(1, (left + right) * 4);
    // The small baseline speed is an explicit world-model assumption. It means
    // score 0 can correctly mean "swimming straight", not "stationary".
    this.swimSpeed = .012 + .075 * motorDrive;
    this.world.heading = (this.world.heading + this.turnBias * 2.4 * dt) % (2 * Math.PI);
    this.world.x = (this.world.x + Math.cos(this.world.heading) * this.swimSpeed * dt + 1) % 1;
    this.world.y = (this.world.y + Math.sin(this.world.heading) * this.swimSpeed * dt + 1) % 1;
    if (this.world.touch_remaining_ms > 0 && (this.world.touch_remaining_ms -= this.dt) <= 0) Object.assign(this.world, { touch_x: null, touch_y: null, touch_side: null });
  }

  private applyLearning(distanceBefore: number, distanceAfter: number, previous: Uint8Array, next: Uint8Array): void {
    // Experimental reward-modulated eligibility trace. Ryan et al. provide the
    // topology/contact depths, not this plasticity rule. Moving closer to the
    // modeled light is an explicit proxy reward and is not asserted to be the
    // natural objective of a Ciona larva.
    const instantaneous = clamp((distanceBefore - distanceAfter) * 700, -1, 1);
    this.learningReward = .96 * this.learningReward + .04 * instantaneous;
    let changed = 0, totalChange = 0;
    for (const index of this.plasticEdges) {
      const source = index % this.n, target = Math.floor(index / this.n);
      const coactivity = previous[source] ? (next[target] ? 1 : .12) : 0;
      const eligibility = this.eligibility[index] = .985 * this.eligibility[index] + coactivity;
      if (eligibility > .001 && Math.abs(this.learningReward) > .0001) {
        this.plasticFactors[index] = clamp(this.plasticFactors[index] + .0015 * this.learningReward * eligibility, .7, 1.3);
        this.weights[index] = this.baseWeights[index] * this.signs[index] * this.gainParameters[this.gainClass(source)] * this.plasticFactors[index];
      }
      const delta = Math.abs(this.plasticFactors[index] - 1);
      if (delta > .001) changed++;
      totalChange += delta;
    }
    this.learningUpdates++;
    this.learnedEdgeCount = changed;
    this.learningMeanChange = totalChange / Math.max(1, this.plasticEdges.length);
  }

  snapshot(): Record<string, unknown> { const left = this.mean(this.leftMotor), right = this.mean(this.rightMotor); const spikeIds = [...this.spikes.keys()].filter(i => this.spikes[i]); return { type: "state", time_ms: this.timeMs, spikes: spikeIds, firing_count: spikeIds.length, direction: +this.turnBias.toFixed(3), movement: { speed: +this.swimSpeed.toFixed(4), motor_drive: +Math.min(1, (left + right) * 4).toFixed(3), raw_laterality: +this.rawTurnBias.toFixed(3), note: "Modeled kinematics; speed and temporal smoothing are not measured animal behaviour." }, motor: { left: +left.toFixed(3), right: +right.toFixed(3) }, active_stimuli: [...this.active.keys()], ablated: [...this.ablated.keys()].filter(i => this.ablated[i]), sign_rule: this.signRule, sign_rule_label: SIGN_RULES[this.signRule].label, inhibitory_edges: this.inhibitoryEdges, seed: this.seed, gain_profile: this.gainProfile, gain_profile_label: GAIN_PROFILES[this.gainProfile].label, gain_parameters: this.gainParameters, gain_objective: this.gainObjective, learning: { enabled: this.learningEnabled, rule: "reward_modulated_eligibility", task: "Modeled light-approach proxy", plastic_edges: this.plasticEdges.length, modified_edges: this.learnedEdgeCount, mean_abs_change: +this.learningMeanChange.toFixed(5), reward: +this.learningReward.toFixed(5), updates: this.learningUpdates, assumption: "Experimental rule; topology is measured, plasticity and reward are modeled." }, world: Object.fromEntries(Object.entries(this.world).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(5) : v])) }; }
  metadata(): Record<string, unknown> { return { type: "metadata", neurons: this.connectome.neurons, stimulus_targets: Object.fromEntries(Object.entries(this.targets).map(([k, ids]) => [k, ids.map(id => this.connectome.neurons[id].name)])), connections: this.connectome.edges, sign_rules: SIGN_RULES, gain_profiles: GAIN_PROFILES, motor_groups: this.motorGroups, source: { dataset: "Ryan et al. 2016 / Netzschleuder cintestinalis", graph_nodes: this.connectome.fullNodes, graph_edges: this.connectome.fullEdges, simulated_cns_neurons: 177, synapse_note: "Synaptic signs are not fully annotated in the original connectome; all inhibition and learning modes are explicit assumptions.", provenance: { measured: ["Neuron identities and directed edges", "Cumulative presynaptic contact depth", "Explicit L/R suffixes in source labels"], derived: ["Log-scaled LIF connection magnitudes", "Motor-pool laterality score", "Two-hop touch target partition"], heuristic: ["Synaptic signs", "World-to-sensory transduction", "Retinal left/right proxy banks", "Larval movement physics and reward-modulated plasticity"] } } }; }
  tracePath(target: number, stimulus: Stimulus): Record<string, unknown> { const sources = new Set(this.targets[stimulus]), queue = [...sources].map(id => [id] as number[]); let path: number[] = []; while (queue.length) { const candidate = queue.shift()!; const node = candidate.at(-1)!; if (node === target) { path = candidate; break; } if (candidate.length >= 8) continue; for (const edge of [...this.connectome.outgoing[node]].sort((a, b) => b.weight - a.weight)) if (!candidate.includes(edge.target)) queue.push([...candidate, edge.target]); } return { type: "path", stimulus, target, found: !!path.length, nodes: path.map(id => ({ id, name: this.connectome.neurons[id].name })), edges: path.slice(1).map((id, i) => ({ source: path[i], target: id, source_name: this.connectome.neurons[path[i]].name, target_name: this.connectome.neurons[id].name, source_weight: this.connectome.adjacency[id * this.n + path[i]], effective_weight: this.weights[id * this.n + path[i]] })), note: "Topology is measured; stimulus membership, signs, scaling and effective weights may be model-derived or heuristic." }; }
}

export function runComparison(current: Simulator, stimulus: Stimulus, intensity: number): Record<string, unknown> {
  const trial = (intervention: boolean) => { const sim = new Simulator(current.connectome, current.seed); if (intervention) { sim.setSignRule(current.signRule); sim.gainParameters = { ...current.gainParameters }; sim.gainProfile = current.gainProfile; sim.plasticFactors.set(current.plasticFactors); sim.rebuildWeights(); current.ablated.forEach((v, i) => { if (v) sim.setAblation(i, true); }); } sim.stimulate(stimulus, intensity, 700); const values: number[] = [], left: number[] = [], right: number[] = []; for (let i = 0; i < 220; i++) { sim.step(); if (sim.timeMs >= 250) { const state = sim.snapshot() as any; values.push(state.direction); left.push(state.motor.left); right.push(state.motor.right); } } const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length; return { laterality: +mean(values).toFixed(4), left_motor: +mean(left).toFixed(4), right_motor: +mean(right).toFixed(4) }; };
  const baseline = trial(false), intervention = trial(true); return { type: "comparison", stimulus, baseline, intervention, delta: +(intervention.laterality - baseline.laterality).toFixed(4), baseline_config: "All excitatory · source-derived gains · original weights · no ablations", intervention_config: `${SIGN_RULES[current.signRule].label} · ${GAIN_PROFILES[current.gainProfile].label} · ${current.learnedEdgeCount} learned edges · ${current.ablated.reduce((a, b) => a + b, 0)} ablated` };
}
