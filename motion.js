/* Read-only trace presentation. No inventory, scheduling or simulation stepping. */
(function(root) {
  'use strict';
  // CAD junctions can contain millimetre bridge edges almost perpendicular to
  // their nearly collinear incoming/outgoing lanes. Keep their real phases,
  // times, positions and reservations, but do not draw spurious quarter-turns.
  function presentationPhases(phases) {
    const result = phases.slice();
    const travel = p => p.kind === 'empty_travel' || p.kind === 'loaded_travel';
    const length = p => p.geometry_m?.slice(1).reduce((sum,b,i) =>
      sum + Math.hypot(b[0]-p.geometry_m[i][0],b[1]-p.geometry_m[i][1]),0) ?? Infinity;
    const delta = (a,b) => ((b-a+540)%360)-180;
    for(let i=0;i<phases.length;i++) {
      const before=phases[i];
      if(!travel(before) || length(before)<=.05) continue;
      let end=i+1, bridges=0;
      while(end<phases.length) {
        const next=phases[end];
        if(next.kind==='turn') { end++; continue; }
        if(travel(next) && length(next)<=.05) { bridges++; end++; continue; }
        break;
      }
      const after=phases[end];
      const heading=before.exit_heading_deg ?? before.entry_heading_deg;
      const target=after?.entry_heading_deg;
      if(!bridges || !after || !travel(after) || !Number.isFinite(heading) ||
         !Number.isFinite(target) || Math.abs(delta(heading,target))>2) continue;
      for(let j=i+1;j<end;j++) result[j]={...phases[j],
        display_entry_heading_deg:heading, display_exit_heading_deg:heading};
    }
    return result;
  }
  function vehiclePose(vehicle, phase, time, observedTime) {
    let position = [...vehicle.position_m], heading = vehicle.heading_deg;
    if (!phase) return {position_m:position, heading_deg:heading};
    const duration = phase.end-phase.start;
    const f = Math.max(0,Math.min(1,(time-phase.start)/duration));
    if (phase.position_m) position = [...phase.position_m];
    if (phase.geometry_m) {
      const points=phase.geometry_m;
      const lengths=points.slice(1).map((b,i)=>Math.hypot(b[0]-points[i][0],b[1]-points[i][1]));
      let remaining=f*lengths.reduce((a,b)=>a+b,0);
      position=[...points.at(-1)];
      for(let i=0;i<lengths.length;i++) {
        if(remaining<=lengths[i]) {
          const a=points[i],b=points[i+1],part=lengths[i] ? remaining/lengths[i] : 0;
          position=a.map((v,j)=>v+(b[j]-v)*part);break;
        }
        remaining-=lengths[i];
      }
    }
    if (phase.kind==='turn' || phase.kind.endsWith('_alignment')) {
      const target=phase.display_exit_heading_deg ?? phase.exit_heading_deg ?? phase.fork_heading_deg;
      heading=phase.display_entry_heading_deg ?? heading;
      const part=Math.max(0,Math.min(1,(time-observedTime)/(phase.end-observedTime)));
      heading=(heading+((target-heading+540)%360-180)*part+360)%360;
    } else heading=phase.display_entry_heading_deg ?? phase.entry_heading_deg ?? phase.fork_heading_deg ?? heading;
    return {position_m:position, heading_deg:heading};
  }
  const classColors={'Premium':'#167c38','Premium Export':'#167c38','Class 1':'#8742b2','Class 2':'#b44423','Class 3':'#555555','Juice':'#9a6500'};
  function conveyorPose(move,time) {
    const phase=move.phases?.find(p=>time<p.end) || move.phases?.at(-1) || {...move,kind:'conveyor_travel'};
    return vehiclePose({position_m:move.geometry_m[0],heading_deg:0},phase,time,move.start);
  }
  function binLabels(bins,skus) {
    return [...new Set(bins.filter(b=>b.fruit_count>0).map(b=>b.sku).filter(Boolean))].map(id=>{
      const sku=skus.find(s=>s.id===id);
      const prepacks=[...new Set(skus.map(s=>s.size).filter(size=>/prepack/i.test(size)))].sort();
      const type=prepacks.indexOf(sku?.size);
      const text=type<0 ? sku?.size ?? id : 'PP'+String.fromCharCode(65+type);
      return {text,color:classColors[sku?.grade] ?? '#222222'};
    });
  }
  function binFillState(bins) {
    const occupied=bins.filter(b=>b.fruit_count>0);
    return !occupied.length ? 'empty' : bins.some(b=>!(b.fruit_count>0) || b.phase!=='full') ? 'partial' : 'full';
  }
  // Capacity is the retained packing count, bounded by whole-fruit mass capacity.
  // Neither reservations nor interpolation create physically present fruit.
  function binGlyph(bins, capacityKg, skus) {
    const height=bins.length;
    const layers=[...bins].sort((a,b)=>(a.tier ?? 0)-(b.tier ?? 0)).map(b=>{
      const mass=skus.find(s=>s.id===b.sku)?.mean_fruit_mass_kg;
      const massCount=mass>0 ? Math.floor((capacityKg+1e-9)/mass) : Infinity;
      const target=b.fill_count_target>0 ? Math.min(b.fill_count_target,massCount) : massCount;
      const fraction=!(b.fruit_count>0) ? 0 : Number.isFinite(target) && target>0
        ? Math.min(1,b.fruit_count/target) : Math.min(1,b.fruit_mass_kg/capacityKg);
      return {id:b.id,fraction,color:'#ffdf32'};
    });
    const state=layers.every(b=>b.fraction===0) ? 'empty'
      : layers.every(b=>b.fraction===1) ? 'full' : 'partial';
    if(state==='full' && height===2)layers[1].color='#f59b28';
    if(state==='full' && height===3)for(const layer of layers)layer.color='#e04436';
    return {height,state,emptyColor:['#f0f1f2','#a7d8f0','#2864a0'][Math.min(height,3)-1],layers};
  }
  function pendingRequests(intents,station) {
    return intents.filter(i=>['waiting','submitted'].includes(i.status) &&
      ((i.start_location.id===station && i.pickup_fulfilled_at===undefined) ||
       (i.end_location.id===station && i.dropoff_fulfilled_at===undefined)));
  }
  function equipmentRequests(equipment,station) {
    const explicit=Object.values(equipment?.requests || {}).filter(r=>r.start_location.id===station);
    const intents=pendingRequests(Object.values(equipment?.intents || {}),station).filter(i=>{
      const operation=i.start_location.id===station ? 'pickup' : 'supply';
      return !explicit.some(r=>r.operation===operation);
    });
    return pendingRequests(explicit,station).concat(intents);
  }
  function applyDelta(before,patch) {
    if(patch===null)return before;
    if(Object.hasOwn(patch,'set'))return patch.set;
    const after={...before};
    for(const key of patch.remove)delete after[key];
    for(const [key,change] of Object.entries(patch.keys))after[key]=applyDelta(before?.[key],change);
    return after;
  }
  function decodeWindow(payload) {
    let frames=payload.frames;
    if(payload.format==='event-deltas-v1') {
      frames=[payload.initial];
      for(const patch of payload.deltas)frames.push(applyDelta(frames.at(-1),patch));
    }
    for(const frame of frames)for(const [id,job] of Object.entries(frame.state.jobs))
      if(!job.phases)job.phases=payload.job_phases[id];
    return {start:payload.start,end:payload.end,frames};
  }
  function pinchView(start,startDistance,distance,anchor,current) {
    const scale=Math.max(3/start[2],Math.min(250/start[2],startDistance/Math.max(1,distance)));
    return [anchor[0]-(current[0]-start[0])*scale,
      anchor[1]-(current[1]-start[1])*scale,start[2]*scale,start[3]*scale];
  }
  const api={presentationPhases,vehiclePose,conveyorPose,binLabels,binFillState,binGlyph,pendingRequests,equipmentRequests,classColors,decodeWindow,pinchView};
  if(typeof module!=='undefined') module.exports=api;
  else root.TracePresentation=api;
})(globalThis);
