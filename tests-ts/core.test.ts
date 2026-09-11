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

test("shared runtime persists one authoritative organism", () => {
  const live = new LiveCionaRuntime(graph, 99);
  const initial = live.state() as any;
  assert.equal(initial.live.mode, "shared_live");
  assert.equal(initial.sign_rule, "heuristic_inhibition");
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
