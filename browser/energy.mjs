// Retained physical planning energy assumptions, not a calibrated battery model.
export function phaseEnergy(phases, bin, config) {
  const v = (name) => config[name].value;
  let loaded = false,
    total = 0;
  for (const p of phases) {
    const seconds = p.end - p.start,
      cargo = loaded ? v("bin_tare_mass") + bin.fruit_mass_kg : 0;
    let kwh = (v("auxiliary_power") * seconds) / 3600;
    const geometry = p.geometry_m || [],
      distance = geometry
        .slice(1)
        .reduce(
          (s, b, i) =>
            s + Math.hypot(b[0] - geometry[i][0], b[1] - geometry[i][1]),
          0,
        );
    if (distance) {
      const mass = v("vehicle_mass") + cargo,
        speed = distance / seconds;
      kwh +=
        (mass * 9.81 * v("rolling_coefficient") * distance +
          0.5 * mass * speed * speed) /
        v("drive_efficiency") /
        3.6e6;
    }
    if (p.kind.endsWith("_lift"))
      kwh +=
        ((v("fork_carriage_mass") + cargo) * 9.81 * p.height_m) /
        v("lift_efficiency") /
        3.6e6;
    else if (p.kind.endsWith("_lower"))
      kwh += (v("lowering_power") * seconds) / 3600;
    else if (p.kind === "turn" || p.kind.endsWith("_alignment"))
      kwh += (v("turn_power") * seconds) / 3600;
    else if (!distance) kwh += (v("handling_power") * seconds) / 3600;
    p.power_kw = (kwh * 3600) / seconds;
    total += kwh;
    if (p.kind === "pickup") loaded = true;
    if (p.kind === "drop") loaded = false;
  }
  return total;
}
