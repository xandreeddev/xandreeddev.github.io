/* ---------------------------------------------------------------------------
   VECTOR — the context overworld.

   The blog as a star system you fly. The efferent core is the sun; every
   post is a wireframe planet. Reading an article installs a visible ship
   component (twin cannons, afterburner, missile pods, deflector, swept
   wings, gilded hull). An asteroid belt drifts between the orbits: lasers
   with target lead, homing missiles, auto-lock, scrap, hull damage, and
   docking repairs. Article pages keep an ambient field, a "return to
   system" chip, and esc flies you home.

   Controls (desktop): click the void to take the stick (pointer lock) —
   mouse aims, W thrusts, S brakes, shift boosts, space / click fires,
   E / right-click launches a missile, enter reads when docked, esc
   releases the stick. Unlocked: the pointer steers gently and clicking a
   planet opens it. Touch (iPad / iPhone / Android): the left half of the
   screen is a virtual stick (touch down anywhere, drag to steer); the
   right-thumb cluster has thrust (toggle), boost / brake (hold), fire
   (hold) and missile (tap). Tapping a planet still opens the article.

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

const MODS = [
  { id: 'twin', name: 'twin cannons', desc: 'a second laser muzzle' },
  { id: 'burner', name: 'afterburner', desc: 'hotter boost, faster fuel regen' },
  { id: 'pods', name: 'missile pods', desc: 'twin salvo, faster reload' },
  { id: 'shield', name: 'deflector ring', desc: '+40 hull, half impact damage' },
  { id: 'wings', name: 'swept wings', desc: '+30% turn rate' },
  { id: 'gold', name: 'gilded hull', desc: '+12 top speed' },
];

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
};

const slugOf = (href) => href?.match(/\/posts\/([^/]+)\/?/)?.[1] ?? null;

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

function glowTexture(color) {
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
  return tex;
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
  const gold = mods.has('gold');
  const swept = mods.has('wings');

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

function makeHud(n, modCount) {
  const hud = document.createElement('div');
  hud.className = 'vector-hud';
  hud.innerHTML = `
    <div class="vh-cross" aria-hidden="true"></div>
    <div class="vh-bars" aria-hidden="true">
      <div class="vh-bar-row"><span>hull</span><div class="vh-bar"><i data-vh-hp style="width:100%"></i></div></div>
      <div class="vh-bar-row"><span>boost</span><div class="vh-bar boost"><i data-vh-boost style="width:100%"></i></div></div>
      <div class="vh-stats" data-vh-stats>v 0 · ◆ 0 · ➤ ∞ · mods ${modCount}/${MODS.length}</div>
    </div>
    <div class="vh-top" data-vh-top aria-hidden="true">system xandreed · ${n} planets</div>
    <div class="vh-lock" data-vh-lock aria-hidden="true"></div>
    <div class="vh-toasts" data-vh-toasts aria-live="polite"></div>
    <div class="vh-dock" data-vh-dock hidden></div>
    <div class="vh-help" aria-hidden="true">mouse aim · W thrust · shift boost · space fire · E missile · S brake · ↵ read when docked · esc release</div>
    <div class="vh-overlay" data-vh-overlay><b>❯ take the stick</b><span>${
      coarse
        ? 'left thumb steers · ▲ engages thrust · tap a planet to read it'
        : 'click the void to fly · click a planet to read it'
    }</span></div>
    ${
      coarse
        ? `<div class="vh-stick" data-vh-stick hidden><i></i></div>
    <div class="vh-cluster">
      <button type="button" data-vt-missile>➤ missile</button>
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

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.05, 0.6, 0.18));
  composer.addPass(new OutputPass());

  scene.add(makeStars(isWorld ? 1600 : 900, 200, 700), makeGrid());

  let hud = null;
  let raf = 0;
  const clock = new THREE.Clock();
  let core = null;

  const posts = isWorld ? readPosts() : [];
  const visited = store.visited();
  const mods = new Set();
  posts.forEach((p, i) => {
    if (p.slug && visited.has(p.slug)) mods.add(MODS[i % MODS.length].id);
  });

  /* derived ship stats */
  const stats = {
    maxHp: 100 + (mods.has('shield') ? 40 : 0),
    turn: mods.has('wings') ? 1.3 : 1,
    vmax: 60 + (mods.has('gold') ? 12 : 0),
    boostAcc: mods.has('burner') ? 86 : 64,
    fuelRegen: mods.has('burner') ? 30 : 18,
    impactScale: mods.has('shield') ? 0.5 : 1,
    missileCooldown: mods.has('pods') ? 1.1 : 2.4,
  };

  /* live state */
  const planets = [];
  const hitTargets = [];
  const asteroids = [];
  const bolts = [];
  const missiles = [];
  const booms = [];
  let ship = null;
  const vel = new THREE.Vector3();
  let hp = stats.maxHp;
  let fuel = 100;
  let scrap = store.scrap(0);
  let missileCd = 0;
  let fireTimer = 0;
  let invuln = 0;
  let shake = 0;
  let docked = -1;
  let lockIdx = -1;
  let lockReticle = null;
  let pointerLocked = false;
  let mouseDX = 0;
  let mouseDY = 0;
  const keys = { thrust: false, brake: false, boost: false, fire: false, roll: 0 };
  const pointer = new THREE.Vector2(0, 0);
  const raycaster = new THREE.Raycaster();

  /* ----- builders ----- */

  function makePlanet(post, i) {
    const group = new THREE.Group();
    const color = post.draft ? AMBER : PALETTE[i % PALETTE.length];
    const radius = 5.5 + ((i * 7) % 3);

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

    const angle = i * 2.4 + 0.9;
    const dist = 70 + i * 34;
    group.position.set(Math.cos(angle) * dist, Math.sin(i * 1.9) * 12, Math.sin(angle) * dist);

    scene.add(group);
    planets.push({ group, wire, ring, label, moons, post, radius, mod: MODS[i % MODS.length] });
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
    scene.add(rock);
    asteroids.push(rock);
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
    fireTimer = 0.15;
    const { muzzles } = ship.userData;
    /* aim: locked target with lead, else straight ahead */
    let aimPoint = null;
    if (lockIdx >= 0 && asteroids[lockIdx]) {
      const tgt = asteroids[lockIdx];
      const d = tgt.position.distanceTo(ship.position);
      aimPoint = tgt.position.clone().addScaledVector(tgt.userData.vel, d / 220);
    }
    for (const m of muzzles) {
      const b = bolts.find((x) => x.life <= 0);
      if (!b) return;
      b.pos.copy(ship.localToWorld(m.clone()));
      if (aimPoint) b.dir.copy(aimPoint).sub(b.pos).normalize();
      else b.dir.set(0, 0, -1).applyQuaternion(ship.quaternion);
      b.life = 1.1;
      b.line.visible = true;
    }
  }

  function fireMissile() {
    if (!ship || missileCd > 0) return;
    if (lockIdx < 0 || !asteroids[lockIdx]) {
      hud?.toast('no lock — face an asteroid', 'warn');
      return;
    }
    missileCd = stats.missileCooldown;
    const tubes = mods.has('pods') ? [1.05, -1.05] : [0];
    for (const sx of tubes) {
      const g = new THREE.Group();
      const body = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture('#ffc46a'),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      body.scale.setScalar(1.6);
      g.add(body);
      g.position.copy(ship.localToWorld(new THREE.Vector3(sx, -0.5, 0.4)));
      g.userData = {
        vel: new THREE.Vector3(sx * 6, -2, -46).applyQuaternion(ship.quaternion).add(vel),
        target: asteroids[lockIdx],
        life: 6,
      };
      scene.add(g);
      missiles.push(g);
    }
  }

  function killAsteroid(rock, idx) {
    explode(rock.position, AMBER);
    scene.remove(rock);
    asteroids.splice(idx, 1);
    if (lockIdx === idx) lockIdx = -1;
    else if (lockIdx > idx) lockIdx--;
    scrap = store.scrap(1);
    hud?.toast('+1 scrap', 'ok');
  }

  function damageShip(amount, sourcePos) {
    if (invuln > 0) return;
    hp = Math.max(0, hp - amount * stats.impactScale);
    invuln = 0.9;
    shake = Math.min(1.2, shake + 0.7);
    if (sourcePos && ship) {
      const knock = ship.position.clone().sub(sourcePos).normalize().multiplyScalar(16);
      vel.add(knock);
    }
    if (hp <= 0) {
      explode(ship.position, '#ff5fd2');
      hud?.toast('HULL BREACH — rebooting at the gate', 'bad');
      const p0 = planets[0]?.group.position ?? new THREE.Vector3(0, 0, 90);
      ship.position.copy(p0).multiplyScalar(1.6).add(new THREE.Vector3(0, 22, 0));
      ship.lookAt(core.position);
      ship.rotateY(Math.PI);
      vel.set(0, 0, 0);
      hp = stats.maxHp;
      fuel = 100;
      invuln = 2.5;
    }
  }

  function buildWorld() {
    core = makeCore(1);
    scene.add(core);
    const coreLabel = textSprite(['❯ efferent core', 'the root context'], { color: '#9fffd0' });
    coreLabel.position.set(0, 16, 0);
    scene.add(coreLabel);

    posts.forEach((p, i) => makePlanet(p, i));

    for (let i = 0; i < posts.length; i++) {
      const dist = 70 + i * 34;
      const pts = [];
      for (let a = 0; a <= 128; a++) {
        const t = (a / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * dist, 0, Math.sin(t) * dist));
      }
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat(GREEN_DIM, 0.18)));
    }

    for (let i = 0; i < 26; i++) spawnAsteroid();
    makeBoltPool(24);
    makeBoomPool(8);

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

    ship = makeShip(mods);
    /* spawn in orbit of the planet you just read; otherwise at the gate */
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

    hud = makeHud(posts.length, mods.size);
    document.documentElement.dataset.world = 'on';

    /* announce components installed since the last time we were here */
    try {
      const seen = new Set(JSON.parse(localStorage.getItem('vector-mods-seen') ?? '[]'));
      for (const id of mods)
        if (!seen.has(id))
          hud.toast(`component installed: ${MODS.find((m) => m.id === id)?.name}`, 'ok');
      localStorage.setItem('vector-mods-seen', JSON.stringify([...mods]));
    } catch {}
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
        note.textContent = '✓ ship component acquired — return to the system to see it';
        document.body.append(note);
        setTimeout(() => note.remove(), 4200);
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
        if (d) d.moved += 2;
      },
      { signal },
    );

    el.addEventListener(
      'pointerdown',
      (e) => {
        setPointer(e);
        dismissOverlay();
        downs.set(e.pointerId, { t: performance.now(), x: e.clientX, y: e.clientY, moved: 0 });
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
        if (quick && still) {
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
        dismissOverlay();
        const k = e.key;
        if (['w', 'W', 'ArrowUp'].includes(k)) { keys.thrust = true; e.preventDefault(); }
        else if (['s', 'S', 'ArrowDown'].includes(k)) { keys.brake = true; e.preventDefault(); }
        else if (k === 'Shift') keys.boost = true;
        else if (k === ' ') { keys.fire = true; e.preventDefault(); }
        else if (['e', 'E'].includes(k)) fireMissile();
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
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); dismissOverlay(); on(); }, { signal });
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

    hud?.querySelector('[data-vh-dock]')?.addEventListener(
      'click',
      () => {
        if (docked >= 0) location.href = planets[docked].post.href;
      },
      { signal },
    );
  }

  /* ----- frame loop ----- */

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  let hudTimer = 0;

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
      /* --- steering --- */
      if (pointerLocked) {
        ship.rotateY(-mouseDX * 0.0022 * stats.turn);
        ship.rotateX(-mouseDY * 0.0019 * stats.turn);
        mouseDX = 0;
        mouseDY = 0;
      } else if (stick.id >= 0 || coarse) {
        /* virtual stick: right turns right, up pitches up; idle = fly straight */
        ship.rotateY(-stick.x * 2.2 * stats.turn * dt);
        ship.rotateX(-stick.y * 1.7 * stats.turn * dt);
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
      const boosting = keys.boost && fuel > 1 && keys.thrust;
      if (boosting) fuel = Math.max(0, fuel - 34 * dt);
      else fuel = Math.min(100, fuel + stats.fuelRegen * dt);
      if (keys.thrust) vel.addScaledVector(fwd, (boosting ? stats.boostAcc : 34) * dt);
      if (keys.brake) vel.multiplyScalar(Math.exp(-dt * 3.2));
      vel.multiplyScalar(Math.exp(-dt * 0.55));
      const vmax = boosting ? stats.vmax + 35 : stats.vmax;
      if (vel.length() > vmax) vel.setLength(vmax);
      ship.position.addScaledVector(vel, dt);

      const r = ship.position.length();
      if (r > 620) vel.addScaledVector(tmpV2.copy(ship.position).normalize(), -dt * 40);

      const ex = ship.userData.exhaust;
      ex.material.opacity = THREE.MathUtils.lerp(
        ex.material.opacity,
        keys.thrust ? (boosting ? 1 : 0.85) + Math.sin(time * 30) * 0.1 : 0,
        1 - Math.exp(-dt * 10),
      );
      if (!reduced && ship.userData.shieldRings.length) {
        ship.userData.shieldRings[0].rotation.z += dt * 0.8;
        ship.userData.shieldRings[1].rotation.y += dt * 0.55;
      }

      /* invulnerability blink */
      invuln = Math.max(0, invuln - dt);
      hull.visible = invuln <= 0 || Math.sin(time * 24) > -0.2;

      /* --- weapons --- */
      fireTimer = Math.max(0, fireTimer - dt);
      missileCd = Math.max(0, missileCd - dt);
      if (keys.fire) fireLasers();

      /* bolts */
      for (const b of bolts) {
        if (b.life <= 0) continue;
        b.life -= dt;
        b.pos.addScaledVector(b.dir, 220 * dt);
        b.arr[0] = b.pos.x - b.dir.x * 2.4;
        b.arr[1] = b.pos.y - b.dir.y * 2.4;
        b.arr[2] = b.pos.z - b.dir.z * 2.4;
        b.arr[3] = b.pos.x;
        b.arr[4] = b.pos.y;
        b.arr[5] = b.pos.z;
        b.line.geometry.attributes.position.needsUpdate = true;
        if (b.life <= 0) b.line.visible = false;
        else
          for (let ai = asteroids.length - 1; ai >= 0; ai--) {
            const rock = asteroids[ai];
            if (b.pos.distanceTo(rock.position) < rock.userData.radius + 0.9) {
              b.life = 0;
              b.line.visible = false;
              rock.userData.hp -= 1;
              if (rock.userData.hp <= 0) killAsteroid(rock, ai);
              else explode(b.pos, '#46ffa0');
              break;
            }
          }
      }

      /* missiles */
      for (let mi = missiles.length - 1; mi >= 0; mi--) {
        const m = missiles[mi];
        const u = m.userData;
        u.life -= dt;
        if (u.target && !asteroids.includes(u.target)) u.target = null;
        if (u.target) {
          const speed = Math.min(130, u.vel.length() + 60 * dt);
          const desired = tmpV2.copy(u.target.position).sub(m.position).normalize().multiplyScalar(speed);
          u.vel.lerp(desired, 1 - Math.exp(-dt * 3.2));
        }
        m.position.addScaledVector(u.vel, dt);
        let dead = u.life <= 0;
        for (let ai = asteroids.length - 1; ai >= 0; ai--) {
          const rock = asteroids[ai];
          if (m.position.distanceTo(rock.position) < rock.userData.radius + 1.4) {
            killAsteroid(rock, ai);
            dead = true;
            break;
          }
        }
        if (dead) {
          explode(m.position, '#ffc46a');
          scene.remove(m);
          m.children[0].material.dispose();
          missiles.splice(mi, 1);
        }
      }

      /* explosions */
      for (const b of booms) {
        if (b.life <= 0) continue;
        b.life -= dt * 1.3;
        for (let i = 0; i < b.arr.length; i += 3) {
          b.arr[i] += b.vels[i] * dt;
          b.arr[i + 1] += b.vels[i + 1] * dt;
          b.arr[i + 2] += b.vels[i + 2] * dt;
          b.vels[i] *= 0.94;
          b.vels[i + 1] *= 0.94;
          b.vels[i + 2] *= 0.94;
        }
        b.points.geometry.attributes.position.needsUpdate = true;
        b.points.material.opacity = Math.max(0, b.life);
        if (b.life <= 0) b.points.visible = false;
      }

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
          killAsteroid(rock, ai);
        }
      }
      if (asteroids.length < 26 && Math.random() < dt * 0.25) spawnAsteroid(true);

      /* --- auto-lock: nearest asteroid in the forward cone --- */
      let bestScore = 0.965; // ~15° cone
      let best = -1;
      for (let i = 0; i < asteroids.length; i++) {
        const d = tmpV2.copy(asteroids[i].position).sub(ship.position);
        const dist = d.length();
        if (dist > 260) continue;
        const score = d.normalize().dot(fwd);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      lockIdx = best;
      if (lockIdx >= 0) {
        const rock = asteroids[lockIdx];
        lockReticle.visible = true;
        lockReticle.position.copy(rock.position);
        lockReticle.scale.setScalar(rock.userData.radius * 2);
        lockReticle.lookAt(camera.position);
        if (!reduced) lockReticle.rotation.z = time * 2;
      } else lockReticle.visible = false;

      /* --- planets: moons, labels, soft repulsion, docking --- */
      let nearest = -1;
      let nearestD = Infinity;
      for (let i = 0; i < planets.length; i++) {
        const pl = planets[i];
        /* constant-ish screen size for the nameplate */
        const labelD = camera.position.distanceTo(pl.group.position);
        const k = THREE.MathUtils.clamp(labelD / 55, 0.7, 3.4);
        pl.label.scale.set(28 * k, 7 * k, 1);
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
      if (docked >= 0) hp = Math.min(stats.maxHp, hp + 9 * dt); // docking repairs
      if (docked !== wasDocked) {
        if (wasDocked >= 0) planets[wasDocked].ring.material.opacity = 0.5;
        const dockEl = hud?.querySelector('[data-vh-dock]');
        if (docked >= 0) {
          planets[docked].ring.material.opacity = 1;
          const pl = planets[docked];
          const owned = pl.post.slug && store.visited().has(pl.post.slug);
          if (dockEl) {
            dockEl.hidden = false;
            dockEl.innerHTML = `◉ in orbit: <b>${pl.post.title}</b><br><span>↵ read${
              owned ? ' · component installed ✓' : ` · installs <b>${pl.mod.name}</b> (${pl.mod.desc})`
            } · repairs while docked</span>`;
          }
        } else if (dockEl) dockEl.hidden = true;
      }

      /* --- chase camera + shake --- */
      shake = Math.max(0, shake - dt * 1.8);
      const camTarget = tmpV2.set(0, 3.8, 15.5).applyQuaternion(ship.quaternion).add(ship.position);
      camera.position.lerp(camTarget, reduced ? 1 : 1 - Math.exp(-dt * 4.5));
      if (shake > 0 && !reduced)
        camera.position.add(
          new THREE.Vector3(
            (Math.random() - 0.5) * shake,
            (Math.random() - 0.5) * shake,
            (Math.random() - 0.5) * shake,
          ),
        );
      const look = new THREE.Vector3(0, 1, -14).applyQuaternion(ship.quaternion).add(ship.position);
      camera.lookAt(look);

      /* --- HUD --- */
      if ((hudTimer += dt) > 0.12 && hud) {
        hudTimer = 0;
        hud.querySelector('[data-vh-hp]').style.width = `${(hp / stats.maxHp) * 100}%`;
        hud.querySelector('[data-vh-boost]').style.width = `${fuel}%`;
        hud.querySelector('[data-vh-hp]').classList.toggle('low', hp / stats.maxHp < 0.3);
        hud.querySelector('[data-vh-stats]').textContent = `v ${Math.round(
          vel.length(),
        )} · ◆ ${scrap} · ➤ ${missileCd > 0 ? '…' : '∞'} · mods ${mods.size}/${MODS.length}`;
        const lockEl = hud.querySelector('[data-vh-lock]');
        if (lockIdx >= 0) {
          lockEl.textContent = `◈ lock ${Math.round(
            asteroids[lockIdx].position.distanceTo(ship.position),
          )}m`;
          lockEl.classList.add('on');
        } else lockEl.classList.remove('on');
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
    ac.abort();
    cancelAnimationFrame(raf);
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    });
    composer.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    hud?.remove();
    delete document.documentElement.dataset.world;
  }

  return { unmount };
}
