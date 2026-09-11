/// <reference lib="webworker" />
import { loadConnectome } from "./connectome";
import { Simulator, runComparison, type GainProfile, type SignRule } from "./simulator";

type Command = Record<string, any>;
const scope = self as unknown as DedicatedWorkerGlobalScope;
let simulator: Simulator;
let running = true;
let speed = 1;
let events: Array<{ at_ms: number; command: Command }> = [];
let setup: Command | null = null;
let replay: Array<{ at_ms: number; command: Command }> = [];
let replayUntil = 0;

function apply(command: Command): boolean {
  switch (command.type) {
    case "stimulate": simulator.stimulate(command.stimulus, Number(command.intensity), Number(command.duration_ms || 650)); break;
    case "world": simulator.setWorld(command.changes); break;
    case "world_touch": simulator.touchWorld(Number(command.x), Number(command.y), Number(command.intensity)); break;
    case "ablate": simulator.setAblation(Number(command.neuron_id), Boolean(command.ablated)); break;
    case "ablate_motor_group": simulator.setMotorAblation(command.side, Boolean(command.ablated)); break;
    case "sign_rule": simulator.setSignRule(command.rule as SignRule); break;
    case "gain_profile": simulator.setGainProfile(command.profile as GainProfile); break;
    default: return false;
  }
  return true;
}

function experimentState(): Command { return { active: !!setup, event_count: events.length, replaying: replay.length > 0 || (replayUntil > 0 && simulator.timeMs < replayUntil), events, setup }; }
function sendState(): void { scope.postMessage({ ...simulator.snapshot(), paused: !running, speed, experiment: experimentState() }); }

scope.onmessage = ({ data: command }: MessageEvent<Command>) => {
  try {
    if (apply(command)) {
      if (setup && !replay.length && replayUntil === 0) events.push({ at_ms: simulator.timeMs, command });
    } else switch (command.type) {
      case "reset": simulator.reset(); events = []; setup = null; replay = []; break;
      case "playback": if (command.action === "pause") running = false; else if (command.action === "resume") running = true; else if (command.action === "step") { running = false; simulator.step(); } break;
      case "speed": speed = Number(command.value); break;
      case "experiment_start": simulator.setSeed(Number(command.seed)); events = []; replay = []; setup = { seed: simulator.seed, sign_rule: simulator.signRule, gain_profile: simulator.gainProfile, gain_parameters: { ...simulator.gainParameters }, ablated: [...simulator.ablated.keys()].filter(i => simulator.ablated[i]), world: { light_x: simulator.world.light_x, light_y: simulator.world.light_y, light_strength: simulator.world.light_strength, gravity_angle: simulator.world.gravity_angle } }; running = true; break;
      case "experiment_replay": if (!setup) throw new Error("Start an experiment before replaying it"); simulator.reset(); simulator.setSeed(setup.seed); simulator.setSignRule(setup.sign_rule); simulator.gainParameters = { ...setup.gain_parameters }; simulator.gainProfile = setup.gain_profile; simulator.rebuildWeights(); for (const id of setup.ablated) simulator.setAblation(id, true); simulator.setWorld(setup.world); replay = events.map(event => ({ ...event })); replayUntil = Math.max(0, ...replay.map(e => e.at_ms)) + 900; running = true; break;
      case "trace_path": scope.postMessage(simulator.tracePath(Number(command.neuron_id), command.stimulus)); break;
      case "run_comparison": scope.postMessage(runComparison(simulator, command.stimulus, Number(command.intensity))); break;
      case "optimize_gains": scope.postMessage({ type: "gain_result", ...simulator.optimizeGains() }); break;
    }
    sendState();
  } catch (error) { scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
};

const connectome = await loadConnectome();
simulator = new Simulator(connectome);
scope.postMessage(simulator.metadata());
setInterval(() => {
  if (running) for (let i = 0; i < Math.max(1, Math.round(10 * speed)); i++) { while (replay.length && replay[0].at_ms <= simulator.timeMs) apply(replay.shift()!.command); simulator.step(); }
  if (replayUntil && simulator.timeMs >= replayUntil) replayUntil = 0;
  sendState();
}, 50);
