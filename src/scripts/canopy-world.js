/* ---------------------------------------------------------------------------
   CANOPY — the overworld.

   The blog as a sunny 3D platformer. The homepage is a forest meadow you
   run and jump through as a little sprout-bot: every article is a tree
   along the winding path — a pale sapling until you read it, then it
   blooms. Reading articles unlocks movement power-ups (double jump, dash,
   glide, bloom boost); coins are scattered everywhere; mushrooms bounce;
   three warp pipes lead to seeded floating-island courses with a star at
   the summit. Soft sun shadows, drifting clouds, synth chirps — all
   procedural, no assets.

   Controls (desktop): WASD/arrows run (camera-relative) · space jump,
   hold to glide once unlocked · shift dash · drag to orbit the camera ·
   wheel zooms · ↵ read at a tree / enter a pipe · M sound. Touch: left
   stick runs, A jumps (hold = glide), B dashes; tap the card to read.

   Loaded lazily, only while [data-style="canopy"] is active. mount()
   reads the post list from the DOM and returns { unmount }.
--------------------------------------------------------------------------- */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SKY = 0xa9cdf2;
const LEAF = 0x3f9e52;
const GOLD = 0xf0b432;
const WOOD = 0x8a5a33;

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

const READ_KEY = 'canopy-read';
const COIN_KEY = 'canopy-coins';
const STAR_KEY = 'canopy-stars';
const MUTE_KEY = 'canopy-mute';
const FX_KEY = 'canopy-fx';
const PLAYER_KEY = 'canopy-player'; // sessionStorage: position across visits

/* power-ups unlock from articles read — the whole point of the forest */
const POWERS = [
  { id: 'djump', name: 'double sprout', desc: 'jump again mid-air', need: 1 },
  { id: 'dash', name: 'zip dash', desc: 'shift: a burst of speed', need: 3 },
  { id: 'glide', name: 'leaf glide', desc: 'hold jump to drift down', need: 6 },
  { id: 'boost', name: 'bloom boost', desc: 'higher jumps, faster runs', need: 10 },
];

const store = {
  read() {
    try {
      return new Set(JSON.parse(localStorage.getItem(READ_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  },
  markRead(slug) {
    const r = this.read();
    const fresh = !r.has(slug);
    r.add(slug);
    try {
      localStorage.setItem(READ_KEY, JSON.stringify([...r]));
    } catch {}
    return fresh;
  },
  coins(delta = 0) {
    let n = 0;
    try {
      n = Math.max(0, (parseInt(localStorage.getItem(COIN_KEY) ?? '0', 10) || 0) + delta);
      if (delta) localStorage.setItem(COIN_KEY, String(n));
    } catch {}
    return n;
  },
  stars(idx) {
    let s = [];
    try {
      s = JSON.parse(localStorage.getItem(STAR_KEY) ?? '[]');
      if (idx !== undefined && !s.includes(idx)) {
        s.push(idx);
        localStorage.setItem(STAR_KEY, JSON.stringify(s));
      }
    } catch {}
    return s;
  },
  muted(set) {
    try {
      if (set !== undefined) localStorage.setItem(MUTE_KEY, set ? '1' : '');
      return !!localStorage.getItem(MUTE_KEY);
    } catch {
      return false;
    }
  },
  /* fancy rendering (GTAO) — on unless the player turns it off */
  fx(set) {
    try {
      if (set !== undefined) localStorage.setItem(FX_KEY, set ? '' : '0');
      return localStorage.getItem(FX_KEY) !== '0';
    } catch {
      return true;
    }
  },
  playerState(state) {
    try {
      if (state === undefined) return JSON.parse(sessionStorage.getItem(PLAYER_KEY) ?? 'null');
      if (state === null) sessionStorage.removeItem(PLAYER_KEY);
      else sessionStorage.setItem(PLAYER_KEY, JSON.stringify(state));
    } catch {}
    return null;
  },
};

/* deterministic helpers — layout must look the same on every visit */
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

/* bake a cheap AO gradient into vertex colors: undersides and crevices
   darken, tops stay lit — multiplies with instance colors for free */
function bakeVertexAO(geo, minY, maxY, floor = 0.55) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const h = THREE.MathUtils.clamp((pos.getY(i) - minY) / (maxY - minY), 0, 1);
    const up = nor.getY(i) * 0.5 + 0.5;
    const ao = floor + (1 - floor) * Math.min(1, h * 0.7 + up * 0.45);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

const slugOf = (href) => href?.match(/\/(?:posts|drafts)\/([^/]+)\/?/)?.[1] ?? null;

function readPosts() {
  return [...document.querySelectorAll('.post-list .post-row')].map((row) => {
    const titleEl = row.querySelector('.title');
    const clone = titleEl.cloneNode(true);
    clone.querySelector('.draft-badge')?.remove();
    return {
      href: row.getAttribute('href'),
      slug: slugOf(row.getAttribute('href')),
      title: clone.textContent.trim().replace(/\s+/g, ' '),
      date: row.querySelector('time')?.textContent.trim() ?? '',
      draft: !!titleEl.querySelector('.draft-badge'),
    };
  });
}

/* ----- synth audio: chirpy platformer sounds, no assets ----- */

function makeAudio() {
  let ctx = null;
  let master = null;
  let muted = store.muted();

  const ensure = () => {
    if (!ctx) {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.3;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  };

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

  return {
    unlock: ensure,
    muted: () => muted,
    setMuted(m) {
      muted = m;
      store.muted(m);
      if (master) master.gain.value = m ? 0 : 0.3;
    },
    jump: () => blip('square', 320, 760, 0.14, 0.12),
    djump: () => blip('square', 420, 980, 0.16, 0.12),
    land: () => blip('triangle', 180, 90, 0.08, 0.1),
    coin: () => {
      blip('square', 988, 988, 0.07, 0.1);
      blip('square', 1319, 1319, 0.18, 0.1, 0.07);
    },
    dash: () => blip('sawtooth', 200, 900, 0.16, 0.1),
    bounce: () => blip('square', 160, 640, 0.22, 0.14),
    power: () => {
      blip('square', 523, 523, 0.1, 0.12);
      blip('square', 659, 659, 0.1, 0.12, 0.09);
      blip('square', 784, 784, 0.1, 0.12, 0.18);
      blip('square', 1047, 1047, 0.24, 0.12, 0.27);
    },
    star: () => {
      for (let i = 0; i < 6; i++) blip('triangle', 523 + i * 110, 523 + i * 110, 0.12, 0.11, i * 0.07);
    },
    warp: () => blip('sine', 700, 80, 0.5, 0.16),
    bird: () => {
      const f = 1800 + Math.random() * 1200;
      blip('sine', f, f * 1.3, 0.09, 0.025);
      if (Math.random() < 0.5) blip('sine', f * 1.1, f * 0.9, 0.07, 0.02, 0.12);
    },
    dispose() {
      try {
        ctx?.close();
      } catch {}
      ctx = null;
    },
  };
}

/* ----- procedural textures ----- */

const TEX_CACHE = new Map();
const shared = (key, make) => {
  if (TEX_CACHE.has(key)) return TEX_CACHE.get(key);
  const t = make();
  t.userData.shared = true;
  TEX_CACHE.set(key, t);
  return t;
};

/* meadow ground: soft green checker with flower speckles */
function meadowTexture() {
  return shared('meadow', () => {
    const t = 32;
    const c = document.createElement('canvas');
    c.width = c.height = t * 8;
    const ctx = c.getContext('2d');
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const v = ((x + y) % 2 ? 0.92 : 1) * (0.94 + hash01(`m${x}:${y}`) * 0.12);
        ctx.fillStyle = `rgb(${Math.round(126 * v)}, ${Math.round(188 * v)}, ${Math.round(108 * v)})`;
        ctx.fillRect(x * t, y * t, t, t);
      }
    for (let i = 0; i < 26; i++) {
      const x = hash01(`fx${i}`) * 256;
      const y = hash01(`fy${i}`) * 256;
      ctx.fillStyle = ['#f7e07a', '#f0f0f0', '#f0a8c0'][i % 3];
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(60, 60);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

function cloudTexture() {
  return shared('cloud', () => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 16; i++) {
      const x = 50 + hash01(`cx${i}`) * 156;
      const y = 50 + hash01(`cy${i}`) * 38;
      const r = 22 + hash01(`cr${i}`) * 26;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 128);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

const rrect = (ctx, x, y, w, h, r) => {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
  }
};

const wrapText = (ctx, text, maxW, maxLines) => {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = next;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (lines.length === maxLines) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, ' …');
  return lines;
};

/* a wooden trail sign for each article tree */
function signTexture(post, read) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = read ? '#9a6a3e' : '#8a5f3a';
  rrect(ctx, 6, 6, 500, 244, 26);
  ctx.fill();
  ctx.strokeStyle = read ? '#5e3d20' : '#56381e';
  ctx.lineWidth = 8;
  rrect(ctx, 10, 10, 492, 236, 24);
  ctx.stroke();
  /* wood grain */
  ctx.strokeStyle = 'rgba(70, 45, 22, 0.25)';
  ctx.lineWidth = 3;
  for (let y = 44; y < 240; y += 36) {
    ctx.beginPath();
    ctx.moveTo(22, y);
    ctx.bezierCurveTo(140, y - 7, 360, y + 7, 490, y);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f8eedd';
  ctx.font = '600 44px "Fredoka Variable", "Trebuchet MS", sans-serif';
  const lines = wrapText(ctx, post.title, 440, 3);
  lines.forEach((ln, k) => ctx.fillText(ln, 256, 84 + k * 52));
  ctx.font = '26px "Nunito Variable", sans-serif';
  ctx.fillStyle = read ? '#ffe9a8' : 'rgba(248,238,221,0.75)';
  ctx.fillText(read ? `${post.date} · ✿ bloomed` : `${post.date} · press ⏎ to read`, 256, 222);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* ----- HUD ----- */

const HELP = 'WASD run · space jump · shift dash · drag to look · ↵ read at a tree · M sound';

function makeHud(powers, coins, stars, total) {
  const hud = document.createElement('div');
  hud.className = 'canopy-hud';
  hud.innerHTML = `
    <div class="cp-meta">
      <div><span class="cp-coin">●</span> <b data-cp-coins>${coins}</b> &nbsp; ★ <b data-cp-stars>${stars}/3</b> &nbsp; ✿ <b data-cp-read>0/${total}</b></div>
      <div class="cp-powers" data-cp-powers></div>
    </div>
    <div class="cp-corner"><button type="button" data-cp-fx aria-label="Toggle fancy rendering"></button><button type="button" data-cp-mute aria-label="Toggle sound"></button></div>
    <div class="cp-toasts" data-cp-toasts aria-live="polite"></div>
    <div class="cp-course" data-cp-course hidden></div>
    <div class="cp-card" data-cp-card hidden></div>
    <div class="cp-help" aria-hidden="true">${HELP}</div>
    <div class="cp-overlay" data-cp-overlay><b>✿ the overworld</b><span>${
      coarse
        ? 'left thumb runs · A jumps · read articles to grow new powers'
        : 'run the forest — every article you read unlocks a power-up'
    }</span></div>
    ${
      coarse
        ? `<div class="cp-stick" data-cp-stick hidden><i></i></div>
    <div class="cp-cluster" data-cp-cluster>
      <button type="button" data-cp-dash>B</button>
      <button type="button" data-cp-jump>A</button>
    </div>`
        : ''
    }`;
  document.body.append(hud);
  const toasts = hud.querySelector('[data-cp-toasts]');
  hud.toast = (msg, cls = '') => {
    const t = document.createElement('div');
    t.className = `cp-toast ${cls}`;
    t.textContent = msg;
    toasts.append(t);
    setTimeout(() => t.remove(), 3200);
  };
  return hud;
}

/* ----- mount ----- */

export function mount() {
  const isWorld = location.pathname === '/' && !!document.querySelector('.post-list .post-row');
  const ac = new AbortController();
  const { signal } = ac;

  /* article pages: record the read (this is how powers grow) + way home */
  if (!isWorld) {
    const slug = location.pathname.match(/^\/(?:posts|drafts)\/([^/]+)\/?$/)?.[1];
    if (slug) {
      try {
        sessionStorage.setItem('canopy-at', slug);
      } catch {}
      if (store.markRead(slug)) {
        const n = store.read().size;
        const next = POWERS.find((p) => p.need === n);
        const note = document.createElement('div');
        note.className = `cp-toast cp-solo ${next ? 'power' : 'gold'}`;
        note.textContent = next
          ? `✿ new power: ${next.name} — ${next.desc}`
          : `✿ tree bloomed — ${n} read`;
        document.body.append(note);
        const noteT = setTimeout(() => note.remove(), 4500);
        signal.addEventListener('abort', () => {
          clearTimeout(noteT);
          note.remove();
        });
      }
    }
    const back = document.createElement('a');
    back.href = '/';
    back.className = 'cp-return';
    back.textContent = '⟵ back to the forest';
    document.body.append(back);
    signal.addEventListener('abort', () => back.remove());
    addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') location.href = '/';
      },
      { signal },
    );
    return {
      unmount() {
        ac.abort();
      },
    };
  }

  const posts = readPosts();
  const read = store.read();
  const powerOn = (id) => {
    const p = POWERS.find((x) => x.id === id);
    return !!p && read.size >= p.need;
  };

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.3 : 1.4));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = 'canopy-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(0xd3def5, 120, 420);

  /* gradient sky dome + sun disc — a flat clear color reads like a void */
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 zenith = vec3(0.30, 0.56, 0.94);
        vec3 horizon = vec3(0.88, 0.85, 0.97); /* pink-lavender, not white */
        vec3 col = mix(horizon, zenith, smoothstep(0.02, 0.55, h));
        vec3 sdir = normalize(vec3(0.49, 0.76, 0.33));
        float sd = dot(vDir, sdir);
        col += vec3(1.0, 0.95, 0.78) * smoothstep(0.9985, 0.9995, sd);          /* disc */
        col += vec3(1.0, 0.9, 0.6) * pow(max(sd, 0.0), 90.0) * 0.28;            /* halo */
        col = mix(col, vec3(0.87, 0.88, 0.96), smoothstep(0.12, 0.0, vDir.y));  /* haze */
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 24, 12), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 900);

  /* the composer bypasses the canvas's MSAA — render multisampled or
     every edge is a staircase */
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
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.25, 0.5, 0.9);
  /* day grade: split-tone + vibrance + the gentlest vignette, display-
     referred (after OutputPass). Daylight cut of the toy-render look:
     shadows cool into lavender, highlights warm into cream */
  const gradePass = new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      varying vec2 vUv;
      void main() {
        vec2 c = vUv - 0.5;
        vec3 col = texture2D(tDiffuse, vUv).rgb;
        float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col += vec3(0.028, 0.022, 0.06) * (1.0 - smoothstep(0.0, 0.45, luma));
        col *= mix(vec3(1.0), vec3(1.04, 1.0, 0.94), smoothstep(0.6, 1.0, luma) * 0.5);
        col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 1.12);
        col *= 1.0 - smoothstep(0.2, 0.9, dot(c, c)) * 0.16;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  /* GTAO: real screen-space occlusion, mobile included — the denoiser
     just runs lighter there */
  const gtaoPass = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  gtaoPass.updateGtaoMaterial({
    radius: 0.9,
    distanceExponent: 1,
    thickness: 1,
    distanceFallOff: 1,
    scale: 1.4,
      samples: coarse ? 6 : 8,
  });
  gtaoPass.updatePdMaterial({
    lumaPhi: 10,
    depthPhi: 2,
    normalPhi: 3,
    radius: 4,
    rings: 2,
    samples: coarse ? 8 : 16,
  });
  gtaoPass.enabled = store.fx();
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(gtaoPass);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.addPass(gradePass);

  addEventListener(
    'resize',
    () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
      composer.setSize(innerWidth, innerHeight);
    },
    { signal },
  );

  let hud = null;
  let raf = 0;
  const clock = new THREE.Clock();
  const audio = makeAudio();

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

  /* ----- light: high sun, soft shadows ----- */

  /* sky side leans lavender so shade reads as cool color, not gray —
     the ground side keeps the warm grass bounce */
  scene.add(new THREE.HemisphereLight(0xaebcff, 0x86ae6e, 1.1));
  const sun = new THREE.DirectionalLight(0xffeecf, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(coarse ? 1024 : 2048);
  sun.shadow.radius = 10;
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70;
  sun.shadow.camera.bottom = -70;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 360;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const SUN_OFF = new THREE.Vector3(90, 140, 60);

  /* ----- collision world: everything walkable is an AABB ----- */

  /* box: { x, y, z (center), hx, hy, hz, mesh?, mover? } */
  const boxes = [];
  const movers = [];
  const treeCols = []; // cylinders: { x, z, r }

  const addBox = (x, y, z, hx, hy, hz, opts = {}) => {
    const b = { x, y, z, hx, hy, hz, ...opts };
    boxes.push(b);
    if (b.mover) movers.push(b);
    return b;
  };

  /* ----- the meadow ----- */

  const HUB_R = 120;
  {
    const ground = new THREE.Mesh(
      new THREE.CylinderGeometry(HUB_R, HUB_R + 7, 9, 56),
      new THREE.MeshStandardMaterial({ map: meadowTexture(), roughness: 0.95 }),
    );
    ground.position.y = -4.5;
    ground.receiveShadow = true;
    scene.add(ground);
    addBox(0, -4.5, 0, HUB_R, 4.5, HUB_R, { round: HUB_R });
    /* dirt underside fades to fog — a floating island, platformer-style */
    const under = new THREE.Mesh(
      new THREE.CylinderGeometry(HUB_R + 7, HUB_R * 0.45, 36, 40),
      new THREE.MeshStandardMaterial({ color: 0x7a5536, roughness: 1 }),
    );
    under.position.y = -27;
    scene.add(under);
  }

  /* ----- the elder tree: the landmark the whole meadow bends around ----- */

  {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a4e2a, roughness: 0.9 });
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.4, 24, 12), trunkMat);
    trunk.position.y = 12;
    trunk.castShadow = true;
    const blobB = (x, y, z, s) => {
      const g = new THREE.IcosahedronGeometry(s, 1);
      g.translate(x, y, z);
      return g;
    };
    const crownGeo = bakeVertexAO(
      mergeGeometries([
        blobB(0, 0, 0, 7.5),
        blobB(5.5, 2.5, 1.5, 4.6),
        blobB(-5.2, 2.2, -2, 4.8),
        blobB(1, 5.5, -4, 4.2),
        blobB(-1.5, 1.5, 5, 4.4),
        blobB(2.5, -2.5, 3.5, 3.6),
      ]),
      -7,
      9,
      0.55,
    );
    const crown = new THREE.Mesh(
      crownGeo,
      new THREE.MeshStandardMaterial({ color: 0x4fae5e, roughness: 0.85, flatShading: true, vertexColors: true }),
    );
    crown.position.y = 27;
    crown.castShadow = true;
    /* roots flare out */
    const rootMat = trunkMat;
    const roots = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const root = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.1, 4.5, 6), rootMat);
      root.position.set(Math.cos(a) * 3.2, 1.6, Math.sin(a) * 3.2);
      root.rotation.z = Math.cos(a) * 0.55;
      root.rotation.x = -Math.sin(a) * 0.55;
      root.castShadow = true;
      roots.add(root);
    }
    scene.add(trunk, crown, roots);
    treeCols.push({ x: 0, z: 0, r: 3.6 });
  }

  /* distant floating islands: hand-tinted silhouettes past the fog */
  {
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const a = hash01(`isl${i}`) * Math.PI * 2;
      const r = 300 + hash01(`islr${i}`) * 80;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = 30 + hash01(`islh${i}`) * 55;
      const s = 12 + hash01(`isls${i}`) * 16;
      /* polyhedra are non-indexed — de-index the rest or the merge fails */
      const top = new THREE.BoxGeometry(s, s * 0.18, s * 0.8).toNonIndexed();
      top.translate(x, y, z);
      const cone = new THREE.ConeGeometry(s * 0.34, s * 0.7, 6).toNonIndexed();
      cone.rotateX(Math.PI);
      cone.translate(x, y - s * 0.42, z);
      const tuft1 = new THREE.IcosahedronGeometry(s * 0.22, 0);
      tuft1.translate(x + s * 0.2, y + s * 0.28, z);
      parts.push(top, cone, tuft1);
    }
    const islands = new THREE.Mesh(
      mergeGeometries(parts),
      new THREE.MeshBasicMaterial({ color: 0x9fc4d8, fog: false }),
    );
    scene.add(islands);
  }

  /* ----- decor: trees, grass, flowers, clouds ----- */

  {
    const blob = (x, y, z, s) => {
      const g = new THREE.IcosahedronGeometry(s, 1);
      g.translate(x, y, z);
      return g;
    };
    const canopyGeo = bakeVertexAO(
      mergeGeometries([
        blob(0, 0, 0, 2.0),
        blob(1.2, 0.7, 0.3, 1.3),
        blob(-1.1, 0.5, -0.4, 1.35),
        blob(0.2, 1.5, -0.1, 1.2),
      ]),
      -2,
      2.7,
      0.6,
    );
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.5, 3, 7);
    const trunkMat = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true, vertexColors: true });
    const N = 70;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, N);
    trunks.castShadow = canopies.castShadow = true;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const cv = new THREE.Color();
    const UPY = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      /* ring the rim so the middle stays playable */
      const a = hash01(`ta${i}`) * Math.PI * 2;
      const r = HUB_R * (0.72 + hash01(`tr${i}`) * 0.24);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const s = 0.9 + hash01(`ts${i}`) * 1.3;
      q.setFromAxisAngle(UPY, hash01(`tq${i}`) * Math.PI);
      sc.set(s, s, s);
      m4.compose(pos.set(x, 1.5 * s, z), q, sc);
      trunks.setMatrixAt(i, m4);
      m4.compose(pos.set(x, (3 + 1.6) * s, z), q, sc);
      canopies.setMatrixAt(i, m4);
      cv.setHSL(0.3 + hash01(`tc${i}`) * 0.12, 0.55, 0.42 + hash01(`tl${i}`) * 0.14);
      canopies.setColorAt(i, cv);
      treeCols.push({ x, z, r: 1.1 * s });
    }
    scene.add(trunks, canopies);

    /* grass tufts */
    const blades = [];
    for (let b = 0; b < 6; b++) {
      const h = 0.5 + (b % 3) * 0.22;
      const g = new THREE.ConeGeometry(0.06, h, 4, 1);
      g.translate(0, h / 2, 0);
      const a = (b / 6) * Math.PI * 2;
      g.rotateX(0.3 * Math.cos(a));
      g.rotateZ(0.3 * Math.sin(a));
      g.translate(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12);
      blades.push(g);
    }
    const tuftGeo = bakeVertexAO(mergeGeometries(blades), 0, 0.8, 0.5);
    const tuftMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true, vertexColors: true });
    const GN = coarse ? 250 : 500;
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, GN);
    for (let i = 0; i < GN; i++) {
      const a = hash01(`ga${i}`) * Math.PI * 2;
      const r = 6 + hash01(`gr${i}`) * (HUB_R - 10);
      const s = 0.8 + hash01(`gs${i}`) * 1.2;
      q.setFromAxisAngle(UPY, hash01(`gq${i}`) * Math.PI);
      sc.set(s, s, s);
      m4.compose(pos.set(Math.cos(a) * r, 0, Math.sin(a) * r), q, sc);
      tufts.setMatrixAt(i, m4);
      cv.setHSL(0.3 + hash01(`gc${i}`) * 0.1, 0.5, 0.38 + hash01(`gl${i}`) * 0.12);
      tufts.setColorAt(i, cv);
    }
    scene.add(tufts);

    /* flowers: tiny crosses of petals */
    const petal = new THREE.SphereGeometry(0.12, 5, 4);
    petal.scale(1, 0.5, 1);
    const stemG = new THREE.CylinderGeometry(0.025, 0.025, 0.5, 4);
    stemG.translate(0, 0.25, 0);
    petal.translate(0, 0.55, 0);
    const flowerGeo = mergeGeometries([petal, stemG]);
    const flowerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    const FN = 300;
    const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, FN);
    for (let i = 0; i < FN; i++) {
      const a = hash01(`fa${i}`) * Math.PI * 2;
      const r = 5 + hash01(`fr${i}`) * (HUB_R - 9);
      m4.makeRotationY(hash01(`fq${i}`) * Math.PI);
      m4.setPosition(Math.cos(a) * r, 0, Math.sin(a) * r);
      flowers.setMatrixAt(i, m4);
      cv.set([0xf7e07a, 0xf0f0f0, 0xf0a8c0, 0xb8a8f0][i % 4]);
      flowers.setColorAt(i, cv);
    }
    scene.add(flowers);

    /* bushes: half-buried leaf blobs */
    const bushGeo = bakeVertexAO(
      mergeGeometries([
        (() => { const g = new THREE.IcosahedronGeometry(0.9, 1); return g; })(),
        (() => { const g = new THREE.IcosahedronGeometry(0.6, 1); g.translate(0.7, -0.1, 0.2); return g; })(),
        (() => { const g = new THREE.IcosahedronGeometry(0.55, 1); g.translate(-0.6, -0.12, -0.25); return g; })(),
      ]),
      -0.9,
      1.0,
      0.5,
    );
    const bushMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true, vertexColors: true });
    const BN = 90;
    const bushes = new THREE.InstancedMesh(bushGeo, bushMat, BN);
    bushes.castShadow = true;
    for (let i = 0; i < BN; i++) {
      const a = hash01(`ba${i}`) * Math.PI * 2;
      const r = 10 + hash01(`br${i}`) * (HUB_R - 14);
      const s = 0.6 + hash01(`bs${i}`) * 0.9;
      q.setFromAxisAngle(UPY, hash01(`bq${i}`) * Math.PI);
      sc.set(s, s, s);
      m4.compose(pos.set(Math.cos(a) * r, 0.45 * s, Math.sin(a) * r), q, sc);
      bushes.setMatrixAt(i, m4);
      cv.setHSL(0.29 + hash01(`bc${i}`) * 0.14, 0.5, 0.36 + hash01(`bl${i}`) * 0.12);
      bushes.setColorAt(i, cv);
    }
    scene.add(bushes);

    /* rocks: flattened dodecahedra */
    const rockGeo = bakeVertexAO(new THREE.DodecahedronGeometry(0.8, 0), -0.8, 0.8, 0.55);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true, vertexColors: true });
    const RN = 60;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, RN);
    rocks.castShadow = true;
    for (let i = 0; i < RN; i++) {
      const a = hash01(`ra${i}`) * Math.PI * 2;
      const r = 8 + hash01(`rr${i}`) * (HUB_R - 11);
      const s = 0.5 + hash01(`rs${i}`) * 1.1;
      q.setFromAxisAngle(UPY, hash01(`rq${i}`) * Math.PI);
      sc.set(s, s * 0.62, s);
      m4.compose(pos.set(Math.cos(a) * r, 0.28 * s, Math.sin(a) * r), q, sc);
      rocks.setMatrixAt(i, m4);
      cv.setHSL(0.55 + hash01(`rc${i}`) * 0.08, 0.08, 0.5 + hash01(`rl${i}`) * 0.16);
      rocks.setColorAt(i, cv);
    }
    scene.add(rocks);

    /* fallen logs — walkable micro-platforms */
    const logGeo = new THREE.CylinderGeometry(0.5, 0.55, 3.6, 9);
    logGeo.rotateZ(Math.PI / 2);
    bakeVertexAO(logGeo, -0.55, 0.55, 0.6);
    const logMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true, vertexColors: true });
    const LN = 14;
    const logs = new THREE.InstancedMesh(logGeo, logMat, LN);
    logs.castShadow = true;
    for (let i = 0; i < LN; i++) {
      const a = hash01(`la${i}`) * Math.PI * 2;
      const r = 18 + hash01(`lr${i}`) * (HUB_R - 32);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      q.setFromAxisAngle(UPY, hash01(`lq${i}`) * Math.PI);
      sc.set(1, 1, 1);
      m4.compose(pos.set(x, 0.5, z), q, sc);
      logs.setMatrixAt(i, m4);
      cv.setHSL(0.07 + hash01(`lc${i}`) * 0.03, 0.35, 0.3 + hash01(`ll${i}`) * 0.08);
      logs.setColorAt(i, cv);
      addBox(x, 0.5, z, 1.9, 0.5, 1.9);
    }
    scene.add(logs);

    /* tiny mushroom clusters */
    const shroomletGeo = mergeGeometries([
      (() => { const g = new THREE.CylinderGeometry(0.05, 0.07, 0.22, 5); g.translate(0, 0.11, 0); return g; })(),
      (() => { const g = new THREE.SphereGeometry(0.13, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2); g.translate(0, 0.2, 0); return g; })(),
      (() => { const g = new THREE.CylinderGeometry(0.04, 0.06, 0.16, 5); g.translate(0.18, 0.08, 0.06); return g; })(),
      (() => { const g = new THREE.SphereGeometry(0.09, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2); g.translate(0.18, 0.14, 0.06); return g; })(),
    ]);
    const shroomletMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 });
    const SN = 70;
    const shroomlets = new THREE.InstancedMesh(shroomletGeo, shroomletMat, SN);
    for (let i = 0; i < SN; i++) {
      const a = hash01(`sma${i}`) * Math.PI * 2;
      const r = 9 + hash01(`smr${i}`) * (HUB_R - 13);
      const s = 0.9 + hash01(`sms${i}`) * 1.2;
      q.setFromAxisAngle(UPY, hash01(`smq${i}`) * Math.PI);
      sc.set(s, s, s);
      m4.compose(pos.set(Math.cos(a) * r, 0, Math.sin(a) * r), q, sc);
      shroomlets.setMatrixAt(i, m4);
      cv.set([0xe25548, 0xf0b432, 0xb8a8f0][i % 3]);
      shroomlets.setColorAt(i, cv);
    }
    scene.add(shroomlets);
  }

  const clouds = [];
  for (let i = 0; i < 10; i++) {
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: cloudTexture(), transparent: true, opacity: 0.85, depthWrite: false }),
    );
    const a = hash01(`cl${i}`) * Math.PI * 2;
    const r = 90 + hash01(`cd${i}`) * 260;
    sp.position.set(Math.cos(a) * r, 55 + hash01(`ch${i}`) * 50, Math.sin(a) * r);
    sp.scale.set(60 + hash01(`cs${i}`) * 50, 26 + hash01(`cw${i}`) * 20, 1);
    scene.add(sp);
    clouds.push(sp);
  }

  /* drifting pollen — the air itself moves */
  let pollen = null;
  {
    const N = 200;
    const arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = hash01(`pa${i}`) * Math.PI * 2;
      const r = hash01(`pr${i}`) * (HUB_R - 6);
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = 0.6 + hash01(`ph${i}`) * 7;
      arr[i * 3 + 2] = Math.sin(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    pollen = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0xfff4d8,
        size: 0.16,
        transparent: true,
        opacity: 0.7,
        sizeAttenuation: true,
        depthWrite: false,
      }),
    );
    pollen.userData.base = arr.slice();
    scene.add(pollen);
  }

  /* butterflies fluttering between the flowers */
  const butterflies = [];
  {
    const wingGeo = new THREE.PlaneGeometry(0.26, 0.34);
    wingGeo.translate(0.13, 0, 0);
    const colors = [0xf0a8c0, 0xb8a8f0, 0xf7e07a, 0x9adcf0];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({
        color: colors[i % 4],
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
      });
      const l = new THREE.Mesh(wingGeo, mat);
      l.rotation.y = Math.PI;
      const r = new THREE.Mesh(wingGeo, mat);
      g.add(l, r);
      const a = hash01(`bfa${i}`) * Math.PI * 2;
      const rad = 12 + hash01(`bfr${i}`) * (HUB_R - 30);
      g.userData = { cx: Math.cos(a) * rad, cz: Math.sin(a) * rad, ph: i * 1.7, l, r };
      scene.add(g);
      butterflies.push(g);
    }
  }

  /* dust puffs + sparkles: one pooled sprite system */
  const puffs = [];
  {
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: cloudTexture(),
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      s.visible = false;
      scene.add(s);
      puffs.push({ s, life: 0, vy: 0, grow: 0 });
    }
  }
  function puffAt(x, y, z, color = 0xf2efe2, big = 1, rise = 0.6) {
    const p = puffs.find((q2) => q2.life <= 0) ?? puffs[0];
    p.s.material.color.set(color);
    p.s.position.set(x, y, z);
    p.s.scale.setScalar(0.6 * big);
    p.life = 0.55;
    p.vy = rise;
    p.grow = 2.6 * big;
    p.s.visible = true;
  }

  /* ----- article trees: saplings bloom when read ----- */

  const artTrees = [];
  {
    const signGeo = new THREE.PlaneGeometry(3.2, 1.6);
    const postGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.6, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9 });
    /* bloom tree: round pink-white canopy; sapling: a sprout */
    const bloomCanopy = mergeGeometries([
      (() => { const g = new THREE.IcosahedronGeometry(1.6, 1); return g; })(),
      (() => { const g = new THREE.IcosahedronGeometry(1.0, 1); g.translate(0.9, 0.6, 0.2); return g; })(),
      (() => { const g = new THREE.IcosahedronGeometry(0.95, 1); g.translate(-0.85, 0.5, -0.3); return g; })(),
    ]);
    bakeVertexAO(bloomCanopy, -1.6, 2.4, 0.62);
    const bloomMat = new THREE.MeshStandardMaterial({ color: 0xf2b8cc, roughness: 0.8, flatShading: true, vertexColors: true });
    const sproutMat = new THREE.MeshStandardMaterial({ color: 0x9ccf8a, roughness: 0.85, flatShading: true });
    const trunkG = new THREE.CylinderGeometry(0.18, 0.3, 2.2, 6);
    const trunkM = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9 });

    /* the trail: a spiral from the center out, one tree per article */
    posts.forEach((post, i) => {
      const isRead = post.slug && read.has(post.slug);
      const a = i * 0.55 + hash01(post.slug ?? String(i)) * 0.2;
      const r = 13 + i * 1.85;
      const x = Math.cos(a) * Math.min(r, HUB_R - 14);
      const z = Math.sin(a) * Math.min(r, HUB_R - 14);
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(trunkG, trunkM);
      trunk.position.y = isRead ? 1.1 : 0.5;
      trunk.scale.setScalar(isRead ? 1 : 0.55);
      trunk.castShadow = true;
      const crown = new THREE.Mesh(isRead ? bloomCanopy : new THREE.IcosahedronGeometry(0.7, 1), isRead ? bloomMat : sproutMat);
      crown.position.y = isRead ? 3.3 : 1.35;
      crown.castShadow = true;
      g.add(trunk, crown);
      /* the sign, angled toward the center path */
      const sPost = new THREE.Mesh(postGeo, postMat);
      sPost.position.set(1.6, 0.8, 0);
      const sign = new THREE.Mesh(
        signGeo,
        new THREE.MeshStandardMaterial({ map: signTexture(post, isRead), roughness: 0.8 }),
      );
      sign.position.set(1.6, 1.9, 0);
      sign.castShadow = true;
      g.add(sPost, sign);
      g.position.set(x, 0, z);
      g.lookAt(0, 0, 0);
      scene.add(g);
      treeCols.push({ x, z, r: 0.7 });
      artTrees.push({ group: g, sign, post, read: !!isRead, x, z });
    });
  }

  /* ----- coins ----- */

  const coins = [];
  {
    const coinGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.1, 14);
    coinGeo.rotateX(Math.PI / 2);
    const coinMat = new THREE.MeshStandardMaterial({
      color: GOLD,
      metalness: 0.6,
      roughness: 0.3,
      emissive: 0x6a4a08,
      emissiveIntensity: 0.4,
    });
    const addCoin = (x, y, z) => {
      const m = new THREE.Mesh(coinGeo, coinMat);
      m.position.set(x, y, z);
      m.userData.baseY = y;
      m.userData.ph = (x * 7 + z * 13) % 6.28;
      m.castShadow = true;
      scene.add(m);
      coins.push(m);
    };
    /* rings along the trail + arcs over mushrooms; courses add their own */
    for (let i = 0; i < 9; i++) {
      const a = hash01(`coin-ring${i}`) * Math.PI * 2;
      const r = 16 + hash01(`coin-r${i}`) * (HUB_R - 34);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      for (let k = 0; k < 5; k++) {
        const ka = (k / 5) * Math.PI * 2;
        addCoin(cx + Math.cos(ka) * 2.2, 1.1, cz + Math.sin(ka) * 2.2);
      }
    }
    coins.addCoin = addCoin;
  }

  /* ----- mushroom bouncers ----- */

  const shrooms = [];
  {
    const stemG = new THREE.CylinderGeometry(0.55, 0.7, 1.1, 10);
    const capG = new THREE.SphereGeometry(1.25, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const stemM = new THREE.MeshStandardMaterial({ color: 0xf2e8d8, roughness: 0.8 });
    const capM = new THREE.MeshStandardMaterial({ color: 0xe25548, roughness: 0.6 });
    const dotM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    for (let i = 0; i < 6; i++) {
      const a = hash01(`sh${i}`) * Math.PI * 2;
      const r = 22 + hash01(`shr${i}`) * (HUB_R - 44);
      const g = new THREE.Group();
      const stem = new THREE.Mesh(stemG, stemM);
      stem.position.y = 0.55;
      const cap = new THREE.Mesh(capG, capM);
      cap.position.y = 1.0;
      cap.castShadow = true;
      g.add(stem, cap);
      for (let d = 0; d < 3; d++) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5), dotM);
        const da = (d / 3) * Math.PI * 2 + i;
        dot.position.set(Math.cos(da) * 0.7, 1.55, Math.sin(da) * 0.7);
        g.add(dot);
      }
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      scene.add(g);
      shrooms.push({ g, cap, x: g.position.x, z: g.position.z, squish: 0 });
    }
  }

  /* ----- platform playground in the hub center ----- */

  const platMat = new THREE.MeshStandardMaterial({ color: 0x6abf6e, roughness: 0.85, vertexColors: true });
  const platSideMat = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.95, vertexColors: true });
  function addPlatform(x, y, z, hx, hz, mover) {
    const g = new THREE.Group();
    const top = new THREE.Mesh(bakeVertexAO(new RoundedBoxGeometry(hx * 2, 0.6, hz * 2, 2, 0.18), -0.3, 0.3, 0.62), platMat);
    const base = new THREE.Mesh(bakeVertexAO(new RoundedBoxGeometry(hx * 2 - 0.3, 0.9, hz * 2 - 0.3, 2, 0.18), -0.45, 0.45, 0.5), platSideMat);
    base.position.y = -0.7;
    top.castShadow = top.receiveShadow = true;
    g.add(top, base);
    g.position.set(x, y, z);
    scene.add(g);
    return addBox(x, y, z, hx, 0.3, hz, { mesh: g, mover });
  }
  {
    addPlatform(0, 2.2, -6, 2.4, 2.4);
    addPlatform(4.5, 4.4, -10, 2.2, 2.2);
    addPlatform(0, 6.6, -14, 2.2, 2.2);
    addPlatform(-5, 8.8, -10, 2, 2, { axis: 'x', amp: 3, speed: 0.7, phase: 0 });
    addPlatform(-9, 11, -3, 2, 2);
    coins.addCoin(0, 8, -14);
    coins.addCoin(-9, 13.4, -3);
  }

  /* ----- warp pipes → seeded courses ----- */

  const COURSE_NAMES = ['sprout climb', 'cloud steps', 'star summit'];
  const pipes = [];
  const stars = [];
  const gotStars = store.stars();
  {
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x2e9e44, roughness: 0.4, metalness: 0.15 });
    for (let k = 0; k < 3; k++) {
      const a = -0.5 + k * 0.55;
      const x = Math.cos(a) * (HUB_R - 22);
      const z = Math.sin(a) * (HUB_R - 22);
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 2.6, 18), pipeMat);
      body.position.y = 1.3;
      const lip = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 0.7, 18), pipeMat);
      lip.position.y = 2.85;
      body.castShadow = lip.castShadow = true;
      g.add(body, lip);
      g.position.set(x, 0, z);
      scene.add(g);
      addBox(x, 1.6, z, 1.85, 1.6, 1.85);
      pipes.push({ x, z, idx: k, done: gotStars.includes(k) });
    }
  }

  /* baked contact shadows: a dark breath under everything standing on the
     meadow — grounding the shadow map alone can't deliver at this size */
  {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');
    const blot = (x, z, r, a) => {
      const u = ((x / HUB_R) * 0.5 + 0.5) * 1024;
      const v = ((-z / HUB_R) * 0.5 + 0.5) * 1024; /* circle uv: +v is -z */
      const rr = (r / HUB_R) * 0.5 * 1024;
      const g = ctx.createRadialGradient(u, v, 0, u, v, rr);
      g.addColorStop(0, `rgba(10, 22, 10, ${a})`);
      g.addColorStop(1, 'rgba(10, 22, 10, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(u, v, rr, 0, Math.PI * 2);
      ctx.fill();
    };
    /* the trail: a sandy path tracing the article spiral */
    ctx.strokeStyle = 'rgba(196, 168, 118, 0.5)';
    ctx.lineWidth = (2.6 / HUB_R) * 0.5 * 1024 * 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i <= posts.length; i++) {
      const a = i * 0.55 + 0.1;
      const r = Math.min(13 + i * 1.85, HUB_R - 14) - 3.4;
      const u = ((Math.cos(a) * r) / HUB_R) * 0.5 * 1024 + 512;
      const v = ((-Math.sin(a) * r) / HUB_R) * 0.5 * 1024 + 512;
      if (i === 0) ctx.moveTo(u, v);
      else ctx.lineTo(u, v);
    }
    ctx.stroke();
    for (const t of treeCols) blot(t.x, t.z, t.r * 2.6, 0.34);
    for (const p of pipes) blot(p.x, p.z, 3.6, 0.4);
    for (const s of shrooms) blot(s.x, s.z, 2.6, 0.34);
    const tex = new THREE.CanvasTexture(c);
    const overlay = new THREE.Mesh(
      new THREE.CircleGeometry(HUB_R, 48),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    overlay.rotation.x = -Math.PI / 2;
    overlay.position.y = 0.04;
    overlay.renderOrder = 1;
    scene.add(overlay);
  }

  const courseSpots = []; // island positions — decorated after the build
  /* a course: floating islands ascending to a star, offset far from the hub */
  function buildCourse(k) {
    const rnd = mulberry(hash32(`course-${k}`));
    const ox = 700 + k * 700;
    const island = (x, y, z, hx, hz) => {
      const g = new THREE.Group();
      const top = new THREE.Mesh(bakeVertexAO(new RoundedBoxGeometry(hx * 2, 0.7, hz * 2, 2, 0.2), -0.35, 0.35, 0.62), platMat);
      const base = new THREE.Mesh(bakeVertexAO(new THREE.CylinderGeometry(Math.min(hx, hz) * 0.8, 0.3, 1.6, 8), -0.8, 0.8, 0.45), platSideMat);
      base.position.y = -1.1;
      top.castShadow = top.receiveShadow = true;
      g.add(top, base);
      g.position.set(x, y, z);
      scene.add(g);
      courseSpots.push({ x, y, z, hx });
      return addBox(x, y, z, hx, 0.35, hz, { mesh: g });
    };
    /* start pad */
    island(ox, 0, 0, 5, 5);
    let px = ox;
    let py = 0;
    let pz = 0;
    const n = 10 + k * 3;
    for (let i = 0; i < n; i++) {
      const da = (rnd() - 0.5) * 2.4;
      const dist = 4.5 + rnd() * 2.5 + k;
      px += Math.sin(da) * dist;
      pz -= Math.cos(da) * dist;
      py += 1.6 + rnd() * 1.2;
      const hx = 1.5 + rnd() * 1.2;
      if (rnd() < 0.25 + k * 0.12 && i > 1) {
        /* a mover: ride it */
        const axis = rnd() < 0.5 ? 'x' : 'y';
        const b = island(px, py, pz, hx, hx);
        b.mover = { axis, amp: 2 + rnd() * 2, speed: 0.6 + rnd() * 0.5, phase: rnd() * 6 };
        movers.push(b);
      } else island(px, py, pz, hx, hx);
      if (rnd() < 0.6) coins.addCoin(px, py + 1.5, pz);
    }
    /* summit + star */
    island(px, py + 2, pz - 6, 3.4, 3.4);
    const starGeo = new THREE.OctahedronGeometry(1.0, 0);
    starGeo.scale(1, 1.35, 1);
    const star = new THREE.Mesh(
      starGeo,
      new THREE.MeshStandardMaterial({
        color: GOLD,
        emissive: 0x8a6210,
        emissiveIntensity: 0.8,
        metalness: 0.5,
        roughness: 0.3,
      }),
    );
    star.position.set(px, py + 4.6, pz - 6);
    star.castShadow = true;
    star.visible = !gotStars.includes(k);
    scene.add(star);
    stars.push({ mesh: star, idx: k, x: px, y: py + 4.6, z: pz - 6 });
    return { spawn: new THREE.Vector3(ox, 1.2, 0) };
  }
  const courses = [buildCourse(0), buildCourse(1), buildCourse(2)];

  /* course atmosphere: drifting rock shards around the islands + a flag
     on every start pad */
  {
    const shardGeo = new THREE.DodecahedronGeometry(0.7, 0);
    const shardMat = new THREE.MeshStandardMaterial({ color: 0xa8b8c4, roughness: 0.9, flatShading: true });
    const N = Math.min(140, courseSpots.length * 2);
    const shards = new THREE.InstancedMesh(shardGeo, shardMat, N);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      const sp = courseSpots[i % courseSpots.length];
      const a = hash01(`shard${i}`) * Math.PI * 2;
      const d = sp.hx + 2.5 + hash01(`shardd${i}`) * 5;
      const s = 0.35 + hash01(`shards${i}`) * 0.8;
      m4.makeRotationY(hash01(`shardq${i}`) * Math.PI);
      m4.scale(new THREE.Vector3(s, s, s));
      m4.setPosition(
        sp.x + Math.cos(a) * d,
        sp.y - 1.5 - hash01(`shardy${i}`) * 4,
        sp.z + Math.sin(a) * d,
      );
      shards.setMatrixAt(i, m4);
    }
    scene.add(shards);

    const flagPoleMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc2, roughness: 0.6 });
    for (let k = 0; k < courses.length; k++) {
      const sp = courses[k].spawn;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 4.2, 6), flagPoleMat);
      pole.position.set(sp.x + 3, 2.1, sp.z - 2);
      pole.castShadow = true;
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 0.9),
        new THREE.MeshStandardMaterial({
          color: [0x58c46a, 0x4aa8e0, 0xf0b432][k],
          side: THREE.DoubleSide,
          roughness: 0.7,
        }),
      );
      flag.position.set(sp.x + 3.75, 3.7, sp.z - 2);
      scene.add(pole, flag);
    }
  }

  /* ----- the player: a little sprout-bot ----- */

  function makePlayer() {
    const p = new THREE.Group();
    const body = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0x58c46a, roughness: 0.5 });
    const belly = new THREE.MeshStandardMaterial({ color: 0xf2eedd, roughness: 0.6 });
    const tub = new THREE.Mesh(new RoundedBoxGeometry(0.9, 1.0, 0.74, 3, 0.3), skin);
    tub.position.y = 0.62;
    const face = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.5, 0.1, 2, 0.05), belly);
    face.position.set(0, 0.72, 0.34);
    const eyeM = new THREE.MeshStandardMaterial({ color: 0x202830, roughness: 0.3 });
    for (const sx of [-0.15, 0.15]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), eyeM);
      eye.position.set(sx, 0.78, 0.4);
      body.add(eye);
    }
    /* the sprout on top — grows leaves with your read count */
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.35, 6), skin);
    stem.position.y = 1.3;
    const leafG = new THREE.SphereGeometry(0.17, 6, 5);
    leafG.scale(1.6, 0.5, 0.8);
    const leafM = new THREE.MeshStandardMaterial({ color: 0x7adf8a, roughness: 0.6 });
    const leaves = Math.min(4, 1 + Math.floor(read.size / 3));
    for (let i = 0; i < leaves; i++) {
      const leaf = new THREE.Mesh(leafG, leafM);
      leaf.position.y = 1.5;
      leaf.rotation.y = (i / leaves) * Math.PI * 2;
      leaf.rotation.z = 0.5;
      leaf.position.x = Math.cos((i / leaves) * Math.PI * 2) * 0.14;
      leaf.position.z = Math.sin((i / leaves) * Math.PI * 2) * 0.14;
      body.add(leaf);
    }
    const feet = [];
    for (const sx of [-0.26, 0.26]) {
      const foot = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.2, 0.42, 2, 0.08), belly);
      foot.position.set(sx, 0.1, 0.02);
      body.add(foot);
      feet.push(foot);
    }
    body.add(tub, face, stem);
    body.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    /* soft blob shadow helper for height reading */
    const blobShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 18),
      new THREE.MeshBasicMaterial({ color: 0x1a3a20, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    blobShadow.rotation.x = -Math.PI / 2;
    p.add(body, blobShadow);
    p.userData = { body, feet, blobShadow };
    return p;
  }
  const player = makePlayer();
  scene.add(player);

  /* ----- state ----- */

  const vel = new THREE.Vector3();
  let onGround = false;
  let groundBox = null;
  let coyote = 0;
  let jumpBuf = 0;
  let usedDouble = false;
  let dashT = 0;
  let dashCd = 0;
  let gliding = false;
  let facing = 0;
  let squash = 0;
  let inCourse = -1; // -1 = hub
  let coinCount = store.coins();
  let camYaw = 0.6;
  let camPitch = 0.38;
  let camDist = 13;
  const keys = { f: false, b: false, l: false, r: false, jump: false, dash: false };
  let nearTree = -1;
  let nearPipe = -1;
  let birdT = 4;

  const SPAWN = new THREE.Vector3(0, 1.2, 19);
  {
    let placed = false;
    const saved = store.playerState();
    if (saved && Array.isArray(saved.p) && Date.now() - (saved.t ?? 0) < 45 * 60 * 1000) {
      try {
        player.position.fromArray(saved.p);
        inCourse = saved.c ?? -1;
        placed = true;
      } catch {}
    }
    if (!placed) {
      let atSlug = null;
      try {
        atSlug = sessionStorage.getItem('canopy-at');
      } catch {}
      const t = artTrees.find((a) => a.post.slug && a.post.slug === atSlug);
      if (t) player.position.set(t.x * 0.92, 1.2, t.z * 0.92);
      else player.position.copy(SPAWN);
    }
  }

  function savePlayer() {
    if (!isWorld) return;
    store.playerState({ p: player.position.toArray(), c: inCourse, t: Date.now() });
  }

  function respawn() {
    const at = inCourse >= 0 ? courses[inCourse].spawn : SPAWN;
    player.position.copy(at);
    vel.set(0, 0, 0);
    audio.land();
    hud?.toast('back on your feet');
  }

  function warpTo(courseIdx) {
    audio.warp();
    if (courseIdx >= 0) {
      inCourse = courseIdx;
      player.position.copy(courses[courseIdx].spawn);
      const el = hud?.els?.course;
      if (el) {
        el.hidden = false;
        el.textContent = `★ ${COURSE_NAMES[courseIdx]} — reach the star`;
      }
    } else {
      inCourse = -1;
      player.position.copy(SPAWN);
      if (hud?.els?.course) hud.els.course.hidden = true;
    }
    vel.set(0, 0, 0);
    camYaw = facing + Math.PI;
  }

  /* ----- input ----- */

  const stick = { id: -1, x0: 0, y0: 0, x: 0, y: 0, live: false };
  const STICK_R = 52;
  const drag = { id: -1, lx: 0, ly: 0 };

  function bindInput() {
    const el = renderer.domElement;

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
    addEventListener('pagehide', savePlayer, { signal });

    const overlay = hud?.querySelector('[data-cp-overlay]');
    let overlayGone = false;
    const dismissOverlay = () => {
      if (overlayGone) return;
      overlayGone = true;
      overlay?.classList.add('hidden');
    };
    setTimeout(dismissOverlay, 6500);

    const kset = (k, v) => {
      if (['w', 'W', 'ArrowUp'].includes(k)) keys.f = v;
      else if (['s', 'S', 'ArrowDown'].includes(k)) keys.b = v;
      else if (['a', 'A', 'ArrowLeft'].includes(k)) keys.l = v;
      else if (['d', 'D', 'ArrowRight'].includes(k)) keys.r = v;
      else if (k === ' ') {
        if (v && !keys.jump) jumpBuf = 0.12;
        keys.jump = v;
      } else if (k === 'Shift') keys.dash = v;
      else return false;
      return true;
    };
    addEventListener(
      'keydown',
      (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        audio.unlock();
        dismissOverlay();
        if (kset(e.key, true)) {
          e.preventDefault();
          return;
        }
        if (['m', 'M'].includes(e.key)) toggleMute();
        else if (e.key === 'Enter' && document.activeElement === document.body) {
          if (nearTree >= 0) location.href = artTrees[nearTree].post.href;
          else if (nearPipe >= 0) warpTo(pipes[nearPipe].idx);
        }
      },
      { signal },
    );
    addEventListener('keyup', (e) => kset(e.key, false), { signal });

    /* touch stick (left zone) */
    const stickEl = hud?.querySelector('[data-cp-stick]');
    const stickNub = stickEl?.querySelector('i');
    el.addEventListener(
      'pointerdown',
      (e) => {
        audio.unlock();
        dismissOverlay();
        if (e.pointerType === 'touch') {
          if (stick.id < 0 && e.clientX < innerWidth * 0.55) {
            stick.id = e.pointerId;
            stick.x0 = e.clientX;
            stick.y0 = e.clientY;
            stick.x = stick.y = 0;
            return;
          }
        } else if (drag.id < 0) {
          drag.id = e.pointerId;
          drag.lx = e.clientX;
          drag.ly = e.clientY;
        }
      },
      { signal },
    );
    el.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId === stick.id) {
          const dx = e.clientX - stick.x0;
          const dy = e.clientY - stick.y0;
          const len = Math.hypot(dx, dy);
          const k = len > STICK_R ? STICK_R / len : 1;
          stick.x = (dx * k) / STICK_R;
          stick.y = (dy * k) / STICK_R;
          if (!stick.live && len > 10 && stickEl) {
            stick.live = true;
            stickEl.hidden = false;
            stickEl.style.left = `${stick.x0}px`;
            stickEl.style.top = `${stick.y0}px`;
          }
          if (stick.live && stickNub) stickNub.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
        } else if (e.pointerId === drag.id) {
          camYaw -= (e.clientX - drag.lx) * 0.006;
          camPitch = THREE.MathUtils.clamp(camPitch + (e.clientY - drag.ly) * 0.004, 0.08, 1.1);
          drag.lx = e.clientX;
          drag.ly = e.clientY;
        }
      },
      { signal },
    );
    const release = (e) => {
      if (e.pointerId === stick.id) {
        stick.id = -1;
        stick.x = stick.y = 0;
        stick.live = false;
        if (stickEl) stickEl.hidden = true;
        if (stickNub) stickNub.style.transform = '';
      }
      if (e.pointerId === drag.id) drag.id = -1;
    };
    el.addEventListener('pointerup', release, { signal });
    el.addEventListener('pointercancel', release, { signal });
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.01, 7, 22);
      },
      { passive: false, signal },
    );

    /* touch cluster */
    const bindBtn = (sel, on, off) => {
      const b = hud?.querySelector(sel);
      if (!b) return;
      b.addEventListener(
        'pointerdown',
        (e) => {
          e.preventDefault();
          audio.unlock();
          dismissOverlay();
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
    bindBtn(
      '[data-cp-jump]',
      () => {
        jumpBuf = 0.12;
        keys.jump = true;
      },
      () => (keys.jump = false),
    );
    bindBtn('[data-cp-dash]', () => (keys.dash = true), () => (keys.dash = false));

    hud?.querySelector('[data-cp-card]')?.addEventListener(
      'click',
      () => {
        if (nearTree >= 0) location.href = artTrees[nearTree].post.href;
        else if (nearPipe >= 0) warpTo(pipes[nearPipe].idx);
      },
      { signal },
    );
    hud?.querySelector('[data-cp-mute]')?.addEventListener('click', toggleMute, { signal });
    hud?.querySelector('[data-cp-fx]')?.addEventListener('click', toggleFx, { signal });
    syncMute();
    syncFx();
  }

  function syncMute() {
    const b = hud?.querySelector('[data-cp-mute]');
    if (b) b.textContent = audio.muted() ? '♪ off' : '♪ on';
  }

  function syncFx() {
    const b = hud?.querySelector('[data-cp-fx]');
    if (b) b.textContent = store.fx() ? '✨ fx on' : '✨ fx off';
  }

  function toggleFx() {
    const on = !store.fx();
    store.fx(on);
    gtaoPass.enabled = on;
    syncFx();
    hud?.toast(on ? '✨ fancy rendering on' : '✨ fancy rendering off — smoother on small devices');
  }

  function toggleMute() {
    audio.unlock();
    audio.setMuted(!audio.muted());
    syncMute();
  }

  function renderPowers() {
    const el = hud?.querySelector('[data-cp-powers]');
    if (!el) return;
    el.innerHTML = POWERS.map(
      (p) =>
        `<span class="${read.size >= p.need ? 'on' : ''}" title="${p.desc}">${p.name}${
          read.size >= p.need ? '' : ` ✿${p.need}`
        }</span>`,
    ).join('');
    const readEl = hud?.querySelector('[data-cp-read]');
    if (readEl) readEl.textContent = `${read.size}/${posts.length}`;
  }

  /* ----- physics + game loop ----- */

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const camLook = new THREE.Vector3(); // dedicated — never aliases the scratch
  let hudTimer = 0;

  const maxRun = () => (powerOn('boost') ? 16 : 13);
  const jumpV = () => (powerOn('boost') ? 18 : 15.5);

  /* highest support under the player's feet. refY must be the PRE-step y:
     filtering by the post-step y lets a fast fall skip past a floor in one
     frame and tunnel through the map */
  function findGround(refY = player.position.y) {
    const px = player.position.x;
    const py = refY;
    const pz = player.position.z;
    let best = -Infinity;
    let bestBox = null;
    for (const b of boxes) {
      if (b.round) {
        /* the hub disc */
        if (px * px + pz * pz > b.round * b.round) continue;
      } else if (Math.abs(px - b.x) > b.hx + 0.3 || Math.abs(pz - b.z) > b.hz + 0.3) continue;
      const top = b.y + b.hy;
      if (top <= py + 0.25 && top > best) {
        best = top;
        bestBox = b;
      }
    }
    return { top: best, box: bestBox };
  }

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    /* --- movers shift their boxes (and whoever stands on them) --- */
    for (const b of movers) {
      const m = b.mover;
      m.base ??= { x: b.x, y: b.y, z: b.z };
      const off = reduced ? 0 : Math.sin(time * m.speed + m.phase) * m.amp;
      const nx = m.base.x + (m.axis === 'x' ? off : 0);
      const ny = m.base.y + (m.axis === 'y' ? off : 0);
      const nz = m.base.z + (m.axis === 'z' ? off : 0);
      const dx = nx - b.x;
      const dy = ny - b.y;
      const dz = nz - b.z;
      b.x = nx;
      b.y = ny;
      b.z = nz;
      b.mesh?.position.set(nx, ny, nz);
      if (groundBox === b) {
        player.position.x += dx;
        player.position.y += dy;
        player.position.z += dz;
      }
    }

    /* --- input → camera-relative run --- */
    let ix = 0;
    let iz = 0;
    if (stick.id >= 0) {
      ix = stick.x;
      iz = stick.y;
    } else {
      ix = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
      iz = (keys.b ? 1 : 0) - (keys.f ? 1 : 0);
    }
    const ilen = Math.hypot(ix, iz);
    if (ilen > 1) {
      ix /= ilen;
      iz /= ilen;
    }
    /* rotate by camera yaw */
    const sin = Math.sin(camYaw);
    const cos = Math.cos(camYaw);
    const wx = ix * cos - iz * sin;
    const wz = ix * sin + iz * cos;

    dashCd = Math.max(0, dashCd - dt);
    if (keys.dash && powerOn('dash') && dashCd <= 0 && dashT <= 0 && ilen > 0.2) {
      dashT = 0.18;
      dashCd = 0.9;
      audio.dash();
    }
    dashT = Math.max(0, dashT - dt);

    const accel = onGround ? 70 : 26;
    const target = maxRun() * (dashT > 0 ? 2.1 : 1);
    if (ilen > 0.05 || dashT > 0) {
      vel.x = THREE.MathUtils.lerp(vel.x, wx * target, 1 - Math.exp((-dt * accel) / target));
      vel.z = THREE.MathUtils.lerp(vel.z, wz * target, 1 - Math.exp((-dt * accel) / target));
      facing = Math.atan2(vel.x, vel.z);
    } else if (onGround) {
      vel.x *= Math.exp(-dt * 10);
      vel.z *= Math.exp(-dt * 10);
    }

    /* --- jumping --- */
    jumpBuf = Math.max(0, jumpBuf - dt);
    coyote = Math.max(0, coyote - dt);
    if (jumpBuf > 0) {
      if (onGround || coyote > 0) {
        vel.y = jumpV();
        onGround = false;
        coyote = 0;
        jumpBuf = 0;
        usedDouble = false;
        squash = -0.5;
        puffAt(player.position.x, player.position.y + 0.1, player.position.z, 0xf2efe2, 0.8, 0.3);
        audio.jump();
      } else if (powerOn('djump') && !usedDouble) {
        vel.y = jumpV() * 0.92;
        usedDouble = true;
        jumpBuf = 0;
        squash = -0.5;
        puffAt(player.position.x, player.position.y + 0.3, player.position.z, 0xcdf2d2, 0.9, 0.2);
        audio.djump();
      }
    }
    /* variable jump height: let go early, rise less */
    if (!keys.jump && vel.y > 6) vel.y = 6;
    /* glide: hold jump while falling */
    gliding = keys.jump && !onGround && vel.y < 0 && powerOn('glide');
    vel.y -= (gliding ? 14 : 42) * dt;
    if (gliding) vel.y = Math.max(vel.y, -3.2);
    vel.y = Math.max(vel.y, -34); // terminal velocity keeps step sizes sane

    /* --- integrate + collide --- */
    player.position.x += vel.x * dt;
    player.position.z += vel.z * dt;
    /* tree trunks push back */
    for (const t of treeCols) {
      const dx = player.position.x - t.x;
      const dz = player.position.z - t.z;
      const rr = t.r + 0.5;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-4 && player.position.y < 4) {
        const d = Math.sqrt(d2);
        player.position.x = t.x + (dx / d) * rr;
        player.position.z = t.z + (dz / d) * rr;
      }
    }
    /* box walls: push out horizontally when below their tops */
    for (const b of boxes) {
      if (b.round) continue;
      const dy = player.position.y - b.y;
      if (dy > b.hy - 0.1 || dy < -b.hy - 1.4) continue;
      const dx = player.position.x - b.x;
      const dz = player.position.z - b.z;
      const ox = b.hx + 0.45 - Math.abs(dx);
      const oz = b.hz + 0.45 - Math.abs(dz);
      if (ox > 0 && oz > 0) {
        if (ox < oz) player.position.x += Math.sign(dx) * ox;
        else player.position.z += Math.sign(dz) * oz;
      }
    }

    const prevY = player.position.y;
    const g = findGround(prevY); // sweep from where the fall STARTED
    player.position.y += vel.y * dt;
    if (vel.y <= 0 && g.top > -Infinity && prevY >= g.top - 0.05 && player.position.y <= g.top) {
      player.position.y = g.top;
      if (!onGround) {
        if (vel.y < -18) squash = 1;
        else if (vel.y < -6) squash = 0.5;
        if (vel.y < -6) puffAt(player.position.x, player.position.y + 0.15, player.position.z, 0xf2efe2, Math.min(1.6, -vel.y * 0.06), 0.5);
        audio.land();
      }
      vel.y = 0;
      onGround = true;
      groundBox = g.box;
      coyote = 0.12;
      usedDouble = false;
    } else {
      if (onGround && vel.y <= 0) coyote = 0.12;
      onGround = false;
      groundBox = null;
    }

    /* fell off the world */
    if (player.position.y < -34) respawn();

    /* --- mushrooms bounce --- */
    for (const sh of shrooms) {
      sh.squish = Math.max(0, sh.squish - dt * 3);
      sh.cap.scale.y = 1 - sh.squish * 0.45;
      const dx = player.position.x - sh.x;
      const dz = player.position.z - sh.z;
      if (dx * dx + dz * dz < 1.6 && player.position.y < 2.2 && player.position.y > 0.6 && vel.y <= 0) {
        vel.y = 24;
        onGround = false;
        usedDouble = false;
        sh.squish = 1;
        squash = -0.7;
        puffAt(sh.x, 2.1, sh.z, 0xf2c4be, 1.2, 0.8);
        audio.bounce();
      }
    }

    /* --- coins --- */
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      if (!reduced) {
        c.rotation.y += dt * 3.2;
        c.position.y = c.userData.baseY + Math.sin(time * 2 + c.userData.ph) * 0.12;
      }
      tmpV.copy(c.position).sub(player.position);
      tmpV.y -= 0.8;
      if (tmpV.lengthSq() < 1.7) {
        puffAt(c.position.x, c.position.y, c.position.z, 0xffd766, 0.7, 1.4);
        scene.remove(c);
        coins.splice(i, 1);
        coinCount = store.coins(1);
        audio.coin();
        if (hud?.els) hud.els.coins.textContent = coinCount;
      }
    }

    /* --- stars --- */
    for (const st of stars) {
      if (!st.mesh.visible) continue;
      if (!reduced) {
        st.mesh.rotation.y += dt * 1.6;
        st.mesh.position.y = st.y + Math.sin(time * 2) * 0.25;
      }
      tmpV.set(st.x - player.position.x, st.mesh.position.y - player.position.y - 0.8, st.z - player.position.z);
      if (tmpV.lengthSq() < 3.2) {
        st.mesh.visible = false;
        store.stars(st.idx);
        audio.star();
        hud?.toast(`★ ${COURSE_NAMES[st.idx]} cleared!`, 'gold');
        if (hud?.els) hud.els.stars.textContent = `${store.stars().length}/3`;
        setTimeout(() => {
          if (!signal.aborted) warpTo(-1);
        }, 1400);
      }
    }

    /* --- near a tree sign or a pipe? --- */
    let bestTree = -1;
    let bestD = 36;
    for (let i = 0; i < artTrees.length; i++) {
      const t = artTrees[i];
      const dx = t.x - player.position.x;
      const dz = t.z - player.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        bestTree = i;
      }
    }
    let bestPipe = -1;
    if (inCourse < 0) {
      for (let i = 0; i < pipes.length; i++) {
        const dx = pipes[i].x - player.position.x;
        const dz = pipes[i].z - player.position.z;
        if (dx * dx + dz * dz < 16) bestPipe = i;
      }
    }
    if (bestPipe >= 0) bestTree = -1;
    if (bestTree !== nearTree || bestPipe !== nearPipe) {
      nearTree = bestTree;
      nearPipe = bestPipe;
      const card = hud?.els?.card;
      if (card) {
        if (nearPipe >= 0) {
          const p = pipes[nearPipe];
          card.hidden = false;
          card.innerHTML = `<b>⤵ warp pipe: ${COURSE_NAMES[p.idx]}</b><span>a floating course — bring back the star${
            p.done ? ' (★ already yours)' : ''
          }</span><i>${coarse ? 'TAP TO WARP' : 'PRESS ⏎ TO WARP'}</i>`;
        } else if (nearTree >= 0) {
          const t = artTrees[nearTree];
          card.hidden = false;
          card.innerHTML = `<b>${t.read ? '✿' : '🌱'} ${t.post.title}</b><span>${t.post.date}${
            t.read ? ' · bloomed' : ' · reading grows a power'
          }</span><i>${coarse ? 'TAP TO READ' : 'PRESS ⏎ TO READ'}</i>`;
        } else card.hidden = true;
      }
    }

    /* --- player visuals: facing, squash, feet, blob shadow --- */
    const { body, feet, blobShadow } = player.userData;
    body.rotation.y = THREE.MathUtils.lerp(body.rotation.y, facing, 1 - Math.exp(-dt * 12));
    squash *= Math.exp(-dt * 7);
    body.scale.y = 1 - squash * 0.3;
    body.scale.x = body.scale.z = 1 + squash * 0.18;
    const speed2 = vel.x * vel.x + vel.z * vel.z;
    if (onGround && speed2 > 4) {
      const step = Math.sin(time * 14);
      feet[0].position.y = 0.1 + Math.max(0, step) * 0.18;
      feet[1].position.y = 0.1 + Math.max(0, -step) * 0.18;
    } else {
      feet[0].position.y = feet[1].position.y = 0.1;
    }
    if (gliding && !reduced) body.rotation.z = Math.sin(time * 6) * 0.12;
    else body.rotation.z = 0;
    const gB = findGround();
    blobShadow.position.y = (gB.top > -Infinity ? gB.top : 0) - player.position.y + 0.03;
    blobShadow.material.opacity = THREE.MathUtils.clamp(
      0.3 - (player.position.y - (gB.top > -Infinity ? gB.top : 0)) * 0.02,
      0.06,
      0.3,
    );

    /* --- env animation --- */
    if (!reduced) {
      for (const cl of clouds) {
        cl.position.x += dt * 1.4;
        if (cl.position.x > 420) cl.position.x = -420;
      }
      const pp = pollen.geometry.attributes.position;
      const base = pollen.userData.base;
      for (let i = 0; i < pp.count; i++) {
        pp.array[i * 3] = base[i * 3] + Math.sin(time * 0.4 + i) * 1.8;
        pp.array[i * 3 + 1] = base[i * 3 + 1] + Math.sin(time * 0.7 + i * 2.1) * 0.9;
        pp.array[i * 3 + 2] = base[i * 3 + 2] + Math.cos(time * 0.3 + i * 1.3) * 1.8;
      }
      pp.needsUpdate = true;
      for (const bf of butterflies) {
        const u = bf.userData;
        bf.position.set(
          u.cx + Math.sin(time * 0.5 + u.ph) * 4,
          1.4 + Math.sin(time * 1.1 + u.ph) * 0.8,
          u.cz + Math.cos(time * 0.37 + u.ph) * 4,
        );
        bf.rotation.y = time * 0.5 + u.ph + Math.PI / 2;
        const flap = Math.sin(time * 14 + u.ph) * 0.9;
        u.l.rotation.y = Math.PI - flap;
        u.r.rotation.y = flap;
      }
    }
    for (const p of puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.s.position.y += p.vy * dt;
      p.s.scale.addScalar(p.grow * dt);
      p.s.material.opacity = Math.max(0, p.life * 1.4);
      if (p.life <= 0) p.s.visible = false;
    }
    birdT -= dt;
    if (birdT <= 0) {
      birdT = 3 + Math.random() * 6;
      audio.bird();
    }

    sky.position.copy(player.position);

    /* --- sun follows (texel-snapped) --- */
    const sx = Math.round(player.position.x / 4) * 4;
    const sz = Math.round(player.position.z / 4) * 4;
    sun.position.set(sx + SUN_OFF.x, SUN_OFF.y, sz + SUN_OFF.z);
    sun.target.position.set(sx, 0, sz);

    /* --- camera: orbit follow --- */
    const cy = Math.sin(camPitch) * camDist;
    const ch = Math.cos(camPitch) * camDist;
    tmpV2.set(
      player.position.x + Math.sin(camYaw) * ch,
      player.position.y + cy + 1.2,
      player.position.z + Math.cos(camYaw) * ch,
    );
    camera.position.lerp(tmpV2, reduced ? 1 : 1 - Math.exp(-dt * 6));
    camLook.copy(player.position);
    camLook.y += 1.4;
    camera.lookAt(camLook);

    /* --- HUD tick --- */
    if ((hudTimer += dt) > 0.25 && hud?.els) {
      hudTimer = 0;
    }

    composer.render();
    raf = requestAnimationFrame(frame);
  }

  /* ----- boot ----- */

  const start = async () => {
    try {
      await Promise.race([
        Promise.all([
          document.fonts.load('600 44px "Fredoka Variable"'),
          document.fonts.load('26px "Nunito Variable"'),
        ]),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    } catch {}
    if (signal.aborted) return;
    /* redraw signs now the display font is in */
    for (const t of artTrees) {
      const tex = signTexture(t.post, t.read);
      t.sign.material.map?.dispose();
      t.sign.material.map = tex;
      t.sign.material.needsUpdate = true;
    }
    hud = makeHud(POWERS, coinCount, store.stars().length, posts.length);
    hud.els = {
      coins: hud.querySelector('[data-cp-coins]'),
      stars: hud.querySelector('[data-cp-stars]'),
      card: hud.querySelector('[data-cp-card]'),
      course: hud.querySelector('[data-cp-course]'),
    };
    renderPowers();
    document.documentElement.dataset.world = 'on';
    bindInput();
    if (inCourse >= 0) {
      const el = hud.els.course;
      el.hidden = false;
      el.textContent = `★ ${COURSE_NAMES[inCourse]} — reach the star`;
    }
    camera.position.copy(player.position).add(new THREE.Vector3(0, 6, 13));
    raf = requestAnimationFrame(frame);
  };
  start();

  function unmount() {
    savePlayer();
    audio.dispose();
    ac.abort();
    cancelAnimationFrame(raf);
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (m.userData?.shared) continue;
        if (!m.map?.userData?.shared) m.map?.dispose?.();
        m.dispose?.();
      }
    });
    bloomPass.dispose();
    gtaoPass.dispose();
    gradePass.dispose();
    composer.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
    hud?.remove();
    delete document.documentElement.dataset.world;
  }

  return { unmount };
}
