import { Navigation } from "./navigation.mjs";
import { phaseEnergy } from "./energy.mjs";
// User-designated region LEFT OF T5. These explicit finite empty-vehicle bays and
// parking-only links are provisional configuration, NOT surveyed site geometry.
// They add no bin positions and do not change the single C1 charging capacity.
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
          from.startsWith("filler-parking:") || to.startsWith("filler-parking:")
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
  // Two provisional staging bays above/left of the low fillers. These are
  // idle parking only: C1 and its approach/charging capacity remain unchanged.
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
    if (i >= 4) {
      robot.location = robot.home;
      robot.position_m = network.nodes[robot.home];
      run.input.vehicles[i].location = robot.home;
      run.hall.parking.occupancy[robot.home] = robot.id;
    }
  }
  run.navigation = new Navigation(network, run.input.handling);
}
export function returnIdleHome(run, robot) {
  if (
    robot.job !== null ||
    robot.carried !== null ||
    robot.location === robot.home
  )
    return false;
  const parking = run.hall.parking,
    occupant = parking.occupancy[robot.home];
  if (occupant && occupant !== robot.id) {
    robot.idleHomeBlocked = "finite idle bay occupied";
    return false;
  }
  const phases = run.navigation.plan(
    robot,
    robot.location,
    robot.home,
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
        { ...robot, location: robot.home, heading_deg: last.exit_heading_deg },
        robot.home,
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
    destination: robot.home,
    phases,
    status: "active",
    leaseKeys: [`parking:${robot.home}`],
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
    destination: robot.home,
  });
  run.count("idle-home");
  return true;
}
