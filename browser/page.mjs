const $ = (id) => document.getElementById(id),
  NS = "http://www.w3.org/2000/svg",
  worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    type: "module",
  });
let meta,
  latest = null,
  frame = null,
  selected = "",
  playing = false,
  drawMs = 0,
  draws = 0,
  view = [-16, -36, 100, 48];
const binGlyphs = [],
  robotGlyphs = [],
  stationGlyphs = new Map(),
  requestGlyphs = new Map();
function el(tag, attrs, parent = $("world")) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent.append(n);
  return n;
}
function command(type, data = {}) {
  worker.postMessage({ type, ...data });
}
function recycle(buffer, bufferId) {
  worker.postMessage({ type: "return-buffer", bufferId, buffer }, [buffer]);
}
function inspect() {
  if (selected) command("inspect", { request: selected });
}
function choose(id) {
  selected = id;
  $("objects").value = id;
  inspect();
}
function initialize(m) {
  meta = m;
  // Draw static permitted edges once, never rebuild glyphs on model events.
  for (const edge of m.network.edges)
    el("polyline", {
      points: edge.geometry_m.map((p) => `${p[0]},${-p[1]}`).join(" "),
      fill: "none",
      stroke: "#9cb9c9",
      "stroke-width": ".045",
      "stroke-dasharray": ".2 .2",
    });
  for (const id of ["L01", "L02", "T1", "shared_empty"]) {
    const [x, y] = m.network.nodes[id];
    const g = el("g", {});
    el(
      "rect",
      { x: x - 0.7, y: -y - 0.7, width: 1.4, height: 1.4, fill: "#d1dce3" },
      g,
    );
    el("text", { x: x + 0.8, y: -y, "font-size": ".65" }, g).textContent = id;
    g.addEventListener("click", () => choose(id));
    stationGlyphs.set(id, g);
    const marker = el(
      "text",
      {
        x: x - 1,
        y: -y - 1.1,
        "font-size": ".65",
        "font-weight": "bold",
        "data-request-station": id,
        display: "none",
      },
      g,
    );
    requestGlyphs.set(id, marker);
  }
  for (const [i, b] of m.bins.entries()) {
    const g = el("g", { "data-bin": b.id, class: "stack" }),
      base = el(
        "rect",
        {
          x: -0.45,
          y: -0.4,
          width: 0.9,
          height: 0.8,
          stroke: "#17353e",
          "stroke-width": ".055",
        },
        g,
      ),
      fill = el(
        "rect",
        { x: -0.43, y: 0.36, width: 0.86, height: 0, fill: "#ffdf32" },
        g,
      );
    g.addEventListener("click", () => choose(b.id));
    binGlyphs.push({ g, base, fill });
  }
  for (const id of ["V1", "V2", "V3", "V4"]) {
    const g = el("g", { "data-robot": id }),
      diamond = el(
        "path",
        {
          d: "M 0 -.6 L .6 0 L 0 .6 L -.6 0 Z",
          fill: "white",
          stroke: "#1b5a8c",
          "stroke-width": ".12",
        },
        g,
      );
    el("text", { x: 0.7, y: 0, "font-size": ".6" }, g).textContent = id;
    g.addEventListener("click", () => choose(id));
    robotGlyphs.push({ g, diamond });
  }
  for (const id of [
    ...m.bins.map((b) => b.id),
    "V1",
    "V2",
    "V3",
    "V4",
    "L01",
    "L02",
    "T1",
    "shared_empty",
  ]) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id;
    $("objects").append(o);
  }
  $("play").disabled = false;
  $("step").disabled = false;
  $("status").textContent = "Local Worker ready · no world network";
  choose(m.bins.find((b) => b.origin === "L01").id);
}
worker.onmessage = ({ data: m }) => {
  if (m.type === "ready") initialize(m.metadata);
  if (m.type === "frame") {
    if (latest) recycle(latest.buffer, latest.bufferId);
    latest = m;
  }
  if (m.type === "inspection") {
    const s = m.state,
      object =
        s.bins.find((b) => b.id === selected) ||
        s.robots.find((r) => r.id === selected) ||
        s.machines.find((v) => v.id === selected) ||
        s.tipper;
    if (m.request !== selected) return;
    $("inspect").textContent = JSON.stringify(
      {
        ...object,
        requests: s.requests.filter(
          (r) =>
            r.station === selected ||
            r.bin === selected ||
            r.robot === selected,
        ),
      },
      null,
      2,
    );
    $("events").textContent = JSON.stringify(
      { decisions: s.decisions, events: s.events },
      null,
      2,
    );
    window.browserDemo.inspection = s;
  }
  if (m.type === "error") {
    $("status").textContent = m.message;
    window.browserDemo.error = m.message;
  }
};
function locationPoint(b) {
  const id = meta.locations[b.location],
    slot = meta.network.storage_slots[id]?.[b.slot];
  if (slot) return slot.centre_xy_m;
  const station = meta.network.stations[id];
  if (station) {
    const origin = meta.network.nodes[id],
      radians = (station.fork_heading_deg * Math.PI) / 180,
      sign = station.access_motion === "forward" ? 1 : -1;
    return [
      origin[0] + sign * station.approach_distance_m * Math.cos(radians),
      origin[1] + sign * station.approach_distance_m * Math.sin(radians),
    ];
  }
  return meta.network.nodes[id] || [0, 0];
}
function draw(m) {
  if (m.selected?.id === selected)
    $("inspect").textContent = JSON.stringify(
      {
        ...m.selected.object,
        requests: m.requests.filter(
          (r) =>
            r.station === selected ||
            r.bin === selected ||
            r.robot === selected,
        ),
      },
      null,
      2,
    );
  const started = performance.now(),
    a = new Float64Array(m.buffer),
    poses = m.robots.map((r) =>
      TracePresentation.vehiclePose(
        { ...r, heading_deg: r.phase?.entry_heading_deg ?? r.heading_deg },
        r.phase,
        m.time,
        r.phase?.start ?? m.time,
      ),
    );
  const moving = new Map(m.conveyors.map((c) => [c.bin, c]));
  meta.bins.forEach((b, i) => {
    const offset = i * 8,
      location = a[offset],
      slot = a[offset + 1],
      tier = a[offset + 2],
      count = a[offset + 3],
      phase = meta.phases[a[offset + 5]],
      mass = a[offset + 7];
    const carrier = m.robots.findIndex((r) => r.carried === i),
      conveyor = moving.get(i);
    let position =
      carrier >= 0
        ? poses[carrier].position_m
        : conveyor
          ? TracePresentation.conveyorPose(conveyor, m.time).position_m
          : locationPoint({ location, slot });
    if (meta.locations[location] === "T1" && !conveyor)
      position = meta.network.tipper_flow.tippers.T1.tip;
    const glyph = TracePresentation.binGlyph(
      [
        {
          id: b.id,
          tier: 1,
          sku: count ? "SKU02" : null,
          fruit_count: count,
          fruit_mass_kg: mass,
          phase,
          fill_count_target: 952,
        },
      ],
      400,
      meta.skus,
    );
    const nodes = binGlyphs[i];
    nodes.g.setAttribute(
      "transform",
      `translate(${position[0]},${-position[1] - (tier - 1) * 0.12})`,
    );
    nodes.base.setAttribute("fill", glyph.emptyColor);
    nodes.fill.setAttribute("height", 0.72 * glyph.layers[0].fraction);
    nodes.fill.setAttribute("y", 0.36 - 0.72 * glyph.layers[0].fraction);
    nodes.g.setAttribute("data-count", count);
    nodes.g.setAttribute("data-owner", meta.locations[location]);
    nodes.g.setAttribute("data-phase", phase || "");
  });
  poses.forEach((pose, i) =>
    robotGlyphs[i].g.setAttribute(
      "transform",
      `translate(${pose.position_m[0]},${-pose.position_m[1]}) rotate(${-pose.heading_deg})`,
    ),
  );
  for (const [id, marker] of requestGlyphs) {
    const current = m.requests.filter((r) => r.station === id);
    marker.setAttribute("display", current.length ? "inline" : "none");
    marker.setAttribute("data-requests", JSON.stringify(current));
    marker.setAttribute(
      "fill",
      current.some((r) => r.status === "blocked") ? "#b00020" : "#784300",
    );
    marker.textContent = current
      .map((r) => `${r.kind === "pickup" ? "P↓" : "D↑"} ${r.status}`)
      .join(" · ");
  }
  playing = m.playing;
  $("play").textContent = playing ? "Pause" : "Play";
  $("clock").textContent =
    `Displayed ${m.time.toFixed(2)} s · frontier ${m.frontier.toFixed(2)} s`;
  $("metrics").textContent = JSON.stringify(
    { accounting: m.accounting, workerMs: m.timings, drawMs, draws },
    null,
    2,
  );
  $("fleet").textContent = m.robots
    .map(
      (r) =>
        `${r.id}: ${r.phase?.kind || "idle"} · ${(r.soc * 100).toFixed(2)}%`,
    )
    .join(" | ");
  frame = { ...m, buffer: null };
  window.browserDemo.frame = frame;
  drawMs += performance.now() - started;
  draws++;
  recycle(m.buffer, m.bufferId);
}
function render() {
  if (latest) {
    const m = latest;
    latest = null;
    draw(m);
  }
  requestAnimationFrame(render);
}
$("play").onclick = () => command(playing ? "pause" : "play");
$("step").onclick = () => command("step");
$("speed").onchange = () =>
  command("speed", { value: Number($("speed").value) });
$("objects").onchange = () => choose($("objects").value);
$("fit").onclick = () => {
  view = [-16, -36, 100, 48];
  $("plan").setAttribute("viewBox", view.join(" "));
};
let drag = null;
$("plan").onpointerdown = (e) => {
  drag = [e.clientX, e.clientY, ...view];
  $("plan").setPointerCapture(e.pointerId);
};
$("plan").onpointerup = () => {
  drag = null;
};
$("plan").onpointermove = (e) => {
  if (drag) {
    const scale = view[2] / $("plan").clientWidth;
    view = [
      drag[2] - (e.clientX - drag[0]) * scale,
      drag[3] - (e.clientY - drag[1]) * scale,
      drag[4],
      drag[5],
    ];
    $("plan").setAttribute("viewBox", view.join(" "));
  }
};
$("plan").onwheel = (e) => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 1.1 : 0.9;
  view[2] *= factor;
  view[3] *= factor;
  $("plan").setAttribute("viewBox", view.join(" "));
};
window.browserDemo = {
  command,
  inspect,
  frame: null,
  inspection: null,
  error: null,
};
command("init");
requestAnimationFrame(render);
