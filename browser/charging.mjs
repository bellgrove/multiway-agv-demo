import { phaseEnergy } from "./energy.mjs";
// Finite charger recovery. Idle threshold wakes are predicted events,
// never fruit/frame polling. Power and geometry remain the cited input values.
const chargeThreshold = (run) => run.input.energy.charge_trigger_soc.value;
// Provisional dispatch policy, not a battery/hardware parameter. Setting this
// internal policy to the recovery threshold disables elective early charging.
const opportunityThreshold = (run) =>
  run.input.energy.opportunity_charge_soc?.value ?? 0.55;
export function scheduleBatteryWake(run, robot) {
  robot.batteryWake = (robot.batteryWake ?? 0) + 1;
  if (robot.job !== null) return;
  const available =
    robot.soc * robot.usable_kwh -
    (robot.power_kw * (run.time - robot.energy_time)) / 3600;
  // Keep the recovery wake even if an elective wake finds both elective
  // slots occupied; no periodic retries and no missed low-battery recovery.
  for (const threshold of new Set([opportunityThreshold(run), chargeThreshold(run)])) {
    const seconds =
      ((available - threshold * robot.usable_kwh) /
        run.input.energy.auxiliary_power.value) * 3600;
    if (seconds > 1e-6 && Number.isFinite(seconds))
      run.schedule(
        run.time + seconds,
        "hall-energy-wake",
        { robot: run.robots.indexOf(robot), token: robot.batteryWake },
        1,
      );
  }
}
export function chargeIdle(run, robot) {
  const threshold = chargeThreshold(run),
    target = run.input.energy.charge_target_soc.value;
  const available =
    robot.soc * robot.usable_kwh -
    (robot.power_kw * (run.time - robot.energy_time)) / 3600;
  const soc = available / robot.usable_kwh;
  const opportunity = soc > threshold + 1e-9;
  if (opportunity) {
    if (soc > opportunityThreshold(run) + 1e-9) return false;
    const charging = run.robots.filter((r) =>
      r.job !== null && run.jobs[r.job]?.meta.kind === "charge",
    );
    if (charging.filter((r) => run.jobs[r.job].meta.opportunity).length >= 2 ||
        run.robots.length - charging.length <= 6) return false;
  }
  if (robot.carried !== null) return false;
  const charger = run.input.chargers.find(
    (c) =>
      run.leases[`charger:${c.id}`] === undefined &&
      run.leases[`parking:${c.id}`] === undefined &&
      !run.robots.some(
        (r) => r !== robot && r.location === c.id && r.job === null,
      ),
  );
  if (!charger) return true; // Wait for the actual release event, no fake capacity.
  const phases = run.navigation.plan(
    robot,
    robot.location,
    charger.id,
    run.time,
    run.calendar,
    { recovery: true },
  );
  const travelEnergy =
    phaseEnergy(phases, { fruit_mass_kg: 0 }, run.input.energy) +
    (run.input.energy.auxiliary_power.value *
      ((phases[0]?.start ?? run.time) - run.time)) /
      3600;
  if (travelEnergy >= available) {
    robot.idleHomeBlocked = "insufficient energy to reach charger";
    return true;
  }
  const arrival = phases.at(-1)?.end ?? run.time;
  const auxiliary = run.input.energy.auxiliary_power.value;
  const batteryPower =
    charger.power.value * run.input.energy.charge_efficiency.value;
  const duration =
    ((target * robot.usable_kwh - available + travelEnergy) /
      (batteryPower - auxiliary)) *
    3600;
  if (!(duration > 0 && Number.isFinite(duration)))
    throw Error("Invalid charger net power/duration");
  phases.push({
    kind: "charging",
    start: arrival,
    end: arrival + duration,
    position_m: run.input.network.nodes[charger.id],
    resources: [`charger:${charger.id}`, `access:${charger.id}`],
    power_kw: auxiliary,
  });
  const job = {
    id: run.jobs.length,
    robot: run.robots.indexOf(robot),
    bins: [],
    bin: null,
    source: robot.location,
    destination: charger.id,
    phases,
    status: "active",
    leaseKeys: [`charger:${charger.id}`],
    meta: {
      kind: "charge",
      opportunity,
      suppliedKwh: (batteryPower * duration) / 3600,
      gridKwh: (charger.power.value * duration) / 3600,
    },
  };
  run.jobs.push(job);
  run.leases[job.leaseKeys[0]] = job.id;
  robot.job = job.id;
  robot.batteryWake = (robot.batteryWake ?? 0) + 1;
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
  run.record("charge-admitted", { robot: robot.id, charger: charger.id });
  run.count("charge-start");
  return true;
}
export function finishCharge(run, job) {
  if (job.meta.kind !== "charge") return;
  const robot = run.robots[job.robot];
  run.setPower(robot, run.input.energy.auxiliary_power.value);
  robot.soc += job.meta.suppliedKwh / robot.usable_kwh;
  robot.charged_kwh = (robot.charged_kwh ?? 0) + job.meta.suppliedKwh;
  run.count("charge-complete");
  run.record("charge-complete", { robot: robot.id, soc: robot.soc });
}
