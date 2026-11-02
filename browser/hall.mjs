import { seedWorkingStartup } from "./startup.mjs";
import { chargeIdle, finishCharge, scheduleBatteryWake } from "./charging.mjs";
import { installParking, returnIdleHome } from "./parking.mjs";
import { RECIPES } from "./recipes.mjs";
const clone = structuredClone;
const distance = (points) =>
  points
    .slice(1)
    .reduce(
      (n, p, i) => n + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]),
      0,
    );
// This policy deliberately selects retained fixed count rows, not the invalidated
// unlimited-top-up endpoint controller. All rows are provisional sampled evidence.
export function initializeHall(run, options) {
  const original = {};
  for (const name of ["handle", "mission", "observe", "checkpoint"])
    original[name] = run[name].bind(run);
  run.hallBase = original;
  for (const name of Object.getOwnPropertyNames(Hall.prototype))
    if (name !== "constructor") run[name] = Hall.prototype[name];
  run.hall = {
    mode: "mixed",
    seed: options.seed ?? 1,
    random: options.seed ?? 1,
    lossRandom: (options.seed ?? 1) ^ 0xa5a5a5a5,
    actualLoss: options.actualLoss ?? 0.005,
    trace: options.trace ?? null,
    traceIndex: 0,
    counts: {},
    mass: { initial: 0, admitted: 0, consumed: 0 },
    fruitCount: options.fruitCount ?? Number.MAX_SAFE_INTEGER,
    serviceQueue: [],
    serviceScheduled: false,
    admittedBySku: {},
    transitBySku: {},
    consumedBySku: {},
    initialBySku: {},
    feeder: [[], [], []],
    feederMoving: {},
    feederInbound: 0,
    destackerUntil: 0,
    t5: {
      input: [],
      returned: [],
      inbound: 0,
      returnAt: null,
      status: "provisional thirty-minute whole-stack return",
    },
    shared: [],
    sharedInbound: 0,
    sharedReserved: 0,
    sharedCapacity: 3,
    stackerUntil: 0,
    runs: [],
    skuOwners: {},
    localEmpty: {
      slots: [],
      target: 9,
      inbound: 0,
      outbound: 0,
      status:
        "restore three real local three-high stacks; provisional stock policy",
    },
    fifoStores: ["low_staging", "wall_storage"],
    fullPutawayStores: ["wall_storage"],
    fullBySku: {},
    admission: {},
    stores: {},
    carryover: {},
    emptySources: [],
    returnPending: [],

    externalBoundaries: {
      juice:
        "SKU17 bypasses circulating-bin fleet; externally owned offsite stream",
      prepack:
        "SKU09/SKU19 finite filled-bin storage; external collection not configured",
    },
    startup: "empty-fruit-FIFO-166-v1",
    policy: "provisional-fixed-count-bounded-closure",
    blockedModes: [
      "size-12 geometric recipe absent",
      "mixed-pallet/weekend/dispatch policy unresolved; unsupported",
      "no supplemental stock configured; realised shortages block",
    ],
  };
  const h = run.hall;
  installParking(run);
  // Topology is immutable for one Experiment. Cache geometry only; occupancy,
  // leases, stock and batch ownership are always read from the current world.
  run.planningIndex = {
    fronts: Object.fromEntries(
      Object.entries(run.input.network.storage_slots).map(([store, slots]) => [
        store,
        Object.fromEntries(
          slots.map((slot) => [
            slot.slot,
            slots
              .filter(
                (front) =>
                  front.lane === slot.lane &&
                  (store === "wall_storage"
                    ? front.centre_xy_m[0] > slot.centre_xy_m[0]
                    : front.depth < slot.depth),
              )
              .map((front) => front.slot),
          ]),
        ),
      ]),
    ),
    putawayFronts: Object.fromEntries(
      Object.entries(run.input.network.storage_slots).map(([store, slots]) => [
        store,
        Object.fromEntries(
          slots.map((slot) => [
            slot.slot,
            slots
              .filter(
                (other) =>
                  other.lane === slot.lane &&
                  (store === "wall_storage"
                    ? other.centre_xy_m[0] < slot.centre_xy_m[0]
                    : other.depth < slot.depth),
              )
              .map((other) => other.slot),
          ]),
        ),
      ]),
    ),
    cells: new Map(run.input.cells.map((cell) => [cell.id, cell])),
    putaway: Object.fromEntries(
      Object.entries(run.input.network.storage_slots).map(([store, slots]) => [
        store,
        {
          depth: [...slots].sort(
            (a, b) => b.depth - a.depth || a.lane - b.lane,
          ),
          right: [...slots].sort(
            (a, b) =>
              b.centre_xy_m[0] - a.centre_xy_m[0] ||
              b.depth - a.depth ||
              a.lane - b.lane,
          ),
        },
      ]),
    ),
  };
  h.compute = { dispatches: 0, stockLookups: 0 };

  if (!Number.isInteger(h.seed) || h.seed < 0 || h.seed > 0xffffffff)
    throw Error("Invalid unsigned seeded grade stream");
  if (h.trace && (!Array.isArray(h.trace) || !h.trace.length))
    throw Error("A deterministic trace must contain SKU identities");
  if (!(h.actualLoss >= 0 && h.actualLoss <= 1))
    throw Error("Invalid actual loss scenario");
  run.input.id = "mixed-grade-empty-FIFO-166-v1";
  run.input.purpose = `Provisional mixed-grade ${run.robots.length}-AGV hall; selected fixed-count recipe admission; unresolved closure modes blocked`;
  run.config.mode = "mixed";
  run.config.seed = h.seed;
  run.config.fruitCount = h.fruitCount;
  run.config.fruitRate = options.fruitRate ?? run.input.grader.cupsPerSecond;
  run.queue.items = [];
  run.seq = 0;
  run.skuById = new Map(run.input.skus.map((s) => [s.id, s]));
  run.machines = [];
  for (const b of run.bins) {
    const recipe = RECIPES[b.sku];
    b.recipe = recipe ? clone(recipe) : null;
    b.fruitOrigin = null;
    b.fifoEnteredAt = null;
    if (b.location.startsWith("L") || b.location.startsWith("H")) {
      let m = run.machines.find((m) => m.id === b.location);
      if (!m) {
        m = {
          id: b.location,
          bin: null,
          queue: null,
          stack: [],
          assignment:
            run.input.equipment_config.high_volume_assignments[b.location] ??
            null,
          blocked: null,
        };
        run.machines.push(m);
      }
      if (b.slot === 2 && m.assignment) m.queue = run.binIndex.get(b.id);
      else m.bin = run.binIndex.get(b.id);
    } else if (b.location === "grader_empty_drop")
      h.feeder[b.slot].push(run.binIndex.get(b.id));
    else {
      const cells = (h.stores[b.location] ??= {});
      (cells[b.slot] ??= []).push(run.binIndex.get(b.id));
    }
  }
  run.machineById = new Map(run.machines.map((m) => [m.id, m]));
  run.tippers = run.input.cells
    .filter((c) => c.id !== "T5")
    .map((c) => ({
      id: c.id,
      bin: null,
      queue: [],
      run: null,
      phase: "idle",
      blocked: options.blockTipper ? "destination blocked by fixture" : null,
    }));
  run.tipper = run.tippers[0];
  // Optional named recipe-valid stock witness, no identity/position/space changes.
  // Only existing low/wall storage bins may acquire declared initial fruit.
  if (options.initialStock) {
    h.startup = "declared-recipe-stock-witness";
    const slots = Object.entries(h.stores)
      .filter(([id]) => id !== "empty_staging")
      .flatMap(([, v]) => Object.values(v).flat());
    let p = 0;
    for (const entry of options.initialStock) {
      const recipe = RECIPES[entry.sku];
      if (!recipe || !Number.isInteger(entry.bins) || entry.bins < 1)
        throw Error("Invalid declared recipe stock");
      for (let j = 0; j < entry.bins; j++) {
        const b = run.bins[slots[p++]];
        if (!b) throw Error("Finite declared startup storage exhausted");
        b.sku = entry.sku;
        b.recipe = clone(recipe);
        b.fill_count_target = recipe.count;
        b.fruit_count = recipe.count;
        b.fruit_mass_kg = recipe.count * recipe.mass;
        b.phase = "full-ready";
        b.fifoEnteredAt = 0;
        b.sourceGroup = entry.sourceGroup ?? `${entry.sku}:configured-cohort`;
        h.initialBySku[b.sku] = (h.initialBySku[b.sku] ?? 0) + b.fruit_count;
        h.mass.initial += b.fruit_mass_kg;
        (h.fullBySku[b.sku] ??= []).push(run.binIndex.get(b.id));
      }
    }
  }
  const localSlots = run.input.network.storage_slots.low_staging,
    cells = h.stores.low_staging;
  for (const [slot, bins] of Object.entries(cells))
    if (bins.length === 3 && bins.every((i) => run.bins[i].sku === null))
      h.localEmpty.slots.push(Number(slot));
  for (const slot of [...localSlots].sort(
    (a, b) => b.centre_xy_m[0] - a.centre_xy_m[0] || b.depth - a.depth,
  )) {
    if (h.localEmpty.slots.length === 3) break;
    if (
      (cells[slot.slot] ?? []).length ||
      h.localEmpty.slots.some((i) => localSlots[i].lane === slot.lane)
    )
      continue;
    if (
      localSlots.some(
        (front) =>
          front.lane === slot.lane &&
          front.depth < slot.depth &&
          (cells[front.slot] ?? []).length,
      )
    )
      continue;
    h.localEmpty.slots.push(slot.slot);
  }
  if (h.localEmpty.slots.length !== 3)
    throw Error("Three real accessible local empty-buffer slots required");
  if (options.startup === "working") seedWorkingStartup(run);
  run.schedule(0, "hall-startup", {}, 1);
  if (h.fruitCount) run.schedule(0, "hall-fresh", { number: 0, sku: null });
}
class Hall {
  count(kind, amount = 1) {
    this.hall.counts[kind] = (this.hall.counts[kind] ?? 0) + amount;
  }
  drawSku() {
    const h = this.hall;
    if (h.trace) {
      const sku = h.trace[h.traceIndex++ % h.trace.length];
      if (!this.skuById.has(sku)) throw Error("Unknown trace SKU");
      return sku;
    }
    h.random = (Math.imul(1664525, h.random) + 1013904223) >>> 0;
    let r = h.random / 4294967296;
    for (const s of this.input.skus) {
      r -= s.count_fraction;
      if (r < 0) return s.id;
    }
    return this.input.skus.at(-1).id;
  }
  mass(sku) {
    return RECIPES[sku]?.mass ?? this.skuById.get(sku).mean_fruit_mass_kg;
  }
  target(sku) {
    return RECIPES[sku]?.count ?? Math.floor(400 / this.mass(sku));
  }
  handle(kind, d) {
    const h = this.hall,
      cfg = this.input.equipment_config;
    if (kind === "phase") {
      const job = this.jobs[d.job],
        robot = this.robots[job.robot],
        phase = job.phases[d.phase];
      if (
        phase.kind === "empty_travel" &&
        h.parking.occupancy[robot.location] === robot.id
      )
        delete h.parking.occupancy[robot.location];
      this.hallBase.handle(kind, d);
      return;
    }
    if (kind === "mission-end") {
      const job = this.jobs[d.job];
      finishCharge(this, job);
      this.hallBase.handle(kind, d);
      scheduleBatteryWake(this, this.robots[job.robot]);
      if (job.meta.kind === "idle-home") {
        h.parking.occupancy[job.destination] = this.robots[job.robot].id;
        this.record("idle-home-complete", {
          robot: this.robots[job.robot].id,
          destination: job.destination,
        });
      }
      return;
    }
    if (kind === "hall-energy-wake") {
      const robot = this.robots[d.robot];
      if (robot.batteryWake === d.token && robot.job === null)
        this.notify("battery-threshold", robot.id);
      return;
    }
    if (kind === "hall-startup") {
      for (const robot of this.robots) scheduleBatteryWake(this, robot);
      this.record("hall-startup", { startup: h.startup });
      this.notify("station-ready", "hall");
      return;
    }
    if (kind === "hall-service") {
      h.serviceScheduled = false;
      const next = h.serviceQueue.shift();
      if (next) this.handle(next.kind, next.data);
      return;
    }
    if (kind === "hall-fresh" || kind === "hall-regrade") {
      const fresh = kind === "hall-fresh";
      if (fresh && this.transit >= cfg.conveyor_capacity) {
        this.freshWaiting = d;
        return;
      }
      if (this.time < this.serviceAt) {
        h.serviceQueue.push({ kind, data: d });
        if (!h.serviceScheduled) {
          h.serviceScheduled = true;
          this.schedule(this.serviceAt, "hall-service");
        }
        return;
      }
      const sku = d.sku ?? this.drawSku(),
        mass = this.mass(sku);
      this.serviceAt =
        this.time +
        Math.max(
          1 / this.input.grader.cupsPerSecond,
          mass / this.input.grader.massKgPerSecond,
        );
      if (fresh) {
        this.admitted++;
        this.transit++;
        h.mass.admitted += mass;
        h.admittedBySku[sku] = (h.admittedBySku[sku] ?? 0) + 1;
        h.transitBySku[sku] = (h.transitBySku[sku] ?? 0) + 1;
        this.count("grading");
      }
      this.routeFruit(sku);
      if (h.serviceQueue.length && !h.serviceScheduled) {
        h.serviceScheduled = true;
        this.schedule(this.serviceAt, "hall-service");
      }
      if (fresh && d.number + 1 < h.fruitCount)
        this.schedule(
          Math.max(this.serviceAt, (d.number + 1) / this.config.fruitRate),
          "hall-fresh",
          { number: d.number + 1, sku: null },
        );
      return;
    }
    if (kind === "hall-arrive") {
      const b = this.bins[d.bin];
      b.reserved--;
      b.fruit_count++;
      b.fruit_mass_kg = b.fruit_count * this.mass(b.sku);
      this.transit--;
      h.transitBySku[b.sku]--;
      if (this.freshWaiting) {
        const w = this.freshWaiting;
        this.freshWaiting = null;
        this.schedule(Math.max(this.time, this.serviceAt), "hall-fresh", w);
      }
      if (b.fruit_count === b.fill_count_target) {
        b.phase = "full";
        b.readyAt = this.time + cfg.full_bin_ready_delay;
        this.schedule(b.readyAt, "hall-full-ready", d, 1);
        this.record("full", { bin: b.id, sku: b.sku });
      }
      return;
    }
    if (kind === "hall-full-ready") {
      const b = this.bins[d.bin];
      b.phase = "full-ready";
      (h.fullBySku[b.sku] ??= []).push(d.bin);
      this.record("full-ready", { bin: b.id });
      this.notify("station-full-ready", b.location);
      return;
    }
    if (kind === "hall-move") {
      for (const i of d.bins) {
        const b = this.bins[i];
        b.conveyor = null;
        b.phase = d.phase ?? b.phase;
        if (d.location) {
          b.location = d.location;
          b.owner = d.location;
        }
        if (d.slot !== undefined) b.slot = d.slot;
      }
      if (d.operation === "feeder-advance") {
        h.feeder[d.from] = [];
        h.feeder[d.to] = d.bins;
        delete h.feederMoving[d.from];
        delete h.feederMoving[d.to];
        this.count("feeder-advance");
      }
      if (d.operation === "feeder-single") {
        for (const i of d.bins) this.bins[i].batch = null;
        const m = this.machineById.get(d.location);
        m[d.destination] = d.bins[0];
        delete m.supplyInbound;
        const b = this.bins[d.bins[0]];
        b.readyAt = this.time + cfg.inserted_empty_ready_delay;
        this.schedule(b.readyAt, "hall-empty-ready", { bin: d.bins[0] }, 1);
        this.count("feeder-supply");
      }
      if (d.operation === "high-stack") {
        const m = this.machineById.get(d.location);
        m.stacking = false;
        m.stack.push(d.bins[0]);
        this.count("high-stack");
      }
      if (d.operation === "high-queue") {
        const m = this.machineById.get(d.location);
        m.bin = d.bins[0];
        m.queue = null;
        m.queueMoving = false;
        const b = this.bins[d.bins[0]];
        b.readyAt = this.time + cfg.inserted_empty_ready_delay;
        this.schedule(b.readyAt, "hall-empty-ready", { bin: d.bins[0] }, 1);
      }
      if (d.operation === "tip-single-arrive") {
        const t = this.tippers.find((t) => t.id === d.location),
          i = d.bins[0],
          b = this.bins[i],
          batch = h.runs[t.run],
          cell = this.planningIndex.cells.get(t.id);
        t.phase = "tipping";
        b.phase = "tipping";
        b.tier = 1;
        b.tip = {
          start: this.time,
          count: b.fruit_count,
          rate: cell.consumption[b.sku].value / 3600 / this.mass(b.sku),
        };
        batch.phase = "packing";
        this.schedule(
          this.time + b.fruit_count / b.tip.rate,
          "hall-tip-empty",
          { bin: i, tipper: this.tippers.indexOf(t) },
        );
        this.record("tip-start", { bin: b.id, tipper: t.id });
      }
      if (d.operation === "shared-arrive") {
        h.sharedInbound--;
        h.shared.push(d.bins[0]);
        this.bins[d.bins[0]].tier = h.shared.length;
        this.bins[d.bins[0]].slot = 0;
        const t = this.tippers.find((t) => t.id === d.tipper);
        t.bin = null;
        t.phase = "idle";
        this.count("shared-empty");
      }
      this.notify(
        "station-conveyor-complete",
        d.location ?? "grader_empty_drop",
      );
      return;
    }
    if (kind === "hall-empty-ready") {
      this.bins[d.bin].phase = "empty-ready";
      this.notify("station-empty-ready", this.bins[d.bin].location);
      return;
    }
    if (kind === "hall-tip-empty") {
      const t = this.tippers[d.tipper],
        b = this.bins[d.bin],
        count = b.tip.count;
      this.consumed += count;
      h.consumedBySku[b.sku] = (h.consumedBySku[b.sku] ?? 0) + count;
      h.mass.consumed += count * this.mass(b.sku);
      const batch = h.runs[t.run];
      batch.consumed += count;
      batch.tipped++;
      let rejects = 0;
      for (let n = 0; n < count; n++) {
        h.lossRandom = (Math.imul(1664525, h.lossRandom) + 1013904223) >>> 0;
        if (h.lossRandom / 4294967296 < h.actualLoss) rejects++;
      }
      batch.rejects += rejects;
      batch.pendingFruit += count - rejects;
      this.count("packing", count);
      this.count("inspection-rejects", rejects);
      // Only eight equal-height stacks transfer; stack height is predeclared.
      const unit = batch.recipe.size * 8;
      while (
        batch.heights.length &&
        batch.pendingFruit >= batch.heights[0] * unit
      ) {
        const height = batch.heights.shift();
        batch.pendingFruit -= height * unit;
        batch.layers += height;
        batch.transfers.push({
          time: this.time,
          height,
          stacks: 8,
          pallet: batch.currentPallet.id,
        });
        batch.currentPallet.layers += height;
        if (batch.currentPallet.layers === 20) {
          batch.completedPallets.push({
            ...batch.currentPallet,
            completedAt: this.time,
            boundary:
              "complete palletizer output; external dispatch policy unresolved",
          });
          batch.currentPallet = batch.heights.length
            ? {
                id: `${batch.id}:pallet:${batch.completedPallets.length}`,
                owner: batch.cell,
                layers: 0,
              }
            : null;
        }
      }
      b.fruit_count = 0;
      b.fruit_mass_kg = 0;
      b.tip = null;
      b.sku = null;
      b.phase = "empty";
      t.phase = "return-blocked";
      h.returnPending.push({ tipper: d.tipper, bin: d.bin });
      this.record("tip-empty", { bin: b.id, tipper: t.id });
      this.notify("station-empty", t.id);
      return;
    }
    if (kind === "hall-t5-return") {
      if (h.t5.returned.length) throw Error("Finite T5 empty output occupied");
      for (const i of h.t5.input) {
        const b = this.bins[i];
        h.externalFruit = (h.externalFruit ?? 0) + b.fruit_count;
        h.externalMass = (h.externalMass ?? 0) + b.fruit_mass_kg;
        this.count("t5-fruit", b.fruit_count);
        b.fruit_count = 0;
        b.fruit_mass_kg = 0;
        b.sku = null;
        b.recipe = null;
        b.phase = "empty-ready";
        b.location = "T5:empty";
        b.owner = "T5:empty";
      }
      h.t5.returned = h.t5.input;
      h.t5.input = [];
      h.t5.returnAt = null;
      this.count("t5-return");
      this.notify("station-empty", "T5:empty");
      return;
    }
    if (kind === "hall-changeover") {
      const t = this.tippers[d.tipper];
      t.phase = "idle";
      t.run = null;
      if (
        Object.values(h.carryover).some((c) => c.owner === t.id && c.fruit > 0)
      )
        t.closureBlocked =
          "cell-owned finite remainder: same-SKU resumption only; incompatible removal/changeover unsupported";
      this.notify("station-changeover-complete", t.id);
      return;
    }
    if (kind === "transfer") {
      this.transferHall(d);
      return;
    }
    // Motion/mission completion retain the first slice's directed queues,
    // energy phases and withdrawal-scoped leases, not a second scheduler.
    this.hallBase.handle(kind, d);
  }
  routeFruit(sku) {
    const h = this.hall;
    if (sku === "SKU17") {
      this.transit--;
      h.transitBySku[sku]--;
      h.externalFruit = (h.externalFruit ?? 0) + 1;
      h.externalMass = (h.externalMass ?? 0) + this.mass(sku);
      this.count("offsite-juice");
      return;
    }
    const cfg = this.input.equipment_config;
    const fixed = this.machines.some((m) => m.assignment === sku);
    const eligible = this.machines
      .filter(
        (m) =>
          m.bin !== null &&
          (fixed ? m.assignment === sku : !m.assignment) &&
          this.leases[m.id] === undefined,
      )
      .filter((m) => {
        const b = this.bins[m.bin];
        return (
          b.readyAt <= this.time &&
          !b.conveyor &&
          ["empty-ready", "filling"].includes(b.phase) &&
          (!b.sku || b.sku === sku) &&
          b.fruit_count + b.reserved < this.target(sku)
        );
      });
    const m =
      eligible.find((m) => m.assignment === sku) ??
      eligible.find((m) => this.bins[m.bin].sku === sku) ??
      eligible[0];
    if (m) {
      const b = this.bins[m.bin];
      if (!b.sku) {
        b.sku = sku;
        b.recipe = RECIPES[sku] ? clone(RECIPES[sku]) : null;
        b.fill_count_target = this.target(sku);
        b.sourceGroup = `${sku}:configured-cohort`;
        b.fruitOrigin = this.time;
      }
      b.phase = "filling";
      b.reserved++;
      m.sku = sku;
      this.count(`route:${m.id}`);
      this.schedule(
        this.time +
          (cfg.decision_upstream_distance +
            this.machines.indexOf(m) * cfg.filler_pitch) /
            cfg.grader_speed,
        "hall-arrive",
        { bin: m.bin },
      );
    } else {
      this.count("recirculation");
      const delay =
        cfg.decision_to_belt_end / cfg.grader_speed +
        cfg.return_belt_length / cfg.recirculation_speed +
        cfg.return_to_decision_length / cfg.grader_speed;
      this.schedule(this.time + delay, "hall-regrade", { sku });
    }
  }
  move(bins, points, d, dwell = 0, start = this.time) {
    const end = start + distance(points) / 0.25 + dwell;
    const phases = [];
    let cursor = start;
    const dwellAt =
      d.operation === "feeder-single"
        ? 0
        : d.operation === "tip-single-arrive"
          ? 1
          : d.operation === "shared-arrive"
            ? 3
            : points.length - 1;
    for (let i = 0; i < points.length; i++) {
      if (i === dwellAt && dwell) {
        phases.push({
          kind: "conveyor_dwell",
          start: cursor,
          end: cursor + dwell,
          position_m: points[i],
        });
        cursor += dwell;
      }
      if (i + 1 < points.length) {
        const duration = distance([points[i], points[i + 1]]) / 0.25;
        phases.push({
          kind: "conveyor_travel",
          start: cursor,
          end: cursor + duration,
          geometry_m: [points[i], points[i + 1]],
        });
        cursor += duration;
      }
    }
    for (const i of bins)
      this.bins[i].conveyor = {
        start,
        end,
        geometry_m: points,
        dwell_s: dwell,
        phases,
      };
    this.schedule(end, "hall-move", { ...d, bins });
    return end;
  }
  feeder() {
    const h = this.hall,
      flow = this.input.network.high_volume_flow;
    for (const from of [1, 0]) {
      const to = from + 1,
        bins = h.feeder[from];
      if (
        bins.length &&
        !(from === 0 && this.leases.grader_empty_drop !== undefined) &&
        !h.feeder[to].length &&
        !h.feederMoving[from] &&
        !h.feederMoving[to] &&
        !(to === 2 && h.destackerUntil > this.time)
      ) {
        h.feederMoving[from] = true;
        h.feederMoving[to] = true;
        this.record("feeder-stack-advance", {
          from,
          to,
          bins: bins.map((i) => this.bins[i].id),
          start: this.time,
          end: this.time + 6,
        });
        this.move(
          [...bins],
          [flow.feeder_stack_positions[from], flow.feeder_stack_positions[to]],
          { operation: "feeder-advance", from, to },
        );
      }
    }
    for (const m of this.machines.filter((m) => m.assignment)) {
      if (
        m.bin !== null &&
        this.bins[m.bin].phase === "full-ready" &&
        !m.stacking &&
        m.stack.length < 3 &&
        this.leases[m.id] === undefined
      ) {
        const i = m.bin,
          b = this.bins[i];
        m.bin = null;
        m.stacking = true;
        b.slot = 0;
        b.tier = m.stack.length + 1;
        this.move(
          [i],
          [flow.outlets[m.id].filler, flow.outlets[m.id].stacker],
          { operation: "high-stack", location: m.id },
          this.input.handling.single_stack.value,
        );
      }
      if (m.bin === null && m.queue !== null && !m.queueMoving && !m.stacking) {
        m.queueMoving = true;
        this.move(
          [m.queue],
          [flow.outlets[m.id].queued_empty, flow.outlets[m.id].filler],
          {
            operation: "high-queue",
            location: m.id,
            slot: 1,
            phase: "inserted",
          },
        );
      }
      if (
        m.supplyInbound === undefined &&
        m.queue === null &&
        !m.queueMoving &&
        h.feeder[2].length &&
        !h.feederMoving[2] &&
        h.destackerUntil <= this.time
      ) {
        const i = h.feeder[2].pop(),
          b = this.bins[i],
          target = flow.outlets[m.id].queued_empty;
        m.supplyInbound = i;
        b.phase = "inserted";
        h.destackerUntil = this.time + this.input.handling.single_destack.value;
        this.move(
          [i],
          [
            flow.destacker,
            flow.belt_junction,
            [target[0], flow.belt_junction[1]],
            target,
          ],
          {
            operation: "feeder-single",
            location: m.id,
            destination: "queue",
            slot: 2,
            phase: "inserted",
          },
          this.input.handling.single_destack.value,
        );
        this.schedule(h.destackerUntil, "hall-feeder-ready", {}, 1);
        this.count("feeder-withdraw");
      }
    }
  }
  accessible(i, selected = new Set()) {
    const b = this.bins[i],
      slots = this.input.network.storage_slots[b.location];
    if (!slots) return true;
    if (
      this.leases[`column:${b.location}:${slots[b.slot]?.lane}`] !== undefined
    )
      return false;
    const slot = slots[b.slot];
    if (!slot) return false;
    const cells = this.hall.stores[b.location] ?? {};
    for (const front of this.planningIndex.fronts[b.location][b.slot])
      for (const j of cells[front] ?? []) if (!selected.has(j)) return false;
    return true;
  }
  source(i) {
    const b = this.bins[i];
    return (
      this.input.network.storage_slots[b.location]?.[b.slot]?.pickup_node ??
      b.location
    );
  }
  storageDestination(store, bins, rightFirst = false) {
    const cells = this.hall.stores[store],
      slots = this.input.network.storage_slots[store];
    if (!cells || !slots) return null;
    if (bins.length === 1 && this.bins[bins[0]].sku !== null) {
      const incoming = this.robots
        .filter((r) => r.job !== null)
        .map((r) => this.jobs[r.job])
        .find(
          (job) =>
            job.meta?.kind === "full-store" &&
            job.meta.destinationStore === store &&
            this.bins[job.bin].sku === this.bins[bins[0]].sku &&
            this.bins[job.bin].sourceGroup === this.bins[bins[0]].sourceGroup &&
            (cells[job.meta.destinationSlot]?.length ?? 0) < 3,
        );
      if (incoming) return null; // retain the real compatible stack target, not fragmented singleton stock
    }
    if (store === "wall_storage") return this.fifoDestination(bins);
    // Do not bury another cohort, empty supply, or an unfinished rear stack.
    // A partial stack must remain reachable until completed, and reserved rear
    // stock must remain available to its already-admitted packing run.
    const clearForPutaway = (slot) =>
      this.leases[`column:${store}:${slot.lane}`] === undefined &&
      !slots.some(
        (other) =>
          other.lane === slot.lane &&
          ((other.depth < slot.depth && (cells[other.slot] ?? []).length) ||
            (other.depth > slot.depth &&
              (cells[other.slot] ?? []).some((i) => {
                const b = this.bins[i],
                  source = this.bins[bins[0]];
                return (
                  cells[other.slot].length < 3 ||
                  b.batch != null ||
                  b.sku !== source.sku ||
                  b.sourceGroup !== source.sourceGroup
                );
              }))),
      );
    let partialTarget = null;
    if (bins.length === 1 && this.bins[bins[0]].sku !== null) {
      const source = this.bins[bins[0]];
      partialTarget =
        slots
          .filter((slot) => {
            const current = cells[slot.slot] ?? [];
            return (
              clearForPutaway(slot) &&
              current.length > 0 &&
              current.length < 3 &&
              current.every(
                (i) =>
                  this.bins[i].sku === source.sku &&
                  this.bins[i].sourceGroup === source.sourceGroup &&
                  this.bins[i].recipe?.version === source.recipe?.version,
              )
            );
          })
          .sort(
            (a, b) => b.centre_xy_m[0] - a.centre_xy_m[0] || b.depth - a.depth,
          )[0]?.slot ?? null;
    }
    const order =
      this.planningIndex.putaway[store][rightFirst ? "right" : "depth"];
    for (const slot of order) {
      const current = cells[slot.slot] ?? [];
      if (partialTarget !== null && slot.slot !== partialTarget) continue;
      if (!clearForPutaway(slot)) continue;
      if (
        store === "low_staging" &&
        this.bins[bins[0]].sku !== null &&
        this.hall.localEmpty.slots.some((i) => slots[i].lane === slot.lane)
      )
        continue;
      if (
        this.leases[`column:${store}:${slot.lane}`] !== undefined ||
        current.length + bins.length > 3
      )
        continue;
      if (current.some((i) => this.bins[i].batch != null)) continue;
      if (
        current.some(
          (i) =>
            this.bins[i].sku !== this.bins[bins[0]].sku ||
            this.bins[i].sourceGroup !== this.bins[bins[0]].sourceGroup,
        )
      )
        continue;
      if (
        slots.some(
          (s) =>
            s.lane === slot.lane &&
            s.depth < slot.depth &&
            (cells[s.slot] ?? []).length,
        )
      )
        continue;
      return slot;
    }
    return null;
  }
  fifoDestination(bins) {
    const h = this.hall,
      cells = h.stores.wall_storage,
      slots = this.input.network.storage_slots.wall_storage,
      source = this.bins[bins[0]];
    const compatible = (i) => {
      const b = this.bins[i];
      return (
        b.sku === source.sku &&
        b.sourceGroup === source.sourceGroup &&
        b.recipe?.version === source.recipe?.version
      );
    };
    const reachable = (slot) =>
      this.leases[`column:wall_storage:${slot.lane}`] === undefined &&
      this.planningIndex.putawayFronts.wall_storage[slot.slot].every(
        (front) => !cells[front]?.length,
      ) &&
      slots
        .filter((s) => s.lane === slot.lane)
        .every((s) => (cells[s.slot] ?? []).every(compatible));
    // Complete an accessible partial stack before opening a new stack.
    const partial = slots
      .filter((slot) => {
        const stack = cells[slot.slot] ?? [];
        return (
          stack.length &&
          stack.length + bins.length <= 3 &&
          stack.every((i) => this.bins[i].batch == null && compatible(i)) &&
          reachable(slot)
        );
      })
      .sort(
        (a, b) =>
          a.centre_xy_m[0] - b.centre_xy_m[0] ||
          b.centre_xy_m[1] - a.centre_xy_m[1],
      );
    if (partial.length) return partial[0];
    // Load from the left entrance, up against the occupied bank to the right,
    // then work back towards that entrance. Never pass an occupied position.
    const candidates = slots
      .filter((slot) => !cells[slot.slot]?.length && reachable(slot))
      .sort(
        (a, b) =>
          b.centre_xy_m[0] - a.centre_xy_m[0] ||
          b.centre_xy_m[1] - a.centre_xy_m[1],
      );
    return candidates[0] ?? null;
  }
  freeStock(sku) {
    this.hall.compute.stockLookups++;
    return [...new Set(this.hall.fullBySku[sku] ?? [])]
      .filter((i) => {
        const b = this.bins[i];
        return (
          b.phase === "full-ready" &&
          this.hall.fifoStores.includes(b.location) &&
          b.fifoEnteredAt !== null &&
          b.batch == null &&
          this.leases[`bin:${i}`] === undefined &&
          !b.conveyor &&
          b.sku === sku
        );
      })
      .sort((a, b) => this.bins[a].fifoEnteredAt - this.bins[b].fifoEnteredAt);
  }
  admit() {
    const h = this.hall,
      // Reuse only within this admission pass, never across physical events.
      stocks = new Map(
        Object.keys(RECIPES).map((sku) => [sku, this.freeStock(sku)]),
      );
    for (const [sku, recipe] of Object.entries(RECIPES)) {
      const stock = stocks.get(sku),
        selected = new Set(stock);
      h.admission[sku] = {
        source: recipe.source,
        recipeVersion: recipe.version,
        required: recipe.minimum,
        available: stock.length,
        reachable: stock.filter((i) => this.accessible(i, selected)).length,
        owner: h.skuOwners[sku] ?? null,
        state:
          h.skuOwners[sku] !== undefined
            ? "reserved"
            : "waiting-compatible-reachable-recipe-minimum",
      };
    }
    for (const t of this.tippers) {
      if (t.run !== null || t.phase !== "idle" || t.blocked) continue;
      for (const [sku, recipe] of Object.entries(RECIPES)) {
        if (
          (t.assignment && t.assignment !== sku) ||
          Object.entries(h.tipperAssignments ?? {}).some(
            ([cell, assigned]) => assigned === sku && cell !== t.id,
          ) ||
          Object.entries(h.carryover).some(
            ([k, c]) => c.owner === t.id && c.fruit > 0 && k !== sku,
          ) ||
          h.skuOwners[sku] !== undefined ||
          !this.planningIndex.cells
            .get(t.id)
            .compatible_skus.value.includes(sku)
        )
          continue;
        const stock = stocks.get(sku);
        if (stock.length < recipe.minimum) continue;
        const carryRecord = h.carryover[sku];
        const hasCarry = carryRecord?.fruit > 0;
        if (
          hasCarry &&
          (carryRecord.owner !== t.id || carryRecord.recipe !== recipe.version)
        ) {
          h.admission[sku].state = "blocked-cell-owned-carryover";
          h.admission[sku].carryover = clone(carryRecord);
          continue;
        }
        const groups = hasCarry
          ? [carryRecord.sourceGroup]
          : [...new Set(stock.map((i) => this.bins[i].sourceGroup))];
        // Stock is oldest-first; skip cohorts that cannot form a physically
        // accessible recipe-valid run, without pooling their fruit or carryover.
        for (const group of groups) {
          const compatible = stock.filter(
            (i) =>
              this.bins[i].sourceGroup === group &&
              this.bins[i].recipe?.version === recipe.version,
          );
          // Reachability requires every front blocker to be selected, never a
          // fictional relocation. Selected front bins are withdrawn before rear.
          const selected = new Set(compatible);
          const reachable = compatible.filter((i) =>
            this.accessible(i, selected),
          );
          if (reachable.length < recipe.minimum) {
            if (hasCarry) {
              h.admission[sku].state = "blocked-incompatible-cohort-resumption";
              h.admission[sku].carryover = clone(carryRecord);
            }
            continue;
          }
          const ordered = reachable.sort((a, b) => {
            const x = this.bins[a],
              y = this.bins[b];
            return (
              (x.fifoEnteredAt ?? Infinity) - (y.fifoEnteredAt ?? Infinity) ||
              x.location.localeCompare(y.location) ||
              x.slot - y.slot ||
              y.tier - x.tier
            );
          });
          // Select whole physical source groups before reserving a normal run.
          // A terminal pair is predeclared; free cell capacity never shaves a
          // singleton from a reserved stack.
          const physical = new Map();
          for (const i of ordered) {
            const b = this.bins[i],
              key = `${b.location}/${b.slot}`;
            if (!physical.has(key)) physical.set(key, []);
            physical.get(key).push(i);
          }
          let plans = new Map([[0, []]]);
          for (const stack of physical.values()) {
            // A partial pickup must take the physical top. FIFO age orders stacks,
            // never permits reaching through an older bottom bin's upper tiers.
            stack.sort((a, b) => this.bins[b].tier - this.bins[a].tier);
            const next = new Map(plans),
              sizes =
                stack.length >= 3 ? [3, 2] : stack.length === 2 ? [2] : [];
            for (const [count, plan] of plans)
              for (const size of sizes)
                if (count + size <= recipe.minimum && !next.has(count + size))
                  next.set(count + size, [...plan, stack.slice(0, size)]);
            plans = next;
          }
          const transport = plans.get(recipe.minimum);
          if (!transport) {
            h.admission[sku].state =
              "waiting-complete-three-bin-or-terminal-pair-source-groups";
            continue;
          }
          const bins = transport.flat(),
            chosen = new Set(bins);
          if (bins.some((i) => !this.accessible(i, chosen))) continue;
          const carry = hasCarry ? carryRecord.fruit : 0,
            raw = bins.reduce((n, i) => n + this.bins[i].fruit_count, 0);
          const expected = (raw * 0.995 + carry) / (8 * recipe.size),
            goal = Math.floor(expected / 20) * 20;
          // Bounded guard: no unlimited supplemental supply, <=five-layer
          // forecast surplus. Actual shortages remain explicitly unfinished.
          if (goal < recipe.minimum * recipe.layers || expected - goal >= 5)
            continue;
          const heights = [];
          for (let n = goal; n > 0; n -= Math.min(5, n))
            heights.push(Math.min(5, n));
          const batch = {
            id: h.runs.length,
            sku,
            recipe: clone(recipe),
            sourceGroup: group,
            bins,
            transportGroups: transport.map((bins) => ({
              bins,
              source: this.bins[bins[0]].location,
              slot: this.bins[bins[0]].slot,
              status: "reserved",
              job: null,
            })),
            phase: "reserved",
            goalLayers: goal,
            heights,
            transfers: [],
            layers: 0,
            pendingFruit: carry,
            tipped: 0,
            consumed: 0,
            rejects: 0,
            initialFruit: raw + carry,
            cell: t.id,
            completedPallets: [],
            currentPallet: {
              id: `${h.runs.length}:pallet:0`,
              owner: t.id,
              layers: 0,
            },
            supplementLimit: 0,
            status: "provisional-selected-recipe",
          };
          delete h.carryover[sku];
          h.runs.push(batch);
          h.admission[sku].state = "reserved";
          h.admission[sku].owner = t.id;
          delete t.closureBlocked;
          t.run = batch.id;
          h.skuOwners[sku] = t.id;
          for (const i of bins) this.bins[i].batch = batch.id;
          this.record("normal-admitted", {
            batch: batch.id,
            sku,
            bins: bins.map((i) => this.bins[i].id),
            source: recipe.source,
            minimum: recipe.minimum,
          });
          this.count("batch-admitted");
          break;
        }
        if (t.run !== null) break;
      }
    }
    // Batch eligibility belongs to FIFO stock, not a full bin still on a
    // filler. Dispatch below reports actual transport/space/energy blockers.
    for (const m of this.machines) m.blocked = null;
  }
  sharedReturns() {
    const h = this.hall,
      flow = this.input.network.tipper_flow;
    while (
      h.returnPending.length &&
      h.shared.length + h.sharedInbound < h.sharedCapacity &&
      this.leases.shared_empty === undefined
    ) {
      const d = h.returnPending.shift(),
        t = this.tippers[d.tipper],
        g = flow.tippers[t.id];
      const toStacker =
        distance([g.tip, g.empty_exit, g.return_corner, flow.empty_stacker]) /
        0.25;
      const stackAt = Math.max(this.time + toStacker, h.stackerUntil);
      const start = stackAt - toStacker;
      h.stackerUntil = stackAt + this.input.handling.single_stack.value;
      if (!t.outputReserved) throw Error("Tip output reservation missing");
      h.sharedReserved--;
      t.outputReserved = false;
      h.sharedInbound++;
      t.phase = "return-conveyor";
      this.move(
        [d.bin],
        [
          g.tip,
          g.empty_exit,
          g.return_corner,
          flow.empty_stacker,
          flow.intermediate,
          flow.pickup,
        ],
        {
          operation: "shared-arrive",
          tipper: t.id,
          location: "shared_empty",
          phase: "empty-ready",
        },
        this.input.handling.single_stack.value,
        start,
      );
    }
    for (const t of this.tippers)
      if (t.phase === "return-blocked") {
        if (!t.blockReason) this.count("shared-output-blockage");
        t.blockReason = "finite shared empty stacker full/inbound";
      } else delete t.blockReason;
  }
  tip() {
    const h = this.hall;
    for (const [ti, t] of this.tippers.entries()) {
      if (
        t.bin !== null ||
        !t.queue.length ||
        t.blocked ||
        this.leases[t.id] !== undefined
      )
        continue;
      if (
        h.shared.length + h.sharedInbound + h.sharedReserved >=
          h.sharedCapacity ||
        this.leases.shared_empty !== undefined
      ) {
        if (!t.outputWait) this.count("shared-output-blockage");
        t.outputWait = true;
        t.blockReason = "finite shared empty stacker output reserved/full";
        continue;
      }
      t.outputWait = false;
      delete t.blockReason;
      t.outputReserved = true;
      h.sharedReserved++;
      t.queue.sort(
        (a, b) =>
          (this.bins[a].fruitOrigin ?? 0) - (this.bins[b].fruitOrigin ?? 0) ||
          this.bins[a].tier - this.bins[b].tier,
      );
      const i = t.queue.shift(),
        b = this.bins[i],
        flow = this.input.network.tipper_flow.tippers[t.id];
      t.bin = i;
      t.phase = "tip-conveyor";
      b.phase = "tip-conveyor";
      b.tier = 1;
      this.move(
        [i],
        [flow.dropoff, flow.destacker, flow.tip],
        { operation: "tip-single-arrive", location: t.id },
        this.input.handling.single_destack.value,
      );
    }
    for (const [ti, t] of this.tippers.entries()) {
      const batch = h.runs[t.run];
      if (
        !batch ||
        batch.tipped !== batch.bins.length ||
        t.bin !== null ||
        t.queue.length ||
        batch.phase === "reconciled" ||
        batch.phase === "blocked-shortfall"
      )
        continue;
      if (batch.heights.length) {
        batch.phase = "blocked-shortfall";
        t.blocked =
          "realised endpoint shortfall; no finite compatible supplemental fruit";
        this.record("batch-blocked", { batch: batch.id, reason: t.blocked });
        continue;
      }
      // A bounded cell-owned removal retains the entire realised remainder.
      // This is not a downstream loose-tray/stack buffer or shipped production.
      h.carryover[batch.sku] = {
        fruit: batch.pendingFruit,
        trayPositions: Math.ceil(batch.pendingFruit / batch.recipe.size),
        owner: t.id,
        sourceGroup: batch.sourceGroup,
        recipe: batch.recipe.version,
      };
      if (batch.pendingFruit >= 40 * batch.recipe.size) {
        batch.phase = "blocked-carryover-capacity";
        t.blocked = "finite cell-side 40-tray carryover capacity exceeded";
        continue;
      }
      batch.phase = "reconciled";
      batch.reconciliation = {
        input: batch.initialFruit,
        transferred: batch.layers * 8 * batch.recipe.size,
        carryover: batch.pendingFruit,
        rejects: batch.rejects,
      };
      delete h.skuOwners[batch.sku];
      t.phase = "changeover";
      this.schedule(
        this.time +
          this.input.cells.find((c) => c.id === t.id).changeover.value,
        "hall-changeover",
        { tipper: ti },
        1,
      );
      this.count("batch-reconciled");
    }
  }
  localEmptyStatus() {
    const h = this.hall,
      indices = h.localEmpty.slots.flatMap((slot) =>
        (h.stores.low_staging[slot] ?? []).filter(
          (i) => this.bins[i].sku === null && this.bins[i].fruit_count === 0,
        ),
      );
    return {
      ...clone(h.localEmpty),
      assigned: indices.length,
      usable: indices.filter(
        (i) => this.accessible(i) && this.leases[`bin:${i}`] === undefined,
      ).length,
      bins: indices.map((i) => this.bins[i].id),
    };
  }
  localNeedsRefill() {
    const stock = this.localEmptyStatus();
    return stock.assigned - stock.outbound + stock.inbound <= stock.target - 3;
  }
  assignEmpty(robot, vacant, stores) {
    const h = this.hall,
      target = this.input.network.nodes[vacant.id];
    for (const store of stores) {
      const slots = this.input.network.storage_slots[store];
      const candidates = Object.entries(h.stores[store] ?? {}).sort(
        ([a], [b]) =>
          distance([target, slots[a].centre_xy_m]) -
          distance([target, slots[b].centre_xy_m]),
      );
      for (const [slot, stack] of candidates) {
        const i = stack.at(-1);
        if (i === undefined) continue;
        const b = this.bins[i];
        if (
          b.sku === null &&
          b.fruit_count === 0 &&
          b.phase === "empty-ready" &&
          this.accessible(i) &&
          this.leases[`column:${store}:${slots[slot].lane}`] === undefined &&
          this.missionHall(robot, [i], this.source(i), vacant.id, {
            kind: "empty-low",
            store,
            slot: Number(slot),
          })
        )
          return true;
      }
    }
    return false;
  }
  refillLocal(robot) {
    const h = this.hall;
    if (!this.localNeedsRefill()) return false;
    const slots = this.input.network.storage_slots.low_staging;
    const target = h.localEmpty.slots
      .map((i) => slots[i])
      .filter(
        (slot) =>
          !(h.stores.low_staging[slot.slot] ?? []).length &&
          this.leases[`column:low_staging:${slot.lane}`] === undefined,
      )
      .sort((a, b) => b.centre_xy_m[0] - a.centre_xy_m[0])
      .find(
        (slot) =>
          !slots.some(
            (front) =>
              front.lane === slot.lane &&
              front.depth < slot.depth &&
              (h.stores.low_staging[front.slot] ?? []).length,
          ),
      );
    if (!target) return false;
    const meta = {
      kind: "local-empty",
      destinationStore: "low_staging",
      destinationSlot: target.slot,
    };
    if (h.shared.length === 3 && this.leases.shared_empty === undefined)
      return this.missionHall(
        robot,
        [...h.shared],
        "shared_empty",
        target.dropoff_node,
        meta,
      );
    if (h.t5.returned.length === 3 && this.leases["T5:empty"] === undefined)
      return this.missionHall(
        robot,
        [...h.t5.returned],
        "T5:empty",
        target.dropoff_node,
        meta,
      );
    // Existing empties do not occupy fruit FIFO indefinitely: replenish the
    // same finite local buffers from them before borrowing top-right stock.
    for (const store of ["wall_storage", "empty_staging"])
      for (const [slot, bins] of Object.entries(h.stores[store] ?? {}))
        if (
          bins.length === 3 &&
          bins.every(
            (i) =>
              this.bins[i].sku === null && this.bins[i].phase === "empty-ready",
          ) &&
          this.accessible(bins[0]) &&
          this.leases[
            `column:${store}:${this.input.network.storage_slots[store][slot].lane}`
          ] === undefined &&
          this.missionHall(
            robot,
            [...bins],
            this.source(bins[0]),
            target.dropoff_node,
            { ...meta, store, slot: Number(slot) },
          )
        )
          return true;
    return false;
  }
  dispatch(triggers) {
    this.hall.compute.dispatches++;
    this.decisions.push({ time: this.time, triggers });
    if (this.decisions.length > 256) this.decisions.shift();
    this.feeder();
    this.sharedReturns();
    this.tip();
    this.admit();
    const h = this.hall;
    const readyFillers = this.machines.filter(
      (m) =>
        this.leases[m.id] === undefined &&
        (m.assignment
          ? m.stack.length === 3
          : m.bin !== null && this.bins[m.bin].phase === "full-ready"),
    );
    const responseDistance = (robot) =>
      readyFillers.length
        ? Math.min(
            ...readyFillers.map((m) =>
              distance([
                this.input.network.nodes[robot.location],
                this.input.network.nodes[m.id],
              ]),
            ),
          )
        : 0;
    for (const robot of this.robots
      .filter((r) => r.job === null)
      .sort(
        (a, b) =>
          responseDistance(a) - responseDistance(b) ||
          (a.jobsAdmitted ?? 0) - (b.jobsAdmitted ?? 0) ||
          a.id.localeCompare(b.id),
      )) {
      if (chargeIdle(this, robot)) continue;
      let assigned = false;
      // Direct needed empties precede storage; finite bottom refill counts
      // assigned/inbound, while usable stock is projected separately.
      const vacant = this.machines.find(
        (m) =>
          !m.assignment && m.bin === null && this.leases[m.id] === undefined,
      );
      if (vacant && h.shared.length && this.leases.shared_empty === undefined) {
        const i = h.shared.at(-1);
        assigned = this.missionHall(robot, [i], "shared_empty", vacant.id, {
          kind: "empty-low",
        });
      }
      if (!assigned && vacant)
        assigned = this.assignEmpty(robot, vacant, ["low_staging"]);
      const count = h.feeder.reduce((n, s) => n + s.length, 0);
      if (
        !assigned &&
        count < 7 &&
        count + h.feederInbound < 6 &&
        !h.feeder[0].length &&
        !h.feederMoving[0] &&
        !h.feederInbound
      ) {
        if (h.shared.length === 3 && this.leases.shared_empty === undefined)
          assigned = this.missionHall(
            robot,
            [...h.shared],
            "shared_empty",
            "grader_empty_drop",
            { kind: "feeder" },
          );
        if (!assigned) {
          for (const [slot, stack] of Object.entries(
            h.stores.empty_staging ?? {},
          )) {
            if (
              stack.length === 3 &&
              this.accessible(stack[0]) &&
              this.leases[
                `column:empty_staging:${this.input.network.storage_slots.empty_staging[slot].lane}`
              ] === undefined
            ) {
              assigned = this.missionHall(
                robot,
                [...stack],
                this.source(stack[0]),
                "grader_empty_drop",
                { kind: "feeder", store: "empty_staging", slot: Number(slot) },
              );
              if (assigned) break;
            }
          }
        }
      }
      if (
        !assigned &&
        h.t5.returned.length === 3 &&
        this.leases["T5:empty"] === undefined
      ) {
        if (
          count < 7 &&
          count + h.feederInbound < 6 &&
          !h.feeder[0].length &&
          !h.feederMoving[0] &&
          !h.feederInbound
        )
          assigned = this.missionHall(
            robot,
            [...h.t5.returned],
            "T5:empty",
            "grader_empty_drop",
            { kind: "feeder" },
          );
        if (!assigned) {
          const slot = this.storageDestination("empty_staging", h.t5.returned);
          if (slot)
            assigned = this.missionHall(
              robot,
              [...h.t5.returned],
              "T5:empty",
              slot.dropoff_node,
              {
                kind: "empty-store",
                destinationStore: "empty_staging",
                destinationSlot: slot.slot,
              },
            );
        }
      }
      if (assigned) continue;
      if (
        !h.t5.input.length &&
        !h.t5.returned.length &&
        !h.t5.inbound &&
        this.leases.T5 === undefined
      ) {
        for (const sku of ["SKU01", "SKU05", "SKU06"]) {
          const stock = this.freeStock(sku).filter(
            (i) => this.accessible(i) && h.stores[this.bins[i].location],
          );
          const first = stock[0];
          if (first === undefined) continue;
          const b = this.bins[first];
          const group = stock.filter(
            (i) =>
              this.bins[i].location === b.location &&
              this.bins[i].slot === b.slot,
          );
          if (
            group.length === 3 &&
            this.missionHall(robot, group, this.source(first), "T5", {
              kind: "full-t5",
              store: b.location,
              slot: b.slot,
            })
          ) {
            assigned = true;
            break;
          }
        }
      }
      if (assigned) continue;
      for (const t of this.tippers) {
        const batch = h.runs[t.run];
        if (
          !batch ||
          t.blocked ||
          t.queue.length +
            (t.bin !== null ? 1 : 0) +
            (t.inbound ?? 0) +
            (t.inboundConveyor ?? 0) >=
            3 ||
          this.leases[t.id] !== undefined
        )
          continue;
        const free =
          3 -
          t.queue.length -
          (t.bin !== null ? 1 : 0) -
          (t.inbound ?? 0) -
          (t.inboundConveyor ?? 0);
        const transport = batch.transportGroups.find(
          (g) =>
            g.job === null &&
            g.bins.length <= free &&
            g.bins.every((i) => {
              const b = this.bins[i],
                m = this.machineById.get(b.location);
              return (
                b.phase === "full-ready" &&
                !b.conveyor &&
                b.ownerKind !== "robot" &&
                b.location === g.source &&
                b.slot === g.slot &&
                this.leases[this.source(i)] === undefined &&
                this.accessible(i) &&
                (!m?.assignment || m.stack.includes(i))
              );
            }),
        );
        if (!transport) continue;
        const first = transport.bins[0],
          b = this.bins[first];
        if (
          this.missionHall(robot, transport.bins, this.source(first), t.id, {
            kind: "full-tip",
            store: h.stores[b.location] ? b.location : null,
            slot: b.slot,
            tipper: t.id,
            batch: batch.id,
            transportGroup: batch.transportGroups.indexOf(transport),
          })
        ) {
          transport.job = this.jobs.at(-1).id;
          transport.status = "assigned";
          assigned = true;
          break;
        }
      }
      if (assigned) continue;
      if (this.refillLocal(robot)) continue;
      for (const m of this.machines) {
        if (this.leases[m.id] !== undefined) continue;
        const bins = m.assignment
          ? m.stack.length === 3
            ? [...m.stack]
            : []
          : m.bin !== null && this.bins[m.bin].phase === "full-ready"
            ? [m.bin]
            : [];
        if (!bins.length || bins.some((i) => this.bins[i].batch != null))
          continue;
        const source = this.bins[bins[0]];
        // Finish a real singleton stack across BOTH FIFO stores. Fallback must
        // not turn the last twelve bins into 3+3+3+2+1 untransportable stock.
        if (
          bins.length === 1 &&
          this.robots.some((r) => {
            const job = r.job === null ? null : this.jobs[r.job];
            return (
              job?.meta.kind === "full-store" &&
              this.bins[job.bin].sku === source.sku &&
              this.bins[job.bin].sourceGroup === source.sourceGroup
            );
          })
        )
          continue;
        const partialStore =
          bins.length === 1
            ? h.fullPutawayStores.find((store) =>
                Object.values(h.stores[store]).some(
                  (stack) =>
                    stack.length > 0 &&
                    stack.length < 3 &&
                    stack.every(
                      (i) =>
                        this.bins[i].sku === source.sku &&
                        this.bins[i].sourceGroup === source.sourceGroup,
                    ) &&
                    // Ignore permanent rear blockage, but wait for transient leases.
                    this.planningIndex.putawayFronts[store][
                      this.bins[stack[0]].slot
                    ].every((front) => !h.stores[store][front]?.length),
                ),
              )
            : null;
        for (const store of partialStore
          ? [partialStore]
          : h.fullPutawayStores) {
          const slot = this.storageDestination(store, bins, true);
          if (
            slot &&
            this.missionHall(robot, bins, m.id, slot.dropoff_node, {
              kind: "full-store",
              destinationStore: store,
              destinationSlot: slot.slot,
            })
          ) {
            assigned = true;
            break;
          }
        }
        if (assigned) break;
        m.blocked ??= "waiting for reachable compatible FIFO space/transport";
      }
      if (assigned) continue;
      if (h.shared.length === 3 && this.leases.shared_empty === undefined) {
        const slots = this.input.network.storage_slots.empty_staging;
        for (const slot of [...slots].sort(
          (a, b) => b.depth - a.depth || a.lane - b.lane,
        )) {
          if (
            (h.stores.empty_staging[slot.slot] ?? []).length ||
            this.leases[`column:empty_staging:${slot.lane}`] !== undefined
          )
            continue;
          if (
            slots.some(
              (s) =>
                s.lane === slot.lane &&
                s.depth < slot.depth &&
                (h.stores.empty_staging[s.slot] ?? []).length,
            )
          )
            continue;
          if (
            this.missionHall(
              robot,
              [...h.shared],
              "shared_empty",
              slot.dropoff_node,
              {
                kind: "empty-store",
                destinationStore: "empty_staging",
                destinationSlot: slot.slot,
              },
            )
          ) {
            assigned = true;
            break;
          }
        }
      }
      if (assigned) continue;
      if (vacant)
        this.assignEmpty(robot, vacant, [
          "low_staging",
          "wall_storage",
          "empty_staging",
        ]);
    }
    for (const robot of this.robots)
      if (robot.job === null) returnIdleHome(this, robot);
  }
  missionHall(robot, bins, source, destination, meta) {
    bins = [...bins].sort((a, b) => this.bins[a].tier - this.bins[b].tier);
    if (meta.kind === "full-store" && meta.destinationStore !== "wall_storage")
      return false;
    if (meta.store === "wall_storage" && bins.some((i) => !this.accessible(i)))
      return false;
    if (
      meta.destinationStore === "wall_storage" &&
      this.planningIndex.putawayFronts.wall_storage[meta.destinationSlot].some(
        (slot) => this.hall.stores.wall_storage[slot]?.length,
      )
    )
      return false;
    if (meta.store) {
      const current = this.hall.stores[meta.store][meta.slot] ?? [];
      if (
        current.length < bins.length ||
        current.slice(-bins.length).some((i) => !bins.includes(i))
      )
        return false;
    }
    const old = this.jobs.length,
      b = this.bins[bins[0]],
      mass = b.fruit_mass_kg;
    // Admission includes the actual whole carried stack, not one-bin mass.
    b.fruit_mass_kg =
      bins.reduce((n, i) => n + this.bins[i].fruit_mass_kg, 0) +
      (bins.length - 1) * this.input.energy.bin_tare_mass.value;
    try {
      this.hallBase.mission(robot, bins[0], source, destination, {
        dropTier: meta.destinationStore
          ? (this.hall.stores[meta.destinationStore][meta.destinationSlot]
              ?.length ?? 0) + 1
          : 1,
      });
    } finally {
      b.fruit_mass_kg = mass;
    }
    if (this.jobs.length === old) return false;
    const job = this.jobs.at(-1);
    job.bins = bins;
    job.meta = meta;
    for (const i of bins) {
      const key = `bin:${i}`;
      this.leases[key] = job.id;
      job.leaseKeys.push(key);
    }
    if (meta.store) {
      const key = `column:${meta.store}:${this.input.network.storage_slots[meta.store][meta.slot].lane}`;
      this.leases[key] = job.id;
      job.leaseKeys.push(key);
    }
    if (meta.destinationStore) {
      const key = `column:${meta.destinationStore}:${this.input.network.storage_slots[meta.destinationStore][meta.destinationSlot].lane}`;
      this.leases[key] = job.id;
      job.leaseKeys.push(key);
    }
    if (meta.kind === "local-empty")
      this.hall.localEmpty.inbound += bins.length;
    if (
      meta.kind === "empty-low" &&
      meta.store === "low_staging" &&
      this.hall.localEmpty.slots.includes(meta.slot)
    )
      this.hall.localEmpty.outbound += bins.length;
    if (meta.kind === "feeder") this.hall.feederInbound += bins.length;
    if (meta.kind === "full-t5") this.hall.t5.inbound += bins.length;
    if (meta.kind === "full-tip")
      this.tippers.find((t) => t.id === destination).inbound =
        (this.tippers.find((t) => t.id === destination).inbound ?? 0) +
        bins.length;
    robot.jobsAdmitted = (robot.jobsAdmitted ?? 0) + 1;
    this.count("missions");
    return true;
  }
  transferHall(d) {
    const job = this.jobs[d.job],
      robot = this.robots[job.robot],
      h = this.hall,
      meta = job.meta;
    if (d.operation === "pickup") {
      if (
        meta.kind === "empty-low" &&
        meta.store === "low_staging" &&
        h.localEmpty.slots.includes(meta.slot)
      )
        h.localEmpty.outbound -= job.bins.length;
      if (meta.store) {
        const stack = h.stores[meta.store][meta.slot];
        if (
          stack.length < job.bins.length ||
          stack.slice(-job.bins.length).some((i) => !job.bins.includes(i))
        )
          throw Error("Storage pickup must remove the actual top bins");
        h.stores[meta.store][meta.slot] = stack.filter(
          (i) => !job.bins.includes(i),
        );
      }
      const m = this.machineById.get(job.source);
      if (m) {
        if (m.assignment)
          m.stack = m.stack.filter((i) => !job.bins.includes(i));
        else m.bin = null;
      }
      if (job.source === "T5:empty") h.t5.returned = [];
      if (job.source === "shared_empty")
        h.shared = h.shared.filter((i) => !job.bins.includes(i));
      for (const [tier, i] of job.bins.entries()) {
        const b = this.bins[i];
        b.location = robot.id;
        b.ownerKind = "robot";
        b.owner = job.robot;
        b.tier = tier + 1;
      }
      robot.carried = job.bins[0];
      robot.carriedBins = [...job.bins];
      this.record("pickup", {
        bins: job.bins.map((i) => this.bins[i].id),
        robot: robot.id,
        source: job.source,
      });
    } else {
      robot.carried = null;
      robot.carriedBins = [];
      for (const [tier, i] of job.bins.entries()) {
        const b = this.bins[i];
        b.location = job.destination;
        b.ownerKind = "station";
        b.owner = job.destination;
        b.tier = tier + 1;
      }
      if (meta.kind === "feeder") {
        if (h.feeder[0].length)
          throw Error("Finite bottom feeder destination occupied");
        h.feeder[0] = [...job.bins];
        h.feederInbound -= job.bins.length;
        for (const i of job.bins) {
          this.bins[i].slot = 0;
          this.bins[i].phase = "empty-ready";
        }
        this.count("feeder-delivery");
        this.record("feeder-bottom-delivery", {
          slot: 0,
          bins: job.bins.map((i) => this.bins[i].id),
        });
      } else if (
        meta.kind === "empty-store" ||
        meta.kind === "full-store" ||
        meta.kind === "local-empty"
      ) {
        const previous =
          h.stores[meta.destinationStore][meta.destinationSlot] ?? [];
        h.stores[meta.destinationStore][meta.destinationSlot] = [
          ...previous,
          ...job.bins,
        ];
        for (const i of job.bins) {
          const b = this.bins[i];
          b.location = meta.destinationStore;
          b.owner = meta.destinationStore;
          b.slot = meta.destinationSlot;
          b.tier = previous.length + job.bins.indexOf(i) + 1;
          b.phase = meta.kind === "full-store" ? "full-ready" : "empty-ready";
          if (meta.kind === "full-store") b.fifoEnteredAt = this.time;
        }
        if (meta.kind === "local-empty") {
          h.localEmpty.inbound -= job.bins.length;
          this.count("local-empty-delivery");
          this.record("local-empty-delivered", {
            slot: meta.destinationSlot,
            bins: job.bins.map((i) => this.bins[i].id),
          });
        } else
          this.count(
            meta.kind === "empty-store" ? "empty-stored" : "full-stored",
          );
      } else if (meta.kind === "empty-low") {
        const m = this.machineById.get(job.destination),
          b = this.bins[job.bin];
        m.bin = job.bin;
        b.slot = 0;
        b.tier = 1;
        b.phase = "inserted";
        b.recipe = null;
        b.sku = null;
        b.batch = null;
        b.fill_count_target = 0;
        b.readyAt =
          this.time + this.input.equipment_config.inserted_empty_ready_delay;
        this.schedule(b.readyAt, "hall-empty-ready", { bin: job.bin }, 1);
        this.returned++;
      } else if (meta.kind === "full-t5") {
        h.t5.inbound -= job.bins.length;
        h.t5.input = [...job.bins];
        h.t5.returnAt = this.time + 1800;
        for (const i of job.bins)
          this.bins[i].phase = "external-prepack-processing";
        this.schedule(h.t5.returnAt, "hall-t5-return", {}, 1);
        this.count("t5-delivery");
      } else if (meta.kind === "full-tip") {
        const t = this.tippers.find((t) => t.id === job.destination);
        t.inbound -= job.bins.length;
        h.runs[meta.batch].transportGroups[meta.transportGroup].status =
          "delivered";
        t.queue.push(...job.bins);
        for (const i of job.bins) {
          this.bins[i].phase = "tip-queued";
          this.bins[i].slot = 0;
        }
      }
      this.record("drop", {
        bins: job.bins.map((i) => this.bins[i].id),
        destination: job.destination,
      });
    }
    // Physical station completions, not phase frames, wake dispatch.
    this.notify("station-transfer-complete", job.destination);
  }
  requests() {
    const h = this.hall,
      out = [];
    for (const m of this.machines) {
      const full = [
        ...(m.stack ?? []),
        ...(m.bin !== null && this.bins[m.bin].phase === "full-ready"
          ? [m.bin]
          : []),
      ];
      for (const i of full) {
        const b = this.bins[i],
          jobId = this.leases[`bin:${i}`],
          job = jobId === undefined ? null : this.jobs[jobId];
        out.push({
          id: `pickup:${b.id}`,
          station: m.id,
          kind: "pickup",
          bin: b.id,
          status: job ? "assigned" : m.blocked ? "blocked" : "waiting",
          robot: job ? this.robots[job.robot].id : null,
          reason: m.blocked,
        });
      }
    }
    const local = this.localEmptyStatus();
    if (local.assigned < local.target || local.inbound)
      out.push({
        id: "local-empty:supply",
        station: "low_staging",
        kind: "delivery",
        status: local.inbound ? "assigned" : "waiting",
        reason: `local empty stacks: ${local.assigned}/${local.target} assigned, ${local.usable} usable, ${local.inbound} inbound, ${local.outbound} leaving`,
      });
    const count = h.feeder.reduce((n, s) => n + s.length, 0);
    if (count < 7)
      out.push({
        id: "feeder:supply",
        station: "grader_empty_drop",
        kind: "delivery",
        status: h.feederInbound ? "assigned" : "waiting",
        reason: `six-bin objective / below-seven priority; assigned ${count}, inbound ${h.feederInbound}, moving ${Object.keys(h.feederMoving).length}`,
      });
    for (const t of this.tippers)
      if (t.blockReason || t.blocked || t.closureBlocked)
        out.push({
          id: `blocked:${t.id}`,
          station: t.id,
          kind: "pickup",
          status: "blocked",
          reason: t.blockReason ?? t.blocked ?? t.closureBlocked,
        });
    if (h.shared.length)
      out.push({
        id: "shared:pickup",
        station: "shared_empty",
        kind: "pickup",
        status: this.leases.shared_empty !== undefined ? "assigned" : "waiting",
        reason: `${h.shared.length}/3 stationary; ${h.sharedInbound} inbound`,
      });
    for (const j of this.jobs)
      if (j.status === "active")
        out.push({
          id: `delivery:${j.id}`,
          station: j.destination,
          kind: "delivery",
          status: "assigned",
          robot: this.robots[j.robot].id,
          bin: j.bin === null ? null : this.bins[j.bin].id,
        });
    return out;
  }
  checkpoint() {
    throw Error(
      "Mixed-hall checkpoint/seek unsupported until recovery slice; no lossy checkpoint emitted",
    );
  }
  observe() {
    const s = this.hallBase.observe(),
      h = this.hall;
    for (const robot of s.robots) {
      const job = robot.job === null ? null : this.jobs[robot.job];
      if (job?.meta.kind === "charge") {
        const phase = job.phases.at(-1);
        const fraction = Math.max(
          0,
          Math.min(1, (this.time - phase.start) / (phase.end - phase.start)),
        );
        robot.soc += (fraction * job.meta.suppliedKwh) / robot.usable_kwh;
        robot.charged_kwh =
          (robot.charged_kwh ?? 0) + fraction * job.meta.suppliedKwh;
      }
    }
    for (const b of s.bins) {
      if (b.sku)
        b.normalAdmission = clone(
          h.admission[b.sku] ?? {
            state: "unsupported-no-selected-recipe",
            sku: b.sku,
          },
        );
      if (b.tip) b.fruit_mass_kg = b.fruit_count * this.mass(b.sku);
    }
    let progress = 0,
      progressMass = 0;
    for (const b of this.bins)
      if (b.tip) {
        const n = b.tip.count - s.bins[this.binIndex.get(b.id)].fruit_count;
        progress += n;
        progressMass += n * this.mass(b.sku);
      }
    const inventory = s.bins.reduce((n, b) => n + b.fruit_count, 0),
      initial = Object.values(h.initialBySku).reduce((a, b) => a + b, 0),
      consumed = this.consumed + progress;
    const massInventory = s.bins.reduce((n, b) => n + b.fruit_mass_kg, 0),
      massTransit = Object.entries(h.transitBySku).reduce(
        (n, [sku, count]) => n + count * this.mass(sku),
        0,
      );
    s.accounting = {
      physicalBins: this.bins.length,
      initial,
      admitted: this.admitted,
      inventory,
      transit: this.transit,
      consumed,
      external: h.externalFruit ?? 0,
      returned: this.returned,
      balance:
        initial +
        this.admitted -
        inventory -
        this.transit -
        consumed -
        (h.externalFruit ?? 0),
      massKg: {
        initial: h.mass.initial,
        admitted: h.mass.admitted,
        inventory: massInventory,
        transit: massTransit,
        consumed: h.mass.consumed + progressMass,
        external: h.externalMass ?? 0,
        balance:
          h.mass.initial +
          h.mass.admitted -
          massInventory -
          massTransit -
          h.mass.consumed -
          progressMass -
          (h.externalMass ?? 0),
      },
    };
    s.hall = clone(h);
    s.hall.production = {
      tippedFruit: h.counts.packing ?? 0,
      packedFruit: h.runs.reduce(
        (n, batch) => n + batch.layers * 8 * batch.recipe.size,
        0,
      ),
      completedPallets: h.runs.reduce(
        (n, batch) => n + batch.completedPallets.length,
        0,
      ),
      rejects: h.counts["inspection-rejects"] ?? 0,
      emptyBins: s.bins.filter((b) => b.sku === null).length,
      putaways: h.counts["full-stored"] ?? 0,
      emptyReturns: h.counts["shared-empty"] ?? 0,
      chargesCompleted: h.counts["charge-complete"] ?? 0,
    };
    s.hall.carryoverBoundary =
      "At most 40 occupied tray positions per cell; cell-owned, no downstream loose-tray buffer; incompatible changeover blocked pending physical removal authority";
    s.hall.recipes = clone(RECIPES);
    s.hall.localEmptyStock = this.localEmptyStatus();
    s.tippers = clone(this.tippers);
    s.hall.feederStock = {
      assigned: h.feeder.reduce((n, a) => n + a.length, 0),
      inbound: h.feederInbound,
      moving: h.feeder
        .filter((a, i) => h.feederMoving[i])
        .reduce((n, a) => n + a.length, 0),
      usable:
        h.feederMoving[2] || h.destackerUntil > this.time
          ? 0
          : h.feeder[2].length,
      objective: 6,
      priorityBelow: 7,
      capacity: 9,
    };
    return s;
  }
}
// Named readiness wake, never periodic WMS polling.
const handle = Hall.prototype.handle;
Hall.prototype.handle = function (kind, d) {
  if (kind === "hall-feeder-ready") {
    this.notify("station-destacker-ready", "grader_empty_drop");
    return;
  }
  return handle.call(this, kind, d);
};
