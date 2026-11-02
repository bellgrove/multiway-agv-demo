import { installHighRecirculation, sharedTransit, reserveHighLoop, handleHighLoop, wakeFresh } from "./high-local-recirculation.mjs";
import { refreshFeederPreparation, prepareFeederSource, noteFeederSupply, finishFeederSupply, noteFeederTransfer, feederDestinationReadyAt, donateLocalToFeeder } from "./feeder-preparation.mjs";
import { seedWorkingStartup } from "./startup.mjs";
import { chargeIdle, finishCharge, scheduleBatteryWake } from "./charging.mjs";
import {
  installParking,
  returnIdleHome,
  stageHighResponse,
  stageEmptyResponse,
} from "./parking.mjs";
import { RECIPES } from "./recipes.mjs";
const HIGH_VOLUME_SKUS = ["SKU20", "SKU21", "SKU22", "SKU23", "SKU24"];
const PREPACK_SKUS = ["SKU09", "SKU19"];
const T5_SKUS = [...PREPACK_SKUS, "SKU01", "SKU05", "SKU06"];
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
    mass: { initial: 0, admitted: 0, consumed: 0, admittedError: 0 },
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
      status:
        "finite whole-stack collection; same empties ready 1800s after drop",
    },
    shared: [],
    sharedInbound: 0,
    sharedReserved: 0,
    sharedCapacity:
      3 * (run.input.equipment_config.common_output_stack_positions ?? 1),
    sharedOutputPositions:
      run.input.equipment_config.common_output_stack_positions ?? 1,
    sharedInternalCapacity:
      run.input.equipment_config.common_internal_bin_capacity ?? 0,
    sharedInternal: [],
    sharedOutputInbound: 0,
    sharedOutputMoving: {},
    stackerUntil: 0,
    ageClearance: {
      triggerSeconds: 25 * 3600,
      eligibleSeconds: 20 * 3600,
      pendingSkus: [],
      sweeps: [],
      wakeAt: null,
    },
    runs: [],
    skuOwners: {},
    localEmpty: {
      slots: [],
      target: 3 * (run.input.equipment_config.local_empty_stack_locations ?? 3),
      inbound: 0,
      outbound: 0,
      status:
        "restore configured real local three-high stacks; finite reserved mapped slots",
    },
    fifoStores: ["low_staging", "wall_storage"],
    fullPutawayStores: ["wall_storage", "low_staging"],
    fifoLaneOwners: {},
    fullBySku: {},
    admission: {},
    stores: {},
    carryover: {},
    remainderStore: {
      perSkuTrayCapacity: 40,
      assumption:
        "retained conservative 40-tray per-SKU warehouse bound; labelled physical handling duration not calibrated",
      records: [],
      transfers: [],
      inventoryFruit: 0,
      inventoryMassKg: 0,
    },
    emptySources: [],
    returnPending: [],

    externalBoundaries: {
      juice:
        "SKU17 bypasses circulating-bin fleet; externally owned offsite stream",
      prepack:
        "SKU09/SKU19 collect full three-bin storage stacks to T5; same empties ready 1800s after drop",
    },
    startup: "empty-fruit-FIFO-166-v1",
    policy: "provisional-fixed-count-bounded-closure",
    blockedModes: [
      "size-12 geometric recipe absent",
      "mixed-pallet/weekend/dispatch policy unresolved; unsupported",
      "realised shortages wait for finite physically accessible same-cohort source groups",
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
          internalStack: [],
          outfeedMoving: false,
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
  installHighRecirculation(run);
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
    if (h.localEmpty.slots.length === h.localEmpty.target / 3) break;
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
  if (h.localEmpty.slots.length !== h.localEmpty.target / 3)
    throw Error("Configured real accessible local empty-buffer slots required");
  if (
    ![1, 2].includes(h.sharedOutputPositions) ||
    ![0, 3].includes(h.sharedInternalCapacity) ||
    (!h.sharedInternalCapacity && h.sharedOutputPositions !== 1)
  )
    throw Error(
      "Shared return geometry supports legacy one output/no internal bins, or one/two output stacks with three internal bins",
    );
  if (h.sharedInternalCapacity) {
    run.input.network.nodes.shared_internal = [
      ...run.input.network.tipper_flow.empty_stacker,
    ];
    run.input.network.nodes.shared_intermediate = [
      ...run.input.network.tipper_flow.intermediate,
    ];
  }
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
    if (handleHighLoop(this, kind, d)) return;
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
    if (kind === "hall-source-released") {
      const job = this.jobs[d.job];
      const keys = [job.source];
      if (job.meta.store)
        keys.push(
          `column:${job.meta.store}:${this.input.network.storage_slots[job.meta.store][job.meta.slot].lane}`,
        );
      for (const key of keys) {
        if (key === job.destination) continue;
        if (this.leases[key] === job.id) delete this.leases[key];
      }
      const replacement = this.jobs[job.turnoverReplacementJob];
      if (replacement?.status === "active")
        this.leases[job.source] = replacement.id;
      job.sourceReleasedAt = this.time;
      this.record("source-access-released", {
        job: job.id,
        source: job.source,
      });
      this.notify("station-source-withdrawal-complete", job.source);
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
    if (kind === "hall-age-wake") {
      if (d.at !== h.ageClearance.wakeAt) return;
      h.ageClearance.wakeAt = null;
      this.refreshAgeClearance();
      this.notify("age-clearance-threshold", "hall");
      return;
    }
    if (kind === "hall-startup") {
      this.refreshAgeClearance();
      for (const robot of this.robots) scheduleBatteryWake(this, robot);
      this.record("hall-startup", { startup: h.startup });
      this.notify("station-ready", "hall");
      return;
    }
    if (kind === "hall-service") {
      h.serviceScheduled = false;
      // Only the service event owns dequeueing. An arrival at the exact free
      // clock must not jump the queue or rotate its head behind newer fruit.
      if (this.time < this.serviceAt) {
        h.serviceScheduled = true;
        this.schedule(this.serviceAt, "hall-service");
        return;
      }
      const next = h.serviceQueue.shift();
      if (!next) return;
      kind = next.kind;
      d = next.data;
    } else if (kind === "hall-fresh" || kind === "hall-regrade") {
      if (kind === "hall-fresh" && sharedTransit(this) >= cfg.conveyor_capacity) {
        this.freshWaiting = d;
        return;
      }
      h.serviceQueue.push({ kind, data: d });
      if (!h.serviceScheduled) {
        h.serviceScheduled = true;
        this.schedule(Math.max(this.time, this.serviceAt), "hall-service");
      }
      return;
    }
    if (kind === "hall-fresh" || kind === "hall-regrade") {
      const fresh = kind === "hall-fresh";
      if (fresh && sharedTransit(this) >= cfg.conveyor_capacity) {
        this.freshWaiting = d;
        if (h.serviceQueue.length && !h.serviceScheduled) {
          h.serviceScheduled = true;
          this.schedule(Math.max(this.time, this.serviceAt), "hall-service");
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
        // Compensate per-fruit accumulation: a full-day high-throughput run
        // otherwise drifts away from its exact SKU-count-derived admitted mass.
        const correctedMass = mass - h.mass.admittedError;
        const admittedMass = h.mass.admitted + correctedMass;
        h.mass.admittedError = admittedMass - h.mass.admitted - correctedMass;
        h.mass.admitted = admittedMass;
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
      const b = this.bins[d.bin],
        m = this.machineById.get(b.location);
      if (!m || m.bin !== d.bin || b.conveyor || b.readyAt > this.time ||
          !(b.reserved > 0) || (d.sku && d.sku !== b.sku) ||
          b.fruit_count >= b.fill_count_target ||
          (m.assignment && b.slot !== 1))
        throw Error("Fruit arrival requires the actual ready filler bin");
      b.phase = "filling";
      b.reserved--;
      b.fruit_count++;
      if (b.fruit_count === 1) this.scheduleAgeWake(b);
      b.fruit_mass_kg = b.fruit_count * this.mass(b.sku);
      this.transit--;
      h.transitBySku[b.sku]--;
      wakeFresh(this);
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
        m.internalStack.push(d.bins[0]);
        this.count("high-stack");
      }
      if (d.operation === "high-outfeed") {
        const m = this.machineById.get(d.location);
        if (m.stack.length) throw Error("High outlet outfeed already occupied");
        m.stack = [...d.bins];
        m.outfeedMoving = false;
        this.count("high-outfeed");
      }
      if (d.operation === "high-queue") {
        const m = this.machineById.get(d.location);
        m.bin = d.bins[0];
        delete m.emptySince;
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
      if (
        d.operation === "shared-output-arrive" ||
        d.operation === "shared-output-advance"
      ) {
        if (d.operation === "shared-output-arrive") {
          h.sharedOutputInbound -= d.bins.length;
          h.shared.push(...d.bins);
        }
        for (const [tier, i] of d.bins.entries()) this.bins[i].tier = tier + 1;
        delete h.sharedOutputMoving[d.slot];
        if (d.operation === "shared-output-advance")
          delete h.sharedOutputMoving[1];
        this.count(d.operation);
      }
      if (d.operation === "shared-arrive") {
        h.sharedInbound--;
        const inventory = h.sharedInternalCapacity
          ? h.sharedInternal
          : h.shared;
        inventory.push(d.bins[0]);
        this.bins[d.bins[0]].tier = inventory.length;
        this.bins[d.bins[0]].slot = 0;
        // This return can arrive after the tipper has started another bin.
        // Physical tipper ownership was released at its actual empty-exit.
        this.count("shared-empty");
      }
      this.notify(
        "station-conveyor-complete",
        d.location ?? "grader_empty_drop",
      );
      return;
    }
    if (kind === "hall-empty-ready") {
      const b = this.bins[d.bin];
      b.phase = b.fruit_count > 0 ? "filling" : "empty-ready";
      this.notify("station-empty-ready", this.bins[d.bin].location);
      return;
    }
    if (kind === "hall-tip-exit") {
      const t = this.tippers[d.tipper];
      if (t.bin === d.bin && t.phase === "return-conveyor") {
        t.bin = null;
        t.phase = "idle";
        this.record("tip-empty-exit", {
          tipper: t.id,
          bin: this.bins[d.bin].id,
        });
        this.notify("station-empty-exit", t.id);
      }
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
      if (
        batch.realisedClosure ||
        batch.ageClearance ||
        batch.finiteStockResumption
      ) {
        // Age exceptions and finite real-stock recovery transfer only whole
        // realised layers. No forecast loss refund or phantom complete pallet.
        if (!batch.currentPallet)
          batch.currentPallet = {
            id: `${batch.id}:pallet:${batch.completedPallets.length}`,
            owner: batch.cell,
            layers: 0,
          };
        let remaining = Math.floor(batch.pendingFruit / unit);
        let palletLayers = batch.currentPallet.layers;
        batch.heights = [];
        while (remaining > 0) {
          const height = Math.min(5, remaining, 20 - palletLayers);
          batch.heights.push(height);
          remaining -= height;
          palletLayers = (palletLayers + height) % 20;
        }
      }
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
          batch.currentPallet =
            batch.heights.length ||
            ((batch.realisedClosure ||
              batch.ageClearance ||
              batch.finiteStockResumption) &&
              batch.tipped < batch.bins.length)
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
      delete t.closureBlocked;
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
  assignFruitBin(b, sku) {
    b.sku = sku;
    b.recipe = RECIPES[sku] ? clone(RECIPES[sku]) : null;
    b.fill_count_target = this.target(sku);
    b.sourceGroup = `${sku}:configured-cohort`;
    b.fruitOrigin = this.time;
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
    // Only a physically present filler bin or an already scheduled queue
    // conveyor has a guaranteed identity and readiness. Do not forecast a
    // future full-bin departure or an unscheduled empty supply.
    const targetBin = (m) => m.bin ??
      (m.assignment && m.queueMoving && this.bins[m.queue]?.conveyor
        ? m.queue : null);
    const eligible = this.machines
      .filter(
        (m) =>
          targetBin(m) !== null &&
          (fixed ? m.assignment === sku : !m.assignment) &&
          !(m.assignment && (h.highRecirculation.lanes[m.id].stock + h.highRecirculation.lanes[m.id].inbound)) &&
          // High-line AGV access is the independent completed-stack outfeed,
          // not the filler or queued-empty positions. Low filler access remains
          // a real interlock at the single shared loading/unloading position.
          (m.assignment || this.leases[m.id] === undefined),
      )
      .filter((m) => {
        const b = this.bins[targetBin(m)],
          queued = m.bin === null,
          readyAt = queued
            ? b.conveyor.end + cfg.inserted_empty_ready_delay
            : b.readyAt,
          arrivalAt = this.time +
            (cfg.decision_upstream_distance + this.machines.indexOf(m) * cfg.filler_pitch) /
              cfg.grader_speed;
        return (
          readyAt <= (m.assignment ? arrivalAt : this.time) &&
          (!b.conveyor || queued) &&
          (queued || ["empty-ready", "filling"].includes(b.phase) ||
            (m.assignment && b.phase === "inserted")) &&
          (!b.sku || b.sku === sku) &&
          b.fruit_count + b.reserved < this.target(sku)
        );
      });
    const m =
      eligible.find((m) => m.assignment === sku) ??
      eligible.find((m) => this.bins[targetBin(m)].sku === sku) ??
      eligible[0];
    if (m) {
      const i = targetBin(m), b = this.bins[i];
      if (!b.sku) this.assignFruitBin(b, sku);
      b.reserved++;
      m.sku = sku;
      this.count(`route:${m.id}`);
      this.schedule(
        this.time +
          (cfg.decision_upstream_distance +
            this.machines.indexOf(m) * cfg.filler_pitch) /
            cfg.grader_speed,
        "hall-arrive",
        { bin: i, sku },
      );
    } else {
      if (fixed && reserveHighLoop(this, sku)) return;
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
    const outlets = this.machines
      .filter((m) => m.assignment)
      .sort((a, b) => {
        const emptyA = a.bin === null,
          emptyB = b.bin === null;
        if (emptyA !== emptyB) return Number(emptyB) - Number(emptyA);
        if (emptyA)
          return (
            (a.emptySince ?? this.time) - (b.emptySince ?? this.time) ||
            a.id.localeCompare(b.id)
          );
        const fraction = (m) =>
          (this.bins[m.bin].fruit_count + this.bins[m.bin].reserved) /
          this.target(m.assignment);
        return fraction(b) - fraction(a) || a.id.localeCompare(b.id);
      });
    for (const m of outlets) {
      if (
        m.internalStack.length === 3 &&
        !m.stack.length &&
        !m.outfeedMoving &&
        this.leases[m.id] === undefined
      ) {
        const bins = m.internalStack.splice(0, 3);
        m.outfeedMoving = true;
        const points = [flow.outlets[m.id].stacker, flow.outlets[m.id].pickup];
        this.record("high-outfeed-transfer", {
          machine: m.id,
          bins: bins.map((i) => this.bins[i].id),
          start: this.time,
          end: this.time + distance(points) / 0.25,
        });
        this.move(bins, points, {
          operation: "high-outfeed",
          location: m.id,
          slot: 3,
          phase: "full-ready",
        });
      }
      if (
        m.bin !== null &&
        this.bins[m.bin].phase === "full-ready" &&
        !m.stacking &&
        m.internalStack.length < 3
      ) {
        const i = m.bin,
          b = this.bins[i];
        m.bin = null;
        m.emptySince = this.time;
        m.stacking = true;
        b.slot = 0;
        b.tier = m.internalStack.length + 1;
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
  fifoDestination(bins, ignoreLeases = false, admissionSelected = null) {
    const h = this.hall,
      cells = h.stores.wall_storage,
      slots = this.input.network.storage_slots.wall_storage,
      source = this.bins[bins[0]];
    const compatible = (i) => {
      const b = this.bins[i];
      return (
        b.sku === source.sku &&
        b.sourceGroup === source.sourceGroup &&
        b.recipe?.version === source.recipe?.version &&
        // Admission will tag precisely its selected bins with the new batch.
        // Any unselected bin would become incompatible after that atomic tag.
        (!admissionSelected || admissionSelected.has(i)) &&
        (b.batch ?? null) === (source.batch ?? null)
      );
    };
    const stagingLane =
      source.batch == null ? null : h.runs[source.batch]?.fifoStagingLane;
    const reservedLane = (slot) =>
      stagingLane == null || slot.lane === stagingLane;
    const reachable = (slot) =>
      reservedLane(slot) &&
      (h.fifoLaneOwners[slot.lane] === undefined ||
        h.fifoLaneOwners[slot.lane] === source.batch) &&
      (ignoreLeases ||
        this.leases[`column:wall_storage:${slot.lane}`] === undefined) &&
      this.planningIndex.putawayFronts.wall_storage[slot.slot].every(
        (front) => !cells[front]?.length,
      ) &&
      slots
        .filter((s) => s.lane === slot.lane)
        .every((s) => (cells[s.slot] ?? []).every(compatible));
    const inbound = this.jobs.filter(
      (j) =>
        j.status === "active" &&
        ["full-store", "fifo-relocate"].includes(j.meta?.kind) &&
        j.meta.destinationStore === "wall_storage" &&
        j.bins.every(compatible),
    );
    const matchingLanes = new Set(
      slots
        .filter((slot) => (cells[slot.slot] ?? []).some(compatible))
        .map((s) => s.lane),
    );
    for (const j of inbound)
      matchingLanes.add(slots[j.meta.destinationSlot].lane);
    // A temporary lane lease must not fragment one cohort across multiple lanes.
    const matchingHasSpace = slots.some(
      (slot) =>
        reservedLane(slot) &&
        matchingLanes.has(slot.lane) &&
        (h.fifoLaneOwners[slot.lane] === undefined ||
          h.fifoLaneOwners[slot.lane] === source.batch) &&
        (cells[slot.slot]?.length ?? 0) + bins.length <= 3 &&
        this.planningIndex.putawayFronts.wall_storage[slot.slot].every(
          (front) => !cells[front]?.length,
        ) &&
        slots
          .filter((s) => s.lane === slot.lane)
          .every((s) => (cells[s.slot] ?? []).every(compatible)),
    );
    const preferred = (slot) =>
      !matchingHasSpace || matchingLanes.has(slot.lane);
    // Complete an accessible partial stack before opening a new stack.
    const partial = slots
      .filter((slot) => {
        const stack = cells[slot.slot] ?? [];
        return (
          preferred(slot) &&
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
      .filter(
        (slot) =>
          preferred(slot) && !cells[slot.slot]?.length && reachable(slot),
      )
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
  binFruitAge(b) {
    return b.sku && b.fruit_count > 0 && Number.isFinite(b.fruitOrigin)
      ? Math.max(0, this.time - b.fruitOrigin)
      : null;
  }
  scheduleAgeWake(b) {
    if (!b.sku || !Number.isFinite(b.fruitOrigin)) return;
    const policy = this.hall.ageClearance;
    // Strictly older than 25h, with one timestamped wake, never fruit polling.
    const at = b.fruitOrigin + policy.triggerSeconds + 0.001;
    if (at > this.time && (policy.wakeAt === null || at < policy.wakeAt)) {
      policy.wakeAt = at;
      this.schedule(at, "hall-age-wake", { at }, 1);
    }
  }
  refreshAgeClearance() {
    const policy = this.hall.ageClearance;
    const fruit = this.bins.filter((b) => this.binFruitAge(b) !== null);
    policy.oldestSeconds = fruit.reduce(
      (n, b) => Math.max(n, this.binFruitAge(b)),
      0,
    );
    const eligible = [
      ...new Set(
        fruit
          .filter((b) => this.binFruitAge(b) > policy.eligibleSeconds)
          .map((b) => b.sku),
      ),
    ];
    // A triggered sweep persists while its aged fruit is waiting for physical
    // collection, including stock still filling. It never grants younger
    // cohorts a blanket minimum exemption merely for sharing the SKU.
    const pending = new Set(
      policy.pendingSkus.filter((sku) => eligible.includes(sku)),
    );
    if (policy.oldestSeconds > policy.triggerSeconds) {
      const added = eligible.filter((sku) => !pending.has(sku));
      if (added.length) {
        policy.sweeps.push({
          time: this.time,
          oldestSeconds: policy.oldestSeconds,
          skus: added,
        });
        this.record("age-clearance-trigger", {
          skus: added,
          oldestSeconds: policy.oldestSeconds,
        });
      }
      for (const sku of eligible) pending.add(sku);
    }
    policy.pendingSkus = [...pending];
    for (const b of fruit) this.scheduleAgeWake(b);
  }
  agedCohort(sku, bins) {
    return (
      this.hall.ageClearance.pendingSkus.includes(sku) &&
      bins.some(
        (i) =>
          this.binFruitAge(this.bins[i]) >
          this.hall.ageClearance.eligibleSeconds,
      )
    );
  }
  syncRemainderStore() {
    const h = this.hall,
      active = h.remainderStore.records.filter((r) => r.status === "stored");
    h.carryover = {};
    for (const record of active) h.carryover[record.sku] ??= clone(record);
    h.remainderStore.inventoryFruit = active.reduce((n, r) => n + r.fruit, 0);
    h.remainderStore.inventoryMassKg = active.reduce((n, r) => n + r.massKg, 0);
    h.remainderStore.trayPositions = active.reduce(
      (n, r) => n + r.trayPositions,
      0,
    );
  }
  recallRemainders(batch, records) {
    batch.recalledRemainders = [];
    for (const record of records) {
      if (record.status !== "stored")
        throw Error("Remainder already reserved/recalled");
      record.status = "recalled";
      record.recalledAt = this.time;
      record.destinationBatch = batch.id;
      batch.recalledRemainders.push(record.id);
      this.hall.remainderStore.transfers.push({
        time: this.time,
        kind: "recall",
        record: record.id,
        fruit: record.fruit,
        massKg: record.massKg,
        from: "labelled-remainder-store",
        to: batch.cell,
        batch: batch.id,
      });
    }
    batch.carryoverInputFruit = records.reduce((n, r) => n + r.fruit, 0);
    const origins = records.map((r) => r.fruitOrigin).filter(Number.isFinite);
    batch.carryoverFruitOrigin = origins.length ? Math.min(...origins) : null;
    this.syncRemainderStore();
    if (records.length) this.notify("remainder-stock-recalled", batch.cell);
  }
  storeRemainder(batch) {
    const warehouse = this.hall.remainderStore;
    if (batch.pendingFruit === 0) return true;
    if (warehouse.records.some((r) => r.sourceBatch === batch.id)) return true;
    const trayPositions = Math.ceil(batch.pendingFruit / batch.recipe.size);
    const occupied = warehouse.records
      .filter((r) => r.status === "stored" && r.sku === batch.sku)
      .reduce((n, r) => n + r.trayPositions, 0);
    if (
      batch.pendingFruit >= 40 * batch.recipe.size ||
      occupied + trayPositions > warehouse.perSkuTrayCapacity
    )
      return false;
    const origins = [
      ...batch.sourceInventory.map((b) => b.fruitOrigin),
      batch.carryoverFruitOrigin,
    ].filter(Number.isFinite);
    const record = {
      id: `remainder:${batch.id}`,
      status: "stored",
      sku: batch.sku,
      sourceGroup: batch.sourceGroup,
      recipe: batch.recipe.version,
      fruit: batch.pendingFruit,
      massKg: batch.pendingFruit * this.mass(batch.sku),
      trayPositions,
      fruitOrigin: origins.length ? Math.min(...origins) : null,
      storedAt: this.time,
      owner: "labelled-remainder-store",
      sourceCell: batch.cell,
      sourceBatch: batch.id,
    };
    warehouse.records.push(record);
    warehouse.transfers.push({
      time: this.time,
      kind: "store",
      record: record.id,
      fruit: record.fruit,
      massKg: record.massKg,
      from: batch.cell,
      to: record.owner,
      batch: batch.id,
    });
    this.syncRemainderStore();
    this.record("remainder-stored", { ...record });
    return true;
  }
  admit() {
    this.refreshAgeClearance();
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
      // Startup assignments only reserve the opening two preloaded lanes.
      // Thereafter prefer an overdue cohort, then stock already in FIFO, then
      // the largest pressure relative to the minimum at this cell's real rate.
      const candidates = Object.entries(RECIPES).sort(([a, ar], [b, br]) => {
        const as = stocks.get(a),
          bs = stocks.get(b);
        const aged =
          Number(this.agedCohort(b, bs)) - Number(this.agedCohort(a, as));
        if (aged) return aged;
        const wall = (stock) =>
          stock.filter((i) => this.bins[i].location === "wall_storage").length;
        return (
          Number(wall(bs) >= br.minimum) - Number(wall(as) >= ar.minimum) ||
          bs.length / br.minimum - as.length / ar.minimum ||
          (this.planningIndex.cells.get(t.id).consumption[b]?.value ?? 0) -
            (this.planningIndex.cells.get(t.id).consumption[a]?.value ?? 0)
        );
      });
      for (const [sku, recipe] of candidates) {
        if (
          (t.assignment && t.assignment !== sku) ||
          Object.entries(h.tipperAssignments ?? {}).some(
            ([cell, assigned]) => assigned === sku && cell !== t.id,
          ) ||
          h.skuOwners[sku] !== undefined ||
          !this.planningIndex.cells
            .get(t.id)
            .compatible_skus.value.includes(sku)
        )
          continue;
        const stock = stocks.get(sku);
        if (stock.length < recipe.minimum && !this.agedCohort(sku, stock))
          continue;
        const groups = [...new Set(stock.map((i) => this.bins[i].sourceGroup))];
        // Stock is oldest-first; skip cohorts that cannot form a physically
        // accessible recipe-valid run, without pooling their fruit or carryover.
        for (const group of groups) {
          const carryRecords = h.remainderStore.records.filter(
            (r) =>
              r.status === "stored" &&
              r.sku === sku &&
              r.sourceGroup === group &&
              r.recipe === recipe.version,
          );
          const hasCarry = carryRecords.length > 0;
          const carryRecord = hasCarry
            ? {
                fruit: carryRecords.reduce((n, r) => n + r.fruit, 0),
                sourceGroup: group,
                recipe: recipe.version,
                owner: "labelled-remainder-store",
              }
            : null;
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
          const ageClearance = this.agedCohort(sku, reachable);
          const flexible = !!h.startupStock;
          // One lane contains 24 bins. Clearing whole stacks up to that real
          // lane capacity avoids leaving a sub-minimum residue at its entrance.
          const required = flexible
            ? Math.min(reachable.length, Math.max(24, recipe.minimum))
            : ageClearance
              ? Math.min(reachable.length, recipe.minimum)
              : recipe.minimum;
          if (
            !required ||
            (reachable.length < recipe.minimum && !ageClearance)
          ) {
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
              (flexible
                ? Number(y.location === "wall_storage") -
                  Number(x.location === "wall_storage")
                : 0) ||
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
          // FIFO age never permits selecting rear stock through younger front
          // stock. Order source stacks by real withdrawal dependencies first,
          // using oldest age only among the currently reachable choices.
          const pendingStacks = [...physical.values()],
            physicalOrder = [],
            cleared = new Set();
          while (pendingStacks.length) {
            const next = pendingStacks.findIndex((stack) => {
              const selected = new Set([...cleared, ...stack]);
              return stack.every((i) => this.accessible(i, selected));
            });
            if (next < 0) break;
            const [stack] = pendingStacks.splice(next, 1);
            physicalOrder.push(stack);
            for (const i of stack) cleared.add(i);
          }
          const physicallySelectable = (indices) => {
            const selected = new Set(indices);
            return indices.every((i) => this.accessible(i, selected));
          };
          let plans = new Map([[0, []]]);
          for (const stack of physicalOrder) {
            // A partial pickup must take the physical top. FIFO age orders stacks,
            // never permits reaching through an older bottom bin's upper tiers.
            stack.sort((a, b) => this.bins[b].tier - this.bins[a].tier);
            const next = new Map(plans),
              sizes = flexible
                ? [stack.length]
                : ageClearance
                  ? [3, 2, 1].filter((n) => n <= stack.length)
                  : stack.length >= 3
                    ? [3, 2]
                    : stack.length === 2
                      ? [2]
                      : [];
            for (const [count, plan] of plans)
              for (const size of sizes)
                if (
                  count + size <= required &&
                  !next.has(count + size) &&
                  (
                    h.stores[this.bins[stack[0]].location][
                      this.bins[stack[0]].slot
                    ] ?? []
                  )
                    .slice(-size)
                    .every((i) => stack.slice(0, size).includes(i)) &&
                  physicallySelectable([
                    ...plan.flat(),
                    ...stack.slice(0, size),
                  ])
                )
                  next.set(count + size, [...plan, stack.slice(0, size)]);
            plans = next;
          }
          const chosenCount = flexible
            ? [...plans.keys()]
                .filter((n) => n > 0 && (n >= recipe.minimum || ageClearance))
                .sort((a, b) => b - a)[0]
            : required;
          const transport = plans.get(chosenCount);
          if (!transport) {
            h.admission[sku].state =
              "waiting-complete-three-bin-or-terminal-pair-source-groups";
            continue;
          }
          const bins = transport.flat(),
            chosen = new Set(bins);
          if (bins.some((i) => !this.accessible(i, chosen))) continue;
          // Never occupy a production cell with low-area stock that has no
          // real FIFO staging route. Reserve the physical lane atomically with
          // admission, so another cell cannot take its only staging capacity.
          const lowGroup = transport.find(
            (g) => this.bins[g[0]].location !== "wall_storage",
          );
          const staging = lowGroup
            ? this.fifoDestination(lowGroup, false, chosen)
            : null;
          if (lowGroup && !staging) {
            h.admission[sku].state = "waiting-physical-FIFO-staging-lane";
            continue;
          }
          const carry = hasCarry ? carryRecord.fruit : 0,
            raw = bins.reduce((n, i) => n + this.bins[i].fruit_count, 0);
          const expected = (raw * 0.995 + carry) / (8 * recipe.size),
            goal =
              ageClearance || flexible ? 0 : Math.floor(expected / 20) * 20;
          // Bounded guard: no unlimited supplemental supply, <=five-layer
          // forecast surplus. Actual shortages remain explicitly unfinished.
          if (
            !ageClearance &&
            !flexible &&
            (goal < recipe.minimum * recipe.layers || expected - goal >= 5)
          )
            continue;
          const heights = [];
          for (let n = goal; n > 0; n -= Math.min(5, n))
            heights.push(Math.min(5, n));
          const batch = {
            id: h.runs.length,
            sku,
            recipe: clone(recipe),
            sourceGroup: group,
            realisedClosure: flexible,
            fifoStagingLane: staging?.lane ?? null,
            ageClearance: ageClearance
              ? {
                  triggeredAt: h.ageClearance.sweeps.at(-1)?.time,
                  eligibleSeconds: h.ageClearance.eligibleSeconds,
                  originalMinimum: recipe.minimum,
                  actualBins: bins.length,
                  oldestSeconds: Math.max(
                    ...bins.map((i) => this.binFruitAge(this.bins[i]) ?? 0),
                  ),
                }
              : null,
            bins,
            sourceInventory: bins.map((i) => ({
              bin: this.bins[i].id,
              fifoEnteredAt: this.bins[i].fifoEnteredAt,
              fruitOrigin: this.bins[i].fruitOrigin,
              fruit: this.bins[i].fruit_count,
            })),
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
          h.runs.push(batch);
          if (staging) h.fifoLaneOwners[staging.lane] = batch.id;
          // These pins describe startup only, not permanent cell restrictions.
          if (t.assignment) {
            delete t.assignment;
            delete h.tipperAssignments[t.id];
          }
          this.recallRemainders(batch, carryRecords);
          h.admission[sku].state = "reserved";
          h.admission[sku].owner = t.id;
          delete t.closureBlocked;
          t.run = batch.id;
          h.skuOwners[sku] = t.id;
          for (const i of bins) this.bins[i].batch = batch.id;
          this.record(
            ageClearance ? "age-clearance-admitted" : "normal-admitted",
            {
              batch: batch.id,
              sku,
              bins: bins.map((i) => this.bins[i].id),
              source: recipe.source,
              minimum: recipe.minimum,
            },
          );
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
  sharedPickupStack() {
    return this.hall.shared
      .filter((i) => {
        const b = this.bins[i];
        return b.location === "shared_empty" && b.slot === 0 && !b.conveyor;
      })
      .sort((a, b) => this.bins[a].tier - this.bins[b].tier);
  }
  advanceSharedOutputs() {
    const h = this.hall,
      flow = this.input.network.tipper_flow;
    if (!h.sharedInternalCapacity) return;
    const at = (slot) => h.shared.filter((i) => this.bins[i].slot === slot);
    if (
      h.sharedOutputPositions === 2 &&
      !at(0).length &&
      at(1).length === 3 &&
      !h.sharedOutputMoving[0] &&
      !h.sharedOutputMoving[1] &&
      this.leases.shared_empty === undefined
    ) {
      const bins = at(1);
      h.sharedOutputMoving[0] = h.sharedOutputMoving[1] = true;
      this.move(bins, [flow.intermediate, flow.pickup], {
        operation: "shared-output-advance",
        location: "shared_empty",
        slot: 0,
        phase: "empty-ready",
      });
    }
    const slot = h.sharedOutputPositions - 1;
    if (
      h.sharedInternal.length === 3 &&
      !at(slot).length &&
      !h.sharedOutputMoving[slot] &&
      (slot !== 0 || this.leases.shared_empty === undefined)
    ) {
      const bins = h.sharedInternal.splice(0, 3);
      h.sharedOutputMoving[slot] = true;
      h.sharedOutputInbound += bins.length;
      this.move(
        bins,
        slot === 1
          ? [flow.empty_stacker, flow.intermediate]
          : [flow.empty_stacker, flow.intermediate, flow.pickup],
        {
          operation: "shared-output-arrive",
          location: slot === 1 ? "shared_intermediate" : "shared_empty",
          slot,
          phase: "empty-ready",
        },
      );
    }
  }
  sharedReturns() {
    this.advanceSharedOutputs();
    const h = this.hall,
      flow = this.input.network.tipper_flow;
    while (
      h.returnPending.length &&
      (h.sharedInternalCapacity
        ? h.sharedInternal.length + h.sharedInbound < h.sharedInternalCapacity
        : h.shared.length + h.sharedInbound < h.sharedCapacity &&
          this.leases.shared_empty === undefined)
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
      // Reserve finite shared output only when the empty actually enters its
      // return flow, not throughout the preceding fruit-tipping operation.
      h.sharedInbound++;
      t.phase = "return-conveyor";
      this.schedule(
        start + distance([g.tip, g.empty_exit]) / 0.25,
        "hall-tip-exit",
        { tipper: d.tipper, bin: d.bin },
        1,
      );
      this.move(
        [d.bin],
        [
          g.tip,
          g.empty_exit,
          g.return_corner,
          flow.empty_stacker,
          ...(h.sharedInternalCapacity ? [] : [flow.intermediate, flow.pickup]),
        ],
        {
          operation: "shared-arrive",
          tipper: t.id,
          location: h.sharedInternalCapacity
            ? "shared_internal"
            : "shared_empty",
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
  resumeShortfall(t, batch) {
    if (batch.finiteStockResumption) return false;
    const stock = this.freeStock(batch.sku);
    // One finite real source group stays within the same cohort and cell;
    // its entire surplus is drained as realised layers, not abandoned as a
    // new whole-bin carryover deadlock or stranded FIFO front pair.
    const i = stock.find((i) => {
      const b = this.bins[i];
      const stack = this.hall.stores[b.location]?.[b.slot];
      return (
        b.fruit_count > 0 &&
        b.sourceGroup === batch.sourceGroup &&
        b.recipe?.version === batch.recipe.version &&
        stack?.at(-1) === i &&
        this.accessible(i) &&
        this.leases[this.source(i)] === undefined
      );
    });
    if (i === undefined) return false;
    const b = this.bins[i];
    const available = new Set(stock);
    const stack = this.hall.stores[b.location][b.slot];
    const bins = [];
    // Clear one whole compatible top source group (up to three actual bins).
    // Shaving just one bin off a FIFO three-stack leaves an untransportable
    // front pair for subsequent normal batches; the entire group is finite.
    for (const j of [...stack].reverse()) {
      const x = this.bins[j];
      if (
        bins.length === 3 ||
        !available.has(j) ||
        x.sourceGroup !== batch.sourceGroup ||
        x.recipe?.version !== batch.recipe.version
      )
        break;
      bins.push(j);
    }
    batch.finiteStockResumption = {
      time: this.time,
      originalGoalLayers: batch.goalLayers,
      missingFruit: Math.max(
        0,
        batch.heights.reduce((n, h) => n + h, 0) * batch.recipe.size * 8 -
          batch.pendingFruit,
      ),
      bin: b.id,
      bins: bins.map((i) => this.bins[i].id),
      groupSize: bins.length,
      fruit: bins.reduce((n, i) => n + this.bins[i].fruit_count, 0),
      source: b.location,
      reason:
        "realised shortfall; one actual same-cohort source group, entire realised surplus packed",
    };
    batch.bins.push(...bins);
    for (const j of bins) {
      const x = this.bins[j];
      batch.sourceInventory.push({
        bin: x.id,
        fifoEnteredAt: x.fifoEnteredAt,
        fruitOrigin: x.fruitOrigin,
        fruit: x.fruit_count,
        finiteSupplement: true,
      });
      batch.initialFruit += x.fruit_count;
      x.batch = batch.id;
    }
    batch.transportGroups.push({
      bins,
      source: b.location,
      slot: b.slot,
      status: "reserved",
      job: null,
      finiteSupplement: true,
    });
    batch.supplementLimit = bins.length;
    batch.phase = "reserved";
    t.blocked = null;
    t.phase = "idle";
    this.record("batch-real-stock-resumption", {
      batch: batch.id,
      sku: batch.sku,
      ...batch.finiteStockResumption,
    });
    this.count("batch-real-stock-resumption");
    return true;
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
      // A full shared stacker may hold a future EMPTY on its tipper;
      // it must not prevent tipping a currently accepted full bin in advance.
      t.outputWait = false;
      delete t.blockReason;
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
        batch.phase === "reconciled"
      )
        continue;
      if (batch.heights.length) {
        const firstBlock = batch.phase !== "blocked-shortfall";
        batch.phase = "blocked-shortfall";
        if (this.resumeShortfall(t, batch)) continue;
        t.blocked =
          "realised endpoint shortfall; waiting for physically accessible same-cohort stock";
        if (firstBlock)
          this.record("batch-blocked", { batch: batch.id, reason: t.blocked });
        continue;
      }
      // User-authorised separate labelled stock frees the cell, but fruit is
      // neither shipped nor packed here. Keep a finite per-SKU warehouse bound.
      if (!this.storeRemainder(batch)) {
        batch.phase = "blocked-carryover-capacity";
        t.blocked =
          "finite labelled remainder store 40-tray per-SKU capacity exceeded";
        continue;
      }
      t.blocked = null;
      if (
        batch.realisedClosure ||
        batch.ageClearance ||
        batch.finiteStockResumption
      ) {
        batch.goalLayers = batch.layers;
        batch.partialPallet = batch.currentPallet?.layers
          ? {
              ...batch.currentPallet,
              boundary:
                "incomplete pallet retained; not counted as completed output",
            }
          : null;
      }
      batch.phase = "reconciled";
      batch.reconciliation = {
        input: batch.initialFruit,
        transferred: batch.layers * 8 * batch.recipe.size,
        carryover: batch.pendingFruit,
        rejects: batch.rejects,
      };
      for (const [lane, owner] of Object.entries(h.fifoLaneOwners))
        if (owner === batch.id) delete h.fifoLaneOwners[lane];
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
  assignEmpty(robot, vacant, stores, turnover = {}) {
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
        if (i === undefined || (turnover.turnoverFor !== undefined &&
          !h.localEmpty.slots.includes(Number(slot)))) continue;
        const b = this.bins[i];
        if (
          b.sku === null &&
          b.fruit_count === 0 &&
          b.phase === "empty-ready" &&
          this.leases[`bin:${i}`] === undefined &&
          this.accessible(i) &&
          this.leases[`column:${store}:${slots[slot].lane}`] === undefined &&
          this.missionHall(robot, [i], this.source(i), vacant.id, {
            kind: "empty-low",
            ...turnover,
            store,
            slot: Number(slot),
          })
        )
          return true;
      }
    }
    return false;
  }
  pipelineLowTurnovers() {
    for (const carrier of this.robots) {
      const full = carrier.job === null ? null : this.jobs[carrier.job];
      if (full?.meta?.kind !== "full-store" ||
          this.machineById.get(full.source)?.assignment ||
          full.sourceReleasedAt !== undefined ||
          full.turnoverReplacementJob !== undefined) continue;
      const withdrawal = full.phases.find((p) => p.kind === "pickup_withdrawal");
      if (!withdrawal || withdrawal.end <= this.time) continue;
      const robot = this.robots.find((r) => r.job === null);
      if (!robot) break;
      if (this.assignEmpty(robot, this.machineById.get(full.source), ["low_staging"], {
        turnoverFor: full.id,
        destinationNotBefore: withdrawal.end,
      })) full.turnoverReplacementJob = this.jobs.at(-1).id;
    }
  }
  localEmptyDestination() {
    const h = this.hall;
    const slots = this.input.network.storage_slots.low_staging;
    return h.localEmpty.slots
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
  }
  refillLocal(robot) {
    const h = this.hall;
    if (!this.localNeedsRefill()) return false;
    const target = this.localEmptyDestination();
    if (!target) return false;
    const meta = {
      kind: "local-empty",
      destinationStore: "low_staging",
      destinationSlot: target.slot,
    };
    if (
      this.sharedPickupStack().length === 3 &&
      this.leases.shared_empty === undefined
    )
      return this.missionHall(
        robot,
        this.sharedPickupStack(),
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
  drainSharedPickup(robot) {
    const h = this.hall;
    if (this.leases.shared_empty !== undefined) return false;
    const bins = this.sharedPickupStack();
    // The physical common stacker releases complete three-bin stacks only.
    // Single-filler supply is taken from local storage after whole-stack delivery.
    if (bins.length !== 3) {
      h.sharedPickupBlocked =
        h.sharedInternalCapacity && bins.length
          ? "incomplete common output stack; requires three bins, single/pair pickup forbidden"
          : null;
      return false;
    }
    h.sharedPickupBlocked = null;
    const local = this.localEmptyStatus();
    const projectedLocal = local.assigned - local.outbound + local.inbound;
    const feederCount = h.feeder.flat().length;
    const feed = () =>
      feederCount + h.feederInbound + 3 <=
        (this.input.equipment_config.feeder_capacity ?? 9) &&
      feederDestinationReadyAt(this) !== null &&
      !h.feederInbound &&
      this.missionHall(robot, bins, "shared_empty", "grader_empty_drop", {
        kind: "feeder",
      });
    // Protect two real local stacks, not an always-full eighteen-bin reserve.
    // An empty high-volume destacker takes priority over topping local capacity.
    if (
      projectedLocal >= 6 &&
      feederCount + h.feederInbound <= 6 &&
      feed()
    )
      return true;
    if (projectedLocal + bins.length <= local.target) {
      const slot = this.localEmptyDestination();
      if (
        slot &&
        this.missionHall(robot, bins, "shared_empty", slot.dropoff_node, {
          kind: "local-empty",
          destinationStore: "low_staging",
          destinationSlot: slot.slot,
        })
      )
        return true;
    }
    if (feed()) return true;
    // User-authorised overflow uses only mapped top-right empty storage, never
    // invented capacity or one overloaded AGV carrying both output stacks.
    const slot = this.storageDestination("empty_staging", bins, true);
    return (
      !!slot &&
      this.missionHall(robot, bins, "shared_empty", slot.dropoff_node, {
        kind: "empty-store",
        destinationStore: "empty_staging",
        destinationSlot: slot.slot,
      })
    );
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
    refreshFeederPreparation(this);
    // Generate actual tasks, then missionHall pairs each with a feasible robot.
    // Charging is admitted before productive pairing, never during a rejected probe.
    const projectedSoc = (robot) =>
      robot.soc -
      (robot.power_kw * (this.time - robot.energy_time)) /
        3600 /
        robot.usable_kwh;
    for (const robot of [...this.robots].sort(
      (a, b) => projectedSoc(a) - projectedSoc(b) || a.id.localeCompare(b.id),
    ))
      if (robot.job === null) chargeIdle(this, robot);
    this.pipelineLowTurnovers();
    for (const robot of this.robots) {
      if (!this.robots.some((r) => r.job === null)) break;
      let assigned = prepareFeederSource(this, robot);
      if (assigned) continue;
      assigned = this.drainSharedPickup(robot);
      if (assigned) continue;
      // Direct needed empties precede storage; finite bottom refill counts
      // assigned/inbound, while usable stock is projected separately.
      const vacant = this.machines.find(
        (m) =>
          !m.assignment && m.bin === null && this.leases[m.id] === undefined,
      );
      if (!assigned && vacant)
        assigned = this.assignEmpty(robot, vacant, ["low_staging"]);
      const count = h.feeder.reduce((n, s) => n + s.length, 0);
      if (
        !assigned &&
        count + h.feederInbound + 3 <=
          (this.input.equipment_config.feeder_capacity ?? 9) &&
        feederDestinationReadyAt(this) !== null &&
        !h.feederInbound
      ) {
        if (
          this.sharedPickupStack().length === 3 &&
          this.leases.shared_empty === undefined
        )
          assigned = this.missionHall(
            robot,
            this.sharedPickupStack(),
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
          count + h.feederInbound + 3 <=
            (this.input.equipment_config.feeder_capacity ?? 9) &&
          feederDestinationReadyAt(this) !== null &&
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
      if (!assigned) assigned = donateLocalToFeeder(this, robot);
      if (assigned) continue;
      if (
        !h.t5.input.length &&
        !h.t5.returned.length &&
        !h.t5.inbound &&
        this.leases.T5 === undefined
      ) {
        for (const sku of T5_SKUS) {
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
        if (b.location !== "wall_storage") {
          const destination = this.fifoDestination(transport.bins);
          if (
            destination &&
            this.missionHall(
              robot,
              transport.bins,
              this.source(first),
              destination.dropoff_node,
              {
                kind: "fifo-relocate",
                sku: batch.sku,
                store: b.location,
                slot: b.slot,
                destinationStore: "wall_storage",
                destinationSlot: destination.slot,
                batch: batch.id,
                transportGroup: batch.transportGroups.indexOf(transport),
              },
            )
          ) {
            h.fifoLaneOwners[destination.lane] = batch.id;
            transport.job = this.jobs.at(-1).id;
            transport.status = "relocating-to-FIFO";
            assigned = true;
            break;
          }
          continue;
        }
        if (
          this.missionHall(robot, transport.bins, this.source(first), t.id, {
            kind: "full-tip",
            sku: batch.sku,
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
      for (const m of this.putawayOrder()) {
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
        const putawayStores = HIGH_VOLUME_SKUS.includes(source.sku)
          ? this.overflowReason(bins)
            ? ["wall_storage", "low_staging"]
            : ["wall_storage"]
          : ["low_staging"];
        const partialStore =
          bins.length === 1
            ? putawayStores.find((store) =>
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
        for (const store of partialStore ? [partialStore] : putawayStores) {
          const slot = this.storageDestination(store, bins, true);
          if (
            slot &&
            (store !== "wall_storage" || this.allowFifoLane(slot, source)) &&
            this.missionHall(robot, bins, m.id, slot.dropoff_node, {
              kind: "full-store",
              sku: source.sku,
              destinationStore: store,
              destinationSlot: slot.slot,
            })
          ) {
            assigned = true;
            this.pipelineLowTurnovers();
            break;
          }
        }
        if (assigned) break;
        m.blocked ??= "waiting for reachable compatible FIFO space/transport";
      }
      if (assigned) continue;
      if (
        this.sharedPickupStack().length === 3 &&
        this.leases.shared_empty === undefined
      ) {
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
              this.sharedPickupStack(),
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
    stageHighResponse(this);
    stageEmptyResponse(this);
    for (const robot of this.robots)
      if (robot.job === null) returnIdleHome(this, robot);
  }
  rankMissionRobots(bin, source, destination, meta, handlingOptions = {}) {
    const point = this.input.network.nodes[source];
    const region = (p) =>
      p?.[0] >= 40
        ? "right"
        : p?.[0] < 40 && p?.[1] > 18
          ? "upper-left"
          : "other";
    const desired = region(point);
    const candidates = [];
    for (const robot of this.robots) {
      if (robot.job !== null || robot.carried !== null) continue;
      let preview;
      try {
        preview = this.hallBase.mission(robot, bin, source, destination, {
          ...handlingOptions,
          destinationNotBefore: meta.destinationNotBefore,
          destinationLeaseOwner: meta.turnoverFor,
          preview: true,
          dropTier: meta.destinationStore
            ? (this.hall.stores[meta.destinationStore][meta.destinationSlot]
                ?.length ?? 0) + 1
            : 1,
        });
      } catch (e) {
        if (
          e.message.startsWith("No permitted") ||
          e.message.startsWith("Unmapped station")
        )
          continue;
        throw e;
      }
      if (!preview) continue;
      const local = region(this.input.network.nodes[robot.location]);
      const bay = /^(P\d+|C1)$/.test(robot.location);
      const highResponder =
        robot.location === "HP1" && !!this.machineById.get(source)?.assignment;
      const priority =
        desired === "right"
          ? bay || highResponder
            ? 0
            : local === "right"
              ? 1
              : 2
          : desired === "upper-left"
            ? local === desired
              ? 0
              : 1
            : 0;
      const response =
        preview.phases.find((p) => p.kind === "pickup")?.end ?? Infinity;
      candidates.push({
        robot,
        priority,
        response,
        completion: preview.phases.at(-1).end,
        sourceClearance: preview.phases.find((p) => p.kind === "pickup_withdrawal")?.end ?? Infinity,
      });
    }
    return candidates.sort(
      (a, b) =>
        // Critical empty supply optimizes the actual physical objective before
        // regional preferences: delivered stock, or clearing a blocked source.
        (meta.kind === "feeder"
          ? a.completion - b.completion || a.response - b.response
          : meta.feederPreparation
            ? a.sourceClearance - b.sourceClearance || a.response - b.response
            : 0) ||
        a.priority - b.priority ||
        a.response - b.response ||
        a.completion - b.completion ||
        (a.robot.jobsAdmitted ?? 0) - (b.robot.jobsAdmitted ?? 0) ||
        a.robot.id.localeCompare(b.robot.id),
    );
  }
  putawayOrder() {
    const h = this.hall;
    const score = (m) => {
      const i = m.assignment ? m.stack[0] : m.bin;
      const b = this.bins[i];
      if (!b) return -Infinity;
      const active = Object.values(h.tipperAssignments ?? {}).includes(b.sku)
        ? 10000
        : 0;
      return (
        (this.agedCohort(b.sku, [i]) && RECIPES[b.sku] ? 30000 : 0) +
        (PREPACK_SKUS.includes(b.sku) ? 20000 : 0) +
        active +
        (m.assignment ? 1000 : 0) +
        this.bins.filter(
          (bin) =>
            bin.sku === b.sku &&
            bin.phase === "full-ready" &&
            bin.batch == null,
        ).length /
          (RECIPES[b.sku]?.minimum ?? Infinity) +
        (this.time - (b.readyAt ?? this.time)) * 1e-8
      );
    };
    return [...this.machines].sort(
      (a, b) => score(b) - score(a) || a.id.localeCompare(b.id),
    );
  }
  allowFifoLane(slot, source) {
    // Working profile has eight homogeneous lanes for more than eight grades.
    // Protect real active/fast fixed-output streams, rather than consume all
    // eight lanes with rare singleton cohorts which cannot form a recipe.
    if (!this.hall.startupStock) return true;
    const slots = this.input.network.storage_slots.wall_storage;
    const existing = slots
      .filter((s) => s.lane === slot.lane)
      .flatMap((s) => this.hall.stores.wall_storage[s.slot] ?? []);
    if (existing.length) return true;
    const owners = [
      ...new Set([
        ...PREPACK_SKUS,
        ...Object.values(this.hall.tipperAssignments ?? {}),
        ...this.machines
          .filter((m) => m.assignment && RECIPES[m.assignment])
          .map((m) => m.assignment),
      ]),
    ];
    if (owners.includes(source.sku)) return true;
    // A triggered aged cohort now has a real reduced-run consumer. Let it use
    // a physically vacant lane; never relocate or mix existing lane stock.
    if (
      RECIPES[source.sku] &&
      this.agedCohort(source.sku, [this.bins.indexOf(source)])
    )
      return true;
    const occupiedOther = new Set(
      slots
        .filter((s) =>
          (this.hall.stores.wall_storage[s.slot] ?? []).some(
            (i) => !owners.includes(this.bins[i].sku),
          ),
        )
        .map((s) => s.lane),
    );
    const pendingOther = this.jobs.filter(
      (j) =>
        j.status === "active" &&
        j.meta?.kind === "full-store" &&
        !owners.includes(this.bins[j.bin].sku),
    );
    for (const j of pendingOther)
      occupiedOther.add(slots[j.meta.destinationSlot].lane);
    if (occupiedOther.size >= Math.max(0, 8 - owners.length)) {
      this.hall.fifoAllocation = {
        time: this.time,
        protectedSkus: owners,
        spareLanes: Math.max(0, 8 - owners.length),
        deferredSku: source.sku,
        reason:
          "homogeneous lane budget reserved for active and fixed recipe replenishment",
      };
      return false;
    }
    // Prepack has protected collection capacity above; other spare lanes go to
    // supported recipes or the existing T5 carton streams.
    return (
      !!RECIPES[source.sku] || ["SKU01", "SKU05", "SKU06"].includes(source.sku)
    );
  }
  overflowReason(bins) {
    if (
      !bins.length ||
      !bins.every((i) => HIGH_VOLUME_SKUS.includes(this.bins[i].sku))
    )
      return null;
    // Ignore temporary lane leases: a busy reachable FIFO slot is a reason to
    // wait, not to fragment a cohort across left overflow storage.
    return this.fifoDestination(bins, true)
      ? null
      : "no-physically-reachable-compatible-FIFO-position";
  }
  missionHall(robot, bins, source, destination, meta) {
    bins = [...bins].sort((a, b) => this.bins[a].tier - this.bins[b].tier);
    if (meta.kind === "feeder") {
      const readyAt = feederDestinationReadyAt(this);
      if (readyAt === null || this.hall.feederInbound || bins.length !== 3 ||
          this.hall.feeder.flat().length + this.hall.feederInbound + bins.length >
            (this.input.equipment_config.feeder_capacity ?? 9)) return false;
      meta = { ...meta, destinationNotBefore: readyAt };
    }
    if (this.leases[source] !== undefined ||
        (this.leases[destination] !== undefined &&
          this.leases[destination] !== meta.turnoverFor)) return false;
    const highSource = this.machineById.get(source);
    if (
      highSource?.assignment &&
      (bins.length !== 3 ||
        highSource.stack.length !== 3 ||
        highSource.outfeedMoving ||
        bins.some((i) => !highSource.stack.includes(i)))
    )
      return false;
    if (source === "shared_empty") {
      const stack = this.sharedPickupStack();
      if (meta.kind === "empty-low" || bins.length !== 3 || stack.length !== 3)
        return false;
      if (
        bins.length > 3 ||
        stack.slice(-bins.length).some((i) => !bins.includes(i)) ||
        bins.some((i) => !stack.includes(i))
      )
        return false;
    }
    if (
      meta.kind === "full-store" &&
      meta.destinationStore !== "wall_storage"
    ) {
      if (meta.destinationStore !== "low_staging") return false;
      const highVolume = HIGH_VOLUME_SKUS.includes(this.bins[bins[0]].sku);
      const reason = highVolume ? this.overflowReason(bins) : null;
      if (highVolume && !reason) return false;
      const target = this.storageDestination("low_staging", bins, true);
      if (!target || target.slot !== meta.destinationSlot) return false;
      meta = {
        ...meta,
        sku: this.bins[bins[0]].sku,
        slowAccumulation: !highVolume,
        fifoOverflow: highVolume,
        fifoOverflowReason: reason,
      };
    }
    if (
      meta.kind === "full-tip" &&
      this.bins[bins[0]].location !== "wall_storage"
    )
      return false;
    if (
      meta.kind === "fifo-relocate" &&
      (meta.destinationStore !== "wall_storage" || meta.store !== "low_staging")
    )
      return false;
    if (meta.store && bins.some((i) => !this.accessible(i))) return false;
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
      const candidates = this.rankMissionRobots(
        bins[0],
        source,
        destination,
        meta,
        { emptyPickup: b.sku === null && bins.length === 1 },
      );
      if (!candidates.length) return false;
      robot = candidates[0].robot;
      this.hallBase.mission(robot, bins[0], source, destination, {
        emptyPickup: b.sku === null && bins.length === 1,
        destinationNotBefore: meta.destinationNotBefore,
        destinationLeaseOwner: meta.turnoverFor,
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
      ["empty-low", "feeder"].includes(meta.kind) &&
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
    const withdrawal = job.phases.find((p) => p.kind === "pickup_withdrawal");
    if (withdrawal)
      this.schedule(withdrawal.end, "hall-source-released", { job: job.id }, 1);
    noteFeederSupply(this, job);
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
        ["empty-low", "feeder"].includes(meta.kind) &&
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
        finishFeederSupply(this, job);
        this.record("feeder-bottom-delivery", {
          slot: 0,
          bins: job.bins.map((i) => this.bins[i].id),
        });
      } else if (
        meta.kind === "empty-store" ||
        meta.kind === "full-store" ||
        meta.kind === "fifo-relocate" ||
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
          b.phase = ["full-store", "fifo-relocate"].includes(meta.kind)
            ? "full-ready"
            : "empty-ready";
          if (["full-store", "fifo-relocate"].includes(meta.kind))
            b.fifoEnteredAt = this.time;
        }
        if (meta.kind === "fifo-relocate") {
          const group = h.runs[meta.batch].transportGroups[meta.transportGroup];
          group.source = meta.destinationStore;
          group.slot = meta.destinationSlot;
          group.job = null;
          group.status = "FIFO-ready";
          this.count("fifo-relocated", job.bins.length);
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
    noteFeederTransfer(this, job, d.operation);
    // Physical station completions, not phase frames, wake dispatch.
    this.notify("station-transfer-complete", job.destination);
  }
  requests() {
    const h = this.hall,
      out = [];
    for (const m of this.machines) {
      const full = [
        ...(m.stack ?? []),
        ...(!m.assignment &&
        m.bin !== null &&
        this.bins[m.bin].phase === "full-ready"
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
    if (count + h.feederInbound < (this.input.equipment_config.feeder_capacity ?? 9))
      out.push({
        id: "feeder:supply",
        station: "grader_empty_drop",
        kind: "delivery",
        status: h.feederInbound ||
          this.jobs[h.feederPreparation?.preparationJob]?.status === "active"
          ? "assigned" : "waiting",
        reason: `${this.jobs[h.feederPreparation?.preparationJob]?.status === "active"
          ? "real source preparation in progress"
          : "anticipatory complete-stack supply"}; finite nine-bin target; assigned ${count}, inbound ${h.feederInbound}, moving ${Object.keys(h.feederMoving).length}`,
        requestReason: h.feederPreparation?.reason ?? null,
        requestAt: h.feederPreparation?.requestAt ?? this.time,
        preparationJob: h.feederPreparation?.preparationJob ?? null,
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
        reason: `${this.sharedPickupStack().length}/3 pickup; ${h.shared.length}/${h.sharedCapacity} outputs${h.sharedInternalCapacity ? `; ${h.sharedInternal.length}/${h.sharedInternalCapacity} internal` : ""}; ${h.sharedInbound} inbound`,
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
      storedRemainderFruit: h.remainderStore.inventoryFruit,
      storedRemainderMassKg: h.remainderStore.inventoryMassKg,
      packedFruit: h.runs.reduce(
        (n, batch) => n + batch.layers * 8 * batch.recipe.size,
        0,
      ),
      partialPallets: h.runs.filter((batch) => batch.partialPallet?.layers > 0)
        .length,
      partialPalletLayers: h.runs.reduce(
        (n, batch) => n + (batch.partialPallet?.layers ?? 0),
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
      "Separate labelled remainder stock, conservative at most 40 occupied tray positions per SKU across cohorts; recalled once only for matching SKU/source-group/recipe; not packed or shipped output";
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
      objective: this.input.equipment_config.feeder_capacity ?? 9,
      priorityBelow: this.input.equipment_config.feeder_capacity ?? 9,
      capacity: this.input.equipment_config.feeder_capacity ?? 9,
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
