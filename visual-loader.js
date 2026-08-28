(() => {
  'use strict';

  const sourceUrl = './visual.js?v=20260826-dream-world-spin-1';
  const loading = document.getElementById('loading');

  async function loadSource(cache) {
    const response = await fetch(sourceUrl, { cache });
    if (!response.ok) throw new Error(`Visual engine failed to load: ${response.status}`);
    return response.text();
  }

  function configureVisual(source) {
    const replacements = [
      [
        'const coreR=unit*0.026*overviewZoom;',
        'const coreR=unit*0.042*overviewZoom;'
      ],
      [
        '[unit*.075,unit*.025,t*.11+overviewRoll],',
        '[unit*.105,unit*.035,t*.11+overviewRoll],'
      ],
      [
        '[unit*.105,unit*.034,-t*.075-overviewRoll*.7],',
        '[unit*.145,unit*.047,-t*.075-overviewRoll*.7],'
      ],
      [
        '[unit*.135,unit*.043,t*.048+1.05]',
        '[unit*.185,unit*.059,t*.048+1.05]'
      ],
      [
        'unityLabel.style.top=`${height*.5+unit*.045}px`;',
        'unityLabel.style.top=`${height*.5+unit*.072}px`;'
      ],
      [
        '      element.style.top=`${point.y-point.r*1.65}px`;',
        "      const labelLift=key==='reality'?1.05:1.65;\n      element.style.top=`${point.y-point.r*labelLift}px`;"
      ],
      [
        '      lastTime:now,type:event.pointerType\n    };',
        "      lastTime:now,type:event.pointerType,\n      grabWorld:hitTest(event.clientX,event.clientY)\n    };"
      ],
      [
        "    if(gestureTravel>4) {\n      overviewYaw-=dx*.0065;\n      overviewPitch=clamp(overviewPitch-dy*.0055,-1.18,1.18);\n      overviewYawVelocity=-dx*.0065/dt;\n      overviewPitchVelocity=-dy*.0055/dt;\n      hoverWorld=null;\n      canvas.style.cursor='grabbing';\n      event.preventDefault();\n    }",
        "    if(gestureTravel>4) {\n      // Dream World begins almost on the ordinary yaw/pitch axes, so pure\n      // Euler yaw/pitch makes it feel pinned compared with the side worlds.\n      // When it is the grabbed node, blend roll into the horizontal gesture\n      // and increase pitch leverage so the node follows the pointer through\n      // a comparable visible arc. The same deltas feed inertia after release.\n      const grabbedReality=pointer.grabWorld==='reality';\n      const yawDelta=-dx*(grabbedReality?.0038:.0065);\n      const pitchDelta=-dy*(grabbedReality?.0080:.0055);\n      const rollDelta=grabbedReality?dx*.0064:0;\n      overviewYaw+=yawDelta;\n      overviewPitch=clamp(overviewPitch+pitchDelta,-1.18,1.18);\n      overviewRoll+=rollDelta;\n      overviewYawVelocity=yawDelta/dt;\n      overviewPitchVelocity=pitchDelta/dt;\n      overviewRollVelocity=rollDelta/dt;\n      hoverWorld=null;\n      canvas.style.cursor='grabbing';\n      event.preventDefault();\n    }"
      ]
    ];

    let result = source;
    for (const [before, after] of replacements) {
      if (!result.includes(before)) throw new Error(`Visual configuration anchor not found: ${before}`);
      result = result.replace(before, after);
    }
    return result;
  }

  loadSource('force-cache')
    .catch(() => loadSource('no-store'))
    .then(source => Function(configureVisual(source))())
    .catch(error => {
      console.error(error);
      loading?.classList.add('hide');
    });
})();
