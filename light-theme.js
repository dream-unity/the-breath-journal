(() => {
  'use strict';

  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  const proto = typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : null;
  const fillStyleDescriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'fillStyle') : null;
  const strokeStyleDescriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'strokeStyle') : null;
  const compositeDescriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'globalCompositeOperation') : null;

  if (!nativeGetContext || !fillStyleDescriptor?.get || !fillStyleDescriptor?.set || !strokeStyleDescriptor?.get || !strokeStyleDescriptor?.set || !compositeDescriptor?.get || !compositeDescriptor?.set) return;

  const palette = new Map([
    ['57,215,255', [0,149,255]],
    ['98,239,165', [0,200,120]],
    ['189,124,255', [124,58,237]],
    ['205,248,255', [0,102,179]],
    ['220,255,235', [0,145,86]],
    ['235,215,255', [91,33,182]],
    ['120,220,255', [0,122,204]],
    ['190,150,255', [111,57,203]],
    ['130,255,190', [0,158,96]],
    ['230,235,255', [51,65,85]],
    ['236,220,255', [106,62,190]],
    ['255,245,205', [245,158,11]],
    ['255,220,140', [245,158,11]],
    ['255,230,175', [217,119,6]],
    ['255,242,205', [245,158,11]],
    ['255,240,205', [217,119,6]]
  ]);

  const clamp01 = value => Math.max(0, Math.min(1, value));
  const parseRgba = value => {
    if (typeof value !== 'string') return null;
    const match = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (!match) return null;
    return { r:+match[1], g:+match[2], b:+match[3], a:match[4] == null ? 1 : +match[4] };
  };

  function remapColor(value, alphaScale = 1) {
    if (typeof value !== 'string') return value;
    if (value.toLowerCase() === '#02040a' || value.toLowerCase() === '#010309') return '#ffffff';
    const parsed = parseRgba(value);
    if (!parsed) return value;

    let {r,g,b,a} = parsed;
    const mapped = palette.get(`${Math.round(r)},${Math.round(g)},${Math.round(b)}`);
    if (mapped) [r,g,b] = mapped;
    else if (r >= 245 && g >= 245 && b >= 245) [r,g,b] = [15,23,42];
    else if (r >= 248 && g >= 220 && b <= 215) [r,g,b] = [245,158,11];

    a = clamp01(a * alphaScale);
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
  }

  HTMLCanvasElement.prototype.getContext = function(type, options) {
    const context = nativeGetContext.call(this, type, options);
    if (!context || type !== '2d' || this.id !== 'world' || context.__dreamUnityLightOverview) return context;

    Object.defineProperty(context, '__dreamUnityLightOverview', { value: true });

    Object.defineProperty(context, 'fillStyle', {
      configurable: true,
      get() { return fillStyleDescriptor.get.call(this); },
      set(value) { fillStyleDescriptor.set.call(this, remapColor(value, 1)); }
    });

    Object.defineProperty(context, 'strokeStyle', {
      configurable: true,
      get() { return strokeStyleDescriptor.get.call(this); },
      set(value) { strokeStyleDescriptor.set.call(this, remapColor(value, 1.28)); }
    });

    Object.defineProperty(context, 'globalCompositeOperation', {
      configurable: true,
      get() { return compositeDescriptor.get.call(this); },
      set(value) { compositeDescriptor.set.call(this, value === 'lighter' ? 'source-over' : value); }
    });

    const nativeRadial = context.createRadialGradient.bind(context);
    context.createRadialGradient = function(x0,y0,r0,x1,y1,r1) {
      const gradient = nativeRadial(x0,y0,r0,x1,y1,r1);
      const nativeAdd = gradient.addColorStop.bind(gradient);
      const unit = Math.min(innerWidth || 1, innerHeight || 1);
      const isBackgroundFog = r1 > unit * 0.25;
      const isLargeGlow = !isBackgroundFog && r1 > unit * 0.14;
      try {
        Object.defineProperty(gradient, 'addColorStop', {
          configurable: true,
          value(offset, color) {
            if (isBackgroundFog) {
              nativeAdd(offset, 'rgba(255,255,255,0)');
              return;
            }
            nativeAdd(offset, remapColor(color, isLargeGlow ? 0.48 : 1.12));
          }
        });
      } catch {}
      return gradient;
    };

    return context;
  };
})();
