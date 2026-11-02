// Provisional finite lane hardware, not another pass through the main grader.
export function installHighRecirculation(run) {
  const cfg = run.input.equipment_config;
  const declared = cfg.high_local_recirculation ?? {};
  const loopLengthM = declared.loopLengthM ?? 12;
  const fruitPitchM = declared.fruitPitchM ?? 0.12;
  const trackPitchM = declared.trackPitchM ?? 0.12;
  const enabled = declared.enabled !== false;
  run.highLocalQueues = new Map();
  run.highLocalSequence = 0;
  run.highLocalTokens = new Map();
  const speed = cfg.recirculation_speed;
  const burstMarginSeconds = 24;
  if (!Number.isFinite(loopLengthM) || !(loopLengthM >= fruitPitchM) || !(fruitPitchM > 0) || !Number.isFinite(fruitPitchM) || !(trackPitchM > 0) || !Number.isFinite(trackPitchM) || !(speed > 0)) throw Error("Positive finite high local-loop geometry required");
  const lanes = {};
  for (const machine of run.machines.filter(m => m.assignment)) {
    const siblings = run.machines.filter(m => m.assignment === machine.assignment).length;
    const fraction = run.skuById.get(machine.assignment).count_fraction / siblings;
    const upstreamSeconds = (cfg.decision_upstream_distance + run.machines.indexOf(machine) * cfg.filler_pitch) / cfg.grader_speed;
    const coverageSeconds = 72 + upstreamSeconds + burstMarginSeconds;
    const capacity = declared.capacityPerLane ?? Math.ceil(2 * run.input.grader.cupsPerSecond * fraction * coverageSeconds);
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Positive finite integer local-loop capacity required");
    const positionsPerTrack = Math.floor(loopLengthM / fruitPitchM);
    const serviceHeadway = Math.max(1 / run.input.grader.cupsPerSecond, run.mass(machine.assignment) / run.input.grader.massKgPerSecond);
    const inletRate = 1 / serviceHeadway;
    const tracks = Math.max(Math.ceil(capacity / positionsPerTrack), Math.ceil(inletRate * fruitPitchM / speed));
    run.highLocalQueues.set(machine.id, []);
    lanes[machine.id] = {
      enabled, fruitPitchM, trackPitchM, positionsPerTrack, tracks, widthM: tracks * trackPitchM,
      lastDeliveredToken: null, lastDeliveredAt: null, held: 0, circulating: 0, wakeAt: null,
      sku: machine.assignment, capacity, stock: 0, inbound: 0, peak: 0,
      loopLengthM, speed, lapSeconds: loopLengthM / speed, coverageSeconds,
      nominalFruitPerSecond: run.input.grader.cupsPerSecond * fraction,
      outputHeadwaySeconds: Math.max(fruitPitchM / (tracks * speed), 1 / run.input.grader.cupsPerSecond, run.mass(machine.assignment) / run.input.grader.massKgPerSecond),
      outputAt: 0, entered: 0, delivered: 0, laps: 0, overflow: 0,
    };
  }
  run.hall.highRecirculation = { assumption: "provisional physical capacity: twice declared per-lane mix over 72s bin change plus upstream lead and 24s burst margin; provisional multi-track 12m belts with 0.12m longitudinal/track pitches and controlled FIFO merge", lanes };
}

export function sharedTransit(run) {
  return run.transit - Object.values(run.hall.highRecirculation.lanes).reduce((n, lane) => n + lane.stock, 0);
}

export function wakeFresh(run) {
  if (run.freshWaiting && sharedTransit(run) < run.input.equipment_config.conveyor_capacity) {
    const waiting = run.freshWaiting;
    run.freshWaiting = null;
    run.schedule(Math.max(run.time, run.serviceAt), "hall-fresh", waiting);
  }
}

export function reserveHighLoop(run, sku) {
  const assigned = Object.entries(run.hall.highRecirculation.lanes).filter(([, lane]) => lane.sku === sku && lane.enabled);
  if (!assigned.length) return false;
  const candidates = assigned.filter(([, lane]) => lane.stock + lane.inbound < lane.capacity);
  if (!candidates.length) {
    assigned[0][1].overflow++;
    run.count("high-local-overflow");
    return false;
  }
  candidates.sort((a, b) => (a[1].stock + a[1].inbound) - (b[1].stock + b[1].inbound) || a[0].localeCompare(b[0]));
  const [station, lane] = candidates[0];
  lane.inbound++;
  lane.peak = Math.max(lane.peak, lane.stock + lane.inbound);
  const cfg = run.input.equipment_config;
  const machine = run.machineById.get(station);
  const delay = (cfg.decision_upstream_distance + run.machines.indexOf(machine) * cfg.filler_pitch) / cfg.grader_speed;
  const token = run.highLocalSequence++;
  const fruit = { station, sku, token, origin: run.time, enteredAt: run.time + delay, arrived: false, gateAt: run.time + delay };
  run.highLocalQueues.get(station).push(fruit);
  run.highLocalTokens.set(token, fruit);
  run.schedule(fruit.enteredAt, "hall-high-local-entry", { station, sku, token });
  run.count("high-local-routed");
  return true;
}

// One exact merge wake per lane. Waiting fruit occupies existing finite track
// positions, not a new external queue or a fresh trip through the shared grader.
function scheduleGate(run, lane, station, at) {
  if (lane.wakeAt !== null && lane.wakeAt <= at) return;
  lane.wakeAt = at;
  run.schedule(at, "hall-high-local-gate", { station, sku: lane.sku, wakeAt: at });
}

function dischargeHead(run, station, lane) {
  const fifo = run.highLocalQueues.get(station);
  const fruit = fifo[0];
  if (!fruit?.arrived) return;
  if (fruit.gateAt > run.time) {
    scheduleGate(run, lane, station, fruit.gateAt);
    return;
  }
  lane.circulating = 0;
  lane.held = lane.stock;
  const machine = run.machineById.get(station);
  const bin = run.bins[machine.bin];
  const ready = bin && !bin.conveyor && bin.slot === 1 && bin.readyAt <= run.time &&
    ["empty-ready", "filling", "inserted"].includes(bin.phase) && (!bin.sku || bin.sku === fruit.sku) &&
    bin.fruit_count + bin.reserved < run.target(fruit.sku);
  if (!ready) {
    // Missing/full/unready real bins require actual local transport. Only the
    // head circulates; the controlled parallel tracks retain younger FIFO fruit.
    fruit.gateAt = run.time + lane.lapSeconds;
    lane.circulating = 1;
    lane.held = lane.stock - 1;
    lane.laps++;
    run.count("high-local-laps");
    scheduleGate(run, lane, station, fruit.gateAt);
    return;
  }
  if (lane.outputAt > run.time) {
    // A finite merge headway is not an absent filler: retain fruit on its
    // already-counted track position and release at the exact meter deadline.
    scheduleGate(run, lane, station, lane.outputAt);
    return;
  }
  if (!bin.sku) run.assignFruitBin(bin, fruit.sku);
  bin.fruitOrigin = Math.min(bin.fruitOrigin ?? fruit.origin, fruit.origin);
  bin.reserved++;
  fifo.shift();
  run.highLocalTokens.delete(fruit.token);
  if (lane.lastDeliveredToken !== null && fruit.token <= lane.lastDeliveredToken) throw Error("Local fruit must leave in FIFO order");
  lane.lastDeliveredToken = fruit.token;
  lane.lastDeliveredAt = run.time;
  lane.stock--;
  lane.held = lane.stock;
  lane.delivered++;
  lane.outputAt = run.time + lane.outputHeadwaySeconds;
  run.count("high-local-delivered");
  run.count(`route:${machine.id}`);
  run.handle("hall-arrive", { bin: machine.bin, sku: fruit.sku });
  const next = fifo[0];
  if (next?.arrived) scheduleGate(run, lane, station, Math.max(lane.outputAt, next.gateAt));
}

export function handleHighLoop(run, kind, data) {
  if (kind !== "hall-high-local-entry" && kind !== "hall-high-local-gate") return false;
  const lane = run.hall.highRecirculation.lanes[data.station];
  if (!lane || lane.sku !== data.sku) throw Error("Local loop requires its own assigned SKU");
  if (kind === "hall-high-local-entry") {
    const fruit = run.highLocalTokens.get(data.token);
    if (!(lane.inbound > 0) || !fruit || fruit.arrived) throw Error("Local loop entry requires a reserved physical slot");
    fruit.arrived = true;
    lane.inbound--;
    lane.stock++;
    lane.held = lane.stock - lane.circulating;
    lane.entered++;
    wakeFresh(run);
    if (lane.wakeAt !== null) return true;
  } else {
    if (data.wakeAt !== lane.wakeAt) return true;
    lane.wakeAt = null;
  }
  dischargeHead(run, data.station, lane);
  return true;
}
