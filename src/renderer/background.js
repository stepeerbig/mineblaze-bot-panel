'use strict';

// Живой фон панели «Вороны» (тёмное фэнтези): стая ворон над мёртвым деревом под красной луной. От курсора вороны
// разлетаются, роняя перья; щелчок — спугнуть стаю. Рисует только окно — на ботов не влияет (они в своих процессах).
// Окно свёрнуто — кадров нет (requestAnimationFrame не вызывается); окно не в фокусе — не чаще 20 кадров в секунду;
// «уменьшение движения» в Windows — неподвижная картинка. Включает и выключает renderer.js: window.liveBackground.
(() => {
  const canvas = document.getElementById('bg');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const reduce = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const TAU = Math.PI * 2;
  const SIDE = 320; // ширина левой панели: луна — правее неё, чтобы её было видно
  const IDLE_FRAME_MS = 50; // окно не в фокусе — не чаще 20 кадров в секунду
  const FLEE_RADIUS = 170; // ближе к курсору — ворона улетает
  const DPR = () => Math.min(window.devicePixelRatio || 1, 1.5);

  /** Повторяемая «случайность» (mulberry32): дерево и облака одни и те же при каждом изменении окна. */
  function rng(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function offscreen(w, h) {
    const d = DPR();
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * d));
    c.height = Math.max(1, Math.ceil(h * d));
    const g = c.getContext('2d');
    g.scale(d, d);
    return [c, g];
  }

  const view = { w: 0, h: 0 };
  const pointer = { x: -1e4, y: -1e4, inside: false };
  let birds = [];
  let feathers = [];
  let backdrop = null;
  let enabled = false;
  let raf = 0;
  let last = 0;
  let lastDrawn = 0;

  /** Небо, луна, облака, мёртвое дерево и земля — один раз на размер окна. */
  function buildBackdrop(w, h) {
    const [c, g] = offscreen(w, h);
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#170f11');
    sky.addColorStop(0.55, '#3a1a1d');
    sky.addColorStop(1, '#4d2020');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // Луна — у дерева, справа внизу (там, в чате, меньше всего текста), а не за списком ботов.
    const mx = w > SIDE * 2 ? SIDE + (w - SIDE) * 0.7 : w * 0.6;
    const my = h * 0.6;
    const mr = Math.min(w, h) * 0.1;
    const glow = g.createRadialGradient(mx, my, mr * 0.8, mx, my, mr * 3.2);
    glow.addColorStop(0, 'rgba(170,40,26,0.42)');
    glow.addColorStop(1, 'rgba(170,40,26,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#a82c1c';
    g.beginPath();
    g.arc(mx, my, mr, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(12,9,9,0.85)';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.ellipse(mx + (i - 1) * mr * 0.9, my + mr * (0.2 + i * 0.35), mr * 1.6, mr * 0.16, 0, 0, TAU);
      g.fill();
    }

    const r = rng(31);
    g.strokeStyle = '#060505';
    g.lineCap = 'round';
    const branch = (x, y, len, a, wd, depth) => {
      const x2 = x + Math.cos(a) * len;
      const y2 = y + Math.sin(a) * len;
      g.lineWidth = wd;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x2, y2);
      g.stroke();
      if (depth <= 0 || len < 5) return;
      const n = r() < 0.35 ? 3 : 2;
      for (let i = 0; i < n; i++) branch(x2, y2, len * (0.6 + r() * 0.22), a + (r() - 0.5) * 1.15, wd * 0.66, depth - 1);
    };
    branch(w * 0.86, h * 1.02, Math.min(w, h) * 0.2, -Math.PI / 2 - 0.08, Math.max(6, w * 0.012), 7);

    g.fillStyle = '#050404';
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w + 20; x += 20) g.lineTo(x, h * 0.93 + Math.sin(x * 0.013) * h * 0.02);
    g.lineTo(w, h);
    g.closePath();
    g.fill();
    return c;
  }

  function makeBird(w, h) {
    return {
      x: Math.random() * w,
      y: h * (0.08 + Math.random() * 0.6),
      vx: (Math.random() < 0.5 ? -1 : 1) * (50 + Math.random() * 40),
      vy: (Math.random() - 0.5) * 20,
      ph: Math.random() * TAU,
      size: 8 + Math.random() * 8,
      scared: 0,
    };
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w < 2 || h < 2) return;
    const d = DPR();
    const first = !view.w;
    view.w = w;
    view.h = h;
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    backdrop = buildBackdrop(w, h);
    const want = Math.round(Math.min(42, Math.max(14, (w * h) / 22000)));
    if (first) birds = [];
    while (birds.length < want) birds.push(makeBird(w, h));
    if (birds.length > want) birds.length = want;
    for (const b of birds) b.y = Math.min(b.y, h * 0.8);
  }

  function dropFeather(x, y) {
    if (feathers.length > 60) feathers.shift();
    feathers.push({ x, y, vy: 30 + Math.random() * 30, ph: Math.random() * TAU, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 3, life: 6, size: 4 + Math.random() * 3 });
  }

  /** Спугнуть ворон вокруг точки (щелчок). */
  function scare(x, y, radius, power) {
    for (const b of birds) {
      const dx = b.x - x;
      const dy = b.y - y;
      const d = Math.hypot(dx, dy);
      if (d >= radius || d < 0.1) continue;
      const f = (1 - d / radius) * power;
      b.vx += (dx / d) * f;
      b.vy += (dy / d) * f;
      b.scared = 1;
      if (Math.random() < 0.4) dropFeather(b.x, b.y);
    }
  }

  function step(dt, t) {
    const { w, h } = view;
    for (const b of birds) {
      // Стая: лететь как соседи, не налетать друг на друга.
      let ax = 0;
      let ay = 0;
      let cnt = 0;
      let sx = 0;
      let sy = 0;
      for (const o of birds) {
        if (o === b) continue;
        const dx = o.x - b.x;
        const dy = o.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 8100) {
          ax += o.vx;
          ay += o.vy;
          cnt += 1;
          if (d2 < 576) {
            sx -= dx;
            sy -= dy;
          }
        }
      }
      if (cnt) {
        b.vx += (ax / cnt - b.vx) * 0.6 * dt;
        b.vy += (ay / cnt - b.vy) * 0.6 * dt;
      }
      b.vx += sx * 2 * dt;
      b.vy += sy * 2 * dt;
      if (pointer.inside) {
        const dx = b.x - pointer.x;
        const dy = b.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < FLEE_RADIUS && d > 0.1) {
          const f = (1 - d / FLEE_RADIUS) * 900 * dt;
          b.vx += (dx / d) * f;
          b.vy += (dy / d) * f;
          if (d < 110 && b.scared < 0.5 && Math.random() < 0.08) dropFeather(b.x, b.y);
          b.scared = 1;
        }
      }
      if (b.y > h * 0.78) b.vy -= 70 * dt;
      if (b.y < h * 0.05) b.vy += 70 * dt;
      b.vy += (Math.random() - 0.5) * 30 * dt;
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const max = b.scared > 0.05 ? 300 : 120;
      const min = 45;
      if (sp > max) {
        b.vx *= max / sp;
        b.vy *= max / sp;
      } else if (sp < min) {
        b.vx *= min / sp;
        b.vy *= min / sp;
      }
      b.scared = Math.max(0, b.scared - dt * 0.8);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < -40) b.x = w + 40;
      else if (b.x > w + 40) b.x = -40;
      b.ph += dt * (8 + sp * 0.04 + b.scared * 10);
    }
    for (let i = feathers.length - 1; i >= 0; i--) {
      const f = feathers[i];
      f.life -= dt;
      if (f.life <= 0 || f.y > h + 10) {
        feathers.splice(i, 1);
        continue;
      }
      f.y += f.vy * dt;
      f.x += Math.sin(t * 0.002 + f.ph) * 22 * dt;
      f.rot += f.vr * dt;
    }
  }

  function drawCrow(b) {
    const s = b.size;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.scale(b.vx >= 0 ? 1 : -1, 1);
    ctx.rotate(Math.atan2(b.vy, Math.abs(b.vx)) * 0.5);
    const wy = -Math.sin(b.ph) * s * 1.2;
    ctx.strokeStyle = '#050404';
    ctx.fillStyle = '#050404';
    ctx.lineWidth = s * 0.34;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-s * 1.7, wy);
    ctx.quadraticCurveTo(-s * 0.7, wy * 0.2 - s * 0.25, 0, 0);
    ctx.quadraticCurveTo(s * 0.7, wy * 0.2 - s * 0.25, s * 1.7, wy);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, s * 0.12, s * 0.75, s * 0.24, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s * 0.72, s * 0.02, s * 0.2, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(s * 0.88, -s * 0.02);
    ctx.lineTo(s * 1.18, s * 0.06);
    ctx.lineTo(s * 0.88, s * 0.12);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-s * 0.6, s * 0.1);
    ctx.lineTo(-s * 1.08, -s * 0.02);
    ctx.lineTo(-s * 1.08, s * 0.32);
    ctx.fill();
    ctx.restore();
  }

  function draw() {
    const { w, h } = view;
    if (!w || !backdrop) return;
    ctx.drawImage(backdrop, 0, 0, w, h);
    for (const b of birds) drawCrow(b);
    ctx.fillStyle = '#0a0808';
    for (const f of feathers) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.globalAlpha = Math.min(1, f.life / 2);
      ctx.beginPath();
      ctx.ellipse(0, 0, f.size, f.size * 0.3, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function frame(t) {
    raf = 0;
    if (!enabled) return;
    if (!document.hasFocus() && t - lastDrawn < IDLE_FRAME_MS) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.05, Math.max(0, (t - last) / 1000));
    last = t;
    lastDrawn = t;
    step(dt, t);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!enabled) return;
    if (reduce) {
      draw();
      return;
    }
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  window.addEventListener('resize', () => {
    if (!enabled) return;
    resize();
    if (reduce) draw();
  });
  window.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.inside = true;
  });
  document.documentElement.addEventListener('mouseleave', () => {
    pointer.inside = false;
  });
  window.addEventListener('blur', () => {
    pointer.inside = false;
  });
  window.addEventListener('pointerdown', (e) => {
    if (!enabled) return;
    scare(e.clientX, e.clientY, 260, 420);
    if (reduce) draw();
  });

  window.liveBackground = {
    /** Включить или выключить живой фон (галочка «Живой фон»). */
    setEnabled(on) {
      const next = Boolean(on);
      if (next === enabled) return;
      enabled = next;
      canvas.hidden = !next;
      if (next) {
        resize();
        start();
      } else {
        stop();
      }
    },
    get enabled() {
      return enabled;
    },
  };
})();
