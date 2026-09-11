import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConnectome } from "../src/connectome";
import { Simulator, runComparison } from "../src/simulator";

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
