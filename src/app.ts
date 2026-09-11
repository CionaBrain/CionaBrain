// The simulation protocol is typed at the Worker boundary; DOM state remains
// intentionally lightweight because this is a dependency-free interface.
const groupGrids = {
  left: document.querySelector("#leftGrid"),
  right: document.querySelector("#rightGrid"),
  unlabelled: document.querySelector("#unlabelledGrid"),
};
const intensity = document.querySelector("#intensity");
const intensityValue = document.querySelector("#intensityValue");
const connection = document.querySelector(".connection");
const connectionText = document.querySelector("#connectionText");
const tooltip = document.querySelector("#tooltip");
const trace = document.querySelector("#activityTrace");
const raster = document.querySelector("#rasterPlot");
const worldCanvas = document.querySelector("#larvalWorld");

let worker;
let metadata = null;
let neurons = [];
let dots = [];
let selectedId = null;
let latestState = null;
let lastRecordedTime = null;
let worldTool = "light";
let pathNodeIds = new Set();
let incoming = new Map();
let outgoing = new Map();
const activityHistory = [];
const rasterFrames = [];
const records = [];
const worldTrail = [];

function send(command) {
  worker?.postMessage(command);
}

function setConnected(online) {
  connection.classList.toggle("online", online);
  connectionText.textContent = online ? "Local simulation" : "Worker unavailable";
}

function indexConnections(connections) {
  incoming = new Map();
  outgoing = new Map();
  connections.forEach((edge) => {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    incoming.get(edge.target).push(edge);
    outgoing.get(edge.source).push(edge);
  });
}

function buildGrid(items) {
  neurons = items;
  Object.values(groupGrids).forEach((group) => group.replaceChildren());
  const counts = { left: 0, right: 0, unlabelled: 0 };
  dots = items.map((neuron) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = `neuron ${neuron.side}`;
    dot.dataset.id = neuron.id;
    dot.setAttribute("aria-label", `${neuron.name}, ${neuron.side}`);
    dot.addEventListener("click", () => selectNeuron(neuron.id));
    dot.addEventListener("mouseenter", showTooltip);
    dot.addEventListener("mousemove", moveTooltip);
    dot.addEventListener("mouseleave", () => (tooltip.style.display = "none"));
    const side = groupGrids[neuron.side] ? neuron.side : "unlabelled";
    counts[side] += 1;
    groupGrids[side].append(dot);
    return dot;
  });
  document.querySelector("#leftCount").textContent = counts.left;
  document.querySelector("#rightCount").textContent = counts.right;
  document.querySelector("#unlabelledCount").textContent = counts.unlabelled;
}

function selectNeuron(id) {
  selectedId = id;
  const neuron = neurons[id];
  const inputs = incoming.get(id) || [];
  const outputs = outgoing.get(id) || [];
  document.querySelector("#neuronEmpty").hidden = true;
  document.querySelector("#neuronDetail").hidden = false;
  document.querySelector("#detailName").textContent = neuron.name;
  document.querySelector("#detailId").textContent = `sim #${id} / source #${neuron.source_id}`;
  document.querySelector("#detailClass").textContent = neuron.class;
  document.querySelector("#detailSide").textContent = neuron.side;
  document.querySelector("#detailIncoming").textContent = `${inputs.length} (${sumWeights(inputs)})`;
  document.querySelector("#detailOutgoing").textContent = `${outputs.length} (${sumWeights(outputs)})`;
  refreshSelectionClasses();
  activateTab("readout", "readout-neuron");
}

function activateTab(group, target) {
  const navigation = document.querySelector(`[data-tab-group="${group}"]`);
  if (!navigation) return;
  navigation.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tabTarget === target);
  });
  document.querySelectorAll(`[data-tab-panel^="${group}-"]`).forEach((panel) => {
    panel.classList.toggle("is-hidden", panel.dataset.tabPanel !== target);
  });
  requestAnimationFrame(drawPlots);
}

function sumWeights(edges) {
  return edges.reduce((sum, edge) => sum + edge.weight, 0).toFixed(2);
}

function clearSelection() {
  selectedId = null;
  document.querySelector("#neuronEmpty").hidden = false;
  document.querySelector("#neuronDetail").hidden = true;
  refreshSelectionClasses();
}

function refreshSelectionClasses() {
  const ablated = new Set(latestState?.ablated || []);
  dots.forEach((dot, id) => {
    dot.classList.remove("selected", "upstream", "downstream", "path-node");
    dot.classList.toggle("ablated", ablated.has(id));
    dot.classList.toggle("path-node", pathNodeIds.has(id));
  });
  if (selectedId === null) return;
  dots[selectedId]?.classList.add("selected");
  (incoming.get(selectedId) || []).forEach((edge) => dots[edge.source]?.classList.add("upstream"));
  (outgoing.get(selectedId) || []).forEach((edge) => dots[edge.target]?.classList.add("downstream"));
  const isAblated = ablated.has(selectedId);
  const button = document.querySelector("#ablateButton");
  button.textContent = isAblated ? "Restore neuron" : "Ablate neuron";
  button.classList.toggle("active", isAblated);
}

function showTooltip(event) {
  const id = Number(event.currentTarget.dataset.id);
  const neuron = neurons[id];
  const inputCount = (incoming.get(id) || []).length;
  const outputCount = (outgoing.get(id) || []).length;
  tooltip.innerHTML = `<b>${neuron.name}</b><br>${neuron.class} · ${neuron.side}<br>${inputCount} in / ${outputCount} out`;
  tooltip.style.display = "block";
  moveTooltip(event);
}

function moveTooltip(event) {
  tooltip.style.left = `${event.clientX + 14}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
}

function renderState(state) {
  latestState = state;
  const firing = new Set(state.spikes);
  dots.forEach((dot, index) => dot.classList.toggle("firing", firing.has(index)));
  refreshSelectionClasses();

  document.querySelector("#firingCount").textContent = state.firing_count;
  document.querySelector("#simTime").textContent = state.time_ms.toFixed(1);
  document.querySelector("#leftMotor").textContent = state.motor.left.toFixed(3);
  document.querySelector("#rightMotor").textContent = state.motor.right.toFixed(3);
  document.querySelector("#activeStimuli").textContent = state.active_stimuli.length
    ? state.active_stimuli.map(formatStimulus).join(" + ")
    : "None";
  document.querySelector("#leftGroup").classList.toggle(
    "stim-active", state.active_stimuli.includes("touch_left")
  );
  document.querySelector("#rightGroup").classList.toggle(
    "stim-active", state.active_stimuli.includes("touch_right")
  );
  document.querySelector("#currentSignRule").textContent = state.sign_rule_label;
  document.querySelector("#inhibitoryEdgeCount").textContent = state.inhibitory_edges;
  document.querySelector("#currentGainProfile").textContent = state.gain_profile_label;
  document.querySelector("#gainResult").textContent = state.gain_profile === "original"
    ? "No fitted gain multipliers are active."
    : `Experimental multipliers: ${Object.entries(state.gain_parameters).map(([key, value]) => `${key} ${value.toFixed(1)}×`).join(" · ")}${state.gain_objective === null ? "" : ` · objective ${state.gain_objective.toFixed(3)}`}`;
  document.querySelector("#signRuleSelect").value = state.sign_rule;
  document.querySelectorAll("[data-ablate-side]").forEach((button) => {
    const side = button.dataset.ablateSide;
    const group = metadata?.motor_groups?.[side] || [];
    const allAblated = group.length > 0 && group.every((id) => state.ablated.includes(id));
    button.classList.toggle("active", allAblated);
    button.textContent = `${allAblated ? "Restore" : "Ablate"} ${side} motor-related`;
  });

  const score = state.direction;
  document.querySelector("#directionValue").textContent = `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
  document.querySelector("#directionMarker").style.left = `${(score + 1) * 50}%`;
  document.querySelector("#directionLabel").textContent =
    Math.abs(score) < 0.08 ? "Neutral" : score < 0 ? "Turning left" : "Turning right";
  const motorBlock = document.querySelector(".motor-block");
  motorBlock.classList.toggle("strong-left", score < -0.3);
  motorBlock.classList.toggle("strong-right", score > 0.3);

  const playButton = document.querySelector("#playPauseButton");
  playButton.textContent = state.paused ? "Resume" : "Pause";
  playButton.title = state.paused ? "Resume simulation" : "Pause simulation";
  document.querySelector("#speedSelect").value = String(state.speed);
  document.querySelector("#seedInput").value = state.seed;
  const experiment = state.experiment || {};
  document.querySelector("#experimentStatus").textContent = experiment.replaying
    ? `Replaying ${experiment.event_count} events from seed ${state.seed}…`
    : experiment.active
      ? `Recording · seed ${state.seed} · ${experiment.event_count} events`
      : "No deterministic experiment is active.";

  if (state.time_ms !== lastRecordedTime) {
    lastRecordedTime = state.time_ms;
    activityHistory.push(state.firing_count);
    rasterFrames.push(state.spikes);
    records.push({
      time_ms: state.time_ms,
      spikes: state.spikes,
      direction: state.direction,
      motor: state.motor,
      stimuli: state.active_stimuli,
      ablated: state.ablated,
      sign_rule: state.sign_rule,
      sign_rule_label: state.sign_rule_label,
      inhibitory_edges: state.inhibitory_edges,
      seed: state.seed,
      gain_profile: state.gain_profile,
      gain_parameters: state.gain_parameters,
      world: state.world,
    });
    if (activityHistory.length > 240) activityHistory.shift();
    if (rasterFrames.length > 120) rasterFrames.shift();
    if (records.length > 2400) records.shift();
    document.querySelector("#recordCount").textContent = `${records.length} states recorded in this browser`;
  }
  updateWorldTrail(state.world);
  drawPlots();
}

function updateWorldTrail(world) {
  if (!world) return;
  const last = worldTrail.at(-1);
  if (!last || Math.hypot(world.x - last.x, world.y - last.y) > 0.002) {
    worldTrail.push({ x: world.x, y: world.y });
    if (worldTrail.length > 180) worldTrail.shift();
  }
}

function formatStimulus(value) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function drawTrace() {
  const { context, width, height } = prepareCanvas(trace);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#e0e3e2";
  context.lineWidth = 1;
  for (let row = 1; row < 4; row += 1) {
    const y = Math.round((height * row) / 4) + 0.5;
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  if (activityHistory.length < 2) return;
  const ceiling = Math.max(12, ...activityHistory);
  context.strokeStyle = "#184f73";
  context.lineWidth = 1.25;
  context.beginPath();
  activityHistory.forEach((value, index) => {
    const x = width - ((activityHistory.length - 1 - index) / 239) * width;
    const y = height - 5 - (value / ceiling) * (height - 10);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
}

function drawRaster() {
  const { context, width, height } = prepareCanvas(raster);
  context.fillStyle = "#20252a";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#e0715f";
  const columnWidth = width / 120;
  rasterFrames.forEach((spikes, frameIndex) => {
    const x = width - (rasterFrames.length - frameIndex) * columnWidth;
    spikes.forEach((neuronId) => {
      const y = 2 + (neuronId / 176) * (height - 4);
      context.fillRect(x, y, Math.max(1, columnWidth), 1.25);
    });
  });
}

function drawPlots() {
  drawTrace();
  drawRaster();
  drawWorld();
}

function drawWorld() {
  const { context, width, height } = prepareCanvas(worldCanvas);
  const world = latestState?.world;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#e8eef0";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(31, 59, 68, .08)";
  context.lineWidth = 1;
  for (let x = 0; x < width; x += 32) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
  for (let y = 0; y < height; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
  if (!world) return;

  const lx = world.light_x * width;
  const ly = world.light_y * height;
  const gradient = context.createRadialGradient(lx, ly, 2, lx, ly, 75 + 80 * world.light_strength);
  gradient.addColorStop(0, `rgba(248, 197, 70, ${0.8 * world.light_strength})`);
  gradient.addColorStop(1, "rgba(248, 197, 70, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#d99b20";
  context.beginPath(); context.arc(lx, ly, 5, 0, Math.PI * 2); context.fill();

  if (worldTrail.length > 1) {
    context.strokeStyle = "rgba(24, 79, 115, .35)";
    context.lineWidth = 1.5;
    context.beginPath();
    worldTrail.forEach((point, index) => {
      const x = point.x * width, y = point.y * height;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  }

  const gx = width - 30, gy = 29;
  context.save(); context.translate(gx, gy); context.rotate(world.gravity_angle);
  context.strokeStyle = "#65757c"; context.fillStyle = "#65757c"; context.lineWidth = 1.5;
  context.beginPath(); context.moveTo(-16, 0); context.lineTo(16, 0); context.stroke();
  context.beginPath(); context.moveTo(16, 0); context.lineTo(9, -4); context.lineTo(9, 4); context.closePath(); context.fill();
  context.restore();
  context.fillStyle = "#65757c"; context.font = "9px ui-monospace"; context.fillText("g", width - 34, 12);

  const x = world.x * width, y = world.y * height;
  const swimPhase = Math.sin((latestState.time_ms || 0) / 75) * 4;
  context.save(); context.translate(x, y); context.rotate(world.heading);
  // Tadpole-like Ciona silhouette: bulbous trunk plus a long muscular tail.
  context.fillStyle = "rgba(224, 220, 184, .9)"; context.strokeStyle = "#213a42"; context.lineWidth = 1.3;
  context.beginPath();
  context.moveTo(-10, -3.4);
  context.bezierCurveTo(-25, -5, -42, swimPhase - 4, -61, swimPhase * .35);
  context.bezierCurveTo(-42, swimPhase + 4, -25, 5, -10, 3.4);
  context.closePath(); context.fill(); context.stroke();
  // Notochord and dorsal nerve cord are schematic orientation cues.
  context.strokeStyle = "#b88b36"; context.lineWidth = 1.2;
  context.beginPath(); context.moveTo(-8, 1.2); context.bezierCurveTo(-27, 1, -44, swimPhase + 1, -58, swimPhase * .35); context.stroke();
  context.strokeStyle = "#477e9e"; context.lineWidth = 1;
  context.beginPath(); context.moveTo(-7, -1.7); context.bezierCurveTo(-27, -2, -44, swimPhase - 2, -57, swimPhase * .35 - 1); context.stroke();
  context.fillStyle = "#f5f0da"; context.strokeStyle = "#213a42"; context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(-11, -7); context.bezierCurveTo(-2, -12, 14, -10, 20, -3);
  context.bezierCurveTo(24, 2, 17, 9, 6, 10); context.bezierCurveTo(-3, 10, -10, 6, -11, -7);
  context.closePath(); context.fill(); context.stroke();
  context.fillStyle = "#263b47";
  context.beginPath(); context.arc(12, -3, 2.3, 0, Math.PI * 2); context.fill();
  context.fillStyle = "#b58a3e";
  context.beginPath(); context.arc(7, 3.2, 1.8, 0, Math.PI * 2); context.fill();
  context.restore();
  if (world.touch_x !== null) {
    const tx = world.touch_x * width, ty = world.touch_y * height;
    context.strokeStyle = world.touch_side === "left" ? "#3b82f6" : "#f97316";
    context.lineWidth = 2;
    context.beginPath(); context.arc(tx, ty, 10, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.moveTo(tx - 14, ty); context.lineTo(tx + 14, ty); context.moveTo(tx, ty - 14); context.lineTo(tx, ty + 14); context.stroke();
  }
}

function connect() {
  worker = new Worker("/static/dist/simulator.worker.js", { type: "module" });
  worker.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "metadata") {
      metadata = message;
      indexConnections(message.connections);
      buildGrid(message.neurons);
      updateSignRuleDescription(document.querySelector("#signRuleSelect").value);
      populateProvenance(message.source.provenance);
    }
    if (message.type === "state") renderState(message);
    if (message.type === "path") renderPath(message);
    if (message.type === "comparison") renderComparison(message);
    if (message.type === "gain_result") {
      document.querySelector("#gainResult").textContent = `Calibration complete · objective ${message.objective.toFixed(3)}`;
      const button = document.querySelector("#optimizeGains");
      button.disabled = false;
      button.textContent = "Calibrate experimental gains";
    }
    if (message.type === "error") console.warn(message.message);
  });
  worker.addEventListener("error", (event) => {
    console.error(event.message);
    setConnected(false);
  });
  setConnected(true);
}

function populateProvenance(provenance) {
  Object.entries({ measured: "#measuredList", derived: "#derivedList", heuristic: "#heuristicList" }).forEach(([key, selector]) => {
    const list = document.querySelector(selector);
    list.replaceChildren(...(provenance?.[key] || []).map((item) => {
      const li = document.createElement("li"); li.textContent = item; return li;
    }));
  });
}

function renderPath(message) {
  pathNodeIds = new Set(message.nodes.map((node) => node.id));
  refreshSelectionClasses();
  const result = document.querySelector("#pathResult");
  if (!message.found) {
    result.textContent = `No path found within 8 hops from ${formatStimulus(message.stimulus)}.`;
    return;
  }
  result.innerHTML = message.nodes.map((node, index) =>
    `<span>${node.name}</span>${index < message.nodes.length - 1 ? "<i>→</i>" : ""}`
  ).join("") + `<small>${message.note}</small>`;
}

function renderComparison(message) {
  const baseline = message.baseline;
  const intervention = message.intervention;
  document.querySelector("#comparisonResult").innerHTML = `
    <div><span>Baseline</span><b>${signed(baseline.laterality)}</b><small>L ${baseline.left_motor.toFixed(3)} · R ${baseline.right_motor.toFixed(3)}</small></div>
    <div><span>Intervention</span><b>${signed(intervention.laterality)}</b><small>L ${intervention.left_motor.toFixed(3)} · R ${intervention.right_motor.toFixed(3)}</small></div>
    <p>Δ ${signed(message.delta)} · ${formatStimulus(message.stimulus)}</p>
    <small>${message.baseline_config}<br>${message.intervention_config}</small>`;
  const button = document.querySelector("#runComparison");
  button.disabled = false;
  button.textContent = "Run matched trial";
}

function signed(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function downloadFile(filename, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function updateSignRuleDescription(rule) {
  const description = metadata?.sign_rules?.[rule]?.description;
  if (description) document.querySelector("#signRuleDescription").textContent = description;
}

document.querySelectorAll("[data-tab-group]").forEach((navigation) => {
  navigation.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.addEventListener("click", () => activateTab(navigation.dataset.tabGroup, button.dataset.tabTarget));
  });
});
document.querySelector(".provenance-panel").addEventListener("toggle", (event) => {
  event.currentTarget.querySelector(".methods-actions > i").textContent = event.currentTarget.open ? "Hide methods" : "Show methods";
});

intensity.addEventListener("input", () => {
  intensityValue.textContent = `${intensity.value}%`;
});

document.querySelectorAll(".stimulus").forEach((button) => {
  button.addEventListener("click", () => {
    send({
      type: "stimulate",
      stimulus: button.dataset.stimulus,
      intensity: Number(intensity.value) / 100,
      duration_ms: 650,
    });
    button.classList.add("pressed");
    setTimeout(() => button.classList.remove("pressed"), 180);
  });
});

document.querySelector("#resetButton").addEventListener("click", () => {
  send({ type: "reset" });
  activityHistory.length = 0;
  rasterFrames.length = 0;
  records.length = 0;
  worldTrail.length = 0;
  pathNodeIds.clear();
  lastRecordedTime = null;
});
document.querySelector("#playPauseButton").addEventListener("click", () => {
  send({ type: "playback", action: latestState?.paused ? "resume" : "pause" });
});
document.querySelector("#stepButton").addEventListener("click", () => {
  send({ type: "playback", action: "step" });
});
document.querySelector("#speedSelect").addEventListener("change", (event) => {
  send({ type: "speed", value: Number(event.target.value) });
});
document.querySelector("#signRuleSelect").addEventListener("change", (event) => {
  updateSignRuleDescription(event.target.value);
  send({ type: "sign_rule", rule: event.target.value });
});
document.querySelectorAll("[data-ablate-side]").forEach((button) => {
  button.addEventListener("click", () => {
    const side = button.dataset.ablateSide;
    const group = metadata?.motor_groups?.[side] || [];
    const ablated = new Set(latestState?.ablated || []);
    const allAblated = group.length > 0 && group.every((id) => ablated.has(id));
    send({ type: "ablate_motor_group", side, ablated: !allAblated });
  });
});
document.querySelector("#clearSelectionButton").addEventListener("click", clearSelection);
document.querySelector("#ablateButton").addEventListener("click", () => {
  if (selectedId === null) return;
  const isAblated = (latestState?.ablated || []).includes(selectedId);
  send({ type: "ablate", neuron_id: selectedId, ablated: !isAblated });
});
document.querySelector("#tracePathButton").addEventListener("click", () => {
  if (selectedId === null) return;
  send({
    type: "trace_path",
    neuron_id: selectedId,
    stimulus: document.querySelector("#pathStimulus").value,
  });
});
document.querySelectorAll("[data-world-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    worldTool = button.dataset.worldTool;
    document.querySelectorAll("[data-world-tool]").forEach((item) => item.classList.toggle("active", item === button));
  });
});
worldCanvas.addEventListener("click", (event) => {
  const bounds = worldCanvas.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width;
  const y = (event.clientY - bounds.top) / bounds.height;
  if (worldTool === "light") send({ type: "world", changes: { light_x: x, light_y: y } });
  else send({ type: "world_touch", x, y, intensity: Number(intensity.value) / 100 });
});
document.querySelector("#worldLightStrength").addEventListener("input", (event) => {
  send({ type: "world", changes: { light_strength: Number(event.target.value) / 100 } });
});
document.querySelector("#gravityAngle").addEventListener("input", (event) => {
  send({ type: "world", changes: { gravity_angle: Number(event.target.value) * Math.PI / 180 } });
});
document.querySelector("#originalGains").addEventListener("click", () => {
  send({ type: "gain_profile", profile: "original" });
});
document.querySelector("#optimizeGains").addEventListener("click", () => {
  const button = document.querySelector("#optimizeGains");
  button.disabled = true;
  button.textContent = "Calibrating…";
  document.querySelector("#gainResult").textContent = "Running deterministic class-gain calibration…";
  send({ type: "optimize_gains" });
});
document.querySelector("#startExperiment").addEventListener("click", () => {
  activityHistory.length = 0; rasterFrames.length = 0; records.length = 0; worldTrail.length = 0;
  lastRecordedTime = null;
  send({ type: "experiment_start", seed: Number(document.querySelector("#seedInput").value) });
});
document.querySelector("#replayExperiment").addEventListener("click", () => {
  activityHistory.length = 0; rasterFrames.length = 0; records.length = 0; worldTrail.length = 0;
  lastRecordedTime = null;
  send({ type: "experiment_replay" });
});
document.querySelector("#runComparison").addEventListener("click", () => {
  const button = document.querySelector("#runComparison");
  button.disabled = true;
  button.textContent = "Running trial…";
  document.querySelector("#comparisonResult").textContent = "Running two matched simulations…";
  send({
    type: "run_comparison",
    stimulus: document.querySelector("#comparisonStimulus").value,
    intensity: Number(intensity.value) / 100,
  });
});
document.querySelector("#exportJson").addEventListener("click", () => {
  downloadFile("cionabrain-experiment.json", "application/json", JSON.stringify({
    schema_version: 2,
    scientific_notice: "Connectome topology and contact depth are measured; signs, sensory transduction, movement and fitted gains include explicit model assumptions.",
    metadata,
    experiment: latestState?.experiment,
    active_configuration: latestState ? {
      seed: latestState.seed,
      sign_rule: latestState.sign_rule,
      gain_profile: latestState.gain_profile,
      gain_parameters: latestState.gain_parameters,
      ablated: latestState.ablated,
    } : null,
    records,
  }, null, 2));
});
document.querySelector("#exportCsv").addEventListener("click", () => {
  const rows = ["time_ms,neuron_id,neuron_name,direction,left_motor,right_motor,world_x,world_y,heading,active_stimuli,sign_rule,gain_profile,seed,inhibitory_edges"];
  records.forEach((state) => state.spikes.forEach((id) => {
    rows.push([state.time_ms, id, neurons[id].name, state.direction, state.motor.left, state.motor.right, state.world.x, state.world.y, state.world.heading, state.stimuli.join("+"), state.sign_rule, state.gain_profile, state.seed, state.inhibitory_edges].join(","));
  }));
  downloadFile("cionabrain-spikes.csv", "text/csv", rows.join("\n"));
});

connect();
window.addEventListener("resize", drawPlots);
drawPlots();
