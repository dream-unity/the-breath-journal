(() => {
  'use strict';

  const canvas = document.getElementById('world');
  const loading = document.getElementById('loading');
  const unityLabel = document.getElementById('unityLabel');
  const labels = {
    machine: document.getElementById('label-machine'),
    maker: document.getElementById('label-maker'),
    reality: document.getElementById('label-reality')
  };

  const releaseLoader = () => loading?.classList.add('hide');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) {
    releaseLoader();
    return;
  }

  const coarse = matchMedia('(pointer: coarse)').matches;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lowCPU = (navigator.hardwareConcurrency || 8) <= 6;
  const TAU = Math.PI * 2;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const rgba = (rgb, alpha) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;

  const WORLD = {
    machine: { index: '01', name: 'DREAM MACHINE', css: '#009DFF', rgb: [0,157,255] },
    maker: { index: '02', name: 'DREAM MAKER', css: '#00C97A', rgb: [0,201,122] },
    reality: { index: '03', name: 'DREAM WORLD', css: '#7A36F5', rgb: [122,54,245] }
  };
  const WHITE_ALT = {
    machine:[0,92,235],
    maker:[0,146,112],
    reality:[210,35,255],
    unity:[255,151,0]
  };
  const worldKeys = ['machine','maker','reality'];

  let width = 1;
  let height = 1;
  let unit = 1;
  let dpr = 1;
  let time = 0;
  let last = performance.now();
  let frame = 0;
  let fpsFrames = 0;
  let fpsTime = 0;
  let slowWindows = 0;
  let labelTick = 0;

  let overviewYaw = 0.18;
  let overviewPitch = -0.06;
  let overviewRoll = 0;
  let overviewZoom = 1;
  let overviewYawVelocity = 0;
  let overviewPitchVelocity = 0;
  let overviewRollVelocity = 0;
  let overviewLastInput = -99;
  let hoverWorld = null;
  let gestureTravel = 0;
  let gestureHadPinch = false;
  let pinchState = null;
  let lastTapAt = 0;
  const pointers = new Map();

  const worldScreen = {
    machine: { x:0, y:0, r:0, z:0, f:1 },
    maker: { x:0, y:0, r:0, z:0, f:1 },
    reality: { x:0, y:0, r:0, z:0, f:1 }
  };

  const stars = [];
  const starCount = coarse || lowCPU ? 520 : 900;
  for (let i = 0; i < starCount; i++) {
    stars.push({
      x: (Math.random() * 2 - 1) * 13,
      y: (Math.random() * 2 - 1) * 8,
      z: Math.random() * 18 - 6,
      alpha: 0.15 + Math.random() * 0.7,
      size: 0.35 + Math.random() * 1.4,
      tint: i % 7
    });
  }

  function resize() {
    width = Math.max(1, innerWidth);
    height = Math.max(1, innerHeight);
    unit = Math.min(width, height);
    const cap = coarse || lowCPU ? 1.05 : 1.3;
    dpr = Math.min(devicePixelRatio || 1, cap);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function rotate3(point, yaw, pitch, roll = 0) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const x1 = point.x * cy - point.z * sy;
    const z1 = point.x * sy + point.z * cy;
    const y2 = point.y * cp - z1 * sp;
    const z2 = point.y * sp + z1 * cp;
    return {
      x: x1 * cr - y2 * sr,
      y: x1 * sr + y2 * cr,
      z: z2
    };
  }

  function project(point, scale = 1, cameraZ = 11.8) {
    const depth = cameraZ - point.z;
    const perspective = scale * cameraZ / Math.max(2.5, depth);
    return {
      x: width * 0.5 + point.x * unit * 0.085 * perspective,
      y: height * 0.5 - point.y * unit * 0.085 * perspective,
      f: perspective,
      z: point.z,
      depth
    };
  }

  function overviewBasePositions() {
    const portrait = height > width * 1.15;
    return portrait
      ? {
          machine: { x:-2.45, y:2.25, z:0.15 },
          maker: { x:2.45, y:2.25, z:-0.15 },
          reality: { x:0, y:-3.0, z:0.1 }
        }
      : {
          machine: { x:-4.15, y:1.5, z:0.15 },
          maker: { x:4.15, y:1.5, z:-0.15 },
          reality: { x:0, y:-3.15, z:0.1 }
        };
  }

  function overviewPositions(t) {
    const portrait = height > width * 1.15;
    const base = overviewBasePositions();
    const positions = {};
    worldKeys.forEach((key, index) => {
      const point = base[key];
      const wobble = reduced ? 0 : 0.08 * Math.sin(t * 0.38 + index * 2.2);
      const rotated = rotate3(
        { x:point.x, y:point.y + wobble, z:point.z },
        overviewYaw,
        overviewPitch,
        overviewRoll
      );
      const projected = project(rotated, overviewZoom, 12.3);
      positions[key] = {
        x: projected.x,
        y: projected.y,
        r: unit * (portrait ? 0.095 : 0.102) * projected.f,
        f: projected.f,
        z: rotated.z,
        world: rotated
      };
    });
    return positions;
  }

  function wLerpColor(a,b,t) {
    return [
      Math.round(a[0]+(b[0]-a[0])*t),
      Math.round(a[1]+(b[1]-a[1])*t),
      Math.round(a[2]+(b[2]-a[2])*t)
    ];
  }

  function drawBackground(t) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const parallaxYaw = overviewYaw * 0.04;
    const parallaxPitch = overviewPitch * 0.03;
    const idle = t * 0.0016;
    for (let i = 0; i < stars.length; i += 3) {
      const star = stars[i];
      const rotated = rotate3(star, parallaxYaw + idle, parallaxPitch, 0);
      const projected = project(rotated, 0.74, 15);
      if (projected.x < 0 || projected.x > width || projected.y < 0 || projected.y > height) continue;
      const pulse = 0.45 + 0.55 * Math.sin(t * 0.48 + i * 0.77) ** 2;
      const tint = star.tint === 0 ? WORLD.machine.rgb : star.tint === 1 ? WORLD.reality.rgb : star.tint === 2 ? WORLD.maker.rgb : [95,110,130];
      ctx.fillStyle = rgba(tint, (star.tint < 3 ? 0.13 : 0.038) * pulse);
      const radius = Math.min(1.15, Math.max(0.45, star.size * 0.46 * clamp(projected.f, 0.5, 1.25)));
      ctx.beginPath();
      ctx.arc(projected.x, projected.y, radius, 0, TAU);
      ctx.fill();
    }
  }

  function wCurvePoint(p0,p1,p2,p3,u) {
    const o = 1-u;
    return {
      x:o*o*o*p0.x+3*o*o*u*p1.x+3*o*u*u*p2.x+u*u*u*p3.x,
      y:o*o*o*p0.y+3*o*o*u*p1.y+3*o*u*u*p2.y+u*u*u*p3.y
    };
  }

  function drawCurve(a,b,rgb,alpha,seed,t,packets=true) {
    const dx=b.x-a.x, dy=b.y-a.y;
    const len=Math.max(1,Math.hypot(dx,dy));
    const tx=dx/len, ty=dy/len;
    const nx=-ty, ny=tx;
    const depthBias=clamp(0.72+((a.z||0)+(b.z||0))*0.035,0.5,1.08);
    const bow=(0.095+0.025*Math.sin(t*0.32+seed))*unit;
    const reach=Math.min(unit*0.075,len*0.13);
    const p0={x:a.x-tx*reach,y:a.y-ty*reach};
    const p3={x:b.x+tx*reach,y:b.y+ty*reach};
    const p1={x:a.x+dx*0.28+nx*bow,y:a.y+dy*0.28+ny*bow};
    const p2={x:a.x+dx*0.72-nx*bow*0.72,y:a.y+dy*0.72-ny*bow*0.72};

    ctx.globalCompositeOperation='source-over';
    ctx.lineCap='round';
    ctx.strokeStyle=rgba(rgb,alpha*0.09*depthBias);
    ctx.lineWidth=5.4;
    ctx.beginPath();ctx.moveTo(p0.x,p0.y);ctx.bezierCurveTo(p1.x,p1.y,p2.x,p2.y,p3.x,p3.y);ctx.stroke();
    ctx.strokeStyle=rgba(rgb,alpha*0.42*depthBias);
    ctx.lineWidth=1.45;
    ctx.beginPath();ctx.moveTo(p0.x,p0.y);ctx.bezierCurveTo(p1.x,p1.y,p2.x,p2.y,p3.x,p3.y);ctx.stroke();

    const echo=unit*0.018*(seed%2?1:-1);
    ctx.strokeStyle=rgba(rgb,alpha*0.12*depthBias);
    ctx.lineWidth=0.85;
    ctx.beginPath();
    ctx.moveTo(p0.x+nx*echo,p0.y+ny*echo);
    ctx.bezierCurveTo(p1.x+nx*echo,p1.y+ny*echo,p2.x+nx*echo,p2.y+ny*echo,p3.x+nx*echo,p3.y+ny*echo);
    ctx.stroke();

    if (!packets) return;
    for (let j=0;j<4;j++) {
      const u=(t*0.045+seed*0.073+j/4)%1;
      const p=wCurvePoint(p0,p1,p2,p3,u);
      const rr=2.0+1.6*Math.sin(u*Math.PI);
      ctx.fillStyle=rgba(rgb,0.82*alpha*depthBias);
      ctx.beginPath();ctx.arc(p.x,p.y,rr,0,TAU);ctx.fill();
      ctx.fillStyle='rgba(255,255,255,.9)';
      ctx.beginPath();ctx.arc(p.x-rr*.22,p.y-rr*.22,Math.max(.65,rr*.22),0,TAU);ctx.fill();
    }
  }

  function drawOrb(x,y,radius,config,kind,t,alpha=1,focus=0,depth=0) {
    if(alpha<=0.002||radius<=1)return;
    ctx.save();
    const depthAlpha=clamp(0.76+depth*0.045,0.58,1.08);
    ctx.globalAlpha=alpha*depthAlpha;
    ctx.globalCompositeOperation='source-over';
    const alt=WHITE_ALT[kind]||config.rgb;

    const aura=radius*1.18;
    let g=ctx.createRadialGradient(x,y,0,x,y,aura);
    g.addColorStop(0,rgba(config.rgb,0.16+focus*0.035));
    g.addColorStop(0.5,rgba(config.rgb,0.055));
    g.addColorStop(1,rgba(config.rgb,0));
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,aura,0,TAU);ctx.fill();

    g=ctx.createRadialGradient(x-radius*.22,y-radius*.24,radius*.03,x,y,radius);
    g.addColorStop(0,'rgba(255,255,255,.96)');
    g.addColorStop(.14,rgba(config.rgb,.78));
    g.addColorStop(.58,rgba(config.rgb,.20));
    g.addColorStop(1,rgba(alt,.055));
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,radius,0,TAU);ctx.fill();
    ctx.strokeStyle=rgba(alt,.72+focus*.1);ctx.lineWidth=Math.max(1.1,radius*.011);ctx.stroke();

    ctx.fillStyle=rgba(alt,.92);
    ctx.beginPath();ctx.arc(x-radius*.05,y+radius*.035,radius*.22,0,TAU);ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.94)';
    ctx.beginPath();ctx.arc(x-radius*.115,y-radius*.07,Math.max(1.4,radius*.052),0,TAU);ctx.fill();

    for (let i=0;i<5;i++) {
      const mix=i/4;
      const ringColor=wLerpColor(config.rgb,alt,mix*.78);
      const ringRadius=radius*(1.18+i*.18);
      ctx.save();ctx.translate(x,y);
      ctx.rotate(t*(0.055+i*.017)+(kind==='maker'?i*.71:kind==='reality'?i*.48:i*.37));
      ctx.scale(1,0.28+i*.095);
      ctx.strokeStyle=rgba(ringColor,.28+i*.065+focus*.025);
      ctx.lineWidth=i===0?1.45:0.9;
      ctx.beginPath();ctx.arc(0,0,ringRadius,0,TAU);ctx.stroke();
      const ang=t*(0.48+i*.09)+i*1.37;
      const sx=Math.cos(ang)*ringRadius, sy=Math.sin(ang)*ringRadius;
      ctx.fillStyle=rgba(ringColor,.78);ctx.beginPath();ctx.arc(sx,sy,Math.max(1.2,radius*.018),0,TAU);ctx.fill();
      ctx.restore();
    }

    if(kind==='machine') {
      ctx.strokeStyle=rgba(alt,.72);ctx.lineWidth=1.1;
      for(let i=0;i<10;i++) {
        const a=t*.11+i*TAU/10;
        const r1=radius*(.24+(i%3)*.055), r2=radius*(.62+(i%2)*.07);
        ctx.beginPath();ctx.moveTo(x+Math.cos(a)*r1,y+Math.sin(a)*r1);ctx.lineTo(x+Math.cos(a+.28)*r2,y+Math.sin(a+.28)*r2);ctx.stroke();
      }
    } else if(kind==='maker') {
      ctx.strokeStyle=rgba(alt,.76);ctx.lineWidth=1.2;ctx.beginPath();
      for(let i=0;i<=58;i++) {
        const a=i/58*TAU*2.5+t*.19;
        const rr=radius*(.10+.0085*i);
        const px=x+Math.cos(a)*rr, py=y+Math.sin(a)*rr*.51;
        i?ctx.lineTo(px,py):ctx.moveTo(px,py);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle=rgba(alt,.60);ctx.lineWidth=.95;
      for(let i=-3;i<=3;i++) {
        ctx.beginPath();ctx.moveTo(x-radius*.58,y+i*radius*.14);ctx.lineTo(x+radius*.58,y+i*radius*.14);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x+i*radius*.14,y-radius*.58);ctx.lineTo(x+i*radius*.14,y+radius*.58);ctx.stroke();
      }
      ctx.save();ctx.translate(x,y);ctx.rotate(t*.08);ctx.strokeStyle=rgba(config.rgb,.35);ctx.strokeRect(-radius*.34,-radius*.34,radius*.68,radius*.68);ctx.restore();
    }
    ctx.restore();
  }

  function drawUnity(unity,t,alpha) {
    const amber=[245,158,11], orange=[255,105,0];
    const coreR=unit*0.026*overviewZoom;
    const aura=coreR*2.25;
    const g=ctx.createRadialGradient(unity.x,unity.y,0,unity.x,unity.y,aura);
    g.addColorStop(0,rgba(amber,.20*alpha));
    g.addColorStop(.45,rgba(amber,.065*alpha));
    g.addColorStop(1,rgba(amber,0));
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(unity.x,unity.y,aura,0,TAU);ctx.fill();

    ctx.fillStyle=rgba(amber,.96*alpha);ctx.beginPath();ctx.arc(unity.x,unity.y,coreR,0,TAU);ctx.fill();
    ctx.fillStyle=rgba(orange,.82*alpha);ctx.beginPath();ctx.arc(unity.x+coreR*.18,unity.y-coreR*.12,coreR*.42,0,TAU);ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.94)';ctx.beginPath();ctx.arc(unity.x-coreR*.22,unity.y-coreR*.26,Math.max(1.6,coreR*.12),0,TAU);ctx.fill();

    const rings=[
      [unit*.075,unit*.025,t*.11+overviewRoll],
      [unit*.105,unit*.034,-t*.075-overviewRoll*.7],
      [unit*.135,unit*.043,t*.048+1.05]
    ];
    rings.forEach((r,i)=>{
      ctx.save();ctx.translate(unity.x,unity.y);ctx.rotate(r[2]);
      ctx.strokeStyle=rgba(i===2?orange:amber,(.52-i*.09)*alpha);ctx.lineWidth=i===0?1.7:1.05;
      ctx.beginPath();ctx.ellipse(0,0,r[0]*overviewZoom,r[1]*overviewZoom,0,0,TAU);ctx.stroke();
      const a=t*(.55+i*.13)+i*2.1;
      const sx=Math.cos(a)*r[0]*overviewZoom, sy=Math.sin(a)*r[1]*overviewZoom;
      ctx.fillStyle=rgba(i===2?orange:amber,.9*alpha);ctx.beginPath();ctx.arc(sx,sy,2.1+i*.25,0,TAU);ctx.fill();
      ctx.restore();
    });
  }

  function drawOverview(t) {
    const positions=overviewPositions(t);
    worldKeys.forEach(key=>Object.assign(worldScreen[key],positions[key]));
    const unity={x:width*.5,y:height*.5,r:unit*.05,z:0};

    ctx.globalCompositeOperation='source-over';
    ctx.globalAlpha=1;
    const ordered=worldKeys.map(key=>positions[key]);
    ctx.strokeStyle='rgba(65,80,105,.055)';
    ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(ordered[0].x,ordered[0].y);
    ctx.bezierCurveTo(width*.48,height*.16,width*.77,height*.20,ordered[1].x,ordered[1].y);
    ctx.bezierCurveTo(width*.73,height*.55,width*.58,height*.74,ordered[2].x,ordered[2].y);
    ctx.bezierCurveTo(width*.32,height*.67,width*.27,height*.38,ordered[0].x,ordered[0].y);ctx.stroke();

    const pairs=[['machine','maker'],['maker','reality'],['reality','machine']];
    pairs.forEach((pair,index)=>drawCurve(positions[pair[0]],positions[pair[1]],WORLD[pair[0]].rgb,.88,index+1,t));
    worldKeys.forEach((key,index)=>drawCurve(unity,positions[key],WORLD[key].rgb,.95,8+index,t));
    drawUnity(unity,t,1);

    const depthOrder=[...worldKeys].sort((a,b)=>positions[a].z-positions[b].z);
    depthOrder.forEach(key=>{
      const p=positions[key];
      drawOrb(p.x,p.y,p.r*1.06,WORLD[key],key,t,1,hoverWorld===key?1:0,p.z);
    });
    ctx.globalAlpha=1;
  }

  function updateLabels() {
    if (++labelTick % 2) return;
    worldKeys.forEach(key=>{
      const element=labels[key];
      const point=worldScreen[key];
      if (!element) return;
      element.style.left=`${point.x}px`;
      element.style.top=`${point.y-point.r*1.65}px`;
      element.classList.toggle('hovered',hoverWorld===key);
    });
    if (unityLabel) {
      unityLabel.style.left=`${width*.5}px`;
      unityLabel.style.top=`${height*.5+unit*.045}px`;
    }
  }

  function hitTest(x,y) {
    let best=null;
    let bestDistance=Infinity;
    const depthOrder=[...worldKeys].sort((a,b)=>worldScreen[b].z-worldScreen[a].z);
    depthOrder.forEach(key=>{
      const point=worldScreen[key];
      const distance=Math.hypot(x-point.x,y-point.y);
      if(distance<point.r*1.55 && distance<bestDistance) {
        bestDistance=distance;
        best=key;
      }
    });
    return best;
  }

  function pointerDistance(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }
  function pointerAngle(a,b) { return Math.atan2(b.y-a.y,b.x-a.x); }
  function pointerMidpoint(a,b) { return {x:(a.x+b.x)*.5,y:(a.y+b.y)*.5}; }

  function beginPinch() {
    const list=[...pointers.values()];
    if(list.length<2){pinchState=null;return;}
    const a=list[0], b=list[1];
    pinchState={
      distance:Math.max(1,pointerDistance(a,b)),
      angle:pointerAngle(a,b),
      midpoint:pointerMidpoint(a,b),
      overviewZoom,
      overviewRoll,
      overviewYaw,
      overviewPitch
    };
    gestureHadPinch=true;
  }

  function recordPointer(event) {
    const now=performance.now();
    return {
      x:event.clientX,y:event.clientY,
      lastX:event.clientX,lastY:event.clientY,
      startX:event.clientX,startY:event.clientY,
      lastTime:now,type:event.pointerType
    };
  }

  canvas.addEventListener('pointerdown',event=>{
    pointers.set(event.pointerId,recordPointer(event));
    canvas.setPointerCapture?.(event.pointerId);
    gestureTravel=0;
    if(pointers.size===1)gestureHadPinch=false;
    if(pointers.size>=2)beginPinch();
    overviewLastInput=time;
    overviewYawVelocity=overviewPitchVelocity=overviewRollVelocity=0;
  },{passive:false});

  canvas.addEventListener('pointermove',event=>{
    const pointer=pointers.get(event.pointerId);
    if(!pointer) {
      if(!coarse && frame%3===0) {
        hoverWorld=hitTest(event.clientX,event.clientY);
        canvas.style.cursor=hoverWorld?'pointer':'grab';
      }
      return;
    }

    const now=performance.now();
    const dx=event.clientX-pointer.lastX;
    const dy=event.clientY-pointer.lastY;
    const dt=Math.max(.008,(now-pointer.lastTime)/1000);
    pointer.x=event.clientX;pointer.y=event.clientY;
    pointer.lastX=event.clientX;pointer.lastY=event.clientY;pointer.lastTime=now;
    gestureTravel+=Math.hypot(dx,dy);
    overviewLastInput=time;

    if(pointers.size>=2) {
      const list=[...pointers.values()];
      const a=list[0], b=list[1];
      if(!pinchState)beginPinch();
      const distance=Math.max(1,pointerDistance(a,b));
      const angle=pointerAngle(a,b);
      const midpoint=pointerMidpoint(a,b);
      const ratio=distance/Math.max(1,pinchState.distance);
      const rotationDelta=angle-pinchState.angle;
      const midDx=midpoint.x-pinchState.midpoint.x;
      const midDy=midpoint.y-pinchState.midpoint.y;
      overviewZoom=clamp(pinchState.overviewZoom*ratio,.66,1.62);
      overviewRoll=pinchState.overviewRoll+rotationDelta;
      overviewYaw=pinchState.overviewYaw-midDx*.0035;
      overviewPitch=clamp(pinchState.overviewPitch-midDy*.0035,-1.18,1.18);
      gestureHadPinch=true;
      canvas.style.cursor='grabbing';
      event.preventDefault();
      return;
    }

    if(gestureTravel>4) {
      overviewYaw-=dx*.0065;
      overviewPitch=clamp(overviewPitch-dy*.0055,-1.18,1.18);
      overviewYawVelocity=-dx*.0065/dt;
      overviewPitchVelocity=-dy*.0055/dt;
      hoverWorld=null;
      canvas.style.cursor='grabbing';
      event.preventDefault();
    }
  },{passive:false});

  function finishPointer(event,cancelled=false) {
    const pointerCountBefore=pointers.size;
    pointers.delete(event.pointerId);
    if(pointers.size>=2)beginPinch();
    else pinchState=null;
    if(pointers.size===1) {
      const remaining=[...pointers.values()][0];
      remaining.startX=remaining.lastX=remaining.x;
      remaining.startY=remaining.lastY=remaining.y;
      remaining.lastTime=performance.now();
    }

    canvas.style.cursor=coarse?'default':'grab';
    const moved=cancelled||gestureHadPinch||pointerCountBefore>1||gestureTravel>9;
    if(moved)return;

    // Portals are intentionally inert in this repository. A click/tap never opens
    // a world, sub-portal, game, or any downstream content.
    const hit=hitTest(event.clientX,event.clientY);
    if(hit)return;

    const now=performance.now();
    if(now-lastTapAt<330) {
      overviewYaw=.18;
      overviewPitch=-.06;
      overviewRoll=0;
      overviewZoom=1;
    }
    lastTapAt=now;
  }

  canvas.addEventListener('pointerup',event=>finishPointer(event,false),{passive:false});
  canvas.addEventListener('pointercancel',event=>finishPointer(event,true),{passive:false});
  canvas.addEventListener('pointerleave',()=>{
    if(pointers.size===0) {
      hoverWorld=null;
      canvas.style.cursor=coarse?'default':'grab';
    }
  });

  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    const factor=Math.exp(-event.deltaY*.0011);
    overviewZoom=clamp(overviewZoom*factor,.66,1.62);
    overviewLastInput=time;
  },{passive:false});

  function updateMotion(dt) {
    if(pointers.size===0) {
      overviewYaw+=overviewYawVelocity*dt;
      overviewPitch=clamp(overviewPitch+overviewPitchVelocity*dt,-1.18,1.18);
      overviewRoll+=overviewRollVelocity*dt;
      const decay=Math.exp(-dt*5.1);
      overviewYawVelocity*=decay;
      overviewPitchVelocity*=decay;
      overviewRollVelocity*=decay;
      if(!reduced && time-overviewLastInput>3.2 && Math.abs(overviewYawVelocity)<.01) {
        overviewYaw+=dt*.026;
      }
    }
    if(Math.abs(overviewYaw)>TAU*50)overviewYaw%=TAU;
    if(Math.abs(overviewRoll)>TAU*50)overviewRoll%=TAU;
  }

  function render(t) {
    drawBackground(t);
    drawOverview(t);
    updateLabels();
    ctx.globalCompositeOperation='source-over';
    ctx.globalAlpha=1;
  }

  function governor(rawDt) {
    fpsFrames++;
    fpsTime+=rawDt;
    if(fpsTime<2)return;
    const fps=fpsFrames/fpsTime;
    fpsFrames=0;fpsTime=0;
    if(fps<42)slowWindows++;
    else slowWindows=Math.max(0,slowWindows-1);
    if(slowWindows>=2 && dpr>.78) {
      dpr=Math.max(.78,dpr-.12);
      canvas.width=Math.round(width*dpr);
      canvas.height=Math.round(height*dpr);
      ctx.setTransform(dpr,0,0,dpr,0,0);
      slowWindows=0;
    }
  }

  function animate(now) {
    const rawDt=Math.max(0,(now-last)/1000);
    last=now;
    const dt=Math.min(rawDt,1/30);
    if(!document.hidden) {
      time+=reduced?dt*.22:dt;
      updateMotion(dt);
      render(time);
      governor(Math.min(rawDt,.1));
      frame++;
    }
    requestAnimationFrame(animate);
  }

  addEventListener('resize',resize,{passive:true});
  document.addEventListener('visibilitychange',()=>{last=performance.now();});
  resize();
  canvas.style.cursor=coarse?'default':'grab';
  releaseLoader();
  render(0);
  requestAnimationFrame(animate);
})();
