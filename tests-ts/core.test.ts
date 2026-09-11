import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConnectome } from "../src/connectome";
import { Simulator, runComparison } from "../src/simulator";
import { LiveCionaRuntime } from "../src/live-runtime";

const graph = parseConnectome(readFileSync("data/nodes.csv", "utf8"), readFileSync("data/edges.csv", "utf8"));

test("loads the 177-neuron Ryan connectome", () => {
  assert.equal(graph.neurons.length, 177);
  assert.equal(graph.fullNodes, 205);
  assert.equal(graph.fullEdges, 2903);
  assert.ok(graph.edges.length > 2500);
});

test("seeded simulations are deterministic", () => {
  const first = new Simulator(graph, 42), second = new Simulator(graph, 42);
  first.touchWorld(.25, .5, .9); second.touchWorld(.25, .5, .9);
  for (let i = 0; i < 120; i++) { first.step(); second.step(); }
  assert.deepEqual(first.snapshot(), second.snapshot());
});

test("the autonomous world produces visible, non-saturated activity", () => {
  const sim = new Simulator(graph, 2016);
  sim.setSignRule("heuristic_inhibition");
  let spikes = 0, motorSpikes = 0, peak = 0;
  for (let i = 0; i < 2000; i++) {
    sim.step();
    const frame = sim.spikes.reduce((sum, value) => sum + value, 0);
    spikes += frame;
    motorSpikes += [...sim.leftMotor, ...sim.rightMotor].reduce((sum, id) => sum + sim.spikes[id], 0);
    peak = Math.max(peak, frame);
  }
  assert.ok(spikes > 2000, "modeled light and gravity should drive spikes without manual input");
  assert.ok(motorSpikes > 0, "sensory activity should reach the motor pool");
  assert.ok(peak < 60, "the network should not saturate");
});

test("straight swimming and laterality are distinct behavioral readouts", () => {
  const sim = new Simulator(graph, 2016);
  const initial = sim.snapshot() as any;
  assert.equal(initial.direction, 0);
  assert.ok(initial.movement.speed > 0, "the modeled world includes a baseline forward speed");
  assert.match(initial.movement.note, /Modeled kinematics/);
  const startY = initial.world.y;
  for (let i = 0; i < 20; i++) sim.step();
  assert.notEqual((sim.snapshot() as any).world.y, startY, "zero laterality must not imply zero translation");
});

test("path tracing only returns observed directed edges", () => {
  const sim = new Simulator(graph);
  const result = sim.tracePath(sim.leftMotor[0], "light") as any;
  assert.equal(result.found, true);
  for (const edge of result.edges) assert.ok(graph.adjacency[edge.target * 177 + edge.source] > 0);
});

test("signs, ablation, and comparison remain available", () => {
  const sim = new Simulator(graph);
  sim.setSignRule("heuristic_inhibition");
  assert.ok(sim.inhibitoryEdges > 0);
  sim.setMotorAblation("left", true);
  const result = runComparison(sim, "touch_left", .9) as any;
  assert.equal(typeof result.delta, "number");
});

test("plasticity stays separate from source weights and can be cleared", () => {
  const sim = new Simulator(graph);
  const edge = sim.plasticEdges[0];
  assert.ok(Number.isInteger(edge));
  const sourceWeight = sim.baseWeights[edge];
  sim.setLearning(true);
  sim.plasticFactors[edge] = 1.2;
  sim.rebuildWeights();
  assert.equal((sim.snapshot() as any).learning.enabled, true);
  assert.notEqual(sim.weights[edge], sourceWeight);
  assert.equal(sim.baseWeights[edge], sourceWeight);
  sim.clearLearning();
  assert.equal(sim.plasticFactors[edge], 1);
  assert.equal((sim.snapshot() as any).learning.modified_edges, 0);
});

test("shared runtime persists one authoritative organism", () => {
  const live = new LiveCionaRuntime(graph, 99);
  const initial = live.state() as any;
  assert.equal(initial.live.mode, "shared_live");
  assert.equal(initial.sign_rule, "heuristic_inhibition");
  assert.equal(initial.learning.enabled, true);
  live.tick(20);
  const later = live.state() as any;
  assert.ok(later.time_ms > initial.time_ms);
  assert.equal(later.live.generation, initial.live.generation);
});

test("shared runtime accepts sensory input and rejects destructive commands", () => {
  const live = new LiveCionaRuntime(graph, 99);
  const [state] = live.command({ type: "stimulate", stimulus: "touch_left", intensity: 0.8 });
  assert.ok((state as any).active_stimuli.includes("touch_left"));
  assert.throws(() => live.command({ type: "reset" }), /Switch to Local lab/);
  assert.throws(() => live.command({ type: "world", changes: { light_x: "not-a-number" } }), /finite number/);
  assert.throws(() => live.command({ type: "stimulate", stimulus: "unknown", intensity: 1 }), /Unknown stimulus/);
});
