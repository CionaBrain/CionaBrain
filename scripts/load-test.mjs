import WebSocket from "ws";

const target = process.env.TARGET_URL || "ws://127.0.0.1:8765/ws";
const requested = Math.max(1, Number(process.env.CLIENTS || 100));
const durationMs = Math.max(2_000, Number(process.env.DURATION_MS || 10_000));
const clients = [];
let connected = 0, messages = 0, bytes = 0, errors = 0;

await Promise.all(Array.from({ length: requested }, () => new Promise(resolve => {
  const client = new WebSocket(target, { perMessageDeflate: false });
  clients.push(client);
  const timeout = setTimeout(() => { errors++; resolve(); }, 5_000);
  client.once("open", () => { clearTimeout(timeout); connected++; resolve(); });
  client.on("message", data => { messages++; bytes += data.length; });
  client.on("error", () => { errors++; });
})));

await new Promise(resolve => setTimeout(resolve, durationMs));
for (const client of clients) client.close();

const report = {
  target,
  requested,
  connected,
  duration_seconds: durationMs / 1000,
  messages,
  received_megabytes: +(bytes / 1024 / 1024).toFixed(2),
  messages_per_client_second: connected ? +(messages / connected / (durationMs / 1000)).toFixed(2) : 0,
  errors,
};
console.log(JSON.stringify(report, null, 2));
if (connected !== requested || errors) process.exitCode = 1;
