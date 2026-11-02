// Compile permitted directed edges and explicit turn pairs once. No world scans.
export class Navigation {
  constructor(network, handling) {
    this.handling = handling;
    this.network = network;
    this.out = new Map();
    this.turns = new Map();
    this.cache = new Map();
    for (const edge of network.edges) {
      if (!this.out.has(edge.source)) this.out.set(edge.source, []);
      this.out.get(edge.source).push(edge);
    }
    for (const t of network.turns)
      this.turns.set(`${t.incoming}\0${t.outgoing}`, t.duration_s);
  }
  route(from, to, loaded) {
    const key = `${from}/${to}/${loaded}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const start = this.network.station_nodes[from],
      target = this.network.station_nodes[to];
    if (!start || !target) throw Error(`Unmapped station ${from} → ${to}`);
    const pending = [{ node: start, last: null, cost: 0, steps: [] }],
      seen = new Set();
    while (pending.length) {
      pending.sort((a, b) => b.cost - a.cost);
      const p = pending.pop(),
        k = `${p.node}/${p.last?.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (p.node === target) {
        this.cache.set(key, p.steps);
        return p.steps;
      }
      for (const edge of this.out.get(p.node) || []) {
        if (
          edge.blocked ||
          !edge.allowed_load_states.includes(loaded ? "loaded" : "empty")
        )
          continue;
        if (
          !p.last &&
          !this.network.stations[from].departure_edges.includes(edge.id)
        )
          continue;
        if (
          edge.destination === target &&
          !this.network.stations[to].arrival_edges.includes(edge.id)
        )
          continue;
        const turn = p.last ? this.turns.get(`${p.last.id}\0${edge.id}`) : 0;
        if (turn === undefined) continue;
        const distance = edge.geometry_m
          .slice(1)
          .reduce(
            (s, b, i) =>
              s +
              Math.hypot(
                b[0] - edge.geometry_m[i][0],
                b[1] - edge.geometry_m[i][1],
              ),
            0,
          );
        const duration =
          distance / edge.speeds_mps[loaded ? "loaded" : "empty"];
        pending.push({
          node: edge.destination,
          last: edge,
          cost: p.cost + duration + turn,
          steps: [...p.steps, { edge, turn, duration }],
        });
      }
    }
    throw Error(
      `No permitted ${loaded ? "loaded" : "empty"} route ${from} → ${to}`,
    );
  }
  // Opposing edges and junctions are exclusive, independent corridors are not.
  // Build the whole reservation set before admitting; delay atomically on conflict.
  plan(robot, source, destination, now, calendar, options = {}) {
    const phases = [];
    let at = 0;
    const add = (kind, duration, details = {}) => {
      const p = { kind, start: at, end: at + duration, ...details };
      phases.push(p);
      at = p.end;
    };
    const travel = (from, to, loaded) => {
      let previousHeading = loaded
        ? this.network.stations[from].fork_heading_deg
        : robot.heading_deg;
      for (const { edge, turn, duration } of this.route(from, to, loaded)) {
        const turnTime =
          turn ||
          Math.abs(
            ((edge.entry_heading_deg - previousHeading + 540) % 360) - 180,
          ) / 30;
        if (turnTime)
          add("turn", turnTime, {
            position_m: edge.geometry_m[0],
            entry_heading_deg: previousHeading,
            exit_heading_deg: edge.entry_heading_deg,
            resources: [`node:${edge.source}`],
          });
        add(loaded ? "loaded_travel" : "empty_travel", duration, {
          geometry_m: edge.geometry_m,
          entry_heading_deg: edge.entry_heading_deg,
          exit_heading_deg: edge.exit_heading_deg,
          edge: edge.id,
          resources: [
            `edge:${[edge.source, edge.destination].sort().join("|")}`,
            `node:${edge.source}`,
            `node:${edge.destination}`,
          ],
        });
        previousHeading = edge.exit_heading_deg;
      }
    };
    const handle = (station, operation) => {
      const s = this.network.stations[station];
      const origin = this.network.nodes[station];
      const radians = (s.fork_heading_deg * Math.PI) / 180;
      const sign = s.access_motion === "forward" ? 1 : -1;
      const position_m = [
        Number(
          (
            origin[0] +
            sign * s.approach_distance_m * Math.cos(radians)
          ).toFixed(9),
        ),
        Number(
          (
            origin[1] +
            sign * s.approach_distance_m * Math.sin(radians)
          ).toFixed(9),
        ),
      ];
      const resources = [s.resource];
      const hold = {
        position_m,
        resources,
        station,
        fork_heading_deg: s.fork_heading_deg,
      };
      add(`${operation}_alignment`, s.alignment_s, {
        ...hold,
        position_m: origin,
        entry_heading_deg: phases.at(-1)?.exit_heading_deg ?? robot.heading_deg,
        exit_heading_deg: s.fork_heading_deg,
      });
      add(
        operation === "charge" ? "charge_dock" : `${operation}_approach`,
        s.approach_s,
        { ...hold, geometry_m: [origin, position_m], motion: s.access_motion },
      );
      if (operation === "charge") return;
      add(`${operation}_lift`, s.transfer_height_m / s.lift_speed_mps, {
        ...hold,
        height_m: s.transfer_height_m,
      });
      if (operation === "pickup" && options.emptyPickup)
        add("single_destack", this.handling.single_destack.value, hold);
      if (operation === "drop" && station === "low_staging")
        add("single_stack", this.handling.single_stack.value, hold);
      add(operation, s.transfer_s, hold);
      add(`${operation}_lower`, s.transfer_height_m / s.lift_speed_mps, {
        ...hold,
        height_m: s.transfer_height_m,
      });
      add(`${operation}_withdrawal`, s.withdrawal_s, {
        ...hold,
        geometry_m: [position_m, origin],
        motion: s.withdrawal_motion,
      });
    };
    if (options.recovery) {
      travel(robot.location, destination, false);
      handle(destination, "charge");
    } else {
      travel(robot.location, source, false);
      handle(source, "pickup");
      travel(source, destination, true);
      handle(destination, "drop");
    }
    let start = now;
    for (let attempts = 0; attempts < 10000; attempts++) {
      let shift = 0;
      for (const p of phases)
        for (const r of p.resources || [])
          for (const used of calendar[r] || []) {
            if (
              start + p.start < used.end - 1e-9 &&
              used.start < start + p.end - 1e-9
            )
              shift = Math.max(shift, used.end - (start + p.start));
          }
      if (!shift)
        return phases.map((p) => ({
          ...p,
          start: p.start + start,
          end: p.end + start,
        }));
      start += shift;
    }
    throw Error("Resource admission did not converge");
  }
}
