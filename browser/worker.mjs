import "../motion.js";
import { SKU_CATALOG } from "./sku-catalog.mjs";
import { Experiment } from "./experiment.mjs";
let run,
  input,
  playing = false,
  speed = 60,
  timer = null,
  wall = 0;
const buffers = [],
  outstanding = new Set(),
  binStride = 10,
  robotStride = 5;
let needsFrame = false;
let initializing = false;
let selection = null;
let setupMs = 0,
  engineMs = 0,
  projectionMs = 0,
  frames = 0;
const displayPhaseCache = new WeakMap();
function displayRobots(robots) {
  return robots.map((robot) => {
    if (!robot.phase || robot.job === null) return robot;
    const actual = run.jobs[robot.job]?.phases;
    if (!actual) return robot;
    let projected = displayPhaseCache.get(actual);
    if (!projected) {
      projected = TracePresentation.presentationPhases(actual);
      displayPhaseCache.set(actual, projected);
    }
    const index = actual.findIndex(
      (p) =>
        p.start === robot.phase.start &&
        p.end === robot.phase.end &&
        p.kind === robot.phase.kind,
    );
    return index < 0 ? robot : { ...robot, phase: projected[index] };
  });
}
const phases = [
  "empty-ready",
  "filling",
  "full",
  "full-ready",
  "tip-conveyor",
  "tipping",
  "empty",
  "inserted",
  "tip-queued",
  "external-prepack-processing",
];
const locations = [],
  locationIndex = new Map(),
  skuIndex = new Map();
const phaseIndex = new Map(phases.map((phase, i) => [phase, i]));
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
        locationIndex.get(b.location) ?? -1,
        b.slot,
        b.tier,
        b.fruit_count,
        b.reserved,
        phaseIndex.get(b.phase) ?? -1,
        b.readyAt,
        b.fruit_mass_kg,
        skuIndex.get(b.sku) ?? -1,
        b.fill_count_target,
      ],
      i * binStride,
    ),
  );
  const offset = s.bins.length * binStride;
  s.robots.forEach((r, i) =>
    a.set(
      [
        locationIndex.get(r.location) ?? -1,
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
              s.tippers?.find((t) => t.id === selection) ||
              (selection === "T5" ? s.hall?.t5 : null) ||
              (selection === "low_staging" ? s.hall?.localEmptyStock : null) ||
              s.hall?.parking?.bays.find((b) => b.id === selection) ||
              (selection === "grader_empty_drop"
                ? s.hall?.feederStock
                : null) ||
              (selection === "shared_empty"
                ? {
                    station: selection,
                    stock: s.hall?.shared,
                    inbound: s.hall?.sharedInbound,
                  }
                : null) ||
              s.tipper,
          }
        : null,
      robots: displayRobots(s.robots),
      tipper: s.tipper,
      tippers: s.tippers,
      hall: s.hall
        ? {
            startupStock: s.hall.startupStock,
            production: s.hall.production,
            counts: s.hall.counts,
            highRecirculation: s.hall.highRecirculation,
            compute: s.hall.compute,
            feederStock: s.hall.feederStock,
            feederPreparation: s.hall.feederPreparation,
            shared: s.hall.shared,
            sharedInbound: s.hall.sharedInbound,
            sharedReserved: s.hall.sharedReserved,
            localEmptyStock: s.hall.localEmptyStock,
            parking: s.hall.parking,
            runs: s.hall.runs
              .filter((r) => r.phase !== "reconciled")
              .concat(
                s.hall.runs.filter((r) => r.phase === "reconciled").slice(-2),
              ),
            blockedModes: s.hall.blockedModes,
            t5: s.hall.t5,
          }
        : null,
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
      run = new Experiment(
        input,
        m.scenario === "working"
          ? {
              mode: "mixed",
              fleetSize: 8,
              startup: "working",
              seed: m.seed ?? 1,
            }
          : m.scenario === "active"
            ? {
                mode: "mixed",
                fleetSize: 8,
                seed: m.seed ?? 1,
                initialStock: [
                  { sku: "SKU23", bins: 12 },
                  { sku: "SKU24", bins: 12 },
                ],
              }
            : m.scenario === "boundary"
              ? {
                  mode: "mixed",
                  fleetSize: 8,
                  seed: m.seed ?? 1,
                  trace: ["SKU05", "SKU17"],
                  fruitCount: 7902,
                }
              : m.scenario === "mixed"
                ? { mode: "mixed", fleetSize: 8, seed: m.seed ?? 1 }
                : {},
      );
      input = run.input;
      locations.push(
        ...Object.keys(input.network.nodes),
        ...run.robots.map((r) => r.id),
      );
      for (const b of run.bins)
        if (!locations.includes(b.location)) locations.push(b.location);
      locations.forEach((location, i) => {
        if (!locationIndex.has(location)) locationIndex.set(location, i);
      });
      input.skus.forEach((sku, i) => skuIndex.set(sku.id, i));
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
          inputId: run.hall?.startup ?? input.id,
          machineIds: run.machines.map((m) => m.id),
          stationIds: [
            ...run.machines.map((m) => m.id),
            ...input.cells.map((c) => c.id),
            "shared_empty",
            "grader_empty_drop",
            "low_staging",
            ...(input.network.parking?.bays ?? []).map((b) => b.id),
          ],
          robotIds: run.robots.map((r) => r.id),
          startupStock: run.hall?.startupStock,
          binStride,
          purpose: run.input.purpose,
          removedInitialFruit: input.removed_initial_fruit_count,
          bins: run.bins.map((b) => ({ id: b.id, origin: b.origin })),
          locations,
          phases,
          network: input.network,
          skus: input.skus.map((s) => ({ ...s, ...SKU_CATALOG[s.id] })),
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
