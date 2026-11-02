// Bounded pre-tasks expose existing complete empty stacks; no new inventory,
// buffer or demand rate is invented. Only real transfer boundaries wake retries.
const empty = (run, bins) => bins.length > 0 && bins.every((i) =>
  run.bins[i].sku === null && run.bins[i].fruit_count === 0 &&
  run.bins[i].phase === "empty-ready" && !run.bins[i].conveyor &&
  run.leases[`bin:${i}`] === undefined,
);

export function refreshFeederPreparation(run) {
  const h = run.hall;
  const stock = h.feeder.flat().length;
  const projectedStock = stock + h.feederInbound;
  const target = run.input.equipment_config.feeder_capacity ?? 9;
  let request = h.feederPreparation;
  if (projectedStock < target && (!request || request.fulfilledAt !== null)) {
    request = h.feederPreparation = {
      sequence: (request?.sequence ?? 0) + 1,
      requestAt: run.time,
      reason: "projected feeder stock below finite target; prepare accessible real complete stacks",
      projectedStock, target, depletionHorizonSeconds: null,
      source: null, binIds: [], preparationJob: null, supplyJob: null,
      preparationAt: null, pickupAt: null, dropAt: null, fulfilledAt: null,
    };
    run.record("feeder-pretask-requested", structuredClone(request));
  }
  if (request) request.projectedStock = projectedStock;
  return request;
}

export function prepareFeederSource(run, robot) {
  const h = run.hall, request = h.feederPreparation;
  if (!request || h.feeder.flat().length + h.feederInbound >= request.target) return false;
  // An active preparation already owns its real source column. Do not create
  // concurrent speculative clearances or repeatedly inspect historical jobs.
  if (run.robots.some((r) => r.job !== null && run.jobs[r.job]?.meta.feederPreparation))
    return false;
  const slots = run.input.network.storage_slots.empty_staging;
  const cells = h.stores.empty_staging ?? {};
  if (slots.some((s) => (cells[s.slot]?.length === 3) &&
      empty(run, cells[s.slot]) && run.accessible(cells[s.slot][0]))) return false;
  for (const source of slots) {
    const bins = cells[source.slot] ?? [];
    if (bins.length < 1 || bins.length > 2 || !empty(run, bins) ||
        !run.accessible(bins[0])) continue;
    const exposesTriple = slots.some((rear) => rear.lane === source.lane &&
      rear.depth > source.depth && cells[rear.slot]?.length === 3 &&
      empty(run, cells[rear.slot]));
    if (!exposesTriple) continue;
    const local = run.localEmptyStatus();
    const projectedLocal = local.assigned - local.outbound + local.inbound;
    let target, store;
    if (projectedLocal + bins.length <= local.target) {
      target = h.localEmpty.slots.map((i) => run.input.network.storage_slots.low_staging[i])
        .filter((s) => {
          const current = h.stores.low_staging[s.slot] ?? [];
          return current.length + bins.length <= 3 &&
            (!current.length || empty(run, current)) &&
            run.leases[`column:low_staging:${s.lane}`] === undefined &&
            run.planningIndex.fronts.low_staging[s.slot].every((i) =>
              !h.stores.low_staging[i]?.length);
        }).sort((a, b) =>
          (h.stores.low_staging[b.slot]?.length ?? 0) -
          (h.stores.low_staging[a.slot]?.length ?? 0))[0];
      if (target) store = "low_staging";
    }
    if (!target) {
      // A wholly empty different column is a finite relocation fallback. Never
      // insert a new partial in front of complete stacks or use common singles.
      target = slots.find((s) => s.depth === 0 && s.lane !== source.lane &&
        run.leases[`column:empty_staging:${s.lane}`] === undefined &&
        slots.filter((other) => other.lane === s.lane).every((other) =>
          !cells[other.slot]?.length));
      if (target) store = "empty_staging";
    }
    if (!target) continue;
    if (!run.missionHall(robot, [...bins], source.pickup_node, target.dropoff_node, {
      kind: store === "low_staging" ? "local-empty" : "empty-store",
      store: "empty_staging", slot: source.slot,
      destinationStore: store, destinationSlot: target.slot,
      feederPreparation: true, requestAt: request.requestAt,
    })) continue;
    const job = run.jobs.at(-1);
    Object.assign(request, {
      source: source.pickup_node, binIds: bins.map((i) => run.bins[i].id),
      preparationJob: job.id, preparationAt: run.time,
      scheduledPickupAt: job.phases.find((p) => p.kind === "pickup").end,
      scheduledDropAt: job.phases.find((p) => p.kind === "drop").end,
    });
    run.record("feeder-pretask-preparation-admitted", structuredClone(request));
    return true;
  }
  return false;
}

export function noteFeederSupply(run, job) {
  const request = run.hall.feederPreparation;
  if (!request || job.meta.kind !== "feeder") return;
  Object.assign(request, {
    supplyJob: job.id, supplyAt: run.time,
    projectedStock: run.hall.feeder.flat().length + run.hall.feederInbound,
    supplySource: job.source, supplyBinIds: job.bins.map((i) => run.bins[i].id),
    supplyPickupAt: null, supplyDropAt: null,
    scheduledSupplyPickupAt: job.phases.find((p) => p.kind === "pickup").end,
    scheduledSupplyDropAt: job.phases.find((p) => p.kind === "drop").end,
  });
  run.record("feeder-pretask-supply-admitted", structuredClone(request));
}

export function finishFeederSupply(run, job) {
  const request = run.hall.feederPreparation;
  if (request?.supplyJob !== job.id) return;
  request.supplyDropAt = run.time;
  request.fulfilledAt = run.time;
  run.record("feeder-pretask-fulfilled", structuredClone(request));
}

export function noteFeederTransfer(run, job, operation) {
  const request = run.hall.feederPreparation;
  if (job.meta.feederPreparation) {
    if (request?.preparationJob === job.id)
      request[operation === "pickup" ? "pickupAt" : "dropAt"] = run.time;
    run.record(`feeder-pretask-preparation-${operation}`, {
      job: job.id, requestAt: job.meta.requestAt, at: run.time,
      binIds: job.bins.map((i) => run.bins[i].id),
    });
  }
  if (job.meta.kind === "feeder" && operation === "pickup" && request?.supplyJob === job.id) {
    request.supplyPickupAt = run.time;
    run.record("feeder-pretask-supply-pickup", structuredClone(request));
  }
}

export function feederDestinationReadyAt(run) {
  const h = run.hall;
  if (!h.feeder[0].length && !h.feederMoving[0]) return run.time;
  if (!h.feederMoving[0] || !h.feeder[0].length) return null;
  // Only the bottom stack's already scheduled conveyor guarantees clearance.
  // No projected future destacking or unscheduled movement grants admission.
  const ends = h.feeder[0].map((i) => run.bins[i].conveyor?.end);
  return ends.every((end) => Number.isFinite(end) && end >= run.time)
    ? Math.max(...ends) : null;
}

export function donateLocalToFeeder(run, robot) {
  const h = run.hall;
  // Fallback only: the dispatcher has already tried real shared/T5/remote
  // complete stacks. Do not relocate local stock without an actual refill gap.
  if (h.feederInbound || feederDestinationReadyAt(run) === null ||
      h.feeder.flat().length + 3 > (run.input.equipment_config.feeder_capacity ?? 9))
    return false;
  if (h.feeder.flat().length > 0 && run.robots.some((r) =>
      r.job !== null && run.jobs[r.job]?.meta.feederPreparation)) return false;
  const local = run.localEmptyStatus();
  if (local.assigned - local.outbound + local.inbound - 3 < 6) return false;
  for (const slot of h.localEmpty.slots) {
    const bins = h.stores.low_staging[slot] ?? [];
    if (bins.length !== 3 || !empty(run, bins) || !run.accessible(bins[0])) continue;
    if (run.missionHall(robot, [...bins], run.source(bins[0]), "grader_empty_drop", {
      kind: "feeder", store: "low_staging", slot,
      localDonor: true,
      donorReason: "regular complete-stack supply unavailable; borrow real surplus above projected six-bin local floor",
    })) return true;
  }
  return false;
}
