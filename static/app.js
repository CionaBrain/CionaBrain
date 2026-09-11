const grid = document.querySelector("#neuronGrid");
const intensity = document.querySelector("#intensity");
const intensityValue = document.querySelector("#intensityValue");
const connection = document.querySelector(".connection");
const connectionText = document.querySelector("#connectionText");
const tooltip = document.querySelector("#tooltip");
const trace = document.querySelector("#activityTrace");
const raster = document.querySelector("#rasterPlot");

let socket;
let metadata = null;
let neurons = [];
let dots = [];
let reconnectTimer;
let selectedId = null;
let latestState = null;
let lastRecordedTime = null;
let incoming = new Map();
let outgoing = new Map();
const activityHistory = [];
const rasterFrames = [];
const records = [];

function send(command) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(command));
  }
}

function setConnected(online) {
  connection.classList.toggle("online", online);
  connectionText.textContent = online ? "Live connection" : "Disconnected";
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
  grid.replaceChildren();
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
    grid.append(dot);
    return dot;
  });
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
    dot.classList.remove("selected", "upstream", "downstream");
    dot.classList.toggle("ablated", ablated.has(id));
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

  const score = state.direction;
  document.querySelector("#directionValue").textContent = `${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
  document.querySelector("#directionMarker").style.left = `${(score + 1) * 50}%`;
  document.querySelector("#directionLabel").textContent =
    Math.abs(score) < 0.08 ? "Neutral" : score < 0 ? "Turning left" : "Turning right";

  const playButton = document.querySelector("#playPauseButton");
  playButton.textContent = state.paused ? "Resume" : "Pause";
  playButton.title = state.paused ? "Resume simulation" : "Pause simulation";
  document.querySelector("#speedSelect").value = String(state.speed);

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
    });
    if (activityHistory.length > 240) activityHistory.shift();
    if (rasterFrames.length > 120) rasterFrames.shift();
    if (records.length > 2400) records.shift();
    document.querySelector("#recordCount").textContent = `${records.length} states recorded in this browser`;
  }
  drawPlots();
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
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws`);
  socket.addEventListener("open", () => setConnected(true));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "metadata") {
      metadata = message;
      indexConnections(message.connections);
      buildGrid(message.neurons);
    }
    if (message.type === "state") renderState(message);
    if (message.type === "error") console.warn(message.message);
  });
  socket.addEventListener("close", () => {
    setConnected(false);
    reconnectTimer = setTimeout(connect, 1600);
  });
}

function downloadFile(filename, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

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
document.querySelector("#clearSelectionButton").addEventListener("click", clearSelection);
document.querySelector("#ablateButton").addEventListener("click", () => {
  if (selectedId === null) return;
  const isAblated = (latestState?.ablated || []).includes(selectedId);
  send({ type: "ablate", neuron_id: selectedId, ablated: !isAblated });
});
document.querySelector("#exportJson").addEventListener("click", () => {
  downloadFile("cionabrain-experiment.json", "application/json", JSON.stringify({ metadata, records }, null, 2));
});
document.querySelector("#exportCsv").addEventListener("click", () => {
  const rows = ["time_ms,neuron_id,neuron_name,direction,left_motor,right_motor,active_stimuli"];
  records.forEach((state) => state.spikes.forEach((id) => {
    rows.push([state.time_ms, id, neurons[id].name, state.direction, state.motor.left, state.motor.right, state.stimuli.join("+")].join(","));
  }));
  downloadFile("cionabrain-spikes.csv", "text/csv", rows.join("\n"));
});

connect();
window.addEventListener("resize", drawPlots);
drawPlots();
