/* ---------------------------------------------------------------------------
   VECTOR — the context overworld.

   The blog as a star system you fly. The core is the sun; every post is a
   wireframe planet on procedurally laid-out orbit shells (works for any
   number of posts — six per shell, slug-hashed placement). Reading an
   article banks a ⬡ core to spend in the ability tree (T): offence /
   defense / ai branches, visible ship components, resettable. Asteroids
   drop scrap and score; interceptors hunt you once your score climbs;
   portal rings at the system edge open seeded transit runs — infinite,
   procedural, four challenge kinds, difficulty scaling with a persistent
   run level — ending in a separate free-flight arena where the warden
   waits. Ship state and score survive article visits (sessionStorage);
   best score and run level stick (localStorage). Synth SFX via WebAudio,
   M mutes. Article pages keep an ambient field, a "return to system"
   chip, and esc flies you home.

   Controls (desktop): click the void to take the stick (pointer lock) —
   mouse aims, W thrusts, S brakes, shift boosts, space / click fires,
   E / right-click launches a missile, T opens the tree, M toggles sound,
   enter reads when docked, esc releases the stick. Unlocked: the pointer
   steers gently and clicking a planet opens it. Touch (iPad / iPhone /
   Android): the left ~60% of the screen is a virtual stick (touch down
   anywhere, drag to steer — quadratic response); the right-thumb cluster
   has thrust (toggle), boost / brake / fire (hold) and missile (tap).
   Pinch and double-tap zoom are suppressed while flying. Tapping a planet
   still opens the article.

   Loaded lazily, only while [data-style="vector"] is active. mount() reads
   the post list from the DOM (one source of truth) and returns { unmount }.
--------------------------------------------------------------------------- */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GREEN = 0x46ffa0;
const GREEN_DIM = 0x1d7a4c;
const MAGENTA = 0xff5fd2;
const AMBER = 0xffc46a;
const CYAN = 0x6ad8ff;
const BG = 0x020806;
const PALETTE = [GREEN, CYAN, MAGENTA, AMBER];

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

const VISITED_KEY = 'vector-visited';
const SCRAP_KEY = 'vector-scrap';
const TREE_KEY = 'vector-tree';
const BEST_KEY = 'vector-best';
const MUTE_KEY = 'vector-mute';
const RUNLVL_KEY = 'vector-runlvl';
const SHIP_KEY = 'vector-ship'; // sessionStorage: ship state across page visits

/* the ability tree: reading an article banks one ⬡ core; nodes cost cores
   and chain within their branch, resettable for a full refund. You start
   with the base kit only — one laser and the parry. Hardware ids keep
   their visible ship parts in makeShip; the rest are pure stat nodes. */
const TREE = [
  /* offence: the manual guns */
  { id: 'twin', branch: 'offence', name: 'twin cannons', desc: 'a second laser muzzle', cost: 1 },
  { id: 'rapid', branch: 'offence', name: 'rapid coils', desc: '+35% laser fire rate', cost: 1, req: 'twin' },
  { id: 'velocity', branch: 'offence', name: 'rail accelerators', desc: 'faster, harder bolts', cost: 2, req: 'rapid' },
  { id: 'pods', branch: 'offence', name: 'missile pods', desc: 'unlocks ➤ homing missiles · twin salvo', cost: 2, req: 'twin' },
  { id: 'lance', branch: 'offence', name: 'lance coils', desc: '+1 bolt damage · +rate again', cost: 2, req: 'velocity' },
  /* defense: survive longer, move better */
  { id: 'shield', branch: 'defense', name: 'deflector cell', desc: 'a 35-pt shield — depletes, then trickles back to ⅓', cost: 1 },
  { id: 'charges', branch: 'defense', name: 'capacitor bank', desc: '2 reboot charges — a broken shield restarts full', cost: 2, req: 'shield' },
  { id: 'plating', branch: 'defense', name: 'ablative plating', desc: '+40 max hull', cost: 1 },
  { id: 'reactor', branch: 'defense', name: 'nanoreactor', desc: 'hull self-repairs in flight · gilded trim', cost: 2, req: 'plating' },
  { id: 'burner', branch: 'defense', name: 'afterburner', desc: 'unlocks ⚡ boost · faster fuel regen', cost: 1 },
  { id: 'gyro', branch: 'defense', name: 'reflex gyros', desc: 'sharper turns & brakes · faster ⛨ parry · swept wings', cost: 2, req: 'burner' },
  /* ai: autonomous modules + the supports that overclock them */
  { id: 'turret', branch: 'ai', name: 'sentry turret', desc: 'auto-fires at the nearest threat', cost: 1 },
  { id: 'igniter', branch: 'ai', name: 'plasma igniter', desc: 'sentry bolts set targets burning — damage over time', cost: 2, req: 'turret' },
  { id: 'automl', branch: 'ai', name: 'missile autoloader', desc: 'launches a homing missile on its own', cost: 2, req: 'turret' },
  { id: 'overclock', branch: 'ai', name: 'tempo core', desc: 'support: auto modules cycle 35% faster', cost: 1, req: 'turret' },
  { id: 'swarm', branch: 'ai', name: 'swarm logic', desc: 'support: sentry fires twin bolts · +15% auto rate', cost: 2, req: 'overclock' },
];

/* transit run challenge kinds — picked by the run seed */
const RUN_KINDS = ['gauntlet', 'slalom', 'hunt', 'surge'];
const KIND_CFG = {
  gauntlet: { rocks: [56, 10], gates: 8, walls: [0, 0], adds: [0, 0] },
  slalom: { rocks: [16, 3], gates: 12, walls: [6, 1], adds: [0, 0] },
  hunt: { rocks: [14, 2], gates: 9, walls: [0, 0], adds: [3, 0.5] },
  surge: { rocks: [34, 6], gates: 11, walls: [2, 0.5], adds: [0, 0] },
};

const store = {
  visited() {
    try {
      return new Set(JSON.parse(localStorage.getItem(VISITED_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  },
  visit(slug) {
    const v = this.visited();
    const fresh = !v.has(slug);
    v.add(slug);
    try {
      localStorage.setItem(VISITED_KEY, JSON.stringify([...v]));
    } catch {}
    return fresh;
  },
  scrap(delta = 0) {
    let n = 0;
    try {
      n = Math.max(0, (parseInt(localStorage.getItem(SCRAP_KEY) ?? '0', 10) || 0) + delta);
      localStorage.setItem(SCRAP_KEY, String(n));
    } catch {}
    return n;
  },
  owned() {
    try {
      const ids = new Set(JSON.parse(localStorage.getItem(TREE_KEY) ?? '[]'));
      return new Set(TREE.filter((n) => ids.has(n.id)).map((n) => n.id));
    } catch {
      return new Set();
    }
  },
  own(id) {
    const o = this.owned();
    o.add(id);
    try {
      localStorage.setItem(TREE_KEY, JSON.stringify([...o]));
    } catch {}
  },
  resetTree() {
    try {
      localStorage.setItem(TREE_KEY, '[]');
    } catch {}
  },
  runLevel(delta = 0) {
    let n = 0;
    try {
      n = Math.max(0, (parseInt(localStorage.getItem(RUNLVL_KEY) ?? '0', 10) || 0) + delta);
      if (delta) localStorage.setItem(RUNLVL_KEY, String(n));
    } catch {}
    return n;
  },
  best(score = 0) {
    let b = 0;
    try {
      b = parseInt(localStorage.getItem(BEST_KEY) ?? '0', 10) || 0;
      if (score > b) {
        b = score;
        localStorage.setItem(BEST_KEY, String(b));
      }
    } catch {}
    return b;
  },
  muted(set) {
    try {
      if (set !== undefined) localStorage.setItem(MUTE_KEY, set ? '1' : '');
      return !!localStorage.getItem(MUTE_KEY);
    } catch {
      return false;
    }
  },
  shipState(state) {
    try {
      if (state === undefined) return JSON.parse(sessionStorage.getItem(SHIP_KEY) ?? 'null');
      if (state === null) sessionStorage.removeItem(SHIP_KEY);
      else sessionStorage.setItem(SHIP_KEY, JSON.stringify(state));
    } catch {}
    return null;
  },
};

const slugOf = (href) => href?.match(/\/posts\/([^/]+)\/?/)?.[1] ?? null;

/* deterministic helpers: orbit layout and transit tunnels must look the
   same on every visit, so everything seeds from strings, not Math.random */
const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const hash01 = (s) => hash32(s) / 4294967296;
const mulberry = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const UP = new THREE.Vector3(0, 1, 0);

/* ----- synth SFX: tiny WebAudio instruments, no assets ----- */

function makeAudio() {
  let ctx = null;
  let master = null;
  let thrustGain = null;
  let thrustFilter = null;
  let muted = store.muted();

  const ensure = () => {
    if (!ctx) {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.3;
      master.connect(ctx.destination);
      /* engine bed: looping noise through a lowpass; gain rides the throttle */
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      thrustFilter = ctx.createBiquadFilter();
      thrustFilter.type = 'lowpass';
      thrustFilter.frequency.value = 220;
      thrustGain = ctx.createGain();
      thrustGain.gain.value = 0;
      src.connect(thrustFilter).connect(thrustGain).connect(master);
      src.start();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  };

  /* one enveloped oscillator, freq gliding f0 → f1 over dur seconds */
  const blip = (type, f0, f1, dur, vol, at = 0) => {
    if (!ctx || muted) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  };

  /* filtered noise burst (explosions, impacts) */
  const burst = (dur, freq, vol) => {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.2), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
  };

  return {
    unlock: ensure,
    muted: () => muted,
    setMuted(m) {
      muted = m;
      store.muted(m);
      if (master) master.gain.value = m ? 0 : 0.3;
    },
    laser: () => blip('square', 920, 180, 0.09, 0.16),
    elaser: () => blip('sawtooth', 340, 90, 0.14, 0.12),
    missile: () => {
      blip('sawtooth', 140, 620, 0.4, 0.12);
      burst(0.3, 900, 0.06);
    },
    boom: (big) => burst(big ? 0.55 : 0.28, big ? 320 : 600, big ? 0.4 : 0.22),
    hit: () => {
      blip('square', 120, 50, 0.16, 0.3);
      burst(0.12, 500, 0.15);
    },
    tick: () => blip('square', 1400, 1400, 0.035, 0.07),
    parry: () => blip('square', 420, 1680, 0.14, 0.2),
    pickup: () => blip('triangle', 660, 1320, 0.12, 0.16),
    dock: () => {
      blip('triangle', 523, 523, 0.1, 0.14);
      blip('triangle', 784, 784, 0.14, 0.14, 0.09);
    },
    chime: () => {
      blip('triangle', 523, 523, 0.09, 0.15);
      blip('triangle', 659, 659, 0.09, 0.15, 0.08);
      blip('triangle', 988, 988, 0.16, 0.15, 0.16);
    },
    portal: () => {
      blip('sawtooth', 80, 640, 0.7, 0.18);
      burst(0.6, 400, 0.12);
    },
    boss: () => {
      blip('sawtooth', 70, 45, 0.8, 0.3);
      blip('sawtooth', 92, 60, 0.8, 0.2, 0.05);
    },
    thrust(on, boost) {
      if (!ctx || !thrustGain) return;
      thrustGain.gain.setTargetAtTime(on ? (boost ? 0.34 : 0.16) : 0, ctx.currentTime, 0.09);
      thrustFilter.frequency.setTargetAtTime(boost ? 520 : 220, ctx.currentTime, 0.12);
    },
    dispose() {
      try {
        ctx?.close();
      } catch {}
      ctx = null;
    },
  };
}

/* ----- DOM data: the post list is the single source of truth ----- */

function readPosts() {
  return [...document.querySelectorAll('.post-list .post-row')].map((row) => {
    const titleEl = row.querySelector('.title');
    const clone = titleEl.cloneNode(true);
    clone.querySelector('.draft-badge')?.remove();
    return {
      href: row.getAttribute('href'),
      slug: slugOf(row.getAttribute('href')),
      title: clone.textContent.trim().replace(/\s+/g, ' '),
      desc: row.querySelector('.desc')?.textContent.trim() ?? '',
      date: row.querySelector('time')?.textContent.trim() ?? '',
      moons: 1 + ((row.querySelector('.desc')?.textContent.length ?? 0) % 3),
      draft: !!titleEl.querySelector('.draft-badge'),
    };
  });
}

/* ----- textures & materials ----- */

/* nameplate sprite: dark backing plate so the bloom pass can't smear the
   glyphs; the frame loop scales these with distance so they read from
   anywhere in the system */
function textSprite(lines, { color = '#46ffa0' } = {}) {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.textAlign = 'center';

  ctx.font = '150px VT323, monospace';
  const w1 = ctx.measureText(lines[0]).width;
  ctx.font = '84px VT323, monospace';
  const w2 = lines[1] ? ctx.measureText(lines[1]).width : 0;
  const plateW = Math.min(1980, Math.max(w1, w2) + 120);
  const plateH = lines[1] ? 330 : 220;
  const px = (2048 - plateW) / 2;
  const py = (512 - plateH) / 2;

  ctx.fillStyle = 'rgba(2, 12, 8, 0.86)';
  ctx.fillRect(px, py, plateW, plateH);
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.strokeRect(px, py, plateW, plateH);

  ctx.fillStyle = '#eafff2';
  ctx.font = '150px VT323, monospace';
  ctx.fillText(lines[0], 1024, py + 150, plateW - 90);
  if (lines[1]) {
    ctx.fillStyle = color;
    ctx.font = '84px VT323, monospace';
    ctx.fillText(lines[1], 1024, py + 262, plateW - 90);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  s.scale.set(28, 7, 1);
  return s;
}

/* glow sprites recur constantly (ship parts, missiles, halos, portals) —
   cache one texture per color for the page lifetime; disposal skips them */
const GLOW_CACHE = new Map();
function glowTexture(color) {
  if (GLOW_CACHE.has(color)) return GLOW_CACHE.get(color);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, color);
  g.addColorStop(0.25, color + '55');
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.shared = true;
  GLOW_CACHE.set(color, tex);
  return tex;
}

/* dispose a subtree's GPU resources, skipping shared/cached maps+materials */
function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.userData?.shared) continue;
      if (!m.map?.userData?.shared) m.map?.dispose?.();
      m.dispose?.();
    }
  });
}

function wireMat(color, opacity = 0.55) {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

/* ----- scene furniture ----- */

function makeStars(count, inner, outer) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = inner + Math.random() * (outer - inner);
    const a = Math.random() * Math.PI * 2;
    const b = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(b) * Math.cos(a);
    pos[i * 3 + 1] = r * Math.cos(b) * 0.7;
    pos[i * 3 + 2] = r * Math.sin(b) * Math.sin(a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    g,
    new THREE.PointsMaterial({
      color: 0x9fffd0,
      size: 1.15,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function makeGrid() {
  const grid = new THREE.GridHelper(900, 70, GREEN_DIM, GREEN_DIM);
  grid.material.transparent = true;
  grid.material.opacity = 0.13;
  grid.material.depthWrite = false;
  grid.position.y = -42;
  return grid;
}

function makeCore(scale = 1) {
  const core = new THREE.Group();
  const outer = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(9 * scale, 1)),
    wireMat(GREEN, 0.5),
  );
  const inner = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(4.5 * scale, 0)),
    wireMat(MAGENTA, 0.6),
  );
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture('#46ffa0'),
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  halo.scale.setScalar(46 * scale);
  core.add(outer, inner, halo);
  core.userData = { outer, inner };
  return core;
}

/* ----- the ship: hull built from installed mods (loud, visible parts) ----- */

function makeShip(mods) {
  const ship = new THREE.Group();
  const hull = new THREE.Group();
  const gold = mods.has('reactor');
  const swept = mods.has('gyro');

  const fuselage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.ConeGeometry(0.55, 2.4, 4)),
    wireMat(gold ? AMBER : GREEN, 0.95),
  );
  fuselage.rotation.x = -Math.PI / 2; // nose toward -z
  hull.add(fuselage);

  if (gold) {
    /* gilded trim: a second, larger outline shell */
    const trim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.ConeGeometry(0.72, 2.85, 4)),
      wireMat(AMBER, 0.4),
    );
    trim.rotation.x = -Math.PI / 2;
    hull.add(trim);
  }

  /* wings: stock delta vs swept blades with winglets */
  const tipX = swept ? 3.1 : 1.9;
  const wing = (sx) =>
    new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        swept
          ? [
              new THREE.Vector3(sx * 3.1, -0.12, 1.9),
              new THREE.Vector3(sx * 0.3, 0, -1.05),
              new THREE.Vector3(sx * 0.3, 0, 1.2),
            ]
          : [
              new THREE.Vector3(sx * 1.9, -0.08, 1.0),
              new THREE.Vector3(sx * 0.25, 0, -0.7),
              new THREE.Vector3(sx * 0.25, 0, 1.05),
            ],
      ),
      wireMat(MAGENTA, 0.95),
    );
  hull.add(wing(1), wing(-1));

  if (swept) {
    for (const sx of [1, -1]) {
      const fin = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(sx * 3.1, -0.12, 1.9),
          new THREE.Vector3(sx * 3.1, 0.75, 2.15),
          new THREE.Vector3(sx * 3.1, -0.12, 2.35),
        ]),
        wireMat(MAGENTA, 0.85),
      );
      hull.add(fin);
    }
  }

  /* exhaust: stock single magenta glow; afterburner = twin amber nozzles */
  const exhaust = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(mods.has('burner') ? '#ffc46a' : '#ff5fd2'),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  exhaust.position.set(0, 0, 1.7);
  exhaust.scale.setScalar(mods.has('burner') ? 4 : 2.2);
  hull.add(exhaust);

  if (mods.has('burner')) {
    for (const sx of [1, -1]) {
      const nozzle = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.ConeGeometry(0.26, 0.7, 6)),
        wireMat(AMBER, 0.9),
      );
      nozzle.rotation.x = Math.PI / 2; // opening backwards
      nozzle.position.set(sx * 0.42, 0, 1.35);
      hull.add(nozzle);
    }
  }

  /* twin cannons: real barrels with glowing muzzle tips */
  const muzzles = [];
  if (mods.has('twin')) {
    for (const sx of [1, -1]) {
      const bx = sx * tipX * 0.78;
      const barrel = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.2, 0.2, 1.7)),
        wireMat(CYAN, 1),
      );
      barrel.position.set(bx, 0.05, 0.1);
      const tip = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture('#6ad8ff'),
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      tip.scale.setScalar(0.85);
      tip.position.set(bx, 0.05, -0.85);
      hull.add(barrel, tip);
      muzzles.push(new THREE.Vector3(bx, 0.05, -0.95));
    }
  } else {
    muzzles.push(new THREE.Vector3(0, -0.1, -1.4));
  }

  /* missile pods: under-wing racks with visible warhead glows */
  if (mods.has('pods')) {
    for (const sx of [1, -1]) {
      const rack = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.5, 0.34, 1.45)),
        wireMat(AMBER, 0.95),
      );
      rack.position.set(sx * 1.05, -0.34, 0.5);
      hull.add(rack);
      for (let k = 0; k < 3; k++) {
        const warhead = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: glowTexture('#ffc46a'),
            transparent: true,
            opacity: 0.85,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        warhead.scale.setScalar(0.4);
        warhead.position.set(sx * 1.05 - 0.13 + k * 0.13, -0.34, -0.28);
        hull.add(warhead);
      }
    }
  }

  /* sentry turret: a dorsal mount — twin barrels with swarm logic */
  if (mods.has('turret')) {
    const base = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(0.36, 0.3, 0.36)),
      wireMat(CYAN, 0.95),
    );
    base.position.set(0, 0.6, 0.45);
    hull.add(base);
    const barrels = mods.has('swarm') ? [-0.14, 0.14] : [0];
    for (const bx of barrels) {
      const barrel = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(0.09, 0.09, 0.95)),
        wireMat(mods.has('igniter') ? AMBER : CYAN, 1),
      );
      barrel.position.set(bx, 0.74, 0.05);
      hull.add(barrel);
    }
  }

  /* deflector: two crossed rings, animated */
  const shieldRings = [];
  if (mods.has('shield')) {
    for (const rx of [Math.PI / 2, 0.35]) {
      const ring = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.TorusGeometry(2.6, 0.025, 3, 56)),
        wireMat(CYAN, 0.4),
      );
      ring.rotation.x = rx;
      hull.add(ring);
      shieldRings.push(ring);
    }
  }

  ship.add(hull);
  ship.scale.setScalar(1.35); // presence — the parts must read from the chase cam
  ship.userData = { exhaust, hull, muzzles, shieldRings };
  return ship;
}

/* ----- interceptors & the warden: magenta hunters ----- */

function makeEnemyCraft(scale = 1) {
  const e = new THREE.Group();
  const body = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.ConeGeometry(0.9 * scale, 3.4 * scale, 3)),
    wireMat(MAGENTA, 0.95),
  );
  body.rotation.x = -Math.PI / 2;
  const ring = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.TorusGeometry(1.6 * scale, 0.03 * scale, 3, 24)),
    wireMat(MAGENTA, 0.5),
  );
  ring.rotation.x = Math.PI / 2;
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture('#ff5fd2'),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.scale.setScalar(5 * scale);
  e.add(body, ring, glow);

  /* inline hp bar: a fixed dark backing and a left-anchored fill whose
     x-scale IS the health fraction — no canvas redraws, ever */
  const w = 3.4 * scale;
  const bg = new THREE.Sprite(
    new THREE.SpriteMaterial({ color: 0x140a12, transparent: true, opacity: 0.78, depthWrite: false, depthTest: false }),
  );
  bg.scale.set(w, 0.3 * Math.max(1, scale * 0.6), 1);
  bg.position.y = 2.6 * scale;
  bg.renderOrder = 7;
  const fill = new THREE.Sprite(
    new THREE.SpriteMaterial({ color: MAGENTA, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false }),
  );
  fill.center.set(0, 0.5); // anchor left so it drains rightward
  fill.scale.set(w, 0.22 * Math.max(1, scale * 0.6), 1);
  fill.position.set(-w / 2, 2.6 * scale, 0);
  fill.renderOrder = 8;
  e.add(bg, fill);
  e.hpBar = { fill, w }; // not userData — callers overwrite that wholesale
  return e;
}

/* keep an enemy's inline bar in sync — call from its update loop */
const syncHpBar = (e) => {
  const u = e.userData;
  if (!e.hpBar || u?.hp === undefined) return;
  const frac = THREE.MathUtils.clamp(u.hp / (u.hpMax ?? u.hp ?? 1), 0, 1);
  e.hpBar.fill.scale.x = Math.max(0.001, e.hpBar.w * frac);
};

/* ----- portals: rings at the system edge that open transit runs ----- */

function makePortal(idx) {
  const g = new THREE.Group();
  const ring = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.TorusGeometry(11, 0.35, 4, 48)),
    wireMat(CYAN, 0.9),
  );
  const inner = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.TorusGeometry(7.5, 0.12, 3, 40)),
    wireMat(MAGENTA, 0.7),
  );
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture('#6ad8ff'),
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.scale.setScalar(34);
  g.add(ring, inner, glow);
  /* the label is level-aware — relabelPortals() owns it */
  g.userData = { ring, inner, label: null, idx };
  return g;
}

/* ----- asteroids ----- */

function jitter(geo, seed) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const h = Math.abs(Math.sin(x * 12.9 + y * 78.2 + z * 37.7 + seed) * 43758.5) % 1;
    const s = 0.78 + h * 0.5;
    p.setXYZ(i, x * s, y * s, z * s);
  }
  p.needsUpdate = true;
  return geo;
}

/* ----- HUD ----- */

const HELP_WORLD =
  'mouse aim · W thrust · shift boost · space fire · E missile · Q parry · S brake · T tree · M sound · esc release';
const HELP_RUN =
  'steer across the tube · shift boost · S brake · space fire · E missile · Q parry';
const HELP_ARENA = 'free flight — bring the warden down · space fire · E missile · Q parry';

function makeHud(n) {
  const hud = document.createElement('div');
  hud.className = 'vector-hud';
  hud.innerHTML = `
    <div class="vh-cross" aria-hidden="true"></div>
    <div class="vh-bars" aria-hidden="true">
      <div class="vh-bar-row"><span>hull</span><div class="vh-bar"><i data-vh-hp style="width:100%"></i></div></div>
      <div class="vh-bar-row" data-vh-shield-row hidden><span>shield</span><div class="vh-bar shield"><i data-vh-shield style="width:100%"></i></div><em data-vh-charges></em></div>
      <div class="vh-bar-row"><span>boost</span><div class="vh-bar boost"><i data-vh-boost style="width:100%"></i></div></div>
      <div class="vh-stats" data-vh-stats></div>
    </div>
    <div class="vh-top" data-vh-top aria-hidden="true">system xandreed · ${n} planets</div>
    <div class="vh-boss" data-vh-boss hidden aria-hidden="true"><span data-vh-boss-name>⌬ THE WARDEN</span><div><i data-vh-boss-fill></i></div></div>
    <div class="vh-corner">
      <button type="button" data-vh-tree-btn>⬡ tree</button>
      <button type="button" data-vh-mute aria-label="Toggle sound"></button>
    </div>
    <div class="vh-lock" data-vh-lock aria-hidden="true"></div>
    <div class="vh-weap" data-vh-weap aria-hidden="true"></div>
    <div class="vh-toasts" data-vh-toasts aria-live="polite"></div>
    <div class="vh-dock" data-vh-dock hidden></div>
    <div class="vh-tree" data-vh-tree hidden>
      <div class="vh-tree-head"><b>⬡ ability tree</b><span data-vh-cores></span><button type="button" data-vh-tree-reset>↺ reset</button><button type="button" data-vh-tree-close>✕ close</button></div>
      <div class="vh-tree-grid" data-vh-tree-grid></div>
      <p class="vh-tree-hint">reading an article banks one ⬡ core · ↺ reset refunds everything</p>
    </div>
    <div class="vh-help" data-vh-help aria-hidden="true">${HELP_WORLD}</div>
    <div class="vh-overlay" data-vh-overlay><b>❯ take the stick</b><span>${
      coarse
        ? 'left thumb steers · ▲ engages thrust · tap a planet to read it'
        : 'click the void to fly · click a planet to read it'
    }</span></div>
    ${
      coarse
        ? `<div class="vh-stick" data-vh-stick hidden><i></i></div>
    <div class="vh-cluster" data-vh-cluster>
      <button type="button" data-vt-missile>➤ missile</button>
      <button type="button" data-vt-parry>⛨ parry</button>
      <button type="button" data-vt-boost>⚡ boost</button>
      <button type="button" data-vt-brake>■ brake</button>
      <button type="button" data-vt-thrust>▲ thrust</button>
      <button type="button" data-vt-fire>✦ fire</button>
    </div>`
        : ''
    }`;
  document.body.append(hud);

  const toasts = hud.querySelector('[data-vh-toasts]');
  hud.toast = (msg, cls = '') => {
    const t = document.createElement('div');
    t.className = `vh-toast ${cls}`;
    t.textContent = msg;
    toasts.append(t);
    setTimeout(() => t.remove(), 3000);
  };
  return hud;
}

/* ----- mount ----- */

export function mount() {
  const isWorld = location.pathname === '/' && !!document.querySelector('.post-list .post-row');
  const ac = new AbortController();
  const { signal } = ac;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.domElement.className = 'vector-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.FogExp2(BG, isWorld ? 0.0042 : 0.008);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1400);

  /* the composer bypasses the canvas's MSAA — render into a multisampled
     HDR target or every wireframe edge is a staircase */
  const pr = renderer.getPixelRatio();
  const composer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(innerWidth * pr, innerHeight * pr, {
      type: THREE.HalfFloatType,
      samples: coarse ? 2 : 4,
    }),
  );
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.05, 0.6, 0.18);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  scene.add(makeStars(isWorld ? 1600 : 900, 200, 700), makeGrid());

  let hud = null;
  let raf = 0;
  const clock = new THREE.Clock();
  let core = null;

  /* context eviction (browsers cap live WebGL contexts): pause the loop on
     loss instead of rendering a dead canvas, resume on restore */
  renderer.domElement.addEventListener(
    'webglcontextlost',
    (e) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
    },
    { signal },
  );
  renderer.domElement.addEventListener(
    'webglcontextrestored',
    () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    { signal },
  );

  const posts = isWorld ? readPosts() : [];
  const visited = store.visited();
  const owned = store.owned();
  const spent = TREE.reduce((s, n) => s + (owned.has(n.id) ? n.cost : 0), 0);
  let cores = Math.max(0, visited.size - spent);

  /* derived ship stats — recomputed in place when a tree node is bought.
     each weapon scales independently: damage, projectile speed, fire rate.
     bolt speed also inherits ship speed, and boosting raises fire rate. */
  const autoRate = () =>
    (owned.has('overclock') ? 0.65 : 1) * (owned.has('swarm') ? 0.85 : 1);
  const calcStats = () => ({
    maxHp: 100 + (owned.has('plating') ? 40 : 0),
    turn: (owned.has('gyro') ? 1.45 : 1),
    vmax: 60 + (owned.has('gyro') ? 8 : 0),
    hasBoost: owned.has('burner'), // boost is an equipped ability, not a given
    boostAcc: 86,
    fuelRegen: owned.has('burner') ? 30 : 18,
    /* the deflector depletes; it only trickles back to a third on its own —
       full restores come from reboot charges or docking */
    shieldMax: owned.has('shield') ? 35 : 0,
    shieldRegen: 4, // trickle per second, after 7s without taking a hit
    shieldChargesMax: owned.has('charges') ? 2 : 0,
    hasMissiles: owned.has('pods'), // so is the launcher
    missileCooldown: 1.6,
    missileDmg: 4,
    missileVmax: 150,
    fireDelay: owned.has('lance') ? 0.085 : owned.has('rapid') ? 0.11 : 0.15,
    boltDmg: 1 + (owned.has('velocity') ? 1 : 0) + (owned.has('lance') ? 1 : 0),
    boltSpeed: 220 + (owned.has('velocity') ? 60 : 0) + (owned.has('lance') ? 25 : 0),
    brake: owned.has('gyro') ? 4.6 : 3.2,
    parryCd: owned.has('gyro') ? 2.2 : 3.2,
    regen: owned.has('reactor') ? 2.2 : 0,
    /* ai modules — support nodes shorten every auto cycle */
    hasTurret: owned.has('turret'),
    hasIgnite: owned.has('igniter'),
    hasAutoMissile: owned.has('automl'),
    turretRate: 1.7 * autoRate(),
    turretBurst: owned.has('swarm') ? 2 : 1,
    autoMissileRate: 7 * autoRate(),
  });
  const stats = calcStats();

  /* live state */
  const planets = [];
  const hitTargets = [];
  const asteroids = [];
  const enemies = [];
  const portals = [];
  const bolts = [];
  const ebolts = [];
  const missiles = [];
  const booms = [];
  let worldGroup = null;
  let routeCurve = null;
  let routeDots = null;
  let ship = null;
  const vel = new THREE.Vector3();
  let hp = stats.maxHp;
  let shield = stats.shieldMax;
  let shieldHitT = 99; // seconds since the shield last took a hit
  let shieldCharges = stats.shieldChargesMax;
  let shieldRebootT = 0; // counts down to a charge-powered full restart
  let autoT = 1.5; // sentry turret cycle
  let amlT = 3; // missile autoloader cycle
  let amlSide = 1;
  let fuel = 100;
  let scrap = store.scrap(0);
  let score = 0;
  let best = store.best();
  let missileCd = 0;
  let fireTimer = 0;
  let parryCd = 0;
  let parryT = 0; // active parry window remaining
  let invuln = 0;
  let shake = 0;
  let simPaused = false; // tree menu open: freeze the sim, free the mouse
  let boostHinted = false;
  let docked = -1;
  let lockTgt = null;
  let prevLock = null;
  let lockReticle = null;
  let pointerLocked = false;
  let mouseDX = 0;
  let mouseDY = 0;
  let enemyT = 22; // grace period before the first interceptor
  /* transit run state: active while flying a portal tunnel or its arena */
  const run = {
    active: false,
    idx: 0,
    level: 0,
    kind: 'gauntlet',
    phase: 'tube', // 'tube' on the rail → 'arena' free-flight boss fight
    group: null,
    curve: null,
    len: 1,
    t: 0,
    prevT: 0,
    speed: 40,
    base: 42,
    off: new THREE.Vector2(),
    offV: new THREE.Vector2(),
    rocks: [],
    boosts: [],
    walls: [],
    adds: [],
    boss: null,
    arenaC: new THREE.Vector3(),
  };
  const ARENA_R = 95;
  const audio = makeAudio();
  const keys = { thrust: false, brake: false, boost: false, fire: false, roll: 0 };
  const pointer = new THREE.Vector2(0, 0);
  const raycaster = new THREE.Raycaster();
  /* one shared missile material — missiles come and go constantly */
  const missileMat = new THREE.SpriteMaterial({
    map: glowTexture('#ffc46a'),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  missileMat.userData.shared = true;

  /* ----- builders ----- */

  /* orbit shells: six planets per shell, deterministic for any post count;
     the newest post takes the innermost slot, slug hashes jitter the rest */
  const SHELL = 6;
  const shellDist = (s) => 80 + s * 46;
  const orbitOf = (i, slug) => {
    const s = Math.floor(i / SHELL);
    const angle = (i % SHELL) * ((Math.PI * 2) / SHELL) + s * 0.9 + hash01(slug ?? String(i)) * 1.1;
    return { dist: shellDist(s), angle, y: (hash01((slug ?? String(i)) + 'y') - 0.5) * 24 };
  };

  function makePlanet(post, i) {
    const group = new THREE.Group();
    const color = post.draft ? AMBER : PALETTE[i % PALETTE.length];
    const radius = 4.6 + hash01((post.slug ?? String(i)) + 'r') * 2.8;

    const occluder = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.97, 24, 16),
      new THREE.MeshBasicMaterial({ color: BG }),
    );
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(radius, 14, 9)),
      wireMat(color, 0.55),
    );
    const ring = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.TorusGeometry(radius * 1.7, 0.04, 4, 64)),
      wireMat(i % 2 ? MAGENTA : GREEN_DIM, i % 2 ? 0.5 : 0.8),
    );
    ring.rotation.x = Math.PI / 2 + (((i * 13) % 10) - 5) * 0.06;
    group.add(occluder, wire, ring);

    const moons = [];
    for (let m = 0; m < post.moons; m++) {
      const moon = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(0.7, 6, 4)),
        wireMat(0x9fffd0, 0.5),
      );
      moon.userData = {
        orbit: radius * 2 + 2 + m * 2.2,
        speed: 0.25 + m * 0.12,
        phase: (m * Math.PI * 2) / post.moons,
      };
      group.add(moon);
      moons.push(moon);
    }

    const done = post.slug && visited.has(post.slug);
    const label = textSprite(
      [post.title, `${post.date}${post.draft ? ' · draft' : ''}${done ? ' · ✓' : ''}`],
      { color: post.draft ? '#ffc46a' : done ? '#9fffd0' : '#46ffa0' },
    );
    label.position.y = radius + 7;
    group.add(label);

    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 2.4, 8, 6),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.userData = { idx: i, href: post.href };
    group.add(hit);
    hitTargets.push(hit);

    const orb = orbitOf(i, post.slug);
    group.position.set(
      Math.cos(orb.angle) * orb.dist,
      orb.y,
      Math.sin(orb.angle) * orb.dist,
    );

    worldGroup.add(group);
    planets.push({ group, wire, ring, label, moons, post, radius });
  }

  function spawnAsteroid(awayFromShip = false) {
    const radius = 1.6 + Math.random() * 2.6;
    const geo = jitter(new THREE.IcosahedronGeometry(radius, 0), Math.random() * 100);
    const rock = new THREE.Group();
    rock.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(radius * 0.62, 8, 6),
        new THREE.MeshBasicMaterial({ color: BG }),
      ),
      new THREE.LineSegments(new THREE.WireframeGeometry(geo), wireMat(0x8de8b8, 0.5)),
    );
    const band = 105 + Math.random() * 95;
    let a = Math.random() * Math.PI * 2;
    if (awayFromShip && ship) {
      for (let tries = 0; tries < 8; tries++) {
        const p = new THREE.Vector3(Math.cos(a) * band, 0, Math.sin(a) * band);
        if (p.distanceTo(ship.position) > 90) break;
        a = Math.random() * Math.PI * 2;
      }
    }
    rock.position.set(Math.cos(a) * band, (Math.random() - 0.5) * 30, Math.sin(a) * band);
    rock.userData = {
      vel: new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(1.5 + Math.random() * 2),
      spin: new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(0.6),
      radius,
      hp: Math.ceil(radius),
    };
    worldGroup.add(rock);
    asteroids.push(rock);
  }

  function makeEboltPool(n) {
    for (let i = 0; i < n; i++) {
      const arr = new Float32Array(6);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const line = new THREE.Line(geo, wireMat(MAGENTA, 1));
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      ebolts.push({ line, arr, pos: new THREE.Vector3(), dir: new THREE.Vector3(), life: 0 });
    }
  }

  function fireEbolt(from, at, jitterAmt = 0.05) {
    const b = ebolts.find((x) => x.life <= 0);
    if (!b) return;
    b.pos.copy(from);
    b.dir
      .copy(at)
      .sub(from)
      .normalize();
    b.dir.x += (Math.random() - 0.5) * jitterAmt;
    b.dir.y += (Math.random() - 0.5) * jitterAmt;
    b.dir.z += (Math.random() - 0.5) * jitterAmt;
    b.dir.normalize();
    b.life = 2.2;
    b.reflected = false;
    b.line.material.color.set(MAGENTA);
    b.line.visible = true;
  }

  const nearestEnemy = (p) => {
    let best = null;
    let bd = Infinity;
    for (const en of enemies) {
      const d = en.position.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = en;
      }
    }
    return best;
  };

  function spawnEnemy() {
    const e = makeEnemyCraft(1);
    const a = Math.random() * Math.PI * 2;
    const d = 240 + Math.random() * 80;
    e.position.set(
      ship.position.x + Math.cos(a) * d,
      ship.position.y + (Math.random() - 0.5) * 40,
      ship.position.z + Math.sin(a) * d,
    );
    e.userData = { vel: new THREE.Vector3(), hp: 3, hpMax: 3, fireCd: 2.5, radius: 2.2 };
    worldGroup.add(e);
    enemies.push(e);
    hud?.toast('◬ interceptor inbound', 'warn');
    audio.elaser();
  }

  function makeBoltPool(n) {
    for (let i = 0; i < n; i++) {
      const arr = new Float32Array(6);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const line = new THREE.Line(geo, wireMat(GREEN, 1));
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      bolts.push({ line, arr, pos: new THREE.Vector3(), dir: new THREE.Vector3(), life: 0 });
    }
  }

  function makeBoomPool(n) {
    for (let i = 0; i < n; i++) {
      const count = 30;
      const arr = new Float32Array(count * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const mat = new THREE.PointsMaterial({
        color: AMBER,
        size: 0.9,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const points = new THREE.Points(geo, mat);
      points.visible = false;
      points.frustumCulled = false;
      scene.add(points);
      booms.push({ points, arr, vels: new Float32Array(count * 3), life: 0 });
    }
  }

  /* floating damage numbers: pooled canvas sprites, redrawn on spawn.
     depthTest off — a pop spawns at the surface of the thing it hit, so
     depth-tested sprites lose to their own target and never show */
  const pops = [];
  const popV = new THREE.Vector3();
  function makePopPool(n) {
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 80;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }),
      );
      s.renderOrder = 9;
      s.visible = false;
      scene.add(s);
      pops.push({ s, c, tex, life: 0 });
    }
  }

  function popDamage(pos, amount, color = '#eafff2') {
    const p = pops.find((x) => x.life <= 0) ?? pops[0];
    if (!p) return;
    /* collision damage is fractional (radius math) — a raw float renders
       17 digits wide and reads as a giant number */
    amount = Math.max(1, Math.round(amount));
    const ctx = p.c.getContext('2d');
    ctx.clearRect(0, 0, 160, 80);
    ctx.font = '58px VT323, monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(2, 14, 9, 0.9)';
    ctx.strokeText(String(amount), 80, 56);
    ctx.fillStyle = color;
    ctx.fillText(String(amount), 80, 56);
    p.tex.needsUpdate = true;
    /* float it toward the camera so the target's own wireframe can't sit on it */
    p.s.position.copy(pos).addScaledVector(popV.copy(camera.position).sub(pos).normalize(), 3);
    p.s.visible = true;
    p.life = 1.05;
  }

  /* plasma igniter: a burning target ticks damage over time, with a flame */
  function igniteTarget(obj) {
    const u = obj.userData;
    if (!u) return;
    u.burn = 3.2;
    u.burnAcc = u.burnAcc ?? 0;
    if (!u.burnFx) {
      const fx = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture('#ff8a4a'),
          transparent: true,
          opacity: 0.8,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      fx.scale.setScalar((u.radius ?? 2) * 2.4);
      obj.add(fx);
      u.burnFx = fx;
    }
  }

  /* parry: base ability — a timed window that throws enemy bolts back */
  function parry() {
    if (parryCd > 0 || !ship) return;
    parryCd = stats.parryCd;
    parryT = 0.4;
    audio.parry();
    for (const r of ship.userData.shieldRings ?? []) r.material.opacity = 1;
  }

  function explode(pos, color = AMBER) {
    const b = booms.find((x) => x.life <= 0) ?? booms[0];
    for (let i = 0; i < b.arr.length; i += 3) {
      b.arr[i] = pos.x;
      b.arr[i + 1] = pos.y;
      b.arr[i + 2] = pos.z;
      const v = new THREE.Vector3().randomDirection().multiplyScalar(8 + Math.random() * 20);
      b.vels[i] = v.x;
      b.vels[i + 1] = v.y;
      b.vels[i + 2] = v.z;
    }
    b.points.material.color.set(color);
    b.points.geometry.attributes.position.needsUpdate = true;
    b.points.visible = true;
    b.life = 1;
  }

  function fireLasers() {
    if (fireTimer > 0 || !ship) return;
    /* boosting overclocks the guns; bolts inherit some of the ship's speed */
    fireTimer = stats.fireDelay * (keys.boost && stats.hasBoost && keys.thrust ? 0.85 : 1);
    const shipSpeed = run.active ? run.speed : vel.length();
    const { muzzles } = ship.userData;
    /* aim: locked target with lead, else straight ahead */
    let aimPoint = null;
    if (lockTgt) {
      const d = lockTgt.position.distanceTo(ship.position);
      aimPoint = lockTgt.position.clone();
      if (lockTgt.userData.vel) aimPoint.addScaledVector(lockTgt.userData.vel, d / 220);
    }
    for (const m of muzzles) {
      const b = bolts.find((x) => x.life <= 0);
      if (!b) return;
      b.pos.copy(ship.localToWorld(m.clone()));
      if (aimPoint) b.dir.copy(aimPoint).sub(b.pos).normalize();
      else b.dir.set(0, 0, -1).applyQuaternion(ship.quaternion);
      b.speed = stats.boltSpeed + shipSpeed * 0.6;
      b.life = 1.1;
      b.dmg = stats.boltDmg;
      b.ignite = false;
      b.line.material.color.set(GREEN);
      b.line.visible = true;
    }
    audio.laser();
  }

  /* sentry turret: picks its own target, fires its own bolts (amber) */
  function pickAutoTarget() {
    const near = (list, max) => {
      let bd = max;
      let hit = null;
      for (const o of list) {
        const d = o.position.distanceTo(ship.position);
        if (d < bd) {
          bd = d;
          hit = o;
        }
      }
      return hit;
    };
    if (run.active)
      return run.boss ?? near(run.adds, 220) ?? near(run.rocks, 70);
    return near(enemies, 230) ?? near(asteroids, 110);
  }

  const turretLocal = new THREE.Vector3();
  function fireTurret(tgt) {
    for (let k = 0; k < stats.turretBurst; k++) {
      const b = bolts.find((x) => x.life <= 0);
      if (!b) return;
      b.pos.copy(ship.localToWorld(turretLocal.set(k === 0 ? -0.14 : 0.14, 0.74, -0.2)));
      b.dir.copy(tgt.position).sub(b.pos).normalize();
      b.dir.x += (Math.random() - 0.5) * 0.03;
      b.dir.y += (Math.random() - 0.5) * 0.03;
      b.dir.normalize();
      b.speed = 250;
      b.life = 1.1;
      b.dmg = 1;
      b.ignite = stats.hasIgnite;
      b.line.material.color.set(stats.hasIgnite ? AMBER : CYAN);
      b.line.visible = true;
    }
    audio.tick();
  }

  function spawnMissile(sx, target) {
    /* on the tube rail the ship's velocity lives in run.speed, not vel */
    const inherit =
      run.active && run.phase === 'tube'
        ? new THREE.Vector3(0, 0, -run.speed).applyQuaternion(ship.quaternion)
        : vel;
    const g = new THREE.Group();
    const body = new THREE.Sprite(missileMat);
    body.scale.setScalar(1.6);
    g.add(body);
    g.position.copy(ship.localToWorld(new THREE.Vector3(sx, -0.5, 0.4)));
    g.userData = {
      vel: new THREE.Vector3(sx * 6, -2, -46).applyQuaternion(ship.quaternion).add(inherit),
      target,
      life: 6,
    };
    scene.add(g);
    missiles.push(g);
  }

  function fireMissile() {
    if (!ship || missileCd > 0) return;
    if (!stats.hasMissiles) {
      hud?.toast('➤ missiles need the pods — ability tree (T)', 'warn');
      return;
    }
    if (!lockTgt) {
      hud?.toast('no lock — face a target', 'warn');
      return;
    }
    missileCd = stats.missileCooldown;
    for (const sx of [1.05, -1.05]) spawnMissile(sx, lockTgt);
    audio.missile();
  }

  function addScore(n) {
    score += n;
    if (score > best) best = store.best(score);
  }

  /* a dead burning thing takes its flame's material with it */
  function dropBurnFx(obj) {
    const u = obj.userData;
    if (u?.burnFx) {
      u.burnFx.material.dispose();
      u.burnFx = null;
    }
  }

  function killAsteroid(rock) {
    dropBurnFx(rock);
    explode(rock.position, AMBER);
    audio.boom(false);
    worldGroup.remove(rock);
    const i = asteroids.indexOf(rock);
    if (i >= 0) asteroids.splice(i, 1);
    if (lockTgt === rock) lockTgt = null;
    scrap = store.scrap(1);
    addScore(25);
    hud?.toast('+1 scrap', 'ok');
  }

  function killEnemy(e) {
    dropBurnFx(e);
    explode(e.position, '#ff5fd2');
    audio.boom(true);
    worldGroup.remove(e);
    const i = enemies.indexOf(e);
    if (i >= 0) enemies.splice(i, 1);
    if (lockTgt === e) lockTgt = null;
    scrap = store.scrap(3);
    addScore(150);
    hud?.toast('◬ interceptor down — +150 · +3 scrap', 'ok');
  }

  function damageShip(amount, sourcePos) {
    if (invuln > 0) return;
    shieldHitT = 0;
    /* the deflector eats damage first and pulses visibly */
    if (shield > 0) {
      const absorbed = Math.min(shield, amount);
      shield -= absorbed;
      amount -= absorbed;
      for (const r of ship?.userData.shieldRings ?? []) r.material.opacity = 0.95;
      if (ship) popDamage(ship.position, absorbed, '#6ad8ff');
      if (shield <= 0) {
        shieldRebootT = 3;
        hud?.toast(shieldCharges > 0 ? '⛉ shield down — rebooting' : '⛉ shield down', 'warn');
      }
      if (amount <= 0) {
        invuln = 0.35;
        shake = Math.min(1.2, shake + 0.3);
        audio.tick();
        return;
      }
    }
    hp = Math.max(0, hp - amount);
    if (ship) popDamage(ship.position, amount, '#ff7a7a');
    invuln = 0.9;
    shake = Math.min(1.2, shake + 0.7);
    audio.hit();
    /* knockback applies wherever flight is free — world and arena both */
    if (sourcePos && ship && (!run.active || run.phase === 'arena')) {
      const knock = ship.position.clone().sub(sourcePos).normalize().multiplyScalar(16);
      vel.add(knock);
    }
    if (hp <= 0) {
      explode(ship.position, '#ff5fd2');
      audio.boom(true);
      hud?.toast(`HULL BREACH — score ${score} · rebooting at the gate`, 'bad');
      if (run.active) endRun(false);
      else {
        const p0 = planets[0]?.group.position ?? new THREE.Vector3(0, 0, 90);
        ship.position.copy(p0).multiplyScalar(1.6).add(new THREE.Vector3(0, 22, 0));
        ship.lookAt(core.position);
        ship.rotateY(Math.PI);
      }
      vel.set(0, 0, 0);
      hp = stats.maxHp;
      fuel = 100;
      invuln = 2.5;
    }
  }

  /* ----- transit runs: a seeded tunnel behind each portal ----- */

  /* path frame at parameter t — shared scratch, finish reading before
     calling again */
  const tmpV3w = new THREE.Vector3(); // run-builder scratch
  const F = { tan: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
  const frameAt = (t) => {
    run.curve.getTangentAt(t, F.tan);
    F.right.crossVectors(F.tan, UP);
    if (F.right.lengthSq() < 1e-4) F.right.set(1, 0, 0);
    F.right.normalize();
    F.up.crossVectors(F.right, F.tan).normalize();
    return F;
  };

  /* a tube rock, shared by startRun's generator */
  const makeTubeRock = (radius, seed) => {
    const rock = new THREE.Group();
    rock.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(radius * 0.62, 8, 6),
        new THREE.MeshBasicMaterial({ color: BG }),
      ),
      new THREE.LineSegments(
        new THREE.WireframeGeometry(jitter(new THREE.IcosahedronGeometry(radius, 0), seed)),
        wireMat(0x8de8b8, 0.55),
      ),
    );
    return rock;
  };

  function startRun(idx) {
    const level = store.runLevel();
    const rnd = mulberry(hash32(`transit-${idx}-L${level}`));
    const kind = RUN_KINDS[Math.floor(rnd() * RUN_KINDS.length)];
    const cfg = KIND_CFG[kind];
    run.active = true;
    run.idx = idx;
    run.level = level;
    run.kind = kind;
    run.phase = 'tube';
    run.t = 0;
    run.prevT = 0;
    run.base = kind === 'surge' ? 54 : 42;
    run.speed = run.base - 2;
    run.off.set(0, 0);
    run.offV.set(0, 0);
    run.boss = null;
    run.rocks = [];
    run.boosts = [];
    run.walls = [];
    run.adds = [];
    run.group = new THREE.Group();

    /* the path wanders outward from the portal — longer at depth */
    const segs = 34 + Math.min(14, level * 2);
    const pts = [];
    const p = ship.position.clone();
    const heading = p.clone().normalize();
    for (let i = 0; i < segs; i++) {
      p.addScaledVector(heading, 46);
      heading.applyAxisAngle(UP, (rnd() - 0.5) * 0.55);
      heading.y = THREE.MathUtils.clamp(heading.y + (rnd() - 0.5) * 0.3, -0.35, 0.35);
      heading.normalize();
      pts.push(p.clone());
    }
    run.curve = new THREE.CatmullRomCurve3(pts);
    run.len = run.curve.getLength();

    /* tube rings */
    const rings = Math.min(100, 70 + level * 3);
    const ringGeo = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 25 }, (_, k) => {
        const a = (k / 24) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * 13, Math.sin(a) * 13, 0);
      }),
    );
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      const ring = new THREE.Line(
        ringGeo,
        wireMat(i % 7 === 0 ? MAGENTA : GREEN_DIM, i % 7 === 0 ? 0.55 : 0.32),
      );
      ring.position.copy(run.curve.getPointAt(t));
      ring.lookAt(run.curve.getPointAt(Math.min(1, t + 0.01)));
      run.group.add(ring);
    }

    /* obstacles: rocks floating in the tube; deeper levels set some adrift */
    const rockN = Math.min(120, cfg.rocks[0] + cfg.rocks[1] * level);
    const driftN = level >= 2 ? Math.min(14, 2 + level * 2) : 0;
    for (let i = 0; i < rockN; i++) {
      const t = 0.05 + rnd() * 0.88;
      const radius = 1.4 + rnd() * 2.2;
      const rock = makeTubeRock(radius, rnd() * 100);
      const f = frameAt(t);
      const a = rnd() * Math.PI * 2;
      const rr = rnd() * 9;
      rock.position
        .copy(run.curve.getPointAt(t))
        .addScaledVector(f.right, Math.cos(a) * rr)
        .addScaledVector(f.up, Math.sin(a) * rr);
      rock.userData = { radius, hp: Math.ceil(radius) };
      if (i < driftN)
        rock.userData.dyn = {
          t,
          x: Math.cos(a) * rr,
          y: Math.sin(a) * rr,
          vx: (rnd() - 0.5) * 7,
          vy: (rnd() - 0.5) * 7,
        };
      run.group.add(rock);
      run.rocks.push(rock);
    }

    /* walls: ring barriers with one open sector — thread the gap */
    const wallN = Math.min(14, Math.floor(cfg.walls[0] + cfg.walls[1] * level));
    for (let i = 0; i < wallN; i++) {
      const t = 0.12 + ((i + rnd() * 0.5) / wallN) * 0.78;
      const gapA = rnd() * Math.PI * 2;
      const gapW = Math.max(0.38, 0.6 - level * 0.02);
      const wall = new THREE.Group();
      for (const wr of [3.5, 6.5, 9.5, 12.2]) {
        const arc = [];
        const steps = 36;
        for (let k = 0; k <= steps; k++) {
          const a = gapA + gapW + (k / steps) * (Math.PI * 2 - gapW * 2);
          arc.push(new THREE.Vector3(Math.cos(a) * wr, Math.sin(a) * wr, 0));
        }
        wall.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc), wireMat(MAGENTA, 0.7)));
      }
      /* amber ticks mark the opening */
      for (const ga of [gapA - gapW, gapA + gapW]) {
        const tick = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(Math.cos(ga) * 3.5, Math.sin(ga) * 3.5, 0),
            new THREE.Vector3(Math.cos(ga) * 12.2, Math.sin(ga) * 12.2, 0),
          ]),
          wireMat(AMBER, 0.9),
        );
        wall.add(tick);
      }
      const f = frameAt(t);
      wall.position.copy(run.curve.getPointAt(t));
      wall.lookAt(tmpV3w.copy(wall.position).add(f.tan));
      run.group.add(wall);
      run.walls.push({ t, gapA, gapW, group: wall });
    }

    /* hunt: sentry interceptors stationed along the tube */
    const addN = Math.min(8, Math.floor(cfg.adds[0] + cfg.adds[1] * level));
    for (let i = 0; i < addN; i++) {
      const t = 0.2 + (i / Math.max(1, addN - 1)) * 0.6;
      const e = makeEnemyCraft(1);
      const f = frameAt(t);
      const a = rnd() * Math.PI * 2;
      e.position
        .copy(run.curve.getPointAt(t))
        .addScaledVector(f.right, Math.cos(a) * 7)
        .addScaledVector(f.up, Math.sin(a) * 7);
      const addHp = 3 + Math.floor(level / 2);
      e.userData = {
        vel: new THREE.Vector3(),
        hp: addHp,
        hpMax: addHp,
        fireCd: 1.2 + rnd(),
        radius: 2.2,
        station: t,
        base: e.position.clone(),
        phase: rnd() * 6,
      };
      run.group.add(e);
      run.adds.push(e);
    }

    /* boost gates: amber rings — thread them for speed, fuel and score */
    for (let i = 0; i < cfg.gates; i++) {
      const t = 0.07 + (i / cfg.gates) * 0.84 + rnd() * 0.04;
      const gate = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.TorusGeometry(4.4, 0.12, 3, 28)),
        wireMat(AMBER, 0.9),
      );
      const f = frameAt(t);
      const a = rnd() * Math.PI * 2;
      const rr = rnd() * 6;
      gate.position
        .copy(run.curve.getPointAt(t))
        .addScaledVector(f.right, Math.cos(a) * rr)
        .addScaledVector(f.up, Math.sin(a) * rr);
      gate.lookAt(run.curve.getPointAt(Math.min(1, t + 0.01)));
      gate.userData = { taken: false };
      run.group.add(gate);
      run.boosts.push(gate);
    }

    scene.add(run.group);
    worldGroup.visible = false;
    for (const b of ebolts) {
      b.life = 0;
      b.line.visible = false;
    }
    lockTgt = null;
    docked = -1;
    const dockEl = hud?.querySelector('[data-vh-dock]');
    if (dockEl) dockEl.hidden = true;
    ship.position.copy(run.curve.getPointAt(0));
    vel.set(0, 0, 0);
    /* the commands swap with the mode */
    hud?.els?.cluster?.setAttribute('data-run', '');
    if (hud?.els?.help) hud.els.help.textContent = HELP_RUN;
    audio.portal();
    hud?.toast(`⌬ L${level + 1} ${kind} — survive to the warden`, 'warn');
  }

  /* the warden waits in its own space: a caged free-flight arena past the
     tunnel mouth, not a turret duel on the rail */
  function enterArena() {
    run.phase = 'arena';
    scene.remove(run.group);
    disposeObject(run.group);
    run.rocks = [];
    run.boosts = [];
    run.walls = [];
    run.adds = [];
    run.group = new THREE.Group();
    run.arenaC.set(0, 260, 0); // worldGroup is hidden — high above its plane
    const cage = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(ARENA_R, 2)),
      wireMat(CYAN, 0.14),
    );
    const cage2 = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(ARENA_R * 0.5, 1)),
      wireMat(MAGENTA, 0.08),
    );
    cage.position.copy(run.arenaC);
    cage2.position.copy(run.arenaC);
    run.group.add(cage, cage2);
    scene.add(run.group);
    ship.position.copy(run.arenaC).add(tmpV3w.set(0, 0, ARENA_R * 0.72));
    ship.lookAt(run.arenaC);
    ship.rotateY(Math.PI); // nose is -z
    vel.set(0, 0, 0);
    run.off.set(0, 0);
    run.offV.set(0, 0);
    /* free flight again: full controls return */
    hud?.els?.cluster?.removeAttribute('data-run');
    if (hud?.els?.help) hud.els.help.textContent = HELP_ARENA;
    spawnBoss();
    audio.portal();
  }

  function spawnBoss() {
    run.boss = makeEnemyCraft(3.4);
    run.boss.position.copy(run.arenaC).add(tmpV3w.set(0, 6, -30));
    const hp = 80 + run.level * 35;
    run.boss.userData = {
      hp,
      hpMax: hp,
      vel: new THREE.Vector3(),
      fireCd: 1.6,
      phase: 0,
      mode: 'orbit',
      modeT: 4,
      addsSpawned: false,
      radius: 5,
    };
    run.group.add(run.boss);
    audio.boss();
    hud?.toast(`⌬ THE WARDEN · L${run.level + 1} — bring it down`, 'bad');
  }

  function hurtBoss(dmg, at) {
    if (!run.boss) return;
    run.boss.userData.hp -= dmg;
    explode(at ?? run.boss.position, '#ff5fd2');
    if (run.boss.userData.hp <= 0) {
      explode(run.boss.position, '#ff5fd2');
      audio.boom(true);
      endRun(true);
    }
  }

  function killAdd(e) {
    dropBurnFx(e);
    explode(e.position, '#ff5fd2');
    audio.boom(true);
    run.group?.remove(e);
    const i = run.adds.indexOf(e);
    if (i >= 0) run.adds.splice(i, 1);
    if (lockTgt === e) lockTgt = null;
    scrap = store.scrap(2);
    addScore(120);
  }

  function endRun(victory) {
    run.active = false;
    run.boss = null;
    if (run.group) {
      scene.remove(run.group);
      disposeObject(run.group);
      run.group = null;
    }
    run.rocks = [];
    run.boosts = [];
    run.walls = [];
    run.adds = [];
    for (const b of ebolts) {
      b.life = 0;
      b.line.visible = false;
    }
    for (const m of missiles) m.userData.target = null;
    lockTgt = null;
    worldGroup.visible = true;
    hud?.els?.cluster?.removeAttribute('data-run');
    if (hud?.els?.help) hud.els.help.textContent = HELP_WORLD;
    /* drop back beside the portal, pointed at the core */
    const portal = portals[run.idx];
    if (portal && ship) {
      ship.position.copy(portal.position).multiplyScalar(0.9).add(new THREE.Vector3(0, 6, 0));
      ship.lookAt(core.position);
      ship.rotateY(Math.PI);
      vel.set(0, 0, 0);
    }
    if (victory) {
      const gain = 600 + run.level * 200;
      const sc = 8 + run.level * 3;
      scrap = store.scrap(sc);
      addScore(gain);
      store.runLevel(1); // every portal gets harder from here on
      relabelPortals();
      audio.chime();
      hud?.toast(`⌬ warden L${run.level + 1} down — +${gain} · +${sc} scrap · transit level up`, 'ok');
    }
  }

  /* portal labels carry the live run level + seeded challenge kind */
  function relabelPortals() {
    const level = store.runLevel();
    for (const p of portals) {
      const rnd = mulberry(hash32(`transit-${p.userData.idx}-L${level}`));
      const kind = RUN_KINDS[Math.floor(rnd() * RUN_KINDS.length)];
      const old = p.userData.label;
      if (old) {
        p.remove(old);
        old.material.map?.dispose();
        old.material.dispose();
      }
      const label = textSprite(
        [`⌬ transit ${String(p.userData.idx + 1).padStart(2, '0')} · L${level + 1}`, `${kind} run — fly through`],
        { color: '#6ad8ff' },
      );
      label.position.y = 17;
      p.add(label);
      p.userData.label = label;
    }
  }

  /* ----- persistence & the ability tree ----- */

  function saveShip() {
    if (!isWorld || !ship || run.active) return;
    store.shipState({
      p: ship.position.toArray(),
      q: ship.quaternion.toArray(),
      v: vel.toArray(),
      hp,
      shield,
      c: shieldCharges,
      fuel,
      score,
      t: Date.now(),
    });
  }

  function rebuildShip() {
    if (!ship) return;
    const pos = ship.position.clone();
    const q = ship.quaternion.clone();
    scene.remove(ship);
    disposeObject(ship);
    ship = makeShip(owned);
    ship.position.copy(pos);
    ship.quaternion.copy(q);
    scene.add(ship);
  }

  function renderTree() {
    const grid = hud?.querySelector('[data-vh-tree-grid]');
    const coresEl = hud?.querySelector('[data-vh-cores]');
    if (!grid) return;
    if (coresEl) coresEl.textContent = `⬡ ${cores} core${cores === 1 ? '' : 's'} banked`;
    grid.innerHTML = ['offence', 'defense', 'ai']
      .map(
        (br) => `
      <div class="vh-branch">
        <h3>${br}</h3>
        ${TREE.filter((n) => n.branch === br)
          .map((n) => {
            const has = owned.has(n.id);
            const reqOk = !n.req || owned.has(n.req);
            const can = !has && reqOk && cores >= n.cost;
            const note = has
              ? '✓ installed'
              : !reqOk
                ? `needs ${TREE.find((x) => x.id === n.req)?.name}`
                : `install · ⬡ ${n.cost}`;
            return `<button type="button" class="vh-node ${has ? 'owned' : can ? 'can' : 'locked'}" data-node="${n.id}" ${can ? '' : 'disabled'}><b>${n.name}</b><span>${n.desc}</span><i>${note}</i></button>`;
          })
          .join('')}
      </div>`,
      )
      .join('');
  }

  function buyNode(id) {
    const n = TREE.find((x) => x.id === id);
    if (!n || owned.has(id) || (n.req && !owned.has(n.req)) || cores < n.cost) return;
    cores -= n.cost;
    owned.add(id);
    store.own(id);
    Object.assign(stats, calcStats());
    if (id === 'shield') shield = stats.shieldMax;
    if (id === 'charges') shieldCharges = stats.shieldChargesMax;
    rebuildShip();
    syncCluster();
    audio.chime();
    hud?.toast(`component installed: ${n.name}`, 'ok');
    renderTree();
  }

  /* respec: tear it all out, every core comes back */
  function resetTree() {
    if (!owned.size) return;
    store.resetTree();
    owned.clear();
    cores = visited.size;
    Object.assign(stats, calcStats());
    shield = 0;
    shieldCharges = 0;
    hp = Math.min(hp, stats.maxHp);
    rebuildShip();
    syncCluster();
    audio.tick();
    hud?.toast('tree reset — every ⬡ core refunded', 'ok');
    renderTree();
  }

  function toggleTree(force) {
    const panel = hud?.querySelector('[data-vh-tree]');
    if (!panel) return;
    const open = force ?? panel.hidden;
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock?.();
      renderTree();
    }
    panel.hidden = !open;
    /* menu open = sim frozen, mouse free */
    simPaused = open && isWorld;
    if (simPaused) audio.thrust(false, false);
  }

  /* equipped abilities live on the cluster buttons — disabled until owned */
  function syncCluster() {
    const c = hud?.querySelector('[data-vh-cluster]');
    if (!c) return;
    const missileBtn = c.querySelector('[data-vt-missile]');
    const boostBtn = c.querySelector('[data-vt-boost]');
    if (missileBtn) missileBtn.disabled = !stats.hasMissiles;
    if (boostBtn) boostBtn.disabled = !stats.hasBoost;
  }

  function syncMuteBtn() {
    const b = hud?.querySelector('[data-vh-mute]');
    if (b) b.textContent = audio.muted() ? '♪ off' : '♪ on';
  }

  function toggleMute() {
    audio.unlock();
    audio.setMuted(!audio.muted());
    syncMuteBtn();
    hud?.toast(audio.muted() ? 'sound off' : 'sound on');
  }

  function buildWorld() {
    worldGroup = new THREE.Group();
    scene.add(worldGroup);
    core = makeCore(1);
    worldGroup.add(core);
    /* no nameplate on the core — it isn't an article, so it shouldn't read
       like one */

    posts.forEach((p, i) => makePlanet(p, i));

    /* one orbit ring per shell */
    const shells = Math.floor(Math.max(0, posts.length - 1) / SHELL) + 1;
    for (let s = 0; s < shells; s++) {
      const dist = shellDist(s);
      const pts = [];
      for (let a = 0; a <= 128; a++) {
        const t = (a / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * dist, 0, Math.sin(t) * dist));
      }
      worldGroup.add(
        new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat(GREEN_DIM, 0.18)),
      );
    }

    const rockCount = Math.min(40, 20 + posts.length * 2);
    for (let i = 0; i < rockCount; i++) spawnAsteroid();
    makeBoltPool(30);
    makeEboltPool(20);
    makeBoomPool(8);
    makePopPool(24);

    /* chronological route: a dashed path threading the planets oldest →
       newest; flow dots drift along it showing the direction of time */
    if (planets.length > 1) {
      const stops = [...planets]
        .reverse() // posts arrive newest-first; the route reads oldest-first
        .map((pl) => pl.group.position.clone().add(new THREE.Vector3(0, pl.radius + 5, 0)));
      routeCurve = new THREE.CatmullRomCurve3(stops);
      const routeLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(routeCurve.getPoints(220)),
        new THREE.LineDashedMaterial({
          color: CYAN,
          transparent: true,
          opacity: 0.3,
          dashSize: 2.4,
          gapSize: 3.6,
          depthWrite: false,
        }),
      );
      routeLine.computeLineDistances();
      worldGroup.add(routeLine);

      const N = 80;
      const arr = new Float32Array(N * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      routeDots = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: CYAN,
          size: 1.6,
          transparent: true,
          opacity: 0.75,
          sizeAttenuation: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      routeDots.frustumCulled = false;
      /* static fill so the route reads even with reduced motion */
      for (let i = 0; i < N; i++) {
        routeCurve.getPointAt(i / (N - 1), tmpV3);
        arr[i * 3] = tmpV3.x;
        arr[i * 3 + 1] = tmpV3.y;
        arr[i * 3 + 2] = tmpV3.z;
      }
      worldGroup.add(routeDots);
    }

    /* portals out at the edge — each opens a seeded transit run */
    for (let i = 0; i < 3; i++) {
      const p = makePortal(i);
      const a = i * ((Math.PI * 2) / 3) + 0.6;
      p.position.set(Math.cos(a) * 560, 8, Math.sin(a) * 560);
      p.lookAt(0, 8, 0);
      worldGroup.add(p);
      portals.push(p);
    }
    relabelPortals();

    lockReticle = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, -1, 0),
        new THREE.Vector3(-1, 0, 0),
      ]),
      wireMat(MAGENTA, 0.95),
    );
    lockReticle.visible = false;
    lockReticle.frustumCulled = false;
    scene.add(lockReticle);

    ship = makeShip(owned);
    /* resume exactly where you left off (article round-trips, style flips);
       else spawn in orbit of the planet you just read; else at the gate */
    const saved = store.shipState();
    let placed = false;
    if (saved && Array.isArray(saved.p) && Date.now() - (saved.t ?? 0) < 45 * 60 * 1000) {
      try {
        ship.position.fromArray(saved.p);
        ship.quaternion.fromArray(saved.q);
        vel.fromArray(saved.v);
        hp = Math.min(stats.maxHp, saved.hp ?? stats.maxHp);
        shield = Math.min(stats.shieldMax, saved.shield ?? stats.shieldMax);
        shieldCharges = Math.min(stats.shieldChargesMax, saved.c ?? stats.shieldChargesMax);
        fuel = saved.fuel ?? 100;
        score = saved.score ?? 0;
        if (score > best) best = store.best(score);
        placed = true;
      } catch {
        placed = false;
      }
    }
    if (!placed) {
      let atSlug = null;
      try {
        atSlug = sessionStorage.getItem('vector-at');
      } catch {}
      const homePl = planets.find((p) => p.post.slug && p.post.slug === atSlug);
      if (homePl) {
        const out = homePl.group.position.clone().normalize();
        ship.position
          .copy(homePl.group.position)
          .addScaledVector(out, homePl.radius * 2.4 + 8)
          .add(new THREE.Vector3(0, 4, 0));
      } else {
        const p0 = planets[0]?.group.position ?? new THREE.Vector3(0, 0, 90);
        ship.position.copy(p0).multiplyScalar(1.6).add(new THREE.Vector3(0, 22, 0));
      }
      ship.lookAt(core.position);
      ship.rotateY(Math.PI);
    }
    scene.add(ship);

    /* spawn clearance: shove any rock that drifted onto the pad */
    for (const rock of asteroids) {
      const d = rock.position.distanceTo(ship.position);
      if (d < 55)
        rock.position.addScaledVector(
          rock.position.clone().sub(ship.position).normalize(),
          60 - d,
        );
    }

    camera.position
      .copy(new THREE.Vector3(0, 3.8, 15.5).applyQuaternion(ship.quaternion))
      .add(ship.position);
    camera.lookAt(ship.position);

    hud = makeHud(posts.length);
    /* cache the hot HUD nodes — the tick runs ~8×/s */
    hud.els = {
      hp: hud.querySelector('[data-vh-hp]'),
      shieldRow: hud.querySelector('[data-vh-shield-row]'),
      shield: hud.querySelector('[data-vh-shield]'),
      charges: hud.querySelector('[data-vh-charges]'),
      boost: hud.querySelector('[data-vh-boost]'),
      stats: hud.querySelector('[data-vh-stats]'),
      lock: hud.querySelector('[data-vh-lock]'),
      weap: hud.querySelector('[data-vh-weap]'),
      top: hud.querySelector('[data-vh-top]'),
      boss: hud.querySelector('[data-vh-boss]'),
      bossName: hud.querySelector('[data-vh-boss-name]'),
      bossFill: hud.querySelector('[data-vh-boss-fill]'),
      dock: hud.querySelector('[data-vh-dock]'),
      help: hud.querySelector('[data-vh-help]'),
      cluster: hud.querySelector('[data-vh-cluster]'),
      missileBtn: hud.querySelector('[data-vt-missile]'),
      parryBtn: hud.querySelector('[data-vt-parry]'),
    };
    syncCluster();
    document.documentElement.dataset.world = 'on';

    if (cores > 0)
      hud.toast(
        `⬡ ${cores} core${cores > 1 ? 's' : ''} banked — ${coarse ? 'tap ⬡ tree' : 'press T'} to install components`,
        'ok',
      );
  }

  function buildAmbient() {
    core = makeCore(0.45);
    core.position.set(14, 5, -55);
    scene.add(core);
    camera.position.set(0, 1, 16);
    camera.lookAt(0, 2, -30);
    renderer.domElement.classList.add('is-ambient');
    document.documentElement.dataset.world = 'ambient';

    /* article pages: record the visit (this is how mods unlock) + escape hatch */
    const slug = location.pathname.match(/^\/posts\/([^/]+)\/?$/)?.[1];
    if (slug) {
      try {
        sessionStorage.setItem('vector-at', slug);
      } catch {}
      if (store.visit(slug)) {
        const note = document.createElement('div');
        note.className = 'vh-toast ok vh-solo';
        note.textContent = '⬡ core banked — spend it in the ability tree back in the system';
        document.body.append(note);
        const noteT = setTimeout(() => note.remove(), 4200);
        signal.addEventListener('abort', () => {
          clearTimeout(noteT);
          note.remove();
        });
      }
    }
    const back = document.createElement('a');
    back.href = '/';
    back.className = 'vh-return';
    back.textContent = '⟵ return to system';
    document.body.append(back);
    ac.signal.addEventListener('abort', () => back.remove());
    addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') location.href = '/';
      },
      { signal },
    );
  }

  /* ----- input ----- */

  /* virtual stick (touch): the left ~60% of the screen is the stick zone —
     touch down anywhere there and drag; x/y are -1..1 steering inputs */
  const stick = { id: -1, x0: 0, y0: 0, x: 0, y: 0, live: false };
  const STICK_R = 56;

  /* per-pointer down records so taps survive multi-touch (stick + tap) */
  const downs = new Map();

  function bindWorldInput() {
    const el = renderer.domElement;
    el.style.cursor = 'crosshair';

    /* iPad / iPhone: flying must never pinch-zoom or double/triple-tap-zoom
       the page (Safari ignores the viewport meta for pinch) */
    for (const t of ['gesturestart', 'gesturechange', 'gestureend'])
      document.addEventListener(t, (e) => e.preventDefault(), { signal, passive: false });
    document.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length > 1) e.preventDefault();
      },
      { signal, passive: false },
    );
    document.addEventListener('dblclick', (e) => e.preventDefault(), { signal });

    /* the ship survives navigation: stash full state before the page goes */
    addEventListener('pagehide', saveShip, { signal });

    /* touch must never feed the mouse-follow steering — a finished tap would
       leave the ship turning toward a stale point forever */
    const setPointer = (e) => {
      if (e.pointerType === 'touch') return;
      pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    };

    const stickEl = hud?.querySelector('[data-vh-stick]');
    const stickNub = stickEl?.querySelector('i');
    const stickDown = (e) => {
      if (e.pointerType !== 'touch' || stick.id >= 0 || e.clientX > innerWidth * 0.6)
        return false;
      stick.id = e.pointerId;
      stick.x0 = e.clientX;
      stick.y0 = e.clientY;
      stick.x = stick.y = 0;
      return true;
    };
    const stickMove = (e) => {
      if (e.pointerId !== stick.id) return false;
      const dx = e.clientX - stick.x0;
      const dy = e.clientY - stick.y0;
      const len = Math.hypot(dx, dy);
      const k = len > STICK_R ? STICK_R / len : 1;
      stick.x = (dx * k) / STICK_R;
      stick.y = (dy * k) / STICK_R;
      /* only materialize the stick once it's clearly a drag, so taps stay taps */
      if (!stick.live && len > 12 && stickEl) {
        stick.live = true;
        stickEl.hidden = false;
        stickEl.style.left = `${stick.x0}px`;
        stickEl.style.top = `${stick.y0}px`;
      }
      if (stick.live && stickNub) stickNub.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
      return true;
    };
    const stickUp = (e) => {
      if (e.pointerId !== stick.id) return;
      stick.id = -1;
      stick.x = stick.y = 0;
      stick.live = false;
      if (stickEl) stickEl.hidden = true;
      if (stickNub) stickNub.style.transform = '';
    };

    /* the take-the-stick overlay is a hint, not a gate: any input dismisses
       it for good, and it fades on its own after a few seconds */
    const overlay = hud?.querySelector('[data-vh-overlay]');
    let overlayGone = false;
    const dismissOverlay = () => {
      if (overlayGone) return;
      overlayGone = true;
      overlay?.classList.add('hidden');
    };
    setTimeout(dismissOverlay, 7000);

    let everLocked = false;
    document.addEventListener(
      'pointerlockchange',
      () => {
        pointerLocked = document.pointerLockElement === el;
        hud?.classList.toggle('locked', pointerLocked);
        if (pointerLocked) {
          everLocked = true;
          dismissOverlay();
        } else {
          keys.fire = false;
          if (everLocked) hud?.toast('stick released — click the void to re-engage');
        }
      },
      { signal },
    );

    el.addEventListener(
      'mousemove',
      (e) => {
        if (pointerLocked) {
          mouseDX += THREE.MathUtils.clamp(e.movementX, -60, 60);
          mouseDY += THREE.MathUtils.clamp(e.movementY, -60, 60);
        }
      },
      { signal },
    );

    el.addEventListener(
      'pointermove',
      (e) => {
        if (stickMove(e)) return;
        setPointer(e);
        const d = downs.get(e.pointerId);
        if (d) {
          /* accumulate real distance — event counts punish 120 Hz pointers */
          d.moved += Math.hypot(e.clientX - d.lx, e.clientY - d.ly);
          d.lx = e.clientX;
          d.ly = e.clientY;
        }
      },
      { signal },
    );

    el.addEventListener(
      'pointerdown',
      (e) => {
        audio.unlock();
        setPointer(e);
        dismissOverlay();
        downs.set(e.pointerId, {
          t: performance.now(),
          x: e.clientX,
          y: e.clientY,
          lx: e.clientX,
          ly: e.clientY,
          moved: 0,
        });
        if (stickDown(e)) return;
        if (pointerLocked) {
          if (e.button === 0) keys.fire = true;
          else if (e.button === 2) fireMissile();
        }
      },
      { signal },
    );

    el.addEventListener(
      'pointerup',
      (e) => {
        stickUp(e);
        const d = downs.get(e.pointerId);
        downs.delete(e.pointerId);
        if (pointerLocked) {
          if (e.button === 0) keys.fire = false;
          return;
        }
        const quick = d && performance.now() - d.t < 350;
        const still = d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 9 && d.moved < 24;
        /* while the tree menu is open the canvas is inert: no planet nav and
           especially no pointer-lock grabbing the mouse out from the menu */
        if (quick && still && !run.active && !simPaused) {
          raycaster.setFromCamera(
            new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1),
            camera,
          );
          const hit = raycaster.intersectObjects(hitTargets, false)[0];
          if (hit) {
            location.href = hit.object.userData.href;
            return;
          }
          if (!coarse && e.pointerType !== 'touch') el.requestPointerLock?.();
        }
      },
      { signal },
    );

    el.addEventListener(
      'pointercancel',
      (e) => {
        stickUp(e);
        downs.delete(e.pointerId);
      },
      { signal },
    );

    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        dismissOverlay();
        if (!ship) return;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quaternion);
        vel.addScaledVector(fwd, -e.deltaY * 0.045);
      },
      { passive: false, signal },
    );

    addEventListener(
      'keydown',
      (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        audio.unlock();
        dismissOverlay();
        const k = e.key;
        if (['w', 'W', 'ArrowUp'].includes(k)) { keys.thrust = true; e.preventDefault(); }
        else if (['s', 'S', 'ArrowDown'].includes(k)) { keys.brake = true; e.preventDefault(); }
        else if (k === 'Shift') {
          keys.boost = true;
          if (!stats.hasBoost && !boostHinted) {
            boostHinted = true;
            hud?.toast('⚡ boost needs the afterburner — ability tree (T)', 'warn');
          }
        }
        else if (k === ' ') { keys.fire = true; e.preventDefault(); }
        else if (['e', 'E'].includes(k)) fireMissile();
        else if (['q', 'Q'].includes(k)) parry();
        else if (['t', 'T'].includes(k)) toggleTree();
        else if (['m', 'M'].includes(k)) toggleMute();
        else if (k === 'Escape') toggleTree(false);
        else if (['a', 'A', 'ArrowLeft'].includes(k)) { keys.roll = 1; e.preventDefault(); }
        else if (['d', 'D', 'ArrowRight'].includes(k)) { keys.roll = -1; e.preventDefault(); }
        else if (k === 'Enter' && docked >= 0 && document.activeElement === document.body)
          location.href = planets[docked].post.href;
      },
      { signal },
    );
    addEventListener(
      'keyup',
      (e) => {
        const k = e.key;
        if (['w', 'W', 'ArrowUp'].includes(k)) keys.thrust = false;
        else if (['s', 'S', 'ArrowDown'].includes(k)) keys.brake = false;
        else if (k === 'Shift') keys.boost = false;
        else if (k === ' ') keys.fire = false;
        else if (['a', 'A', 'ArrowLeft', 'd', 'D', 'ArrowRight'].includes(k)) keys.roll = 0;
      },
      { signal },
    );

    /* touch cluster: thrust latches (a thumb can't hold thrust AND fire),
       boost is hold-to-afterburn and forces thrust on while held */
    const bindHold = (sel, on, off) => {
      const b = hud?.querySelector(sel);
      if (!b) return;
      b.addEventListener(
        'pointerdown',
        (e) => {
          e.preventDefault();
          audio.unlock();
          dismissOverlay();
          /* explicit capture: a mouse on a touch laptop sliding off a held
             button must still deliver its pointerup here */
          try {
            b.setPointerCapture?.(e.pointerId);
          } catch {}
          on();
        },
        { signal },
      );
      b.addEventListener('pointerup', () => off?.(), { signal });
      b.addEventListener('pointercancel', () => off?.(), { signal });
    };
    const thrustBtn = hud?.querySelector('[data-vt-thrust]');
    let thrustLatch = false;
    let boostHeld = false;
    const syncDrive = () => {
      keys.thrust = thrustLatch || boostHeld;
      keys.boost = boostHeld;
      thrustBtn?.classList.toggle('on', keys.thrust);
    };
    thrustBtn?.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        dismissOverlay();
        thrustLatch = !thrustLatch;
        syncDrive();
      },
      { signal },
    );
    bindHold('[data-vt-boost]', () => { boostHeld = true; syncDrive(); }, () => { boostHeld = false; syncDrive(); });
    bindHold('[data-vt-brake]', () => (keys.brake = true), () => (keys.brake = false));
    bindHold('[data-vt-fire]', () => (keys.fire = true), () => (keys.fire = false));
    bindHold('[data-vt-missile]', () => fireMissile());
    bindHold('[data-vt-parry]', () => parry());

    hud?.querySelector('[data-vh-dock]')?.addEventListener(
      'click',
      () => {
        if (docked >= 0) location.href = planets[docked].post.href;
      },
      { signal },
    );

    /* ability tree + sound */
    hud?.querySelector('[data-vh-tree-btn]')?.addEventListener(
      'click',
      () => {
        audio.unlock();
        toggleTree();
      },
      { signal },
    );
    hud?.querySelector('[data-vh-tree]')?.addEventListener(
      'click',
      (e) => {
        const node = e.target.closest?.('[data-node]');
        if (node) buyNode(node.dataset.node);
        else if (e.target.closest?.('[data-vh-tree-reset]')) resetTree();
        else if (e.target.closest?.('[data-vh-tree-close]')) toggleTree(false);
      },
      { signal },
    );
    hud?.querySelector('[data-vh-mute]')?.addEventListener('click', toggleMute, { signal });
    syncMuteBtn();
  }

  /* ----- frame loop ----- */

  /* scratch — tmpV holds `fwd` for a whole updateWorld pass; tmpV2/tmpV3 are
     free between statements */
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpV3 = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const lookM = new THREE.Matrix4();
  let hudTimer = 0;

  /* swept collision: fast projectiles cover several units per frame, so a
     point sample tunnels straight through small targets — test the whole
     travel segment against the sphere instead */
  const segA = new THREE.Vector3();
  const segB = new THREE.Vector3();
  const segV = new THREE.Vector3();
  const sweepHit = (from, dirN, len, center, radius) => {
    segV.copy(center).sub(from);
    const t = THREE.MathUtils.clamp(segV.dot(dirN), 0, len);
    segV.addScaledVector(dirN, -t);
    return segV.lengthSq() < radius * radius;
  };

  /* free flight: steering + thrust, shared by world mode and the arena.
     Returns fwd held in tmpV — callers must respect the scratch rules. */
  function applyFreeFlight(dt) {
    /* --- steering --- */
    if (pointerLocked) {
      ship.rotateY(-mouseDX * 0.0022 * stats.turn);
      ship.rotateX(-mouseDY * 0.0019 * stats.turn);
      mouseDX = 0;
      mouseDY = 0;
    } else if (stick.id >= 0 || coarse) {
      /* virtual stick: quadratic response keeps small corrections gentle */
      const cx = stick.x * Math.abs(stick.x);
      const cy = stick.y * Math.abs(stick.y);
      ship.rotateY(-cx * 1.6 * stats.turn * dt);
      ship.rotateX(-cy * 1.25 * stats.turn * dt);
    } else {
      const dz = 0.07;
      const yawIn = Math.abs(pointer.x) > dz ? -(pointer.x - Math.sign(pointer.x) * dz) : 0;
      const pitchIn = Math.abs(pointer.y) > dz ? pointer.y - Math.sign(pointer.y) * dz : 0;
      ship.rotateY(yawIn * 1.7 * stats.turn * dt);
      ship.rotateX(pitchIn * 1.15 * stats.turn * dt);
    }
    if (keys.roll) ship.rotateZ(keys.roll * 1.6 * dt);

    /* visual bank from turn input, hull-only */
    const hull = ship.userData.hull;
    const steerX = stick.id >= 0 ? stick.x : coarse ? 0 : pointer.x;
    const bankIn = pointerLocked ? 0 : THREE.MathUtils.clamp(-steerX, -0.7, 0.7);
    hull.rotation.z = THREE.MathUtils.lerp(hull.rotation.z, bankIn, 1 - Math.exp(-dt * 4));

    /* --- thrust / boost / fuel --- */
    const fwd = tmpV.set(0, 0, -1).applyQuaternion(ship.quaternion);
    const boosting = keys.boost && stats.hasBoost && fuel > 1 && keys.thrust;
    if (boosting) fuel = Math.max(0, fuel - 34 * dt);
    else fuel = Math.min(100, fuel + stats.fuelRegen * dt);
    if (keys.thrust) vel.addScaledVector(fwd, (boosting ? stats.boostAcc : 34) * dt);
    if (keys.brake) vel.multiplyScalar(Math.exp(-dt * stats.brake));
    vel.multiplyScalar(Math.exp(-dt * 0.55));
    const vmax = boosting ? stats.vmax + 35 : stats.vmax;
    if (vel.length() > vmax) vel.setLength(vmax);
    ship.position.addScaledVector(vel, dt);
    audio.thrust(keys.thrust, boosting);
    return fwd;
  }

  /* world mode: free flight among the planets */
  function updateWorld(dt, time) {
    const fwd = applyFreeFlight(dt);

    const r = ship.position.length();
    if (r > 620) vel.addScaledVector(tmpV2.copy(ship.position).normalize(), -dt * 40);

    /* --- asteroids drift + collision --- */
    for (let ai = asteroids.length - 1; ai >= 0; ai--) {
      const rock = asteroids[ai];
      const u = rock.userData;
      rock.position.addScaledVector(u.vel, dt);
      if (!reduced) {
        rock.rotation.x += u.spin.x * dt;
        rock.rotation.y += u.spin.y * dt;
      }
      const d = rock.position.distanceTo(ship.position);
      if (d < u.radius + 1.6) {
        damageShip(10 + u.radius * 3, rock.position);
        killAsteroid(rock);
      }
    }
    if (asteroids.length < 26 && Math.random() < dt * 0.25) spawnAsteroid(true);

    /* --- interceptors: spawn pressure scales with score --- */
    const cap = score >= 900 ? 3 : score >= 250 ? 2 : score >= 60 ? 1 : 0;
    enemyT -= dt;
    if (enemyT <= 0 && enemies.length < cap) {
      spawnEnemy();
      enemyT = 14 + Math.random() * 8;
    }
    for (let ei = enemies.length - 1; ei >= 0; ei--) {
      const en = enemies[ei];
      const u = en.userData;
      const toShip = tmpV2.copy(ship.position).sub(en.position);
      const dist = toShip.length();
      toShip.normalize();
      /* chase to a standoff range, then strafe around it */
      if (dist > 55) tmpV3.copy(toShip).multiplyScalar(30);
      else tmpV3.crossVectors(toShip, UP).multiplyScalar(24).addScaledVector(toShip, -6);
      u.vel.lerp(tmpV3, 1 - Math.exp(-dt * 1.4));
      en.position.addScaledVector(u.vel, dt);
      en.lookAt(ship.position);
      en.rotateY(Math.PI); // nose is -z
      syncHpBar(en);
      u.fireCd -= dt;
      if (u.fireCd <= 0 && dist < 180) {
        u.fireCd = 1.6 + Math.random() * 0.9;
        fireEbolt(en.position, tmpV3.copy(ship.position).addScaledVector(vel, dist / 115), 0.06);
        audio.elaser();
      }
      if (dist < 3.4) {
        damageShip(16, en.position);
        killEnemy(en);
      }
    }

    /* --- auto-lock: nearest target in the forward cone (~15°) --- */
    let bestDot = 0.965;
    let bestTgt = null;
    const consider = (obj) => {
      const d = tmpV2.copy(obj.position).sub(ship.position);
      const dist = d.length();
      if (dist > 260) return;
      const s = d.normalize().dot(fwd);
      if (s > bestDot) {
        bestDot = s;
        bestTgt = obj;
      }
    };
    for (const rock of asteroids) consider(rock);
    for (const en of enemies) consider(en);
    lockTgt = bestTgt;

    /* --- planets: moons, labels, soft repulsion, docking --- */
    let nearest = -1;
    let nearestD = Infinity;
    for (let i = 0; i < planets.length; i++) {
      const pl = planets[i];
      /* constant-ish screen size for the nameplate */
      const labelD = camera.position.distanceTo(pl.group.position);
      const k = THREE.MathUtils.clamp(labelD / 55, 0.85, 3.8);
      pl.label.scale.set(38 * k, 9.5 * k, 1);
      if (!reduced) {
        pl.wire.rotation.y += dt * 0.12;
        for (const m of pl.moons) {
          const um = m.userData;
          const a = time * um.speed + um.phase;
          m.position.set(
            Math.cos(a) * um.orbit * 0.5,
            Math.sin(a * 0.7) * 1.5,
            Math.sin(a) * um.orbit * 0.5,
          );
        }
      }
      const d = pl.group.position.distanceTo(ship.position);
      if (d < pl.radius + 2.5) {
        const push = tmpV2.copy(ship.position).sub(pl.group.position).normalize();
        ship.position.copy(pl.group.position).addScaledVector(push, pl.radius + 2.5);
        vel.multiplyScalar(0.6);
      }
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
    }

    const wasDocked = docked;
    docked = nearest >= 0 && nearestD < planets[nearest].radius * 2.4 + 12 ? nearest : -1;
    if (docked >= 0) {
      hp = Math.min(stats.maxHp, hp + 9 * dt); // docking repairs
      if (stats.shieldMax) shield = Math.min(stats.shieldMax, shield + 12 * dt);
      shieldCharges = stats.shieldChargesMax; // and restocks the capacitors
    }
    if (docked !== wasDocked) {
      if (wasDocked >= 0) planets[wasDocked].ring.material.opacity = 0.5;
      const dockEl = hud?.els?.dock;
      if (docked >= 0) {
        planets[docked].ring.material.opacity = 1;
        const pl = planets[docked];
        const read = pl.post.slug && visited.has(pl.post.slug);
        audio.dock();
        if (dockEl) {
          dockEl.hidden = false;
          dockEl.innerHTML = `◉ in orbit: <b>${pl.post.title}</b><br><span>↵ read${
            read ? ' · ⬡ banked ✓' : ' · banks <b>⬡ 1 core</b> for the tree'
          } · repairs while docked</span>`;
        }
      } else if (dockEl) dockEl.hidden = true;
    }

    /* --- chronology route: dots flow oldest → newest --- */
    if (routeDots && !reduced) {
      const arr = routeDots.geometry.attributes.position.array;
      const N = arr.length / 3;
      for (let i = 0; i < N; i++) {
        const tt = (i / N + time * 0.01) % 1;
        routeCurve.getPointAt(tt, tmpV3);
        arr[i * 3] = tmpV3.x;
        arr[i * 3 + 1] = tmpV3.y;
        arr[i * 3 + 2] = tmpV3.z;
      }
      routeDots.geometry.attributes.position.needsUpdate = true;
    }

    /* --- portals: spin, labels, entry --- */
    for (let i = 0; i < portals.length; i++) {
      const p = portals[i];
      if (!reduced) {
        p.userData.ring.rotation.z += dt * 0.5;
        p.userData.inner.rotation.z -= dt * 0.9;
      }
      const pd = camera.position.distanceTo(p.position);
      const pk = THREE.MathUtils.clamp(pd / 55, 0.7, 3.4);
      p.userData.label?.scale.set(28 * pk, 7 * pk, 1);
      if (ship.position.distanceTo(p.position) < 9) {
        startRun(i);
        break;
      }
    }
  }

  /* transit run: flight is scoped to the tunnel path; inputs steer the
     lateral offset inside the tube. The arena phase hands control back to
     free flight. */
  function updateRun(dt) {
    if (run.phase === 'arena') return updateArena(dt);
    if (pointerLocked) {
      run.offV.x += mouseDX * 0.045;
      run.offV.y -= mouseDY * 0.045;
      mouseDX = 0;
      mouseDY = 0;
    } else {
      const cx = stick.id >= 0 ? stick.x * Math.abs(stick.x) : coarse ? 0 : pointer.x;
      const cy = stick.id >= 0 ? -stick.y * Math.abs(stick.y) : coarse ? 0 : pointer.y;
      run.offV.x += cx * 110 * dt;
      run.offV.y += cy * 110 * dt;
    }
    run.offV.multiplyScalar(Math.exp(-dt * 2.6));
    run.off.addScaledVector(run.offV, dt);
    if (run.off.length() > 10) {
      run.off.setLength(10);
      run.offV.multiplyScalar(0.4);
    }

    /* throttle: boost spends fuel, brake eases off, gates add bursts */
    const boosting = keys.boost && stats.hasBoost && fuel > 1;
    if (boosting) fuel = Math.max(0, fuel - 26 * dt);
    else fuel = Math.min(100, fuel + stats.fuelRegen * dt);
    run.speed = THREE.MathUtils.lerp(
      run.speed,
      boosting ? run.base + 22 + (stats.vmax - 60) : keys.brake ? 26 : run.base,
      1 - Math.exp(-dt * 1.4),
    );
    audio.thrust(true, boosting);

    run.t = Math.min(1, run.t + (run.speed / run.len) * dt);
    if (run.t >= 0.97) {
      enterArena();
      return;
    }
    const t = run.t;
    const f = frameAt(t);
    const center = run.curve.getPointAt(t, tmpV2);
    ship.position
      .copy(center)
      .addScaledVector(f.right, run.off.x)
      .addScaledVector(f.up, run.off.y);
    /* orient along the path, nudged by lateral drift; the nose is -z, so a
       camera-style lookAt matrix points it the right way */
    tmpV3
      .copy(center)
      .addScaledVector(f.tan, 30)
      .addScaledVector(f.right, run.off.x * 0.55)
      .addScaledVector(f.up, run.off.y * 0.55);
    lookM.lookAt(ship.position, tmpV3, f.up);
    ship.quaternion.slerp(tmpQ.setFromRotationMatrix(lookM), 1 - Math.exp(-dt * 8));
    const hull = ship.userData.hull;
    hull.rotation.z = THREE.MathUtils.lerp(
      hull.rotation.z,
      THREE.MathUtils.clamp(-run.offV.x * 0.06, -0.7, 0.7),
      1 - Math.exp(-dt * 4),
    );

    /* obstacles — drifters re-derive their spot from the curve each frame */
    for (let i = run.rocks.length - 1; i >= 0; i--) {
      const rock = run.rocks[i];
      const dyn = rock.userData.dyn;
      if (dyn) {
        dyn.x += dyn.vx * dt;
        dyn.y += dyn.vy * dt;
        const rr = Math.hypot(dyn.x, dyn.y);
        if (rr > 10.5) {
          const nx = dyn.x / rr;
          const ny = dyn.y / rr;
          const vd = dyn.vx * nx + dyn.vy * ny;
          if (vd > 0) {
            dyn.vx -= 2 * vd * nx;
            dyn.vy -= 2 * vd * ny;
          }
        }
        const fr = frameAt(dyn.t);
        rock.position
          .copy(run.curve.getPointAt(dyn.t, tmpV3))
          .addScaledVector(fr.right, dyn.x)
          .addScaledVector(fr.up, dyn.y);
      }
      if (!reduced) {
        rock.rotation.x += dt * 0.4;
        rock.rotation.y += dt * 0.3;
      }
      if (rock.position.distanceTo(ship.position) < rock.userData.radius + 1.7) {
        explode(rock.position, AMBER);
        audio.boom(false);
        run.group.remove(rock);
        run.rocks.splice(i, 1);
        run.offV.multiplyScalar(-0.5);
        damageShip(8 + rock.userData.radius * 2, null);
        if (!run.active) return; // died — endRun() already moved us home
      }
    }

    /* walls: crossing one means threading its open sector */
    for (const w of run.walls) {
      if (run.prevT < w.t && t >= w.t) {
        const offLen = run.off.length();
        const ang = Math.atan2(run.off.y, run.off.x);
        const diff = Math.atan2(Math.sin(ang - w.gapA), Math.cos(ang - w.gapA));
        const through = offLen >= 2.5 && Math.abs(diff) <= w.gapW;
        if (through) {
          addScore(30);
          audio.pickup();
        } else {
          explode(ship.position, '#ff5fd2');
          run.speed = Math.max(22, run.speed * 0.5);
          run.offV.multiplyScalar(-0.6);
          damageShip(14, null);
          if (!run.active) return;
        }
      }
    }
    run.prevT = t;

    /* tube sentries: hold station, bob, and open fire as you close in */
    for (let i = run.adds.length - 1; i >= 0; i--) {
      const en = run.adds[i];
      const u = en.userData;
      u.phase += dt;
      en.position.copy(u.base);
      en.position.x += Math.sin(u.phase * 1.3) * 1.6;
      en.position.y += Math.cos(u.phase * 1.1) * 1.6;
      en.lookAt(ship.position);
      en.rotateY(Math.PI); // nose is -z
      syncHpBar(en);
      const dist = en.position.distanceTo(ship.position);
      u.fireCd -= dt;
      if (u.fireCd <= 0 && t > u.station - 0.18 && t < u.station + 0.05 && dist < 220) {
        u.fireCd = 1.4 + Math.random() * 0.8;
        fireEbolt(en.position, ship.position, 0.08);
        audio.elaser();
      }
      if (dist < 3.2) {
        damageShip(14, en.position);
        killAdd(en);
        if (!run.active) return;
      }
    }

    /* boost gates */
    for (const gate of run.boosts) {
      if (gate.userData.taken) continue;
      if (gate.position.distanceTo(ship.position) < 4.6) {
        gate.userData.taken = true;
        gate.visible = false;
        run.speed = Math.min(96, run.speed + 26);
        fuel = 100;
        addScore(40);
        audio.pickup();
        hud?.toast('⚡ gate +40', 'ok');
      }
    }

    /* lock the nearest sentry ahead so missiles have something to chase */
    let bestD = 200;
    let bestA = null;
    for (const en of run.adds) {
      const d = en.position.distanceTo(ship.position);
      if (d < bestD) {
        bestD = d;
        bestA = en;
      }
    }
    lockTgt = bestA;
  }

  /* arena: free flight inside the cage; the warden orbits, charges, and
     calls escorts at half health */
  function updateArena(dt) {
    applyFreeFlight(dt);

    /* cage bounds */
    tmpV2.copy(ship.position).sub(run.arenaC);
    const cd = tmpV2.length();
    if (cd > ARENA_R - 10) {
      tmpV2.normalize();
      vel.addScaledVector(tmpV2, -dt * 70);
      if (cd > ARENA_R - 4)
        ship.position.copy(run.arenaC).addScaledVector(tmpV2, ARENA_R - 4);
    }

    const boss = run.boss;
    if (boss) {
      const u = boss.userData;
      u.phase += dt;
      u.modeT -= dt;
      if (u.modeT <= 0) {
        u.mode = u.mode === 'orbit' ? 'charge' : 'orbit';
        u.modeT = u.mode === 'charge' ? 2.2 : Math.max(2.5, 5 - run.level * 0.3);
        if (u.mode === 'charge') audio.boss();
      }
      if (u.mode === 'orbit')
        tmpV3
          .set(
            Math.sin(u.phase * 0.5) * 42,
            Math.sin(u.phase * 0.83) * 22,
            Math.cos(u.phase * 0.5) * 42,
          )
          .add(run.arenaC);
      else tmpV3.copy(ship.position);
      boss.position.lerp(tmpV3, 1 - Math.exp(-dt * (u.mode === 'charge' ? 1.7 : 0.9)));
      boss.lookAt(ship.position);
      boss.rotateY(Math.PI); // nose is -z
      syncHpBar(boss);
      u.fireCd -= dt;
      if (u.fireCd <= 0) {
        u.fireCd = Math.max(0.7, 1.5 - run.level * 0.07);
        const nb = 3 + Math.min(3, run.level);
        for (let k = 0; k < nb; k++) fireEbolt(boss.position, ship.position, 0.16);
        audio.elaser();
      }
      if (boss.position.distanceTo(ship.position) < 7) {
        damageShip(22, boss.position);
        if (!run.active) return;
      }
      if (!u.addsSpawned && u.hp <= u.hpMax * 0.5 && run.level >= 1) {
        u.addsSpawned = true;
        const n = 2 + Math.min(2, run.level - 1);
        for (let k = 0; k < n; k++) {
          const e = makeEnemyCraft(1);
          const a = (k / n) * Math.PI * 2;
          e.position.copy(run.arenaC).add(tmpV3.set(Math.cos(a) * 50, 10, Math.sin(a) * 50));
          e.userData = { vel: new THREE.Vector3(), hp: 3, hpMax: 3, fireCd: 2 + k, radius: 2.2 };
          run.group.add(e);
          run.adds.push(e);
        }
        hud?.toast('◬ escorts deployed', 'warn');
      }
      /* lock still demands facing — an unconditional boss lock would hand
         every shot perfect aim assist and melt the fight */
      tmpV2.copy(boss.position).sub(ship.position).normalize();
      tmpV3.set(0, 0, -1).applyQuaternion(ship.quaternion);
      lockTgt = tmpV2.dot(tmpV3) > 0.93 ? boss : null;
    }

    /* escorts: chase + strafe, same brain as the world interceptors */
    for (let i = run.adds.length - 1; i >= 0; i--) {
      const en = run.adds[i];
      const u = en.userData;
      const toShip = tmpV3.copy(ship.position).sub(en.position);
      const dist = toShip.length();
      toShip.normalize();
      if (dist > 45) toShip.multiplyScalar(28);
      else toShip.crossVectors(toShip, UP).multiplyScalar(22);
      u.vel.lerp(toShip, 1 - Math.exp(-dt * 1.3));
      en.position.addScaledVector(u.vel, dt);
      en.lookAt(ship.position);
      en.rotateY(Math.PI);
      syncHpBar(en);
      u.fireCd -= dt;
      if (u.fireCd <= 0 && dist < 150) {
        u.fireCd = 1.8 + Math.random();
        fireEbolt(en.position, ship.position, 0.07);
        audio.elaser();
      }
      if (dist < 3.4) {
        damageShip(14, en.position);
        killAdd(en);
        if (!run.active) return;
      }
    }
  }

  /* systems that run in both modes: weapons, projectiles, fx, camera, HUD */
  function updateShared(dt, time) {
    invuln = Math.max(0, invuln - dt);
    fireTimer = Math.max(0, fireTimer - dt);
    missileCd = Math.max(0, missileCd - dt);
    parryCd = Math.max(0, parryCd - dt);
    parryT = Math.max(0, parryT - dt);
    if (stats.regen) hp = Math.min(stats.maxHp, hp + stats.regen * dt);
    if (stats.shieldMax) {
      shieldHitT += dt;
      if (shield <= 0 && shieldCharges > 0) {
        /* a capacitor charge reboots the broken shield to full */
        shieldRebootT -= dt;
        if (shieldRebootT <= 0) {
          shieldCharges--;
          shield = stats.shieldMax;
          audio.chime();
          hud?.toast('⛉ shield rebooted', 'ok');
          for (const r of ship.userData.shieldRings ?? []) r.material.opacity = 1;
        }
      } else if (shieldHitT > 7 && shield < stats.shieldMax / 3) {
        /* on its own it only trickles back to a third — that's the deal */
        shield = Math.min(stats.shieldMax / 3, shield + stats.shieldRegen * dt);
      }
    }

    /* invulnerability blink */
    const hull = ship.userData.hull;
    hull.visible = invuln <= 0 || Math.sin(time * 24) > -0.2;

    const ex = ship.userData.exhaust;
    const exOn = run.active || keys.thrust;
    const exHot =
      stats.hasBoost &&
      (run.active ? keys.boost && fuel > 1 : keys.boost && keys.thrust && fuel > 1);
    ex.material.opacity = THREE.MathUtils.lerp(
      ex.material.opacity,
      exOn ? (exHot ? 1 : 0.85) + Math.sin(time * 30) * 0.1 : 0,
      1 - Math.exp(-dt * 10),
    );
    if (ship.userData.shieldRings.length) {
      for (const ring of ship.userData.shieldRings)
        ring.material.opacity = THREE.MathUtils.lerp(
          ring.material.opacity,
          0.4,
          1 - Math.exp(-dt * 3),
        );
      if (!reduced) {
        ship.userData.shieldRings[0].rotation.z += dt * 0.8;
        ship.userData.shieldRings[1].rotation.y += dt * 0.55;
      }
    }

    if (keys.fire) fireLasers();

    /* --- ai modules: they run themselves --- */
    if (stats.hasTurret) {
      autoT -= dt;
      if (autoT <= 0) {
        const tgt = pickAutoTarget();
        if (tgt) {
          autoT = stats.turretRate;
          fireTurret(tgt);
        } else autoT = 0.35; // nothing in range — rescan soon
      }
    }
    if (stats.hasAutoMissile) {
      amlT -= dt;
      if (amlT <= 0) {
        const tgt = run.active
          ? (run.boss ?? run.adds[0] ?? null)
          : nearestEnemy(ship.position);
        if (tgt && tgt.position.distanceTo(ship.position) < 260) {
          amlT = stats.autoMissileRate;
          amlSide = -amlSide;
          spawnMissile(amlSide * 1.05, tgt);
          audio.missile();
        } else amlT = 0.6;
      }
    }

    /* burning targets tick damage over time */
    const tickBurn = (obj, applyDmg) => {
      const u = obj.userData;
      if (!u || !(u.burn > 0)) return;
      u.burn -= dt;
      u.burnAcc = (u.burnAcc ?? 0) + 2.4 * dt;
      if (u.burnFx) u.burnFx.material.opacity = 0.55 + Math.sin(time * 18) * 0.3;
      if (u.burnAcc >= 1) {
        const d = Math.floor(u.burnAcc);
        u.burnAcc -= d;
        popDamage(obj.position, d, '#ff8a4a');
        applyDmg(d);
      }
      if (u.burn <= 0 && u.burnFx) {
        obj.remove(u.burnFx);
        u.burnFx.material.dispose();
        u.burnFx = null;
      }
    };
    if (run.active) {
      if (run.boss) tickBurn(run.boss, (d) => hurtBoss(d, null));
      for (let i = run.adds.length - 1; i >= 0; i--) {
        const e = run.adds[i];
        tickBurn(e, (d) => {
          e.userData.hp -= d;
          if (e.userData.hp <= 0) killAdd(e);
        });
      }
      for (let i = run.rocks.length - 1; i >= 0; i--) {
        const r = run.rocks[i];
        tickBurn(r, (d) => {
          r.userData.hp -= d;
          if (r.userData.hp <= 0) {
            explode(r.position, AMBER);
            audio.boom(false);
            run.group?.remove(r);
            run.rocks.splice(i, 1);
            addScore(10);
          }
        });
      }
    } else {
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        tickBurn(e, (d) => {
          e.userData.hp -= d;
          if (e.userData.hp <= 0) killEnemy(e);
        });
      }
      for (let i = asteroids.length - 1; i >= 0; i--) {
        const r = asteroids[i];
        tickBurn(r, (d) => {
          r.userData.hp -= d;
          if (r.userData.hp <= 0) killAsteroid(r);
        });
      }
    }

    /* player bolts — per-weapon damage, swept collision, both modes */
    for (const b of bolts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const step = (b.speed ?? 220) * dt;
      segA.copy(b.pos);
      b.pos.addScaledVector(b.dir, step);
      b.arr[0] = b.pos.x - b.dir.x * 2.4;
      b.arr[1] = b.pos.y - b.dir.y * 2.4;
      b.arr[2] = b.pos.z - b.dir.z * 2.4;
      b.arr[3] = b.pos.x;
      b.arr[4] = b.pos.y;
      b.arr[5] = b.pos.z;
      b.line.geometry.attributes.position.needsUpdate = true;
      if (b.life <= 0) {
        b.line.visible = false;
        continue;
      }
      let consumed = false;
      const dmg = b.dmg ?? stats.boltDmg;
      const rocks = run.active ? run.rocks : asteroids;
      for (let ai = rocks.length - 1; ai >= 0; ai--) {
        const rock = rocks[ai];
        if (sweepHit(segA, b.dir, step, rock.position, rock.userData.radius + 0.9)) {
          consumed = true;
          rock.userData.hp -= dmg;
          popDamage(b.pos, dmg);
          if (b.ignite) igniteTarget(rock);
          if (rock.userData.hp <= 0) {
            if (run.active) {
              explode(rock.position, AMBER);
              audio.boom(false);
              run.group?.remove(rock);
              run.rocks.splice(ai, 1);
              addScore(10);
            } else killAsteroid(rock);
          } else explode(b.pos, '#46ffa0');
          break;
        }
      }
      if (!consumed && run.active) {
        if (run.boss && sweepHit(segA, b.dir, step, run.boss.position, 5.4)) {
          consumed = true;
          popDamage(b.pos, dmg);
          if (b.ignite) igniteTarget(run.boss);
          hurtBoss(dmg, b.pos);
        } else {
          for (let ei = run.adds.length - 1; ei >= 0; ei--) {
            const en = run.adds[ei];
            if (sweepHit(segA, b.dir, step, en.position, 2.8)) {
              consumed = true;
              en.userData.hp -= dmg;
              popDamage(b.pos, dmg);
              if (b.ignite) igniteTarget(en);
              if (en.userData.hp <= 0) killAdd(en);
              else explode(b.pos, '#ff5fd2');
              break;
            }
          }
        }
      } else if (!consumed) {
        for (let ei = enemies.length - 1; ei >= 0; ei--) {
          const en = enemies[ei];
          if (sweepHit(segA, b.dir, step, en.position, 2.8)) {
            consumed = true;
            en.userData.hp -= dmg;
            popDamage(b.pos, dmg);
            if (b.ignite) igniteTarget(en);
            if (en.userData.hp <= 0) killEnemy(en);
            else explode(b.pos, '#ff5fd2');
            break;
          }
        }
      }
      if (consumed) {
        b.life = 0;
        b.line.visible = false;
      }
    }

    /* enemy bolts — swept against the ship */
    for (const b of ebolts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const step = 115 * dt;
      segA.copy(b.pos);
      b.pos.addScaledVector(b.dir, step);
      b.arr[0] = b.pos.x - b.dir.x * 2;
      b.arr[1] = b.pos.y - b.dir.y * 2;
      b.arr[2] = b.pos.z - b.dir.z * 2;
      b.arr[3] = b.pos.x;
      b.arr[4] = b.pos.y;
      b.arr[5] = b.pos.z;
      b.line.geometry.attributes.position.needsUpdate = true;
      if (b.life <= 0) {
        b.line.visible = false;
        continue;
      }
      if (b.reflected) {
        /* a parried bolt hunts its makers */
        if (run.active) {
          if (run.boss && sweepHit(segA, b.dir, step, run.boss.position, 5.4)) {
            b.life = 0;
            b.line.visible = false;
            popDamage(b.pos, 5, '#6ad8ff');
            hurtBoss(5, b.pos);
          } else {
            for (let ei = run.adds.length - 1; ei >= 0; ei--) {
              const en = run.adds[ei];
              if (sweepHit(segA, b.dir, step, en.position, 2.8)) {
                b.life = 0;
                b.line.visible = false;
                popDamage(b.pos, 5, '#6ad8ff');
                en.userData.hp -= 5;
                if (en.userData.hp <= 0) killAdd(en);
                break;
              }
            }
          }
        } else {
          for (let ei = enemies.length - 1; ei >= 0; ei--) {
            const en = enemies[ei];
            if (sweepHit(segA, b.dir, step, en.position, 2.8)) {
              b.life = 0;
              b.line.visible = false;
              popDamage(b.pos, 5, '#6ad8ff');
              en.userData.hp -= 5;
              if (en.userData.hp <= 0) killEnemy(en);
              else explode(b.pos, '#ff5fd2');
              break;
            }
          }
        }
        continue;
      }
      /* parry window: incoming bolts get thrown back at their source */
      if (parryT > 0 && b.pos.distanceTo(ship.position) < 9) {
        b.reflected = true;
        b.life = 2.2;
        b.line.material.color.set(CYAN);
        const tgt = run.active ? (run.boss ?? run.adds[0] ?? null) : nearestEnemy(b.pos);
        if (tgt) b.dir.copy(tgt.position).sub(b.pos).normalize();
        else b.dir.negate();
        addScore(15);
        explode(ship.position, '#6ad8ff');
        audio.tick();
        continue;
      }
      if (sweepHit(segA, b.dir, step, ship.position, 2.6)) {
        b.life = 0;
        b.line.visible = false;
        damageShip(7, b.pos);
      }
    }

    /* damage numbers: drift up, hold size on screen, fade */
    for (const p of pops) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.s.position.y += dt * 5;
      const pd = camera.position.distanceTo(p.s.position);
      const pk = THREE.MathUtils.clamp(pd / 38, 0.8, 4);
      p.s.scale.set(7 * pk, 3.5 * pk, 1);
      p.s.material.opacity = Math.min(1, p.life * 2.2);
      if (p.life <= 0) p.s.visible = false;
    }

    /* missiles — weapon-scaled damage, not instakill */
    for (let mi = missiles.length - 1; mi >= 0; mi--) {
      const m = missiles[mi];
      const u = m.userData;
      u.life -= dt;
      if (u.target && !u.target.parent) u.target = null;
      if (u.target) {
        const speed = Math.min(stats.missileVmax, u.vel.length() + 60 * dt);
        const desired = tmpV2
          .copy(u.target.position)
          .sub(m.position)
          .normalize()
          .multiplyScalar(speed);
        u.vel.lerp(desired, 1 - Math.exp(-dt * 3.2));
      }
      const mStep = u.vel.length() * dt;
      segA.copy(m.position);
      segB.copy(u.vel).normalize();
      m.position.addScaledVector(u.vel, dt);
      let dead = u.life <= 0;
      const rocks = run.active ? run.rocks : asteroids;
      for (let ai = rocks.length - 1; ai >= 0; ai--) {
        const rock = rocks[ai];
        if (sweepHit(segA, segB, mStep, rock.position, rock.userData.radius + 1.4)) {
          rock.userData.hp -= stats.missileDmg;
          popDamage(m.position, stats.missileDmg, '#ffc46a');
          if (rock.userData.hp <= 0) {
            if (run.active) {
              explode(rock.position, AMBER);
              audio.boom(false);
              run.group?.remove(rock);
              run.rocks.splice(ai, 1);
              addScore(10);
            } else killAsteroid(rock);
          }
          dead = true;
          break;
        }
      }
      if (!dead) {
        if (run.active) {
          if (run.boss && sweepHit(segA, segB, mStep, run.boss.position, 5.6)) {
            popDamage(m.position, stats.missileDmg, '#ffc46a');
            hurtBoss(stats.missileDmg, m.position);
            dead = true;
          } else {
            for (let ei = run.adds.length - 1; ei >= 0; ei--) {
              const en = run.adds[ei];
              if (sweepHit(segA, segB, mStep, en.position, 3)) {
                en.userData.hp -= stats.missileDmg;
                popDamage(m.position, stats.missileDmg, '#ffc46a');
                if (en.userData.hp <= 0) killAdd(en);
                dead = true;
                break;
              }
            }
          }
        } else {
          for (let ei = enemies.length - 1; ei >= 0; ei--) {
            const en = enemies[ei];
            if (sweepHit(segA, segB, mStep, en.position, 3)) {
              en.userData.hp -= stats.missileDmg;
              popDamage(m.position, stats.missileDmg, '#ffc46a');
              if (en.userData.hp <= 0) killEnemy(en);
              dead = true;
              break;
            }
          }
        }
      }
      if (dead) {
        explode(m.position, '#ffc46a');
        scene.remove(m);
        missiles.splice(mi, 1);
      }
    }

    /* explosions — exp damping so 120 Hz decays like 60 Hz */
    const damp = Math.exp(-dt * 3.7);
    for (const b of booms) {
      if (b.life <= 0) continue;
      b.life -= dt * 1.3;
      for (let i = 0; i < b.arr.length; i += 3) {
        b.arr[i] += b.vels[i] * dt;
        b.arr[i + 1] += b.vels[i + 1] * dt;
        b.arr[i + 2] += b.vels[i + 2] * dt;
        b.vels[i] *= damp;
        b.vels[i + 1] *= damp;
        b.vels[i + 2] *= damp;
      }
      b.points.geometry.attributes.position.needsUpdate = true;
      b.points.material.opacity = Math.max(0, b.life);
      if (b.life <= 0) b.points.visible = false;
    }

    /* lock reticle */
    if (lockTgt && lockTgt !== prevLock) audio.tick();
    prevLock = lockTgt;
    if (lockTgt) {
      lockReticle.visible = true;
      lockReticle.position.copy(lockTgt.position);
      lockReticle.scale.setScalar((lockTgt.userData.radius ?? 2.2) * 2);
      lockReticle.lookAt(camera.position);
      if (!reduced) lockReticle.rotation.z = time * 2;
    } else lockReticle.visible = false;

    /* --- chase camera + shake --- */
    shake = Math.max(0, shake - dt * 1.8);
    const camTarget = tmpV2.set(0, 3.8, 15.5).applyQuaternion(ship.quaternion).add(ship.position);
    camera.position.lerp(camTarget, reduced ? 1 : 1 - Math.exp(-dt * 4.5));
    if (shake > 0 && !reduced)
      camera.position.add(
        tmpV3.set(
          (Math.random() - 0.5) * shake,
          (Math.random() - 0.5) * shake,
          (Math.random() - 0.5) * shake,
        ),
      );
    camera.lookAt(tmpV3.set(0, 1, -14).applyQuaternion(ship.quaternion).add(ship.position));

    /* --- HUD --- */
    if ((hudTimer += dt) > 0.12 && hud?.els) {
      hudTimer = 0;
      const els = hud.els;
      els.hp.style.width = `${(hp / stats.maxHp) * 100}%`;
      els.hp.classList.toggle('low', hp / stats.maxHp < 0.3);
      els.shieldRow.hidden = !stats.shieldMax;
      if (stats.shieldMax) {
        els.shield.style.width = `${(shield / stats.shieldMax) * 100}%`;
        if (els.charges)
          els.charges.textContent = stats.shieldChargesMax ? '⬢'.repeat(shieldCharges) : '';
      }
      els.boost.style.width = `${fuel}%`;
      els.stats.textContent = run.active
        ? run.phase === 'arena'
          ? `WARDEN ${Math.max(0, Math.ceil(run.boss?.userData.hp ?? 0))} · L${run.level + 1} ${run.kind} · score ${score}`
          : `v ${Math.round(run.speed)} · ⌬ ${Math.round(run.t * 100)}% · L${run.level + 1} ${run.kind} · score ${score}`
        : `v ${Math.round(vel.length())} · ◆ ${scrap} · ⬡ ${cores} · score ${score}`;
      /* boss bar: front and center while the warden lives */
      const bossOn = run.active && !!run.boss;
      els.boss.hidden = !bossOn;
      if (bossOn) {
        const bu = run.boss.userData;
        els.bossName.textContent = `⌬ THE WARDEN · L${run.level + 1}`;
        els.bossFill.style.width = `${Math.max(0, (bu.hp / bu.hpMax) * 100)}%`;
      }
      els.top.textContent = `system xandreed · ${posts.length} planets · best ${best}`;
      if (lockTgt) {
        els.lock.textContent = `◈ lock ${Math.round(lockTgt.position.distanceTo(ship.position))}m`;
        els.lock.classList.add('on');
      } else els.lock.classList.remove('on');
      /* weapon cooldowns — always visible */
      const mTxt = stats.hasMissiles
        ? missileCd > 0
          ? `➤ ${missileCd.toFixed(1)}s`
          : '➤ ready'
        : '➤ locked';
      const pTxt = parryCd > 0 ? `⛨ ${parryCd.toFixed(1)}s` : '⛨ ready';
      els.weap.textContent = `${mTxt} · ${pTxt}`;
      els.missileBtn?.style.setProperty(
        '--cd',
        `${Math.round((missileCd / stats.missileCooldown) * 100)}%`,
      );
      els.parryBtn?.style.setProperty('--cd', `${Math.round((parryCd / stats.parryCd) * 100)}%`);
    }
  }

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    if (core) {
      const { outer, inner } = core.userData;
      if (!reduced) {
        outer.rotation.y += dt * 0.18;
        outer.rotation.x += dt * 0.05;
        inner.rotation.y -= dt * 0.32;
        core.scale.setScalar(1 + Math.sin(time * 1.4) * 0.035);
      }
    }

    if (isWorld && ship) {
      /* tree menu open: hold the world still under it */
      if (!simPaused) {
        if (run.active) updateRun(dt);
        else updateWorld(dt, time);
        updateShared(dt, time);
      }
    } else if (!isWorld && !reduced) {
      scene.rotation.y = Math.sin(time * 0.05) * 0.02;
      camera.position.y = 1 + Math.sin(time * 0.4) * 0.12;
    }

    composer.render();
    raf = requestAnimationFrame(frame);
  }

  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  }
  addEventListener('resize', onResize, { signal });

  const start = async () => {
    try {
      await Promise.race([
        document.fonts.load('72px VT323'),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    } catch {}
    if (signal.aborted) return;
    if (isWorld && posts.length) {
      buildWorld();
      bindWorldInput();
    } else {
      buildAmbient();
    }
    raf = requestAnimationFrame(frame);
  };
  start();

  function unmount() {
    saveShip(); // style flips keep your spot too
    audio.dispose();
    ac.abort();
    cancelAnimationFrame(raf);
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
    disposeObject(scene);
    missileMat.dispose();
    bloomPass.dispose();
    composer.dispose();
    renderer.dispose();
    /* release the GL context now — browsers cap live contexts and style
       flipping would otherwise burn through them */
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
    hud?.remove();
    delete document.documentElement.dataset.world;
  }

  return { unmount };
}
