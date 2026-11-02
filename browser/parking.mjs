import { Navigation } from "./navigation.mjs";
import { phaseEnergy } from "./energy.mjs";
// User-designated region LEFT OF T5. These explicit finite empty-vehicle bays and
// parking-only links are provisional configuration, NOT surveyed site geometry.
// They add no bin positions. Additional chargers use existing remote bays.
export function installParking(run) {
  const network = run.input.network,
    anchor = "xy:52.50000,-3.90395";
  if (!network.nodes[anchor])
    throw Error("Reviewed left-of-T5 parking junction missing");
  const added = [];
  const node = (id, point) => {
    network.nodes[id] = point;
    return id;
  };
  const link = (a, b) => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const p = network.nodes[from],
        q = network.nodes[to],
        heading =
          ((Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI + 360) % 360;
      const edge = {
        id: `provisional:idle-parking:${from}>${to}`,
        source: from,
        destination: to,
        geometry_m: [p, q],
        motion: "forward",
        allowed_load_states: ["empty"],
        entry_heading_deg: heading,
        exit_heading_deg: heading,
        speeds_mps: { empty: 1, loaded: 0.7 },
        blocked: false,
        parking_only: true,
        source_geometry_ids: [
          from.startsWith("empty-response:") || to.startsWith("empty-response:")
            ? "user-empty-storage-response-2026-11-02-provisional"
            : from.startsWith("filler-parking:") || to.startsWith("filler-parking:")
            ? "user-upper-left-two-AGV-staging-2026-11-02-provisional"
            : "user-base-left-of-T5-2026-10-29-provisional",
        ],
      };
      network.edges.push(edge);
      added.push(edge);
    }
  };
  let previous = node("idle-base:entry", [52.5, -7]);
  link(anchor, previous);
  const bays = [];
  for (let i = 0; i < run.robots.length; i++) {
    if (i === 4) {
      previous = node("idle-base:second-entry", [52.5, -11]);
      link("idle-base:entry", previous);
    }
    const x = 54 + 2 * (i % 4),
      junction = node(`idle-base:aisle:${i}`, [x, i < 4 ? -7 : -11]);
    link(previous, junction);
    previous = junction;
    const id = `P${i + 1}`,
      bay = node(`idle-base:bay:${id}`, [x, i < 4 ? -8.5 : -12.5]);
    link(junction, bay);
    network.nodes[id] = network.nodes[bay];
    network.station_nodes[id] = bay;
    network.stations[id] = {
      node: bay,
      fork_heading_deg: 270,
      approach_s: 0,
      withdrawal_s: 0,
      transfer_s: 0,
      alignment_s: 0,
      approach_distance_m: 0,
      lift_speed_mps: 0.1,
      transfer_height_m: 0,
      access_motion: "forward",
      withdrawal_motion: "reverse",
      resource: `parking:${id}`,
      source_geometry_ids: ["user-base-left-of-T5-2026-10-29-provisional"],
      arrival_edges: added
        .filter((e) => e.destination === bay)
        .map((e) => e.id),
      departure_edges: added.filter((e) => e.source === bay).map((e) => e.id),
    };
    bays.push({
      id,
      position_m: network.nodes[bay],
      capacity: 1,
      status: "provisional user-designated idle bay; not a charger",
    });
  }
  // User permits four chargers. C1 is retained; existing remote P1-P3 bays
  // become independent charge points, not extra overlapping vehicle positions.
  const chargerCount = run.input.energy.charger_count?.value ?? 1;
  for (let i = run.input.chargers.length; i < chargerCount; i++) {
    const bay = bays[i - 1];
    if (!bay) throw Error("Insufficient remote bays for configured chargers");
    const charger = structuredClone(run.input.chargers[0]);
    charger.id = bay.id;
    charger.fork_heading.value = 270;
    run.input.chargers.push(charger);
    bay.charger = true;
    bay.status =
      "user-assumed remote charger; provisional existing bay geometry";
  }
  // Two upper-left staging bays remain parking only.
  const fillerAnchor = "xy:-8.46261,26.32305";
  if (!network.nodes[fillerAnchor])
    throw Error("Upper-left filler junction missing");
  let near = node("filler-parking:entry", [-14, 26.32305]);
  link(fillerAnchor, near);
  const corner = node("filler-parking:corner", [-14, 27.5]);
  link(near, corner);
  near = corner;
  for (let i = 0; i < 2; i++) {
    const id = `FP${i + 1}`,
      x = -12.5 + i * 3,
      junction = node(`filler-parking:aisle:${i}`, [x, 27.5]),
      bay = node(`filler-parking:bay:${id}`, [x, 29.5]);
    link(near, junction);
    link(junction, bay);
    near = junction;
    network.nodes[id] = network.nodes[bay];
    network.station_nodes[id] = bay;
    network.stations[id] = {
      node: bay,
      fork_heading_deg: 90,
      approach_s: 0,
      withdrawal_s: 0,
      transfer_s: 0,
      alignment_s: 0,
      approach_distance_m: 0,
      lift_speed_mps: 0.1,
      transfer_height_m: 0,
      access_motion: "forward",
      withdrawal_motion: "reverse",
      resource: `parking:${id}`,
      source_geometry_ids: [
        "user-upper-left-two-AGV-staging-2026-11-02-provisional",
      ],
      arrival_edges: added
        .filter((e) => e.destination === bay)
        .map((e) => e.id),
      departure_edges: added.filter((e) => e.source === bay).map((e) => e.id),
    };
    bays.push({
      id,
      position_m: network.nodes[bay],
      capacity: 1,
      region: "upper-left-fillers",
      status: "provisional filler-response idle bay; not a charger",
    });
  }
  if (run.input.equipment_config.high_response_parking) {
    const anchor = "xy:41.30583,19.69462";
    if (!network.nodes[anchor])
      throw Error("High-volume response junction missing");
    const id = "HP1",
      bay = node("high-response:bay:HP1", [40, 21.7]);
    link(anchor, bay);
    network.nodes[id] = network.nodes[bay];
    network.station_nodes[id] = bay;
    network.stations[id] = {
      node: bay,
      fork_heading_deg: 0,
      approach_s: 0,
      withdrawal_s: 0,
      transfer_s: 0,
      alignment_s: 0,
      approach_distance_m: 0,
      lift_speed_mps: 0.1,
      transfer_height_m: 0,
      access_motion: "forward",
      withdrawal_motion: "reverse",
      resource: `parking:${id}`,
      source_geometry_ids: [
        "user-high-volume-response-bay-2026-11-02-provisional",
      ],
      arrival_edges: added
        .filter((e) => e.destination === bay)
        .map((e) => e.id),
      departure_edges: added.filter((e) => e.source === bay).map((e) => e.id),
    };
    bays.push({
      id,
      position_m: network.nodes[bay],
      capacity: 1,
      region: "high-volume-response",
      status: "user-designated response parking; not a charger",
    });
  }
  if (run.input.equipment_config.empty_response_parking ??
      run.input.equipment_config.high_response_parking) {
    const anchor = "xy:73.91095,21.90000";
    if (!network.nodes[anchor]) throw Error("Empty-storage response junction missing");
    const id = "EP1", bay = node("empty-response:bay:EP1", [72.4, 21.9]);
    link(anchor, bay);
    network.nodes[id] = network.nodes[bay];
    network.station_nodes[id] = bay;
    network.stations[id] = {
      node: bay, fork_heading_deg: 0,
      approach_s: 0, withdrawal_s: 0, transfer_s: 0, alignment_s: 0,
      approach_distance_m: 0, lift_speed_mps: 0.1, transfer_height_m: 0,
      access_motion: "forward", withdrawal_motion: "reverse",
      resource: `parking:${id}`,
      source_geometry_ids: ["user-empty-storage-response-2026-11-02-provisional"],
      arrival_edges: added.filter((e) => e.destination === bay).map((e) => e.id),
      departure_edges: added.filter((e) => e.source === bay).map((e) => e.id),
    };
    bays.push({ id, position_m: network.nodes[bay], capacity: 1,
      region: "empty-storage-response", feederResponse: true,
      status: "provisional empty-storage/feeder response parking; not a charger or bin position" });
  }
  const newIds = new Set(added.map((e) => e.id));
  for (const incoming of network.edges)
    for (const outgoing of network.edges)
      if (
        incoming.destination === outgoing.source &&
        (newIds.has(incoming.id) || newIds.has(outgoing.id))
      ) {
        const delta = Math.abs(
          ((outgoing.entry_heading_deg - incoming.exit_heading_deg + 540) %
            360) -
            180,
        );
        network.turns.push({
          incoming: incoming.id,
          outgoing: outgoing.id,
          duration_s: delta < 2 ? 0 : 3,
        });
      }
  network.parking = {
    version: 2,
    source:
      "User 2026-10-29: idle AGVs left of T5, charging area; plus user 2026-11-02 upper-left two-AGV staging; provisional empty-only links, C1 unchanged",
    bays,
  };
  run.hall.parking = { ...structuredClone(network.parking), occupancy: {} };
  for (const [i, robot] of run.robots.entries()) {
    robot.home =
      i >= run.robots.length - 2
        ? `FP${i - (run.robots.length - 2) + 1}`
        : bays[i].id;
    if (
      run.input.equipment_config.high_response_parking &&
      i === run.robots.length - 3
    )
      robot.home = "HP1";
    if (i >= 4) {
      robot.location = robot.home;
      robot.position_m = network.nodes[robot.home];
      run.input.vehicles[i].location = robot.home;
      run.hall.parking.occupancy[robot.home] = robot.id;
    }
  }
  run.navigation = new Navigation(network, run.input.handling);
}
export function returnIdleHome(run, robot, preferredDestination = null) {
  if (
    robot.job !== null ||
    robot.carried !== null ||
    (preferredDestination
      ? robot.location === preferredDestination
      : run.hall.parking.bays.some(
          (b) => b.id === robot.location && !b.charger,
        ))
  )
    return false;
  const parking = run.hall.parking;
  // Stage near the completed work, not at a permanent remote home. Both finite
  // upper-left bays remain available to any AGV; charger bays are not idle bays.
  const point = run.input.network.nodes[robot.location];
  const candidates = parking.bays
    .filter(
      (bay) =>
        !bay.charger &&
        (!bay.feederResponse || preferredDestination === bay.id) &&
        (!preferredDestination || bay.id === preferredDestination) &&
        (!parking.occupancy[bay.id] ||
          parking.occupancy[bay.id] === robot.id) &&
        run.leases[`parking:${bay.id}`] === undefined,
    )
    .sort(
      (a, b) =>
        Math.hypot(a.position_m[0] - point[0], a.position_m[1] - point[1]) -
          Math.hypot(b.position_m[0] - point[0], b.position_m[1] - point[1]) ||
        a.id.localeCompare(b.id),
    );
  const destination = candidates[0]?.id;
  if (!destination) {
    robot.idleHomeBlocked = "finite idle bays occupied/reserved";
    return false;
  }
  const phases = run.navigation.plan(
    robot,
    robot.location,
    destination,
    run.time,
    run.calendar,
    { emptyOnly: true },
  );
  const energy = phaseEnergy(phases, { fruit_mass_kg: 0 }, run.input.energy),
    vehicle = run.input.vehicles[run.robots.indexOf(robot)],
    usable = vehicle.usable_energy.value;
  const available =
    robot.soc * usable -
    (robot.power_kw * (run.time - robot.energy_time)) / 3600;
  const recovery = [];
  for (const charger of run.input.chargers) {
    const last = phases.at(-1),
      path = run.navigation.plan(
        { ...robot, location: destination, heading_deg: last.exit_heading_deg },
        destination,
        charger.id,
        last.end,
        {},
        { recovery: true },
      );
    recovery.push(phaseEnergy(path, { fruit_mass_kg: 0 }, run.input.energy));
  }
  const reserve = vehicle.reserve_soc.value * usable,
    wait =
      (run.input.energy.auxiliary_power.value *
        run.input.energy.admission_wait_allowance.value) /
      3600;
  if (available - energy - Math.min(...recovery) - wait < reserve) {
    robot.idleHomeBlocked =
      "idle return plus finite charger recovery reserve infeasible";
    run.record("idle-home-blocked", {
      robot: robot.id,
      reason: robot.idleHomeBlocked,
    });
    return false;
  }
  const job = {
    id: run.jobs.length,
    robot: run.robots.indexOf(robot),
    bins: [],
    bin: null,
    source: robot.location,
    destination: destination,
    phases,
    status: "active",
    leaseKeys: [`parking:${destination}`],
    meta: { kind: "idle-home" },
    completionKwh: energy,
  };
  run.jobs.push(job);
  run.leases[job.leaseKeys[0]] = job.id;
  robot.job = job.id;
  robot.idleHomeBlocked = null;
  if (phases[0].start > run.time)
    robot.phase = {
      kind: "traffic_wait",
      start: run.time,
      end: phases[0].start,
      position_m: robot.position_m,
    };
  for (const [i, p] of phases.entries()) {
    for (const resource of p.resources ?? [])
      (run.calendar[resource] ??= []).push({
        start: p.start,
        end: p.end,
        job: job.id,
      });
    run.schedule(p.start, "phase", { job: job.id, phase: i });
  }
  run.schedule(phases.at(-1).end, "mission-end", { job: job.id });
  run.record("idle-home-admitted", {
    robot: robot.id,
    destination: destination,
  });
  run.count("idle-home");
  return true;
}

// Productive work is assigned first; replenish this response position only with
// an actually idle, energy-feasible AGV. No extra vehicle or charger is created.
export function stageHighResponse(run) {
  if (!run.input.equipment_config.high_response_parking) return false;
  if (
    run.leases["parking:HP1"] !== undefined ||
    run.robots.some((r) => r.location === "HP1" && r.job === null)
  )
    return false;
  const target = run.input.network.nodes.HP1;
  const candidates = run.robots
    .filter(
      (r) =>
        r.job === null &&
        r.carried === null &&
        !["FP1", "FP2", "EP1"].includes(r.location) &&
        r.soc -
          (r.power_kw * (run.time - r.energy_time)) / 3600 / r.usable_kwh >
          run.input.energy.charge_trigger_soc.value,
    )
    .sort(
      (a, b) =>
        Math.hypot(
          ...run.input.network.nodes[a.location].map((v, i) => v - target[i]),
        ) -
          Math.hypot(
            ...run.input.network.nodes[b.location].map((v, i) => v - target[i]),
          ) || a.id.localeCompare(b.id),
    );
  for (const robot of candidates)
    if (returnIdleHome(run, robot, "HP1")) return true;
  return false;
}


// Optional response positioning is admitted after productive dispatch. It uses
// the same finite idle mission, traffic calendar and charger-recovery reserve.
export function stageEmptyResponse(run) {
  if (!run.input.network.stations.EP1 ||
      run.leases["parking:EP1"] !== undefined ||
      run.robots.some((r) => r.location === "EP1" && r.job === null)) return false;
  const h = run.hall;
  if (h.feeder.flat().length + h.feederInbound >=
      (run.input.equipment_config.feeder_capacity ?? 9)) return false;
  const remoteStock = Object.values(h.stores.empty_staging ?? {}).some((bins) =>
    bins.some((i) => run.bins[i].sku === null && run.bins[i].fruit_count === 0));
  if (!remoteStock && !h.shared.length && !h.sharedInternal.length) return false;
  const point = run.input.network.nodes.EP1;
  const candidates = run.robots.filter((r) =>
    r.job === null && r.carried === null &&
    !["FP1", "FP2", "HP1"].includes(r.location) &&
    r.soc - (r.power_kw * (run.time - r.energy_time)) / 3600 / r.usable_kwh >
      run.input.energy.charge_trigger_soc.value,
  ).sort((a, b) =>
    Math.hypot(...run.input.network.nodes[a.location].map((v, i) => v - point[i])) -
    Math.hypot(...run.input.network.nodes[b.location].map((v, i) => v - point[i])) ||
    a.id.localeCompare(b.id));
  for (const robot of candidates) {
    if (!returnIdleHome(run, robot, "EP1")) continue;
    const job = run.jobs.at(-1);
    job.meta.feederResponse = true;
    run.record("feeder-response-stage-admitted", {
      job: job.id, robot: robot.id, source: job.source, destination: "EP1",
      requestAt: h.feederPreparation?.requestAt ?? run.time,
      reason: "finite feeder request pending; position an actually idle AGV near real right-side empty stock",
    });
    return true;
  }
  return false;
}
