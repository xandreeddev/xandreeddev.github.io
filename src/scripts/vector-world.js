/* ---------------------------------------------------------------------------
   VECTOR — the context overworld.

   The blog as a star system. The efferent core is the sun; every post is a
   wireframe planet (a ring for flair, one moon per tag, amber if draft).
   You pilot a little vector ship: aim with the pointer, hold to thrust,
   click a planet — or dock close and press enter — to open the article.

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

/* ----- DOM data: the post list is the single source of truth ----- */

function readPosts() {
  return [...document.querySelectorAll('.post-list .post-row')].map((row) => {
    const titleEl = row.querySelector('.title');
    const clone = titleEl.cloneNode(true);
    clone.querySelector('.draft-badge')?.remove();
    return {
      href: row.getAttribute('href'),
      title: clone.textContent.trim().replace(/\s+/g, ' '),
      desc: row.querySelector('.desc')?.textContent.trim() ?? '',
      date: row.querySelector('time')?.textContent.trim() ?? '',
      tags: 1 + (row.querySelector('.desc')?.textContent.length ?? 0) % 3,
      draft: !!titleEl.querySelector('.draft-badge'),
    };
  });
}

/* ----- canvas-texture label sprites (VT323 phosphor) ----- */

function textSprite(lines, { size = 72, color = '#46ffa0', dim = '#9fffd0' } = {}) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.font = `${size}px VT323, monospace`;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillText(lines[0], 512, 118, 980);
  if (lines[1]) {
    ctx.shadowBlur = 8;
    ctx.fillStyle = dim;
    ctx.font = `${Math.round(size * 0.55)}px VT323, monospace`;
    ctx.fillText(lines[1], 512, 190, 980);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  s.scale.set(26, 6.5, 1);
  return s;
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

function wireMat(color, opacity = 0.55) {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
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

function makeGrid() {
  const grid = new THREE.GridHelper(900, 70, GREEN_DIM, GREEN_DIM);
  grid.material.transparent = true;
  grid.material.opacity = 0.13;
  grid.material.depthWrite = false;
  grid.position.y = -42;
  return grid;
}

/* ----- the ship ----- */

function makeShip() {
  const ship = new THREE.Group();

  const fuselage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.ConeGeometry(0.55, 2.4, 4)),
    wireMat(GREEN, 0.95),
  );
  fuselage.rotation.x = -Math.PI / 2; // nose toward -z

  const wing = (sx) => {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(sx * 1.9, -0.08, 1.0),
      new THREE.Vector3(sx * 0.25, 0, -0.7),
      new THREE.Vector3(sx * 0.25, 0, 1.05),
    ]);
    return new THREE.LineLoop(g, wireMat(MAGENTA, 0.95));
  };

  const exhaust = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture('#ff5fd2'),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  exhaust.position.set(0, 0, 1.6);
  exhaust.scale.setScalar(2.2);

  /* visuals live on an inner hull so banking stays cosmetic and never
     pollutes the flight quaternion */
  const hull = new THREE.Group();
  hull.add(fuselage, wing(1), wing(-1), exhaust);
  ship.add(hull);
  ship.userData = { exhaust, hull };
  return ship;
}

/* ----- HUD (plain DOM, styled by vector.css) ----- */

function makeHud(n) {
  const hud = document.createElement('div');
  hud.className = 'vector-hud';
  hud.setAttribute('aria-hidden', 'true');
  hud.innerHTML = `
    <div class="vh-top" data-vh-top>system xandreed · ${n} planets</div>
    <div class="vh-caption" data-vh-caption></div>
    <div class="vh-help">aim with the pointer · hold click or W to thrust · scroll = burst · click a planet (or dock + ↵) to read</div>`;
  document.body.append(hud);
  return hud;
}

/* ----- mount ----- */

export function mount() {
  const isWorld = location.pathname === '/' && !!document.querySelector('.post-list .post-row');
  const ac = new AbortController();
  const { signal } = ac;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
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

  /* world state */
  const planets = [];
  const hitTargets = [];
  let ship = null;
  let vel = new THREE.Vector3();
  let thrustKey = false;
  let thrustPointer = false;
  let brakeKey = false;
  let boost = false;
  let docked = -1;
  const pointer = new THREE.Vector2(0, 0);
  const raycaster = new THREE.Raycaster();

  const posts = isWorld ? readPosts() : [];

  function makePlanet(post, i, n) {
    const group = new THREE.Group();
    const color = post.draft ? AMBER : PALETTE[i % PALETTE.length];
    const radius = 5.5 + ((i * 7) % 3);

    /* occluder so back lines vanish — feels solid */
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

    /* one moon per tag-ish */
    const moons = [];
    for (let m = 0; m < post.tags; m++) {
      const moon = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(0.7, 6, 4)),
        wireMat(0x9fffd0, 0.5),
      );
      moon.userData = {
        orbit: radius * 2 + 2 + m * 2.2,
        speed: 0.25 + m * 0.12,
        phase: (m * Math.PI * 2) / post.tags,
      };
      group.add(moon);
      moons.push(moon);
    }

    const label = textSprite([post.title, `${post.date}${post.draft ? ' · draft' : ''}`], {
      color: post.draft ? '#ffc46a' : '#46ffa0',
    });
    label.position.y = radius + 7;
    group.add(label);

    /* generous invisible click target */
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 2.4, 8, 6),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.userData = { idx: i, href: post.href };
    group.add(hit);
    hitTargets.push(hit);

    /* placement: a loose spiral around the core, newest closest */
    const angle = i * 2.4 + 0.9;
    const dist = 70 + i * 34;
    group.position.set(
      Math.cos(angle) * dist,
      Math.sin(i * 1.9) * 12,
      Math.sin(angle) * dist,
    );

    scene.add(group);
    planets.push({ group, wire, ring, label, moons, post, radius, baseOpacity: 0.55 });
  }

  function buildWorld() {
    core = makeCore(1);
    core.position.set(0, 0, 0);
    scene.add(core);
    const coreLabel = textSprite(['❯ efferent core', 'the root context'], { color: '#9fffd0' });
    coreLabel.position.set(0, 16, 0);
    scene.add(coreLabel);

    posts.forEach((p, i) => makePlanet(p, i, posts.length));

    /* faint orbit circles */
    for (let i = 0; i < posts.length; i++) {
      const dist = 70 + i * 34;
      const pts = [];
      for (let a = 0; a <= 128; a++) {
        const t = (a / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * dist, 0, Math.sin(t) * dist));
      }
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat(GREEN_DIM, 0.18)));
    }

    ship = makeShip();
    const p0 = planets[0]?.group.position ?? new THREE.Vector3(0, 0, 90);
    ship.position.copy(p0).multiplyScalar(1.6).add(new THREE.Vector3(0, 22, 0));
    /* lookAt points +z at the target; the nose is -z, so flip */
    ship.lookAt(core.position);
    ship.rotateY(Math.PI);
    scene.add(ship);

    camera.position.copy(new THREE.Vector3(0, 3.2, 11).applyQuaternion(ship.quaternion)).add(ship.position);
    camera.lookAt(ship.position);

    hud = makeHud(posts.length);
    document.documentElement.dataset.world = 'on';
  }

  function buildAmbient() {
    core = makeCore(0.45);
    core.position.set(14, 5, -55);
    scene.add(core);
    camera.position.set(0, 1, 16);
    camera.lookAt(0, 2, -30);
    renderer.domElement.classList.add('is-ambient');
    document.documentElement.dataset.world = 'ambient';
  }

  /* ----- input ----- */

  let downAt = 0;
  let downX = 0;
  let downY = 0;
  let moved = 0;

  function bindWorldInput() {
    const el = renderer.domElement;
    el.style.cursor = 'crosshair';

    const setPointer = (e) => {
      pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    };

    el.addEventListener('pointermove', (e) => { setPointer(e); if (downAt) moved += Math.abs(e.movementX ?? 1) + Math.abs(e.movementY ?? 1); }, { signal });

    el.addEventListener(
      'pointerdown',
      (e) => {
        setPointer(e);
        downAt = performance.now();
        downX = e.clientX;
        downY = e.clientY;
        moved = 0;
        thrustPointer = true;
        el.setPointerCapture(e.pointerId);
      },
      { signal },
    );

    el.addEventListener(
      'pointerup',
      (e) => {
        setPointer(e);
        thrustPointer = false;
        const quick = performance.now() - downAt < 350;
        const still = Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) < 9 && moved < 24;
        downAt = 0;
        if (quick && still) {
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(hitTargets, false)[0];
          if (hit) {
            location.href = hit.object.userData.href;
            return;
          }
        }
      },
      { signal },
    );

    el.addEventListener('pointercancel', () => { thrustPointer = false; downAt = 0; }, { signal });

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
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
        const k = e.key;
        if (['w', 'W', 'ArrowUp'].includes(k)) { thrustKey = true; e.preventDefault(); }
        else if (['s', 'S', 'ArrowDown'].includes(k)) { brakeKey = true; e.preventDefault(); }
        else if (k === 'Shift') boost = true;
        else if (k === 'Enter' && docked >= 0 && document.activeElement === document.body)
          location.href = planets[docked].post.href;
      },
      { signal },
    );
    addEventListener(
      'keyup',
      (e) => {
        const k = e.key;
        if (['w', 'W', 'ArrowUp'].includes(k)) thrustKey = false;
        else if (['s', 'S', 'ArrowDown'].includes(k)) brakeKey = false;
        else if (k === 'Shift') boost = false;
      },
      { signal },
    );
  }

  /* ----- frame loop ----- */

  const tmpV = new THREE.Vector3();
  let speedReadout = 0;

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
      /* steering: pointer offset from center turns the ship */
      const dz = 0.07;
      const yawIn = Math.abs(pointer.x) > dz ? -(pointer.x - Math.sign(pointer.x) * dz) : 0;
      const pitchIn = Math.abs(pointer.y) > dz ? pointer.y - Math.sign(pointer.y) * dz : 0;
      ship.rotateY(yawIn * 1.7 * dt);
      ship.rotateX(pitchIn * 1.15 * dt);

      /* visual bank on the hull only */
      const hull = ship.userData.hull;
      const bank = THREE.MathUtils.clamp(-yawIn * 1.1, -0.7, 0.7);
      hull.rotation.z = THREE.MathUtils.lerp(hull.rotation.z, bank, 1 - Math.exp(-dt * 4));

      /* thrust */
      const fwd = tmpV.set(0, 0, -1).applyQuaternion(ship.quaternion);
      const thrusting = thrustKey || thrustPointer;
      const acc = boost ? 64 : 34;
      if (thrusting) vel.addScaledVector(fwd, acc * dt);
      if (brakeKey) vel.multiplyScalar(Math.exp(-dt * 3.2));
      vel.multiplyScalar(Math.exp(-dt * 0.55)); // space drag, forgiving
      const vmax = boost ? 95 : 60;
      if (vel.length() > vmax) vel.setLength(vmax);
      ship.position.addScaledVector(vel, dt);

      /* soft world bounds */
      const r = ship.position.length();
      if (r > 620) vel.addScaledVector(ship.position.clone().normalize(), -dt * 40);

      /* exhaust glow */
      const ex = ship.userData.exhaust;
      ex.material.opacity = THREE.MathUtils.lerp(
        ex.material.opacity,
        thrusting ? 0.85 + Math.sin(time * 30) * 0.1 : 0,
        1 - Math.exp(-dt * 10),
      );

      /* chase camera */
      const camTarget = tmpV
        .set(0, 2.6, 9.5)
        .applyQuaternion(ship.quaternion)
        .add(ship.position);
      camera.position.lerp(camTarget, reduced ? 1 : 1 - Math.exp(-dt * 4.5));
      const look = new THREE.Vector3(0, 0.8, -8).applyQuaternion(ship.quaternion).add(ship.position);
      camera.lookAt(look);

      /* planets: moons orbit, labels breathe, docking check */
      let nearest = -1;
      let nearestD = Infinity;
      for (let i = 0; i < planets.length; i++) {
        const pl = planets[i];
        if (!reduced) {
          pl.wire.rotation.y += dt * 0.12;
          for (const m of pl.moons) {
            const u = m.userData;
            const a = time * u.speed + u.phase;
            m.position.set(Math.cos(a) * u.orbit * 0.5, Math.sin(a * 0.7) * 1.5, Math.sin(a) * u.orbit * 0.5);
          }
        }
        const d = pl.group.position.distanceTo(ship.position);
        if (d < nearestD) {
          nearestD = d;
          nearest = i;
        }
      }

      const wasDocked = docked;
      docked = nearest >= 0 && nearestD < planets[nearest].radius * 2.4 + 12 ? nearest : -1;
      if (docked !== wasDocked) {
        if (wasDocked >= 0) planets[wasDocked].ring.material.opacity = 0.5;
        if (docked >= 0) planets[docked].ring.material.opacity = 1;
        const cap = hud?.querySelector('[data-vh-caption]');
        if (cap) {
          if (docked >= 0) {
            const p = planets[docked].post;
            cap.innerHTML = `◉ in orbit: <b>${p.title}</b> — press ↵ or click to read`;
            cap.classList.add('on');
          } else cap.classList.remove('on');
        }
      }

      /* HUD speed readout, throttled */
      if (((speedReadout += dt) > 0.25 || docked !== wasDocked) && hud) {
        speedReadout = 0;
        const top = hud.querySelector('[data-vh-top]');
        if (top)
          top.textContent = `system xandreed · ${planets.length} planets · v ${Math.round(vel.length())}`;
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

  /* boot: make sure VT323 is ready before painting labels */
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
