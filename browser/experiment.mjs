import { initializeHall } from "./hall.mjs";
import { phaseEnergy } from "./energy.mjs";
import { Navigation } from "./navigation.mjs";
const copy = (value) => structuredClone(value);
// Event ordering: physical transfer/arrival (0), readiness (1); one coalesced
// WMS notification batch after all events at a time. Sequence breaks equal ties.
class Events {
  constructor(items = []) {
    this.items = items;
  }
  push(e) {
    let i = this.items.length;
    this.items.push(e);
    while (i) {
      const p = (i - 1) >> 1;
      if (!this.before(e, this.items[p])) break;
      this.items[i] = this.items[p];
      i = p;
      this.items[i] = e;
    }
  }
  before(a, b) {
    return (
      a.time - b.time < 0 ||
      (a.time === b.time &&
        (a.priority - b.priority < 0 ||
          (a.priority === b.priority && a.seq < b.seq)))
    );
  }
  pop() {
    const first = this.items[0],
      last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      this.items[0] = last;
      for (;;) {
        let j = i * 2 + 1;
        if (j >= this.items.length) break;
        if (
          j + 1 < this.items.length &&
          this.before(this.items[j + 1], this.items[j])
        )
          j++;
        if (!this.before(this.items[j], last)) break;
        this.items[i] = this.items[j];
        i = j;
        this.items[i] = last;
      }
    }
    return first;
  }
  peek() {
    return this.items[0];
  }
}
export class Experiment {
  constructor(input, options = {}) {
    if (
      !input ||
      input.version !== 1 ||
      input.id !== "low-volume-closed-circulation-v1"
    )
      throw Error("Unsupported browser input");
    if (
      !Array.isArray(input.bins) ||
      input.bins.length !== 166 ||
      !Array.isArray(input.vehicles) ||
      input.vehicles.length !== 4 ||
      new Set(input.bins.map((b) => b.id)).size !== 166
    )
      throw Error("Demo requires 166 uniquely identified bins and four robots");
    if (
      input.bins.some(
        (b) => b.fruit_count !== 0 || b.fruit_mass_kg !== 0 || b.sku !== null,
      )
    )
      throw Error("Named demo requires explicitly empty initial fruit");
    if (
      !(input.grader?.cupsPerSecond > 0) ||
      !(input.grader.massKgPerSecond > 0) ||
      !Number.isInteger(input.equipment_config.conveyor_capacity) ||
      input.equipment_config.conveyor_capacity < 1
    )
      throw Error("Invalid finite grader/conveyor configuration");
    this.input = copy(input);
    const fleetSize = options.fleetSize ?? input.vehicles.length;
    if (
      !Number.isInteger(fleetSize) ||
      fleetSize < 4 ||
      fleetSize > 8 ||
      (options.mode !== "mixed" && fleetSize !== 4)
    )
      throw Error("Mixed hall supports four to eight AGVs");
    while (this.input.vehicles.length < fleetSize) {
      const vehicle = copy(input.vehicles[0]);
      vehicle.id = `V${this.input.vehicles.length + 1}`;
      this.input.vehicles.push(vehicle);
    }
    this.navigation =
      options.mode === "mixed"
        ? null
        : new Navigation(input.network, input.handling);
    const sku = input.skus.find((s) => s.id === "SKU02"),
      bin = input.bins.find((b) => b.location === "L01");
    this.config = {
      sku: "SKU02",
      binId: bin.id,
      capacity: Math.floor(400 / sku.mean_fruit_mass_kg),
      mass: sku.mean_fruit_mass_kg,
      fruitRate: options.fruitRate ?? 4,
      tipRate:
        options.tipRate ??
        input.cells[0].consumption.SKU02.value / 3600 / sku.mean_fruit_mass_kg,
      fruitCount: options.fruitCount,
      blockTipper: options.blockTipper ?? false,
      retrievalBinId: options.retrievalBinId ?? null,
    };
    this.config.fruitCount ??= this.config.capacity;
    this.serviceAt = 0;
    this.freshWaiting = null;
    this.serviceInterval = Math.max(
      1 / input.grader.cupsPerSecond,
      this.config.mass / input.grader.massKgPerSecond,
    );
    if (
      !Number.isFinite(this.config.fruitRate) ||
      !Number.isFinite(this.config.tipRate) ||
      !Number.isInteger(this.config.fruitCount) ||
      this.config.fruitCount < 0 ||
      !(this.config.fruitRate > 0) ||
      !(this.config.tipRate > 0)
    )
      throw Error("Invalid demo rates/count");
    this.time = 0;
    this.seq = 0;
    this.queue = new Events();
    this.pending = new Set();
    this.calendar = {};
    this.leases = {};
    this.energyAdmission = {};
    this.events = [];
    this.decisions = [];
    this.jobs = [];
    this.transit = 0;
    this.admitted = 0;
    this.consumed = 0;
    this.returned = 0;
    this.bins = input.bins.map((b) => ({
      ...copy(b),
      ownerKind: "station",
      owner: b.location,
      origin: b.location,
      phase: "empty-ready",
      reserved: 0,
      readyAt: 0,
      fill_count_target: this.config.capacity,
    }));
    this.binIndex = new Map(this.bins.map((b, i) => [b.id, i]));
    this.occupancy = new Map();
    for (const b of this.bins) {
      const key = `${b.location}/${b.slot}`;
      if (!this.occupancy.has(key)) this.occupancy.set(key, []);
      this.occupancy.get(key).push(b.id);
    }
    this.retrieval = options.retrievalBinId
      ? { bin: options.retrievalBinId, blocked: null, blockers: [] }
      : null;
    this.machines = ["L01", "L02"].map((id) => ({
      id,
      bin: this.bins.findIndex((b) => b.location === id),
      phase: "empty-ready",
      sku: null,
      blocked: null,
    }));
    this.tipper = {
      id: "T1",
      bin: null,
      phase: "idle",
      sku: "SKU02",
      blocked: options.blockTipper
        ? "destination blocked by declared fixture"
        : null,
    };
    this.robots = this.input.vehicles.map((v) => ({
      id: v.id,
      location: v.location,
      phase: null,
      job: null,
      carried: null,
      position_m: input.network.nodes[v.location],
      heading_deg: 0,
      soc: v.soc.value,
      usable_kwh: v.usable_energy.value,
      energy_kwh: 0,
      energy_time: 0,
      power_kw: input.energy.auxiliary_power.value,
    }));
    // Only event times are initialized here: no future outcomes are computed.
    this.schedule(0, "startup", {}, 1);
    if (this.config.fruitCount) this.schedule(0, "fresh", { number: 0 });
    if (options.mode === "mixed") initializeHall(this, options);
  }
  schedule(time, kind, data = {}, priority = 0) {
    if (time < this.time - 1e-9) throw Error("Past event");
    this.queue.push({ time, kind, data, priority, seq: this.seq++ });
  }
  record(kind, data = {}) {
    this.events.push({ time: this.time, kind, ...data });
    if (this.events.length > 256) this.events.shift();
  }
  notify(kind, station) {
    this.pending.add(`${kind}:${station}`);
  }
  advance(until) {
    if (!Number.isFinite(until) || until < this.time)
      throw Error("Advance requires finite nondecreasing time");
    while (this.queue.peek()?.time <= until) {
      this.time = this.queue.peek().time;
      let cycles = 0;
      do {
        while (this.queue.peek()?.time === this.time) {
          if (++cycles > 100000) throw Error("Zero-time event cycle");
          const e = this.queue.pop();
          this.handle(e.kind, e.data);
        }
        if (this.pending.size) {
          const triggers = [...this.pending];
          this.pending.clear();
          this.dispatch(triggers);
        }
      } while (this.queue.peek()?.time === this.time || this.pending.size);
    }
    this.time = until;
    return this.time;
  }
  setPower(robot, power) {
    const kwh = (robot.power_kw * (this.time - robot.energy_time)) / 3600;
    robot.energy_kwh += kwh;
    robot.soc -= kwh / robot.usable_kwh;
    robot.energy_time = this.time;
    robot.power_kw = power;
  }
  step() {
    const next = this.queue.peek();
    if (next) this.advance(next.time);
    return this.time;
  }
  handle(kind, d) {
    const c = this.config,
      cfg = this.input.equipment_config;
    if (kind === "startup") {
      this.record("startup");
      this.notify("station-ready", "L01");
      return;
    }
    if (kind === "fresh") {
      // Fresh admission and return regrading share a finite cup/mass service.
      if (this.transit >= cfg.conveyor_capacity) {
        this.freshWaiting = d;
        return;
      }
      if (this.time < this.serviceAt) {
        this.schedule(this.serviceAt, "fresh", d);
        return;
      }
      this.serviceAt = this.time + this.serviceInterval;
      this.admitted++;
      this.transit++;
      this.routeFruit();
      if (d.number + 1 < c.fruitCount)
        this.schedule(
          Math.max(this.time, this.serviceAt, (d.number + 1) / c.fruitRate),
          "fresh",
          { number: d.number + 1 },
        );
      return;
    }
    if (kind === "regrade") {
      if (this.time < this.serviceAt) {
        this.schedule(this.serviceAt, "regrade");
        return;
      }
      this.serviceAt = this.time + this.serviceInterval;
      this.routeFruit();
      return;
    }
    if (kind === "arrive") {
      const b = this.bins[d.bin];
      b.reserved--;
      b.fruit_count++;
      b.fruit_mass_kg = b.fruit_count * c.mass;
      this.transit--;
      if (this.freshWaiting) {
        const waiting = this.freshWaiting;
        this.freshWaiting = null;
        this.schedule(Math.max(this.time, this.serviceAt), "fresh", waiting);
      }
      if (b.fruit_count === c.capacity) {
        b.phase = "full";
        b.readyAt = this.time + cfg.full_bin_ready_delay;
        this.record("full", { bin: b.id });
        this.schedule(b.readyAt, "full-ready", { bin: d.bin }, 1);
      }
      return;
    }
    if (kind === "full-ready") {
      const b = this.bins[d.bin];
      b.phase = "full-ready";
      this.record(kind, { bin: b.id });
      this.notify("station-full-ready", b.location);
      return;
    }
    if (kind === "phase") {
      const job = this.jobs[d.job],
        robot = this.robots[job.robot],
        p = job.phases[d.phase];
      robot.heading_deg =
        p.entry_heading_deg ?? p.fork_heading_deg ?? robot.heading_deg;
      robot.phase = p;
      this.setPower(robot, p.power_kw);
      return;
    }
    if (kind === "transfer") {
      const job = this.jobs[d.job],
        robot = this.robots[job.robot],
        b = this.bins[job.bin];
      if (d.operation === "pickup") {
        b.location = robot.id;
        b.ownerKind = "robot";
        b.owner = job.robot;
        robot.carried = job.bin;
        const source = this.machines.find((m) => m.id === job.source);
        if (source) source.bin = null;
        if (job.source === "shared_empty") this.tipper.bin = null;
        this.record("pickup", {
          bin: b.id,
          robot: robot.id,
          source: job.source,
        });
      } else {
        b.location = job.destination;
        b.ownerKind = "station";
        b.owner = job.destination;
        robot.carried = null;
        this.record("drop", { bin: b.id, destination: job.destination });
        if (job.destination === "T1") {
          this.tipper.bin = job.bin;
          this.tipper.phase = "tipping";
          b.phase = "tip-conveyor";
          const f = this.input.network.tipper_flow.tippers.T1;
          const geometry = [f.dropoff, f.destacker, f.tip];
          const distance = geometry
            .slice(1)
            .reduce(
              (sum, p, i) =>
                sum + Math.hypot(p[0] - geometry[i][0], p[1] - geometry[i][1]),
              0,
            );
          b.conveyor = {
            start: this.time,
            end: this.time + distance / 0.25 + 30,
            geometry_m: geometry,
          };
          this.schedule(b.conveyor.end, "tip-start", { bin: job.bin });
        } else {
          const m = this.machines.find((m) => m.id === job.destination);
          m.bin = job.bin;
          m.phase = "inserted";
          m.sku = null;
          b.phase = "inserted";
          b.sku = null;
          b.tip = null;
          b.readyAt = this.time + cfg.inserted_empty_ready_delay;
          this.returned++;
          this.record("empty-returned", { bin: b.id, readyAt: b.readyAt });
          this.schedule(b.readyAt, "empty-ready", { bin: job.bin }, 1);
        }
      }
      return;
    }
    if (kind === "mission-end") {
      const job = this.jobs[d.job],
        robot = this.robots[job.robot];
      robot.location = job.destination;
      robot.position_m = this.input.network.nodes[job.destination];
      robot.phase = null;
      this.setPower(robot, this.input.energy.auxiliary_power.value);
      robot.job = null;
      job.status = "complete";
      for (const key of job.leaseKeys)
        if (this.leases[key] === job.id) delete this.leases[key];
      for (const key of Object.keys(this.calendar)) {
        this.calendar[key] = this.calendar[key].filter((r) => r.job !== job.id);
        if (!this.calendar[key].length) delete this.calendar[key];
      }
      this.record("robot-target-complete", { robot: robot.id });
      this.notify("robot-target-complete", robot.id);
      return;
    }
    if (kind === "tip-start") {
      const b = this.bins[d.bin];
      b.conveyor = null;
      b.phase = "tipping";
      b.tip = { start: this.time, count: b.fruit_count, rate: c.tipRate };
      this.record(kind, { bin: b.id });
      this.schedule(this.time + b.fruit_count / c.tipRate, "tip-empty", d);
      return;
    }
    if (kind === "tip-empty") {
      const b = this.bins[d.bin];
      this.consumed += b.tip.count;
      b.fruit_count = 0;
      b.fruit_mass_kg = 0;
      b.sku = null;
      b.phase = "empty";
      b.tip = null;
      this.tipper.phase = "return-conveyor";
      this.record(kind, { bin: b.id });
      this.notify("station-empty", "T1");
      const flow = this.input.network.tipper_flow,
        tip = flow.tippers.T1;
      const geometry = [
        tip.tip,
        tip.empty_exit,
        tip.return_corner,
        flow.empty_stacker,
        flow.intermediate,
        flow.pickup,
      ];
      const distance = geometry
        .slice(1)
        .reduce(
          (s, p, i) =>
            s + Math.hypot(p[0] - geometry[i][0], p[1] - geometry[i][1]),
          0,
        );
      b.conveyor = {
        start: this.time,
        end: this.time + distance / 0.25,
        geometry_m: geometry,
      };
      this.schedule(b.conveyor.end, "return-ready", { bin: d.bin }, 1);
      return;
    }
    if (kind === "return-ready") {
      const b = this.bins[d.bin];
      b.location = "shared_empty";
      b.owner = "shared_empty";
      b.conveyor = null;
      this.tipper.phase = "empty-ready";
      this.record(kind, { bin: b.id });
      this.notify("station-capacity-ready", "shared_empty");
      return;
    }
    if (kind === "empty-ready") {
      const b = this.bins[d.bin];
      b.phase = "empty-ready";
      this.record(kind, { bin: b.id });
      this.notify("station-empty-ready", b.location);
      return;
    }
    throw Error(`Unknown domain event ${kind}`);
  }
  routeFruit() {
    const c = this.config,
      cfg = this.input.equipment_config;
    const eligible = this.machines
      .filter((m) => m.bin !== null && this.leases[m.id] === undefined)
      .filter((m) => {
        const b = this.bins[m.bin];
        return (
          b.readyAt <= this.time &&
          ["empty-ready", "filling"].includes(b.phase) &&
          b.fruit_count + b.reserved < c.capacity &&
          (!b.sku || b.sku === c.sku)
        );
      });
    const m =
      eligible.find((m) => this.bins[m.bin].sku === c.sku) || eligible[0];
    if (m) {
      const b = this.bins[m.bin];
      b.sku = c.sku;
      b.phase = "filling";
      b.reserved++;
      m.sku = c.sku;
      const delay =
        (cfg.decision_upstream_distance +
          this.machines.indexOf(m) * cfg.filler_pitch) /
        cfg.grader_speed;
      this.schedule(this.time + delay, "arrive", { bin: m.bin });
    } else {
      this.record("recirculation");
      const delay =
        cfg.decision_to_belt_end / cfg.grader_speed +
        cfg.return_belt_length / cfg.recirculation_speed +
        cfg.return_to_decision_length / cfg.grader_speed;
      this.schedule(this.time + delay, "regrade");
    }
  }
  dispatch(triggers) {
    this.decisions.push({ time: this.time, triggers });
    if (this.decisions.length > 256) this.decisions.shift();
    if (this.retrieval) {
      const b = this.bins[this.binIndex.get(this.retrieval.bin)];
      if (!b) throw Error("Unknown retrieval bin");
      const slots = this.input.network.storage_slots[b.location] || [],
        slot = slots[b.slot];
      const front = slots.filter(
        (s) => s.lane === slot?.lane && s.depth < slot.depth,
      );
      this.retrieval.blockers = front.flatMap(
        (s) => this.occupancy.get(`${b.location}/${s.slot}`) || [],
      );
      this.retrieval.blocked = this.retrieval.blockers.length
        ? "rear blocked: actual front stock; no relocation admitted"
        : "unsupported storage retrieval in bounded low-volume demo";
    }
    const robot = this.robots.find((r) => r.job === null);
    if (!robot) return;
    if (
      this.tipper.phase === "empty-ready" &&
      this.tipper.bin !== null &&
      this.leases.shared_empty === undefined
    ) {
      const b = this.tipper.bin,
        m = this.machines.find(
          (m) =>
            m.id === this.bins[b].origin &&
            m.bin === null &&
            this.leases[m.id] === undefined,
        );
      if (m) {
        this.mission(robot, b, "shared_empty", m.id);
        return;
      }
    }
    const full = this.machines.find(
      (m) =>
        m.bin !== null &&
        this.bins[m.bin].phase === "full-ready" &&
        this.leases[m.id] === undefined,
    );
    if (full) {
      if (
        this.tipper.bin !== null ||
        this.tipper.blocked ||
        this.leases.T1 !== undefined
      ) {
        full.blocked = this.tipper.blocked || "finite tipper occupied/leased";
        return;
      }
      if (
        !this.input.cells[0].compatible_skus.value.includes(
          this.bins[full.bin].sku,
        )
      ) {
        full.blocked = "incompatible SKU";
        return;
      }
      this.mission(robot, full.bin, full.id, "T1");
      return;
    }
  }
  mission(robot, bin, source, destination, options = {}) {
    const phases = this.navigation.plan(
      robot,
      source,
      destination,
      this.time,
      this.calendar,
      {
        emptyPickup: options.emptyPickup ?? this.bins[bin].sku === null,
        pickupTier: this.bins[bin].tier,
        dropTier: options.dropTier ?? 1,
        destinationNotBefore: options.destinationNotBefore,
      },
    );
    const energy = phaseEnergy(phases, options.payload ?? this.bins[bin], this.input.energy);
    const vehicle = this.input.vehicles[this.robots.indexOf(robot)];
    const usable = vehicle.usable_energy.value;
    const available =
      robot.soc * usable -
      (robot.power_kw * (this.time - robot.energy_time)) / 3600;
    const reserve = vehicle.reserve_soc.value * usable;
    const recoveryCosts = [];
    for (const charger of this.input.chargers || []) {
      try {
        const last = phases.at(-1);
        const recovery = this.navigation.plan(
          {
            ...robot,
            location: destination,
            heading_deg: last.fork_heading_deg ?? robot.heading_deg,
          },
          destination,
          charger.id,
          last.end,
          {},
          { recovery: true },
        );
        const cost = phaseEnergy(
          recovery,
          { fruit_mass_kg: 0 },
          this.input.energy,
        );
        recoveryCosts.push({
          charger: charger.id,
          kwh: cost,
          phases: recovery,
        });
      } catch (error) {
        if (
          !error.message.startsWith("No permitted") &&
          !error.message.startsWith("Unmapped station")
        )
          throw error;
      }
    }
    recoveryCosts.sort((a, b) => a.kwh - b.kwh);
    const recovery = recoveryCosts[0];
    const wait =
      (this.input.energy.auxiliary_power.value *
        this.input.energy.admission_wait_allowance.value) /
      3600;
    const admitted =
      !!recovery && available - energy - recovery.kwh - wait >= reserve;
    if (options.preview)
      return admitted ? { phases, energy, recovery, available } : null;
    this.energyAdmission[robot.id] = {
      time: this.time,
      bin: this.bins[bin].id,
      destination,
      availableKwh: available,
      completionKwh: energy,
      recoveryKwh: recovery?.kwh ?? null,
      charger: recovery?.charger ?? null,
      recoveryPhases: recovery?.phases ?? [],
      waitKwh: wait,
      reserveKwh: reserve,
      admitted,
    };
    if (!admitted) {
      const station = this.machines.find((m) => m.id === source);
      if (station)
        station.blocked =
          "job completion plus charger recovery reserve infeasible";
      this.record("energy-blocked", {
        robot: robot.id,
        ...this.energyAdmission[robot.id],
      });
      return;
    }
    const station = this.machines.find((m) => m.id === source);
    if (station) station.blocked = null;
    const job = {
      id: this.jobs.length,
      robot: this.robots.indexOf(robot),
      bin,
      source,
      destination,
      phases,
      status: "active",
      leaseKeys: [source, destination],
    };
    this.jobs.push(job);
    for (const key of job.leaseKeys)
      if (key !== destination || options.destinationLeaseOwner === undefined)
        this.leases[key] = job.id;
    robot.job = job.id;
    if (phases[0].start > this.time)
      robot.phase = {
        kind: "traffic_wait",
        start: this.time,
        end: phases[0].start,
        position_m: robot.position_m,
      };
    for (const [i, p] of phases.entries()) {
      for (const r of p.resources || [])
        (this.calendar[r] ??= []).push({
          start: p.start,
          end: p.end,
          job: job.id,
        });
      this.schedule(p.start, "phase", { job: job.id, phase: i });
      if (p.kind === "pickup" || p.kind === "drop")
        this.schedule(p.end, "transfer", { job: job.id, operation: p.kind });
    }
    this.schedule(phases.at(-1).end, "mission-end", { job: job.id });
    this.record("mission-admitted", {
      bin: this.bins[bin].id,
      source,
      destination,
      robot: robot.id,
    });
  }
  requests() {
    const requests = [];
    const pickup = (station, bin, blocked) => {
      const jobId = this.leases[station],
        job = jobId === undefined ? null : this.jobs[jobId];
      requests.push({
        id: `pickup:${this.bins[bin].id}`,
        station,
        kind: "pickup",
        bin: this.bins[bin].id,
        status: job ? "assigned" : blocked ? "blocked" : "waiting",
        robot: job ? this.robots[job.robot].id : null,
        reason: job ? null : blocked || null,
      });
    };
    for (const m of this.machines)
      if (m.bin !== null && this.bins[m.bin].phase === "full-ready")
        pickup(m.id, m.bin, m.blocked);
    if (this.tipper.phase === "empty-ready" && this.tipper.bin !== null)
      pickup("shared_empty", this.tipper.bin, null);
    for (const job of this.jobs)
      if (
        job.status === "active" &&
        this.bins[job.bin].location !== job.destination
      )
        requests.push({
          id: `delivery:${job.id}`,
          station: job.destination,
          kind: "delivery",
          bin: this.bins[job.bin].id,
          status: "assigned",
          robot: this.robots[job.robot].id,
          reason: null,
        });
    return requests;
  }
  observe() {
    const bins = this.bins.map((b) => {
      const out = copy(b);
      if (b.tip) {
        const consumed = Math.min(
          b.tip.count,
          Math.floor(Math.max(0, this.time - b.tip.start) * b.tip.rate + 1e-9),
        );
        out.fruit_count = b.tip.count - consumed;
        out.fruit_mass_kg = out.fruit_count * this.config.mass;
      }
      return out;
    });
    const progress = this.bins.reduce(
      (s, b) =>
        s +
        (b.tip ? b.tip.count - bins[this.binIndex.get(b.id)].fruit_count : 0),
      0,
    );
    const inventory = bins.reduce((s, b) => s + b.fruit_count, 0),
      consumed = this.consumed + progress;
    return {
      time: this.time,
      frontier: this.time,
      nextEvent: this.queue.peek()?.time ?? null,
      inputId: this.input.id,
      retrieval: copy(this.retrieval),
      purpose: this.input.purpose,
      bins,
      robots: this.robots.map((r) => {
        const out = copy(r),
          used = (r.power_kw * (this.time - r.energy_time)) / 3600;
        out.energy_kwh += used;
        out.soc -= used / r.usable_kwh;
        return out;
      }),
      machines: this.machines.map((m) => ({
        ...copy(m),
        phase: m.bin === null ? "vacant" : this.bins[m.bin].phase,
      })),
      requests: this.requests(),
      tipper: copy(this.tipper),
      leases: copy(this.leases),
      energyAdmission: copy(this.energyAdmission),
      jobs: copy(this.jobs),
      events: copy(this.events),
      decisions: copy(this.decisions),
      accounting: {
        physicalBins: bins.length,
        admitted: this.admitted,
        inventory,
        transit: this.transit,
        consumed,
        returned: this.returned,
        massKg: {
          admitted: this.admitted * this.config.mass,
          inventory: inventory * this.config.mass,
          transit: this.transit * this.config.mass,
          consumed: consumed * this.config.mass,
        },
        balance: this.admitted - inventory - this.transit - consumed,
      },
    };
  }
  checkpoint() {
    return {
      version: 1,
      inputId: this.input.id,
      input: copy(this.input),
      config: copy(this.config),
      state: copy(
        Object.fromEntries(
          [
            "time",
            "seq",
            "serviceAt",
            "freshWaiting",
            "retrieval",
            "calendar",
            "leases",
            "energyAdmission",
            "events",
            "decisions",
            "jobs",
            "transit",
            "admitted",
            "consumed",
            "returned",
            "bins",
            "machines",
            "tipper",
            "robots",
          ].map((k) => [k, this[k]]),
        ),
      ),
      queue: copy(this.queue.items),
    };
  }
  static restore(saved) {
    if (
      saved.version !== 1 ||
      saved.inputId !== saved.input?.id ||
      !saved.state ||
      !Array.isArray(saved.queue)
    )
      throw Error("Incompatible browser checkpoint (Python saves unsupported)");
    const run = new Experiment(saved.input, saved.config);
    Object.assign(run, copy(saved.state));
    if (
      !Number.isFinite(run.time) ||
      run.time < 0 ||
      saved.queue.some((e) => !Number.isFinite(e.time) || e.time < run.time)
    )
      throw Error("Invalid checkpoint time/event queue");
    run.queue = new Events(copy(saved.queue));
    run.binIndex = new Map(run.bins.map((b, i) => [b.id, i]));
    return run;
  }
}
