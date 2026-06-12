/* ---------------------------------------------------------------------------
   SODIUM — night drive.

   The blog as a nocturne you drive through. A ring road circles a lake;
   every post is a glowing billboard exit on the outer shoulder, dark and
   scrambled until you pull up close — discovery is the game. Real-time
   shadows from a low moon, a custom sky shader (stars, moon, a faint
   aurora), planar-reflective water with procedural wave normals, wind
   turbines turning over the lake, drifting clouds, fireflies, sodium
   streetlights. The car is arcade-but-honest: lateral grip you can break
   with the handbrake, suspension lean, speed-dependent steering, engine
   and skid audio synthesized in WebAudio.

   Controls (desktop): W gas · S brake/reverse · A/D steer · space
   handbrake · ↵ read at an exit · M sound. Touch: left side steers
   (virtual stick, x-axis), right cluster has gas (latch), brake and
   drift (hold). Tap the exit card to read.

   Loaded lazily, only while [data-style="sodium"] is active. mount()
   reads the post list from the DOM and returns { unmount }.
--------------------------------------------------------------------------- */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Water } from 'three/addons/objects/Water.js';

const NIGHT = 0x070b16;
const SODIUM = 0xffb45e;
const CYANL = 0xcfe8ff;
const ROAD_R = 140;
const ROAD_W = 8; // half-width
const LAKE_R = 72;

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

const FOUND_KEY = 'sodium-found';
const CAR_KEY = 'sodium-car'; // sessionStorage: car state across page visits
const MUTE_KEY = 'sodium-mute';

const store = {
  found() {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOUND_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  },
  find(slug) {
    const f = this.found();
    const fresh = !f.has(slug);
    f.add(slug);
    try {
      localStorage.setItem(FOUND_KEY, JSON.stringify([...f]));
    } catch {}
    return fresh;
  },
  muted(set) {
    try {
      if (set !== undefined) localStorage.setItem(MUTE_KEY, set ? '1' : '');
      return !!localStorage.getItem(MUTE_KEY);
    } catch {
      return false;
    }
  },
  carState(state) {
    try {
      if (state === undefined) return JSON.parse(sessionStorage.getItem(CAR_KEY) ?? 'null');
      if (state === null) sessionStorage.removeItem(CAR_KEY);
      else sessionStorage.setItem(CAR_KEY, JSON.stringify(state));
    } catch {}
    return null;
  },
};

const hash01 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
};

const slugOf = (href) => href?.match(/\/posts\/([^/]+)\/?/)?.[1] ?? null;

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
      draft: !!titleEl.querySelector('.draft-badge'),
    };
  });
}

/* ----- synth audio: engine bed, skid, chimes — no assets ----- */

function makeAudio() {
  let ctx = null;
  let master = null;
  let engineOsc = null;
  let engineGain = null;
  let engineFilter = null;
  let skidGain = null;
  let muted = store.muted();

  const ensure = () => {
    if (!ctx) {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.32;
      master.connect(ctx.destination);
      /* engine: a saw through a lowpass, pitch rides the speed */
      engineOsc = ctx.createOscillator();
      engineOsc.type = 'sawtooth';
      engineOsc.frequency.value = 42;
      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 320;
      engineGain = ctx.createGain();
      engineGain.gain.value = 0;
      engineOsc.connect(engineFilter).connect(engineGain).connect(master);
      engineOsc.start();
      /* skid: looped noise through a bandpass */
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 0.8;
      skidGain = ctx.createGain();
      skidGain.gain.value = 0;
      src.connect(bp).connect(skidGain).connect(master);
      src.start();
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

  const burst = (dur, freq, vol) => {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + dur);
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
      if (master) master.gain.value = m ? 0 : 0.32;
    },
    engine(speed, throttle) {
      if (!ctx || !engineGain) return;
      const t = ctx.currentTime;
      engineOsc.frequency.setTargetAtTime(42 + speed * 2.4 + throttle * 16, t, 0.06);
      engineFilter.frequency.setTargetAtTime(300 + speed * 14 + throttle * 240, t, 0.1);
      engineGain.gain.setTargetAtTime(0.03 + throttle * 0.05 + Math.min(0.035, speed * 0.0009), t, 0.12);
    },
    skid(on) {
      if (!ctx || !skidGain) return;
      skidGain.gain.setTargetAtTime(on ? 0.16 : 0, ctx.currentTime, 0.07);
    },
    thud: () => burst(0.22, 420, 0.4),
    splash: () => burst(0.6, 600, 0.35),
    chime: () => {
      blip('triangle', 587, 587, 0.1, 0.16);
      blip('triangle', 880, 880, 0.12, 0.16, 0.09);
      blip('triangle', 1175, 1175, 0.2, 0.16, 0.18);
    },
    dock: () => blip('triangle', 740, 740, 0.1, 0.12),
    ui: () => blip('square', 1200, 1200, 0.04, 0.06),
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

function glowTexture(color) {
  return shared(`glow-${color}`, () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, color);
    g.addColorStop(0.3, color + '44');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
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
    for (let i = 0; i < 18; i++) {
      const x = 40 + Math.random() * 176;
      const y = 40 + Math.random() * 48;
      const r = 18 + Math.random() * 30;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(150,170,210,0.10)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 128);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/* tileable wave normal map for the lake — blurred value noise → normals */
function waterNormalsTexture() {
  return shared('waternormals', () => {
    const s = 256;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(s, s);
    let h = new Float32Array(s * s);
    for (let i = 0; i < s * s; i++) h[i] = Math.random();
    const blur = (src) => {
      const out = new Float32Array(s * s);
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          let t = 0;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) t += src[((y + dy + s) % s) * s + ((x + dx + s) % s)];
          out[y * s + x] = t / 25;
        }
      return out;
    };
    h = blur(blur(blur(h)));
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const l = h[y * s + ((x - 1 + s) % s)];
        const r = h[y * s + ((x + 1) % s)];
        const u = h[((y - 1 + s) % s) * s + x];
        const d = h[((y + 1) % s) * s + x];
        const i = (y * s + x) * 4;
        img.data[i] = Math.round(((l - r) * 3.5 * 0.5 + 0.5) * 255);
        img.data[i + 1] = Math.round(((u - d) * 3.5 * 0.5 + 0.5) * 255);
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  });
}

/* tileable asphalt roughness: smooth noise so the wet-road sheen breaks up
   into patches instead of one uniform plastic gloss */
function asphaltRoughnessTexture() {
  return shared('asphalt-rough', () => {
    const s = 128;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(s, s);
    let h = new Float32Array(s * s);
    for (let i = 0; i < s * s; i++) h[i] = Math.random();
    const out = new Float32Array(s * s);
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        let t = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) t += h[((y + dy + s) % s) * s + ((x + dx + s) % s)];
        out[y * s + x] = t / 25;
      }
    h = out;
    for (let i = 0; i < s * s; i++) {
      const v = Math.round((0.4 + h[i] * 0.5) * 255 + (Math.random() - 0.5) * 26);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(14, 14);
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

/* billboard face: a modern glass card. found=false renders the scrambled
   "undiscovered" state */
function billboardTexture(post, i, found) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 576;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 576);
  g.addColorStop(0, '#0d1322');
  g.addColorStop(1, '#131b30');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 576);
  ctx.strokeStyle = found ? 'rgba(255,180,94,0.85)' : 'rgba(255,180,94,0.3)';
  ctx.lineWidth = 6;
  rrect(ctx, 8, 8, 1008, 560, 26);
  ctx.stroke();

  const exit = `EXIT ${String(i + 1).padStart(2, '0')}`;
  if (!found) {
    /* static: scan bars + a question mark */
    ctx.fillStyle = 'rgba(120,140,190,0.08)';
    for (let y = 20; y < 560; y += 14) ctx.fillRect(20, y, 984, 6);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,180,94,0.9)';
    ctx.font = '170px Michroma, sans-serif';
    ctx.fillText('?', 512, 330);
    ctx.font = '34px Michroma, sans-serif';
    ctx.fillStyle = 'rgba(220,228,245,0.65)';
    ctx.fillText('UNDISCOVERED DOC', 512, 430);
    ctx.font = '26px Michroma, sans-serif';
    ctx.fillStyle = 'rgba(255,180,94,0.7)';
    ctx.fillText(exit, 512, 110);
  } else {
    ctx.textAlign = 'left';
    /* exit chip */
    ctx.fillStyle = 'rgba(255,180,94,0.92)';
    rrect(ctx, 52, 48, 218, 58, 14);
    ctx.fill();
    ctx.fillStyle = '#10131c';
    ctx.font = '30px Michroma, sans-serif';
    ctx.fillText(exit, 76, 88);
    ctx.fillStyle = 'rgba(160,176,210,0.85)';
    ctx.font = '30px Michroma, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(post.date + (post.draft ? ' · DRAFT' : ''), 972, 88);
    ctx.textAlign = 'left';
    /* title */
    ctx.fillStyle = '#f3f5fb';
    ctx.font = '600 58px "Outfit Variable", Outfit, sans-serif';
    const tl = wrapText(ctx, post.title, 900, 3);
    tl.forEach((ln, k) => ctx.fillText(ln, 56, 200 + k * 72));
    /* description */
    ctx.fillStyle = 'rgba(190,200,225,0.85)';
    ctx.font = '300 35px "Outfit Variable", Outfit, sans-serif';
    const dl = wrapText(ctx, post.desc, 900, 2);
    dl.forEach((ln, k) => ctx.fillText(ln, 56, 240 + tl.length * 72 + k * 48));
    /* footer */
    ctx.fillStyle = 'rgba(255,180,94,0.9)';
    ctx.font = '26px Michroma, sans-serif';
    ctx.fillText('PULL IN TO READ  ⏎', 56, 526);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* ----- HUD ----- */

const HELP = 'W gas · S brake · A/D steer · space drift · ↵ read at an exit · M sound';

function makeHud(total, foundCount) {
  const hud = document.createElement('div');
  hud.className = 'sodium-hud';
  hud.innerHTML = `
    <div class="sd-meta"><b>night drive</b><span data-sd-docs>docs ${foundCount}/${total} discovered</span></div>
    <div class="sd-corner"><button type="button" data-sd-mute aria-label="Toggle sound"></button></div>
    <div class="sd-speed" data-sd-gauge><div><b data-sd-speed>0</b><span>km/h</span></div></div>
    <div class="sd-toasts" data-sd-toasts aria-live="polite"></div>
    <div class="sd-dock" data-sd-dock hidden></div>
    <div class="sd-help" aria-hidden="true">${HELP}</div>
    <div class="sd-overlay" data-sd-overlay><b>headlights on</b><span>${
      coarse
        ? 'left thumb steers · ▲ gas latches · pull up to a billboard to read it'
        : 'drive into the dark — the docs light up when you find them'
    }</span></div>
    ${
      coarse
        ? `<div class="sd-stick" data-sd-stick hidden><i></i></div>
    <div class="sd-cluster" data-sd-cluster>
      <button type="button" data-sd-drift>⊕ drift</button>
      <button type="button" data-sd-brake>▼ brake</button>
      <button type="button" data-sd-gas>▲ gas</button>
    </div>`
        : ''
    }`;
  document.body.append(hud);
  const toasts = hud.querySelector('[data-sd-toasts]');
  hud.toast = (msg, cls = '') => {
    const t = document.createElement('div');
    t.className = `sd-toast ${cls}`;
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

  /* article pages: no renderer at all — the CSS carries the page. Record
     the visit as a discovery and offer the road back. */
  if (!isWorld) {
    const slug = location.pathname.match(/^\/posts\/([^/]+)\/?$/)?.[1];
    if (slug) {
      try {
        sessionStorage.setItem('sodium-at', slug);
      } catch {}
      store.find(slug);
    }
    const back = document.createElement('a');
    back.href = '/';
    back.className = 'sd-return';
    back.textContent = '⟵ back to the road';
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
  const found = store.found();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.4 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.domElement.className = 'sodium-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(NIGHT);
  scene.fog = new THREE.FogExp2(NIGHT, 0.0027);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 1600);

  /* the composer bypasses the canvas's MSAA — render into a multisampled
     HDR target or every edge in the night is a staircase */
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
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.68, 0.6, 0.78);
  /* night grade: vignette, radial chromatic aberration, film grain.
     Runs AFTER OutputPass, display-referred — additive grain in linear
     HDR lifts a night scene's blacks into gray haze */
  const gradePass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 c = vUv - 0.5;
        float r2 = dot(c, c);
        vec2 ca = c * r2 * 0.028;
        vec3 col;
        col.r = texture2D(tDiffuse, vUv - ca).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv + ca).b;
        col *= 1.0 - smoothstep(0.12, 0.85, r2) * 0.36;
        col += (hash(vUv * 1024.0 + fract(uTime) * 7.13) - 0.5) * 0.03;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  composer.addPass(new RenderPass(scene, camera));
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

  /* ----- sky: gradient, stars, moon, a whisper of aurora ----- */

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
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        float h = clamp(vDir.y, -0.05, 1.0);
        vec3 zenith = vec3(0.012, 0.022, 0.062);
        vec3 mid = vec3(0.02, 0.034, 0.085);
        vec3 horizon = vec3(0.125, 0.062, 0.028); /* sodium city-glow */
        vec3 col = mix(horizon, mix(mid, zenith, smoothstep(0.2, 0.8, h)), smoothstep(0.0, 0.22, h));
        /* stars */
        vec3 sp = floor(vDir * 230.0);
        float s = hash(sp);
        if (s > 0.9965 && vDir.y > 0.04) {
          float tw = 0.55 + 0.45 * sin(uTime * (1.0 + hash(sp + 1.0) * 3.0) + hash(sp + 2.0) * 6.28);
          col += vec3(0.85, 0.9, 1.0) * (s - 0.9965) * 230.0 * tw * smoothstep(0.04, 0.3, vDir.y);
        }
        /* moon */
        vec3 mdir = normalize(vec3(0.42, 0.5, -0.5));
        float md = dot(vDir, mdir);
        col += vec3(0.8, 0.86, 0.98) * smoothstep(0.99935, 0.99965, md);
        col += vec3(0.2, 0.26, 0.4) * pow(max(md, 0.0), 160.0) * 0.55;
        /* aurora bands */
        float a = smoothstep(0.1, 0.42, vDir.y) * smoothstep(0.95, 0.5, vDir.y);
        float wave = sin(vDir.x * 5.0 + uTime * 0.12) * 0.5 + sin(vDir.z * 7.0 - uTime * 0.08) * 0.5;
        float band = smoothstep(0.22, 0.0, abs(vDir.y - 0.4 - wave * 0.07));
        col += vec3(0.04, 0.2, 0.13) * band * a * (0.55 + 0.45 * sin(uTime * 0.2 + vDir.x * 3.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 32, 16), skyMat);
  scene.add(sky);

  /* the sky doubles as the environment map: metal paint and wet surfaces
     pick up the horizon glow instead of going dead black */
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat));
    const envRT = pmrem.fromScene(envScene, 0.04);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.55;
    envScene.children[0].geometry.dispose();
    pmrem.dispose();
    signal.addEventListener('abort', () => envRT.dispose());
  }

  /* ----- light ----- */

  scene.add(new THREE.HemisphereLight(0x26395e, 0x0c0e14, 0.85));
  const moon = new THREE.DirectionalLight(0xa8c0ee, 1.55);
  moon.castShadow = true;
  moon.shadow.mapSize.setScalar(coarse ? 1024 : 2048);
  moon.shadow.camera.left = -95;
  moon.shadow.camera.right = 95;
  moon.shadow.camera.top = 95;
  moon.shadow.camera.bottom = -95;
  moon.shadow.camera.near = 20;
  moon.shadow.camera.far = 420;
  moon.shadow.bias = -0.0006;
  moon.shadow.normalBias = 0.025;
  scene.add(moon, moon.target);
  const MOON_OFF = new THREE.Vector3(110, 150, -130);

  /* static obstacles the car can hit: { x, z, r } */
  const colliders = [];

  /* ----- ground: vertex-noise plain ----- */

  {
    const g = new THREE.PlaneGeometry(2600, 2600, 80, 80);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const base = new THREE.Color(0x0b1018);
    const moss = new THREE.Color(0x0d1a1c);
    const tint = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const n = hash01(`${Math.round(pos.getX(i) / 24)}:${Math.round(pos.getZ(i) / 24)}`);
      tint.lerpColors(base, moss, n * 0.9);
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 }),
    );
    ground.receiveShadow = true;
    scene.add(ground);
  }

  /* ----- the ring road ----- */

  {
    const road = new THREE.Mesh(
      new THREE.RingGeometry(ROAD_R - ROAD_W, ROAD_R + ROAD_W, 160),
      new THREE.MeshStandardMaterial({
        color: 0x1a2030,
        roughness: 0.62,
        roughnessMap: asphaltRoughnessTexture(),
        metalness: 0.12,
      }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.02;
    road.receiveShadow = true;
    scene.add(road);
    /* edge lines */
    for (const r of [ROAD_R - ROAD_W + 0.5, ROAD_R + ROAD_W - 0.5]) {
      const line = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.18, r + 0.18, 160),
        new THREE.MeshStandardMaterial({
          color: 0x2a2f3d,
          emissive: SODIUM,
          emissiveIntensity: 0.32,
          roughness: 0.6,
        }),
      );
      line.rotation.x = -Math.PI / 2;
      line.position.y = 0.035;
      scene.add(line);
    }
    /* center dashes */
    const dashGeo = new THREE.BoxGeometry(0.3, 0.02, 3.2);
    const dashMat = new THREE.MeshStandardMaterial({
      color: 0xaab2c8,
      emissive: 0xaab2c8,
      emissiveIntensity: 0.38,
      roughness: 0.5,
    });
    const dashes = new THREE.InstancedMesh(dashGeo, dashMat, 72);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      m4.makeRotationY(-a);
      m4.setPosition(Math.cos(a) * ROAD_R, 0.04, Math.sin(a) * ROAD_R);
      dashes.setMatrixAt(i, m4);
    }
    scene.add(dashes);
  }

  /* ----- the lake: real planar reflections + animated normals ----- */

  const water = new Water(new THREE.CircleGeometry(LAKE_R, 64), {
    textureWidth: coarse ? 256 : 1024,
    textureHeight: coarse ? 256 : 1024,
    waterNormals: waterNormalsTexture(),
    sunDirection: MOON_OFF.clone().normalize(),
    sunColor: 0x8fb4ff,
    waterColor: 0x041a24,
    distortionScale: 2.6,
    fog: true,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.3;
  scene.add(water);
  /* shore ring */
  {
    const shore = new THREE.Mesh(
      new THREE.RingGeometry(LAKE_R - 0.5, LAKE_R + 2.5, 64),
      new THREE.MeshStandardMaterial({ color: 0x141a26, roughness: 0.9 }),
    );
    shore.rotation.x = -Math.PI / 2;
    shore.position.y = 0.26;
    shore.receiveShadow = true;
    scene.add(shore);
  }

  /* ----- wind turbines over the water ----- */

  const rotors = [];
  {
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xb8c2d4, roughness: 0.5, metalness: 0.4 });
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0xd5dcea, roughness: 0.4, metalness: 0.3 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.7;
      const r = 26 + (i % 2) * 22;
      const t = new THREE.Group();
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 26, 10), towerMat);
      tower.position.y = 13;
      tower.castShadow = true;
      const nacelle = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 2.6), towerMat);
      nacelle.position.set(0, 26, -0.4);
      nacelle.castShadow = true;
      const rotor = new THREE.Group();
      rotor.position.set(0, 26, 1.1);
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.55, 10.5, 0.16), bladeMat);
        blade.position.y = 5.25;
        const arm = new THREE.Group();
        arm.rotation.z = (b / 3) * Math.PI * 2;
        arm.add(blade);
        blade.castShadow = true;
        rotor.add(arm);
      }
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff3344, emissiveIntensity: 2 }),
      );
      beacon.position.y = 27;
      t.add(tower, nacelle, rotor, beacon);
      t.position.set(Math.cos(a) * r, 0.3, Math.sin(a) * r);
      t.rotation.y = -a + Math.PI / 2;
      scene.add(t);
      rotors.push({ rotor, beacon, phase: i * 1.7, speed: 0.9 + (i % 3) * 0.25 });
    }
  }

  /* ----- streetlights: sodium pools along the road ----- */

  {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.6, metalness: 0.5 });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0x553311,
      emissive: SODIUM,
      emissiveIntensity: 2.4,
    });
    const coneMat = new THREE.MeshBasicMaterial({
      color: SODIUM,
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.13;
      const side = i % 2 ? 1 : -1;
      const r = ROAD_R + side * (ROAD_W + 1.5);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 7.5, 8), poleMat);
      pole.position.y = 3.75;
      pole.castShadow = true;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 2.4), poleMat);
      arm.position.set(0, 7.4, -side * 1.2);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.9), headMat);
      head.position.set(0, 7.3, -side * 2.2);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(3.6, 7.2, 16, 1, true), coneMat);
      cone.position.set(0, 3.7, -side * 2.2);
      /* the pool of sodium on the tarmac — the cone alone reads as haze,
         the road needs the light to land somewhere */
      const pool = new THREE.Mesh(
        new THREE.PlaneGeometry(9.5, 9.5),
        new THREE.MeshBasicMaterial({
          map: glowTexture('#ffb45e'),
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(0, 0.06, -side * 2.2);
      g.add(pole, arm, head, cone, pool);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      g.lookAt(0, 0, 0);
      scene.add(g);
      colliders.push({ x: g.position.x, z: g.position.z, r: 0.7 });
    }
  }

  /* ----- trees: instanced, shadowed ----- */

  {
    const N = 140;
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 2.2, 6);
    const canopyGeo = new THREE.IcosahedronGeometry(2.0, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.9 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, N);
    trunks.castShadow = canopies.castShadow = true;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const cv = new THREE.Color();
    let placed = 0;
    let guard = 0;
    while (placed < N && guard++ < 4000) {
      const a = Math.random() * Math.PI * 2;
      const r = LAKE_R + 14 + Math.random() * 380;
      if (Math.abs(r - ROAD_R) < ROAD_W + 6) continue;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const s = 0.8 + Math.random() * 1.7;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI);
      sc.set(s, s, s);
      m4.compose(new THREE.Vector3(x, 1.1 * s, z), q, sc);
      trunks.setMatrixAt(placed, m4);
      m4.compose(new THREE.Vector3(x, (2.2 + 1.3) * s, z), q, sc);
      canopies.setMatrixAt(placed, m4);
      cv.setHSL(0.42 + Math.random() * 0.12, 0.35, 0.1 + Math.random() * 0.07);
      canopies.setColorAt(placed, cv);
      if (r < 420) colliders.push({ x, z, r: 1.3 * s });
      placed++;
    }
    scene.add(trunks, canopies);
  }

  /* ----- clouds + fireflies ----- */

  const clouds = [];
  for (let i = 0; i < 9; i++) {
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: cloudTexture(),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    );
    const a = Math.random() * Math.PI * 2;
    const r = 250 + Math.random() * 500;
    sp.position.set(Math.cos(a) * r, 130 + Math.random() * 60, Math.sin(a) * r);
    sp.scale.set(180 + Math.random() * 120, 80 + Math.random() * 50, 1);
    scene.add(sp);
    clouds.push(sp);
  }

  let fireflies = null;
  {
    const N = 130;
    const arr = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = LAKE_R + 10 + Math.random() * 320;
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = 0.6 + Math.random() * 3.4;
      arr[i * 3 + 2] = Math.sin(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    fireflies = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0xffd9a0,
        size: 0.35,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    fireflies.userData.base = arr.slice();
    scene.add(fireflies);
  }

  /* ----- billboards: the docs, dark until discovered ----- */

  const billboards = [];
  {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.55, metalness: 0.5 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x141925, roughness: 0.5, metalness: 0.35 });
    posts.forEach((post, i) => {
      const a = (i / posts.length) * Math.PI * 2 + hash01(post.slug ?? String(i)) * 0.3;
      const r = ROAD_R + ROAD_W + 9;
      const g = new THREE.Group();
      for (const sx of [-3.6, 3.6]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 6.2, 8), poleMat);
        pole.position.set(sx, 3.1, 0);
        pole.castShadow = true;
        g.add(pole);
      }
      const frame = new THREE.Mesh(new THREE.BoxGeometry(10.6, 6.2, 0.5), frameMat);
      frame.position.y = 8.2;
      frame.castShadow = true;
      g.add(frame);
      const isFound = post.slug && found.has(post.slug);
      const tex = billboardTexture(post, i, isFound);
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 5.6),
        new THREE.MeshStandardMaterial({
          map: tex,
          emissive: 0xffffff,
          emissiveMap: tex,
          emissiveIntensity: isFound ? 0.85 : 0.35,
          roughness: 0.4,
        }),
      );
      panel.position.set(0, 8.2, 0.27);
      g.add(panel);
      /* beacon column for undiscovered docs */
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 1.4, 80, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color: SODIUM,
          transparent: true,
          opacity: 0.06,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      beam.position.y = 40;
      beam.visible = !isFound;
      g.add(beam);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      g.lookAt(Math.cos(a) * ROAD_R, 8, Math.sin(a) * ROAD_R);
      scene.add(g);
      colliders.push({ x: g.position.x - 3.4, z: g.position.z, r: 0.8 });
      colliders.push({ x: g.position.x + 3.4, z: g.position.z, r: 0.8 });
      billboards.push({ group: g, panel, beam, post, idx: i, found: !!isFound, flash: 0 });
    });
  }

  /* ----- the car ----- */

  function makeCar() {
    const car = new THREE.Group();
    const body = new THREE.Group();
    const paint = new THREE.MeshPhysicalMaterial({
      color: 0x243250,
      metalness: 0.85,
      roughness: 0.34,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.3,
    });
    const trim = new THREE.MeshStandardMaterial({ color: 0x0b0e14, metalness: 0.4, roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x0d1722,
      metalness: 0.95,
      roughness: 0.08,
      envMapIntensity: 1.8,
    });

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.52, 4.3), paint);
    chassis.position.y = 0.56;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.3, 1.0), paint);
    nose.position.set(0, 0.74, 1.62);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.5, 2.0), glass);
    cabin.position.set(0, 1.04, -0.3);
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.08, 0.45), trim);
    spoiler.position.set(0, 1.12, -2.02);
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.44, 0.02, 4.32),
      new THREE.MeshStandardMaterial({ color: 0x553311, emissive: SODIUM, emissiveIntensity: 0.9 }),
    );
    stripe.position.y = 0.84;
    for (const m of [chassis, nose, cabin, spoiler]) m.castShadow = true;
    body.add(chassis, nose, cabin, spoiler, stripe);

    const lampMat = new THREE.MeshStandardMaterial({ color: 0x223344, emissive: CYANL, emissiveIntensity: 2.6 });
    for (const sx of [-0.62, 0.62]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.08), lampMat);
      lamp.position.set(sx, 0.66, 2.16);
      body.add(lamp);
    }
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.1, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x330808, emissive: 0xff2233, emissiveIntensity: 1.4 }),
    );
    tail.position.set(0, 0.74, -2.16);
    body.add(tail);

    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 18);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.85 });
    const wheels = [];
    const steerPivots = [];
    for (const [sx, sz, front] of [
      [-0.95, 1.42, true],
      [0.95, 1.42, true],
      [-0.95, -1.42, false],
      [0.95, -1.42, false],
    ]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.castShadow = true;
      const pivot = new THREE.Group();
      pivot.position.set(sx, 0.42, sz);
      pivot.add(wheel);
      car.add(pivot);
      wheels.push(wheel);
      if (front) steerPivots.push(pivot);
    }

    /* underglow */
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 5.6),
      new THREE.MeshBasicMaterial({
        map: glowTexture('#ffb45e'),
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.06;
    car.add(glow);

    /* headlight spots — no volumetric cones: the chase camera looks
       straight down the beam axis, so an additive cone reads as a
       permanent blob in the middle of the screen */
    const spots = [];
    for (const sx of [-0.6, 0.6]) {
      const s = new THREE.SpotLight(0xbfd8ff, 130, 100, 0.5, 0.55, 1.5);
      s.position.set(sx, 0.7, 2.0);
      const tgt = new THREE.Object3D();
      tgt.position.set(sx * 1.5, 0.2, 30);
      car.add(tgt);
      s.target = tgt;
      car.add(s);
      spots.push(s);
    }

    car.add(body);
    car.userData = { body, wheels, steerPivots, tail };
    return car;
  }

  const car = makeCar();
  scene.add(car);

  /* ----- car state + restore ----- */

  let carA = 0; // heading
  const vel = new THREE.Vector3();
  let steer = 0;
  let foundCount = posts.filter((p) => p.slug && found.has(p.slug)).length;
  const keys = { gas: false, brake: false, drift: false };

  const roadPoint = (a) => new THREE.Vector3(Math.cos(a) * ROAD_R, 0, Math.sin(a) * ROAD_R);
  const bbAngle = (i, slug) => (i / posts.length) * Math.PI * 2 + hash01(slug ?? String(i)) * 0.3;

  {
    let placed = false;
    const saved = store.carState();
    if (saved && Array.isArray(saved.p) && Date.now() - (saved.t ?? 0) < 45 * 60 * 1000) {
      try {
        car.position.fromArray(saved.p);
        carA = saved.a ?? 0;
        vel.fromArray(saved.v ?? [0, 0, 0]);
        placed = true;
      } catch {}
    }
    if (!placed) {
      let atSlug = null;
      try {
        atSlug = sessionStorage.getItem('sodium-at');
      } catch {}
      const i = posts.findIndex((p) => p.slug && p.slug === atSlug);
      const a = i >= 0 ? bbAngle(i, posts[i].slug) : bbAngle(0, posts[0]?.slug) - 0.25;
      car.position.copy(roadPoint(a));
      carA = a + Math.PI / 2; // facing along the road, counter-clockwise
    }
  }

  /* ----- input ----- */

  const stick = { id: -1, x0: 0, x: 0, live: false };
  const STICK_R = 56;

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

    addEventListener('pagehide', saveCar, { signal });

    const overlay = hud?.querySelector('[data-sd-overlay]');
    let overlayGone = false;
    const dismissOverlay = () => {
      if (overlayGone) return;
      overlayGone = true;
      overlay?.classList.add('hidden');
    };
    setTimeout(dismissOverlay, 6000);

    const kset = (k, v) => {
      if (['w', 'W', 'ArrowUp'].includes(k)) keys.gas = v;
      else if (['s', 'S', 'ArrowDown'].includes(k)) keys.brake = v;
      else if (['a', 'A', 'ArrowLeft'].includes(k)) keys.left = v;
      else if (['d', 'D', 'ArrowRight'].includes(k)) keys.right = v;
      else if (k === ' ') keys.drift = v;
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
        else if (e.key === 'Enter' && dockIdx >= 0 && document.activeElement === document.body)
          location.href = billboards[dockIdx].post.href;
      },
      { signal },
    );
    addEventListener('keyup', (e) => kset(e.key, false), { signal });

    /* touch: left zone steers (x only) */
    const stickEl = hud?.querySelector('[data-sd-stick]');
    const stickNub = stickEl?.querySelector('i');
    el.addEventListener(
      'pointerdown',
      (e) => {
        audio.unlock();
        dismissOverlay();
        if (e.pointerType !== 'touch' || stick.id >= 0 || e.clientX > innerWidth * 0.55) return;
        stick.id = e.pointerId;
        stick.x0 = e.clientX;
        stick.y0 = e.clientY;
        stick.x = 0;
      },
      { signal },
    );
    el.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== stick.id) return;
        const dx = e.clientX - stick.x0;
        const k = Math.abs(dx) > STICK_R ? STICK_R / Math.abs(dx) : 1;
        stick.x = (dx * k) / STICK_R;
        if (!stick.live && Math.abs(dx) > 10 && stickEl) {
          stick.live = true;
          stickEl.hidden = false;
          stickEl.style.left = `${stick.x0}px`;
          stickEl.style.top = `${stick.y0}px`;
        }
        if (stick.live && stickNub) stickNub.style.transform = `translate(${dx * k}px, 0px)`;
      },
      { signal },
    );
    const stickUp = (e) => {
      if (e.pointerId !== stick.id) return;
      stick.id = -1;
      stick.x = 0;
      stick.live = false;
      if (stickEl) stickEl.hidden = true;
      if (stickNub) stickNub.style.transform = '';
    };
    el.addEventListener('pointerup', stickUp, { signal });
    el.addEventListener('pointercancel', stickUp, { signal });
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    /* cluster: gas latches, brake/drift hold */
    const gasBtn = hud?.querySelector('[data-sd-gas]');
    gasBtn?.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        audio.unlock();
        dismissOverlay();
        keys.gas = !keys.gas;
        gasBtn.classList.toggle('on', keys.gas);
      },
      { signal },
    );
    const bindHold = (sel, on, off) => {
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
    bindHold('[data-sd-brake]', () => (keys.brake = true), () => (keys.brake = false));
    bindHold('[data-sd-drift]', () => (keys.drift = true), () => (keys.drift = false));

    hud?.querySelector('[data-sd-dock]')?.addEventListener(
      'click',
      () => {
        if (dockIdx >= 0) location.href = billboards[dockIdx].post.href;
      },
      { signal },
    );
    hud?.querySelector('[data-sd-mute]')?.addEventListener('click', toggleMute, { signal });
    syncMute();
  }

  function syncMute() {
    const b = hud?.querySelector('[data-sd-mute]');
    if (b) b.textContent = audio.muted() ? 'snd off' : 'snd on';
  }

  function toggleMute() {
    audio.unlock();
    audio.setMuted(!audio.muted());
    syncMute();
  }

  function saveCar() {
    store.carState({ p: car.position.toArray(), a: carA, v: vel.toArray(), t: Date.now() });
  }

  /* ----- physics + game loop ----- */

  const VMAX = 46;
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const camLook = new THREE.Vector3(); // never aliases fwd/tmpV
  let dockIdx = -1;
  let shake = 0;
  let hudTimer = 0;

  const fwdOf = (a, out) => out.set(Math.sin(a), 0, Math.cos(a));

  function resetToRoad() {
    const a = Math.atan2(car.position.z, car.position.x);
    car.position.copy(roadPoint(a));
    carA = a + Math.PI / 2;
    vel.set(0, 0, 0);
    audio.splash();
    hud?.toast('fished out — back on the road');
    shake = 1;
  }

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    /* --- driving --- */
    const steerTarget = stick.id >= 0 ? -stick.x : (keys.left ? 1 : 0) + (keys.right ? -1 : 0);
    steer = THREE.MathUtils.lerp(steer, THREE.MathUtils.clamp(steerTarget, -1, 1), 1 - Math.exp(-dt * 8));

    const fwd = fwdOf(carA, tmpV);
    const speedAlong = vel.dot(fwd);
    const speed = vel.length();

    /* engine / brake / reverse */
    if (keys.gas) vel.addScaledVector(fwd, 26 * dt);
    if (keys.brake) {
      if (speedAlong > 1) vel.multiplyScalar(Math.exp(-dt * 2.6));
      else vel.addScaledVector(fwd, -11 * dt); // reverse
    }
    /* drag (quadratic-ish) + rolling resistance */
    vel.multiplyScalar(Math.exp(-dt * (0.18 + speed * 0.004)));

    /* offroad: heavy grass drag */
    const radial = Math.hypot(car.position.x, car.position.z);
    const offroad = Math.abs(radial - ROAD_R) > ROAD_W + 1.2;
    if (offroad) vel.multiplyScalar(Math.exp(-dt * 0.9));

    /* steering: stronger at speed, reversed in reverse */
    const dir = speedAlong >= 0 ? 1 : -1;
    const grip = keys.drift ? 2.0 : 9.0;
    carA +=
      steer *
      dir *
      (keys.drift ? 3.4 : 2.5) *
      dt *
      THREE.MathUtils.clamp(speed / 9, 0, 1) *
      (1 / (1 + speed * 0.012));

    /* lateral grip: break it with the handbrake and the car slides */
    fwdOf(carA, fwd);
    const right = tmpV2.set(fwd.z, 0, -fwd.x);
    const latV = vel.dot(right);
    vel.addScaledVector(right, latV * (Math.exp(-dt * grip) - 1));
    const drifting = Math.abs(latV) > 6 && speed > 10;

    if (speed > VMAX) vel.setLength(VMAX);
    car.position.addScaledVector(vel, dt);
    car.position.y = 0;
    car.rotation.y = carA;

    /* lake: splash + reset */
    if (radial < LAKE_R - 2) resetToRoad();
    /* soft world edge */
    if (radial > 560) vel.addScaledVector(tmpV2.copy(car.position).setY(0).normalize(), -dt * 30);

    /* collisions: poles, trees, turbine towers */
    for (const cBox of colliders) {
      const dx = car.position.x - cBox.x;
      const dz = car.position.z - cBox.z;
      const d2 = dx * dx + dz * dz;
      const rr = cBox.r + 1.1;
      if (d2 < rr * rr && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        car.position.x = cBox.x + nx * rr;
        car.position.z = cBox.z + nz * rr;
        const vn = vel.x * nx + vel.z * nz;
        if (vn < 0) {
          vel.x -= nx * vn * 1.6;
          vel.z -= nz * vn * 1.6;
          vel.multiplyScalar(0.72);
          if (speed > 6) {
            audio.thud();
            shake = Math.min(1, shake + 0.5);
          }
        }
      }
    }

    /* suspension feel: body roll + pitch, wheel spin + steer */
    const { body, wheels, steerPivots, tail } = car.userData;
    const accelN = (keys.gas ? 1 : 0) - (keys.brake ? 1.2 : 0);
    body.rotation.z = THREE.MathUtils.lerp(
      body.rotation.z,
      steer * THREE.MathUtils.clamp(speed / VMAX, 0, 1) * 0.12,
      1 - Math.exp(-dt * 5),
    );
    body.rotation.x = THREE.MathUtils.lerp(
      body.rotation.x,
      -accelN * 0.035 * THREE.MathUtils.clamp(speed / 14, 0, 1),
      1 - Math.exp(-dt * 5),
    );
    for (const w of wheels) w.rotation.x += speedAlong * dt * 2.4;
    for (const p of steerPivots)
      p.rotation.y = THREE.MathUtils.lerp(p.rotation.y, steer * 0.42, 1 - Math.exp(-dt * 10));
    tail.material.emissiveIntensity = keys.brake ? 3.4 : 1.4;

    audio.engine(speed, keys.gas ? 1 : 0);
    audio.skid(drifting || (offroad && speed > 14));

    /* --- env animation --- */
    skyMat.uniforms.uTime.value = reduced ? 12 : time;
    gradePass.uniforms.uTime.value = reduced ? 1 : time;
    water.material.uniforms.time.value += dt * (reduced ? 0.12 : 0.65);
    for (const t of rotors) {
      if (!reduced) t.rotor.rotation.z += dt * t.speed;
      t.beacon.material.emissiveIntensity = 1.2 + Math.sin(time * 1.8 + t.phase) * 1.1;
    }
    if (!reduced) {
      for (const cl of clouds) {
        cl.position.x += dt * 1.1;
        if (cl.position.x > 800) cl.position.x = -800;
      }
      const fp = fireflies.geometry.attributes.position;
      const base = fireflies.userData.base;
      for (let i = 0; i < fp.count; i++) {
        fp.array[i * 3] = base[i * 3] + Math.sin(time * 0.6 + i) * 1.6;
        fp.array[i * 3 + 1] = base[i * 3 + 1] + Math.sin(time * 0.9 + i * 2.1) * 0.7;
        fp.array[i * 3 + 2] = base[i * 3 + 2] + Math.cos(time * 0.5 + i * 1.3) * 1.6;
      }
      fp.needsUpdate = true;
    }

    /* --- discovery + dock --- */
    let nearest = -1;
    let nearestD = Infinity;
    for (let i = 0; i < billboards.length; i++) {
      const bb = billboards[i];
      const d = bb.group.position.distanceTo(car.position);
      if (d < nearestD) {
        nearestD = d;
        nearest = i;
      }
      if (!bb.found && d < 26) {
        bb.found = true;
        bb.flash = 1;
        if (bb.post.slug) store.find(bb.post.slug);
        const tex = billboardTexture(bb.post, bb.idx, true);
        bb.panel.material.map?.dispose();
        bb.panel.material.map = tex;
        bb.panel.material.emissiveMap = tex;
        bb.panel.material.needsUpdate = true;
        bb.beam.visible = false;
        foundCount++;
        audio.chime();
        hud?.toast(`doc discovered — ${bb.post.title}`, 'ok');
      }
      if (bb.flash > 0) {
        bb.flash = Math.max(0, bb.flash - dt);
        bb.panel.material.emissiveIntensity = 0.85 + bb.flash * 2.4;
      }
    }
    const wasDock = dockIdx;
    dockIdx = nearest >= 0 && nearestD < 20 ? nearest : -1;
    if (dockIdx !== wasDock) {
      const dockEl = hud?.querySelector('[data-sd-dock]');
      if (dockIdx >= 0 && dockEl) {
        const bb = billboards[dockIdx];
        audio.dock();
        dockEl.hidden = false;
        dockEl.innerHTML = `<b>${bb.post.title}</b><span>${bb.post.desc}</span><i>${
          coarse ? 'TAP TO READ' : 'PRESS ⏎ TO READ'
        } · EXIT ${String(bb.idx + 1).padStart(2, '0')}</i>`;
      } else if (dockEl) dockEl.hidden = true;
    }

    /* --- moonlight follows the car (texel-snapped, no shimmer) --- */
    const sx = Math.round(car.position.x / 4) * 4;
    const sz = Math.round(car.position.z / 4) * 4;
    moon.position.set(sx + MOON_OFF.x, MOON_OFF.y, sz + MOON_OFF.z);
    moon.target.position.set(sx, 0, sz);
    sky.position.copy(car.position).setY(0);

    /* --- chase camera --- */
    shake = Math.max(0, shake - dt * 2);
    fwdOf(carA, fwd);
    const camT = tmpV2.copy(car.position).addScaledVector(fwd, -9.8);
    camT.y += 3.6;
    camT.addScaledVector(vel, -0.04);
    camera.position.lerp(camT, reduced ? 1 : 1 - Math.exp(-dt * 4.2));
    if (shake > 0 && !reduced)
      camera.position.add(
        camLook.set(
          (Math.random() - 0.5) * shake,
          (Math.random() - 0.5) * shake * 0.5,
          (Math.random() - 0.5) * shake,
        ),
      );
    fwdOf(carA, fwd);
    /* the look target must not alias fwd — tmpV IS fwd */
    camLook.copy(car.position).addScaledVector(fwd, 7);
    camLook.y = car.position.y + 1.4;
    camera.lookAt(camLook);
    const targetFov = 62 + (speed / VMAX) * 13;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 1 - Math.exp(-dt * 3));
      camera.updateProjectionMatrix();
    }

    /* --- HUD --- */
    if ((hudTimer += dt) > 0.1 && hud?.els) {
      hudTimer = 0;
      const kmh = Math.round(speed * 3.2);
      hud.els.speed.textContent = kmh;
      hud.els.gauge.style.setProperty('--v', String(Math.min(100, (speed / VMAX) * 100)));
      hud.els.docs.textContent = `docs ${foundCount}/${posts.length} discovered`;
    }

    composer.render();
    raf = requestAnimationFrame(frame);
  }

  /* ----- boot ----- */

  const start = async () => {
    try {
      await Promise.race([
        Promise.all([
          document.fonts.load('30px Michroma'),
          document.fonts.load('600 58px "Outfit Variable"'),
        ]),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    } catch {}
    if (signal.aborted) return;
    /* redraw billboard faces now the display fonts are in */
    for (const bb of billboards) {
      const tex = billboardTexture(bb.post, bb.idx, bb.found);
      bb.panel.material.map?.dispose();
      bb.panel.material.map = tex;
      bb.panel.material.emissiveMap = tex;
      bb.panel.material.needsUpdate = true;
    }
    hud = makeHud(posts.length, foundCount);
    hud.els = {
      speed: hud.querySelector('[data-sd-speed]'),
      gauge: hud.querySelector('[data-sd-gauge]'),
      docs: hud.querySelector('[data-sd-docs]'),
    };
    document.documentElement.dataset.world = 'on';
    bindInput();
    camera.position.copy(car.position).add(new THREE.Vector3(0, 3.6, -10));
    raf = requestAnimationFrame(frame);
  };
  start();

  function unmount() {
    saveCar();
    audio.dispose();
    ac.abort();
    cancelAnimationFrame(raf);
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (m.userData?.shared) continue;
        if (!m.map?.userData?.shared) m.map?.dispose?.();
        if (!m.emissiveMap?.userData?.shared) m.emissiveMap?.dispose?.();
        m.dispose?.();
      }
    });
    bloomPass.dispose();
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
