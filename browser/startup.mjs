import { RECIPES } from "./recipes.mjs";

// Explicit initial conditions, not future arrivals, movements or replenishment.
// The retained 166-bin fixture remains unchanged unless this profile is selected.
export function seedWorkingStartup(run) {
  const scope = "two-eight-stack-lanes";
  const h = run.hall;
  let random = (h.seed ^ 0x719ab35d) >>> 0;
  const draw = () => {
    random = (Math.imul(1664525, random) + 1013904223) >>> 0;
    return random / 4294967296;
  };
  const addBin = (location, slot, tier, kind) => {
    const b = {
      ...structuredClone(run.bins[0]),
      id: `START-${kind}-${run.bins.length + 1}`,
      location,
      origin: location,
      owner: location,
      ownerKind: "station",
      slot,
      tier,
      sku: null,
      recipe: null,
      sourceGroup: null,
      fruit_count: 0,
      fruit_mass_kg: 0,
      reserved: 0,
      phase: "empty-ready",
      readyAt: 0,
      fill_count_target: 0,
      fifoEnteredAt: null,
      conveyor: null,
      batch: null,
      tip: null,
    };
    const i = run.bins.length;
    run.bins.push(b);
    run.binIndex.set(b.id, i);
    return i;
  };
  const fill = (i, sku, fraction, fifoTime = null) => {
    const b = run.bins[i],
      recipe = RECIPES[sku],
      target = run.target(sku);
    b.sku = sku;
    b.recipe = recipe ? structuredClone(recipe) : null;
    b.sourceGroup = `${sku}:configured-cohort`;
    b.fill_count_target = target;
    b.fruit_count = Math.floor(target * fraction);
    b.fruit_mass_kg = b.fruit_count * run.mass(sku);
    b.fruitOrigin = -100;
    b.phase = fraction === 1 ? "full-ready" : "filling";
    b.fifoEnteredAt = fifoTime;
    h.initialBySku[sku] = (h.initialBySku[sku] ?? 0) + b.fruit_count;
    h.mass.initial += b.fruit_mass_kg;
    if (fraction === 1) (h.fullBySku[sku] ??= []).push(i);
  };
  const fifoSkus = ["SKU23", "SKU24"];
  const fifo = [];
  // The user means the two horizontal, eight-position wall FIFO lanes,
  // not all low-volume staging or all eight wall lanes. Reuse existing storage
  // identities before declaring additional starting bins; other FIFO stays vacant.
  const reusable = [];
  for (const store of h.fifoStores) {
    for (const [slot, stack] of Object.entries(h.stores[store])) {
      if (store === "low_staging" && h.localEmpty.slots.includes(Number(slot)))
        continue;
      reusable.push(...stack);
      h.stores[store][slot] = [];
    }
  }
  const store = "wall_storage";
  const slots = run.input.network.storage_slots[store];
  const lanes = [...new Set(slots.map((s) => s.lane))]
    .sort(
      (a, b) =>
        Math.max(
          ...slots.filter((s) => s.lane === b).map((s) => s.centre_xy_m[1]),
        ) -
        Math.max(
          ...slots.filter((s) => s.lane === a).map((s) => s.centre_xy_m[1]),
        ),
    )
    .slice(0, 2);
  const fifoLanes = [];
  for (const [index, lane] of lanes.entries()) {
    const positions = slots
      .filter((s) => s.lane === lane)
      .sort((a, b) => a.centre_xy_m[0] - b.centre_xy_m[0]);
    if (positions.length !== 8)
      throw Error(
        "Working startup requires eight stack positions per FIFO lane",
      );
    const sku = fifoSkus[index];
    for (const slot of positions) {
      const stack = (h.stores[store][slot.slot] = []);
      for (let tier = 1; tier <= 3; tier++) {
        const i = reusable.shift() ?? addBin(store, slot.slot, tier, "FIFO");
        Object.assign(run.bins[i], {
          location: store,
          origin: store,
          owner: store,
          slot: slot.slot,
          tier,
        });
        stack.push(i);
        fill(i, sku, 1, -100 + slot.depth);
        fifo.push(i);
      }
    }
    fifoLanes.push({
      store,
      lane,
      sku,
      flow: "right-to-left",
      entry: "right",
      retrieval: "left",
      stacks: positions.length,
      bins: positions.length * 3,
    });
  }
  if (reusable.length)
    throw Error("Undeclared surplus starting FIFO identities");
  for (const m of run.machines) {
    const eligible = run.input.skus.filter(
      (s) =>
        s.id !== "SKU17" &&
        !run.machines.some((other) => other.assignment === s.id),
    );
    const sku =
      m.assignment ?? eligible[Math.floor(draw() * eligible.length)].id;
    // Strictly partial: no startup ready/full event is skipped by rounding.
    fill(m.bin, sku, 0.05 + 0.9 * draw());
    m.sku = sku;
    if (m.assignment) {
      const count = Math.floor(draw() * 3);
      for (let tier = 1; tier <= count; tier++) {
        const i = addBin(m.id, 0, tier, "STACK");
        fill(i, sku, 1);
        m.stack.push(i);
      }
    }
  }
  const sharedCount = Math.floor(draw() * 3);
  // Move declared existing top empties to the shared empty stacker at t=0.
  for (let tier = 1; tier <= sharedCount; tier++) {
    const entries = Object.entries(h.stores.empty_staging);
    const [slot, stack] = entries.find(
      ([, ids]) => ids.length && run.accessible(ids.at(-1)),
    );
    const i = stack.pop(),
      b = run.bins[i];
    Object.assign(b, {
      location: "shared_empty",
      owner: "shared_empty",
      slot: 0,
      tier,
      origin: "shared_empty",
    });
    h.shared.push(i);
  }
  h.startup = "preloaded-working-FIFO-two-SKU-v1";
  h.tipperAssignments = { T1: "SKU23", T2: "SKU24" };
  for (const t of run.tippers) t.assignment = h.tipperAssignments[t.id] ?? null;
  h.startupStock = {
    scope,
    seed: h.seed,
    fifoSkus,
    fifoBins: fifo.length,
    fifoLanes,
    physicalBins: run.bins.length,
    addedBins: run.bins.length - 166,
    sharedEmptyBins: sharedCount,
    tipperAssignments: structuredClone(h.tipperAssignments),
    status:
      "explicit declared initial inventory; not replenishment or fabricated future fruit",
  };
  run.input.purpose =
    "Preloaded working hall: two uppermost right-to-left FIFO lanes, eight three-high stacks each, T1/SKU23 and T2/SKU24, seeded partial fillers and 0–2 stacker bins";
  run.occupancy = new Map();
  for (const b of run.bins) {
    const key = `${b.location}/${b.slot}`;
    if (!run.occupancy.has(key)) run.occupancy.set(key, []);
    run.occupancy.get(key).push(b.id);
  }
}
