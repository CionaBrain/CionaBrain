import type { Connectome } from "./connectome";
import { Simulator, runComparison } from "./simulator";

export type LiveCommand = Record<string, unknown>;

const PUBLIC_COMMANDS = new Set(["stimulate", "world", "world_touch", "trace_path", "run_comparison"]);
const STIMULI = new Set(["light", "gravity", "touch_left", "touch_right", "touch"]);

function finite(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`);
  return number;
}
function stimulus(value: unknown): any {
  const name = String(value || "");
  if (!STIMULI.has(name)) throw new Error("Unknown stimulus.");
  return name;
}

/**
 * One authoritative larva shared by every connected browser.
 *
 * The connectome and LIF dynamics are the same as the local laboratory Worker.
 * Only the surrounding world is autonomous: after a short period without human
 * input, the light and gravity fields move and an occasional spatial touch is
 * introduced. These events are explicitly modelled environment inputs, not
 * measured Ciona behaviour.
 */
export class LiveCionaRuntime {
  readonly simulator: Simulator;
  readonly bornAt = new Date().toISOString();
  readonly generation = Date.now().toString(36);
  viewers = 0;
  private lastHumanAt = 0;
  private nextTouchMs = 9_000;
  private touchLeft = true;
  private lastEvent = "Larva entered the shared world";
  private lastEventAt = 0;

  constructor(connectome: Connectome, seed = 2016) {
    this.simulator = new Simulator(connectome, seed);
    // The shared organism uses the documented heuristic mode. The UI and state
    // continue to identify this as a modelling assumption, not measured signs.
    this.simulator.setSignRule("heuristic_inhibition");
    // The shared Ciona learns continuously inside one server generation. This
    // is an explicit experimental layer; Ryan edge topology remains unchanged.
    this.simulator.setLearning(true);
  }

  metadata(): Record<string, unknown> {
    return {
      ...this.simulator.metadata(),
      runtime: {
        mode: "shared_live",
        label: "Shared live Ciona",
        autonomous_world: true,
        public_commands: [...PUBLIC_COMMANDS],
        note: "Neural state is server-authoritative and shared. World autonomy and sensory transduction are model assumptions.",
      },
    };
  }

  state(): Record<string, unknown> {
    return {
      ...this.simulator.snapshot(),
      paused: false,
      speed: 1,
      experiment: { active: false, replaying: false, event_count: 0 },
      live: {
        mode: "shared_live",
        generation: this.generation,
        born_at: this.bornAt,
        age_seconds: +(this.simulator.timeMs / 1000).toFixed(1),
        viewer_count: this.viewers,
        autonomous: this.isAutonomous(),
        last_event: this.lastEvent,
        last_event_at_ms: this.lastEventAt,
      },
    };
  }

  tick(steps = 10): void {
    for (let i = 0; i < steps; i++) {
      this.driveAutonomousWorld();
      this.simulator.step();
    }
  }

  /** Apply the deliberately small set of public, non-destructive commands. */
  command(command: LiveCommand): Record<string, unknown>[] {
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

  private isAutonomous(): boolean {
    return this.simulator.timeMs - this.lastHumanAt >= 8_000;
  }

  private driveAutonomousWorld(): void {
    if (!this.isAutonomous()) return;
    const seconds = this.simulator.timeMs / 1000;
    // Slow deterministic fields make the same nervous system continuously
    // receive sensory input without inventing a goal or a hidden path planner.
    this.simulator.setWorld({
      light_x: 0.5 + 0.34 * Math.cos(seconds / 10.5),
      light_y: 0.5 + 0.29 * Math.sin(seconds / 13),
      light_strength: 0.42 + 0.12 * Math.sin(seconds / 17),
      gravity_angle: Math.PI / 2 + 0.35 * Math.sin(seconds / 23),
    });
    if (this.simulator.timeMs >= this.nextTouchMs) {
      const heading = this.simulator.world.heading;
      const normal = this.touchLeft ? -1 : 1;
      const x = this.simulator.world.x + Math.cos(heading + normal * Math.PI / 2) * 0.035;
      const y = this.simulator.world.y + Math.sin(heading + normal * Math.PI / 2) * 0.035;
      const side = this.simulator.touchWorld(x, y, 0.48);
      this.note(`Autonomous world contact · ${side}`);
      this.touchLeft = !this.touchLeft;
      this.nextTouchMs += 17_000;
    }
  }

  private note(value: string): void {
    this.lastEvent = value;
    this.lastEventAt = this.simulator.timeMs;
  }
}
