import { Experiment } from "./experiment.mjs";
let run,
  input,
  playing = false,
  speed = 60,
  timer = null,
  wall = 0;
const buffers = [],
  outstanding = new Set(),
  binStride = 8,
  robotStride = 5;
let needsFrame = false;
let initializing = false;
let selection = null;
let setupMs = 0,
  engineMs = 0,
  projectionMs = 0,
  frames = 0;
const phases = [
  "empty-ready",
  "filling",
  "full",
  "full-ready",
  "tip-conveyor",
  "tipping",
  "empty",
  "inserted",
];
const locations = [];
function advance(until) {
  const start = performance.now();
  run.advance(until);
  engineMs += performance.now() - start;
}
function publish() {
  if (!run) return;
  if (!buffers.length) {
    needsFrame = true;
    return;
  }
  needsFrame = false;
  const start = performance.now(),
    slot = buffers.pop(),
    { buffer, id: bufferId } = slot,
    a = new Float64Array(buffer),
    s = run.observe();
  s.bins.forEach((b, i) =>
    a.set(
      [
        locations.indexOf(b.location),
        b.slot,
        b.tier,
        b.fruit_count,
        b.reserved,
        phases.indexOf(b.phase),
        b.readyAt,
        b.fruit_mass_kg,
      ],
      i * binStride,
    ),
  );
  const offset = s.bins.length * binStride;
  s.robots.forEach((r, i) =>
    a.set(
      [
        locations.indexOf(r.location),
        r.carried ?? -1,
        r.soc,
        r.energy_kwh,
        r.job ?? -1,
      ],
      offset + i * robotStride,
    ),
  );
  projectionMs += performance.now() - start;
  frames++;
  outstanding.add(bufferId);
  postMessage(
    {
      type: "frame",
      bufferId,
      buffer,
      presentation: {
        allocated: 2,
        inFlight: outstanding.size,
        available: buffers.length,
      },
      time: s.time,
      frontier: s.frontier,
      nextEvent: s.nextEvent,
      accounting: s.accounting,
      requests: s.requests,
      selected: selection
        ? {
            id: selection,
            object:
              s.bins.find((b) => b.id === selection) ||
              s.robots.find((r) => r.id === selection) ||
              s.machines.find((m) => m.id === selection) ||
              s.tipper,
          }
        : null,
      robots: s.robots,
      tipper: s.tipper,
      machines: s.machines,
      conveyors: s.bins.flatMap((b, i) =>
        b.conveyor ? [{ bin: i, ...b.conveyor }] : [],
      ),
      timings: { setupMs, engineMs, projectionMs, frames },
      playing,
    },
    [buffer],
  );
}
function tick() {
  if (!playing) return;
  const now = performance.now(),
    dt = Math.min(50, Math.max(0, now - wall));
  wall = now;
  advance(run.time + (dt / 1000) * speed);
  publish();
  timer = setTimeout(tick, 16);
}
onmessage = async ({ data: m }) => {
  try {
    if (m.type === "init") {
      if (initializing || run) throw Error("Worker is already initialized");
      initializing = true;
      const started = performance.now();
      input = await (
        await fetch(new URL("./demo-input.json", import.meta.url))
      ).json();
      run = new Experiment(input);
      locations.push(
        ...Object.keys(input.network.nodes),
        ...run.robots.map((r) => r.id),
      );
      for (const b of run.bins)
        if (!locations.includes(b.location)) locations.push(b.location);
      const size =
        (run.bins.length * binStride + run.robots.length * robotStride) * 8;
      buffers.push(
        { id: 0, buffer: new ArrayBuffer(size) },
        { id: 1, buffer: new ArrayBuffer(size) },
      );
      setupMs = performance.now() - started;
      postMessage({
        type: "ready",
        metadata: {
          inputId: input.id,
          purpose: input.purpose,
          removedInitialFruit: input.removed_initial_fruit_count,
          bins: run.bins.map((b) => ({ id: b.id, origin: b.origin })),
          locations,
          phases,
          network: input.network,
          skus: input.skus,
        },
      });
      publish();
    } else if (m.type === "return-buffer") {
      if (!outstanding.has(m.bufferId))
        throw Error("Presentation buffer is not owned by main thread");
      if (
        m.buffer.byteLength !==
        (run.bins.length * binStride + run.robots.length * robotStride) * 8
      )
        throw Error("Invalid presentation buffer");
      outstanding.delete(m.bufferId);
      buffers.push({ id: m.bufferId, buffer: m.buffer });
      if (needsFrame) publish();
    } else if (m.type === "play") {
      if (!playing) {
        playing = true;
        wall = performance.now();
        timer = setTimeout(tick, 0);
      }
      publish();
    } else if (m.type === "pause") {
      playing = false;
      clearTimeout(timer);
      timer = null;
      publish();
    } else if (m.type === "speed") {
      if (![1, 10, 60, 600].includes(m.value)) throw Error("Unsupported speed");
      speed = m.value;
    } else if (m.type === "step") {
      playing = false;
      clearTimeout(timer);
      const start = performance.now();
      run.step();
      engineMs += performance.now() - start;
      publish();
    } else if (m.type === "advance") {
      playing = false;
      clearTimeout(timer);
      advance(m.until);
      publish();
    } else if (m.type === "inspect") {
      selection = m.request;
      postMessage({
        type: "inspection",
        request: m.request,
        state: run.observe(),
      });
    } else if (m.type === "present") publish();
    else throw Error(`Unknown Worker command ${m.type}`);
  } catch (error) {
    postMessage({ type: "error", message: error.message });
  }
};
