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
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Water } from 'three/addons/objects/Water.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/* "purple hour", not navy night — shadows must read as color, render-style */
const NIGHT = 0x191036;
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

const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const hash01 = (s) => hash32(s) / 4294967296;
/* deterministic PRNG for the seeded stunt strips */
const mulberry = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/* bake a cheap AO gradient into vertex colors: undersides darken, tops
   stay lit — multiplies with instance colors for free */
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
    clack: () => {
      blip('square', 760, 190, 0.08, 0.16);
      burst(0.06, 1500, 0.1);
    },
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

/* toy-world ground: a softly jittered checker of big tiles — the terrain
   reads as a playset floor instead of an endless void */
function groundTileTexture() {
  return shared('ground-tiles', () => {
    const t = 32;
    const c = document.createElement('canvas');
    c.width = c.height = t * 8;
    const ctx = c.getContext('2d');
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const v = ((x + y) % 2 ? 0.84 : 1) * (0.9 + hash01(`tile${x}:${y}`) * 0.2);
        ctx.fillStyle = `rgb(${Math.round(176 * v)}, ${Math.round(182 * v)}, ${Math.round(214 * v)})`;
        ctx.fillRect(x * t, y * t, t, t);
      }
    ctx.strokeStyle = 'rgba(10, 12, 34, 0.45)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(i * t, 0);
      ctx.lineTo(i * t, t * 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * t);
      ctx.lineTo(t * 8, i * t);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(70, 70);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/* warning chevrons for the ramp faces */
function chevronTexture() {
  return shared('chevron', () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e8dcc2';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#d84b58';
    for (let i = -1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 42, 0);
      ctx.lineTo(i * 42 + 21, 0);
      ctx.lineTo(i * 42 + 21 + 42, 128);
      ctx.lineTo(i * 42 + 42, 128);
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

/* a jump ramp: slope up +z, vertical drop at the far end */
function wedgeGeometry(w, h, len) {
  const hw = w / 2;
  const v = [
    /* slope */
    -hw, 0, 0, hw, h, len, hw, 0, 0,
    -hw, 0, 0, -hw, h, len, hw, h, len,
    /* back */
    -hw, h, len, hw, 0, len, hw, h, len,
    -hw, h, len, -hw, 0, len, hw, 0, len,
    /* sides */
    -hw, 0, 0, -hw, 0, len, -hw, h, len,
    hw, 0, 0, hw, h, len, hw, 0, len,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const uv = [];
  for (let i = 0; i < v.length; i += 3) uv.push((v[i] + hw) / w, v[i + 2] / len);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
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

/* iPad gets the same legend as desktop — it just spells the touch binds */
const HELP = coarse
  ? 'stick steers · ▲ gas latches · ⊕ drift · pull in to read · ⟲ if stuck'
  : 'W gas · S brake · A/D steer · space drift · ↵ read at an exit · R reset · M sound';

function makeHud(total, foundCount) {
  const hud = document.createElement('div');
  hud.className = 'sodium-hud';
  hud.innerHTML = `
    <div class="sd-meta"><b>night drive</b><span data-sd-docs>docs ${foundCount}/${total} discovered</span><span data-sd-pins></span></div>
    <div class="sd-corner"><button type="button" data-sd-reset aria-label="Reset to road" title="stuck? back to the road">⟲ reset</button><button type="button" data-sd-mute aria-label="Toggle sound"></button></div>
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
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.3 : 1.4));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  /* PCF honors shadow.radius — the soft penumbra without VSM's blur cost */
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
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
  /* night grade: split-tone, vibrance, vignette, radial chromatic
     aberration, a whisper of grain. Runs AFTER OutputPass, display-referred —
     additive grain in linear HDR lifts a night scene's blacks into gray haze.
     The split-tone is the toy-render signature: the toe lifts into violet
     (shadows are a COLOR, never black) while highlights warm toward cream */
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
        float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col += vec3(0.045, 0.022, 0.095) * (1.0 - smoothstep(0.0, 0.5, luma));
        col *= mix(vec3(1.0), vec3(1.05, 1.0, 0.92), smoothstep(0.55, 1.0, luma) * 0.6);
        col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 1.16);
        col *= 1.0 - smoothstep(0.15, 0.9, r2) * 0.24;
        col += (hash(vUv * 1024.0 + fract(uTime) * 7.13) - 0.5) * 0.016;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  /* no GTAO here: AO occludes ambient light, and this scene is lamp-lit
     night — baked vertex AO + contact shadows carry the grounding at zero
     per-frame cost (GTAO measured -20fps for an invisible change) */
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
        vec3 zenith = vec3(0.05, 0.032, 0.15);
        vec3 mid = vec3(0.10, 0.06, 0.27);
        vec3 horizon = vec3(0.40, 0.13, 0.27); /* warm magenta dusk glow */
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
        /* aurora bands — teal-into-pink, tuned to the violet palette */
        float a = smoothstep(0.1, 0.42, vDir.y) * smoothstep(0.95, 0.5, vDir.y);
        float wave = sin(vDir.x * 5.0 + uTime * 0.12) * 0.5 + sin(vDir.z * 7.0 - uTime * 0.08) * 0.5;
        float band = smoothstep(0.22, 0.0, abs(vDir.y - 0.4 - wave * 0.07));
        vec3 atint = mix(vec3(0.05, 0.18, 0.2), vec3(0.2, 0.06, 0.18), 0.5 + 0.5 * sin(vDir.x * 2.0 + uTime * 0.1));
        col += atint * band * a * (0.55 + 0.45 * sin(uTime * 0.2 + vDir.x * 3.0));
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
    scene.environmentIntensity = 1.0;
    envScene.children[0].geometry.dispose();
    pmrem.dispose();
    signal.addEventListener('abort', () => envRT.dispose());
  }

  /* ----- light ----- */

  /* hemisphere IS the look: a saturated violet sky side means everything
     in shadow reads as purple, never gray — the toy-render signature.
     Ground side bounces deep plum back up, the cheapest GI there is */
  scene.add(new THREE.HemisphereLight(0x6a58d6, 0x3a2158, 1.15));
  const moon = new THREE.DirectionalLight(0xc8ccf6, 1.9);
  moon.castShadow = true;
  /* 2048 + VSM blur beats 4096 + hard PCF — the blur pass is per-frame */
  moon.shadow.mapSize.setScalar(2048);
  moon.shadow.radius = 18;
  moon.shadow.camera.left = -70;
  moon.shadow.camera.right = 70;
  moon.shadow.camera.top = 70;
  moon.shadow.camera.bottom = -70;
  moon.shadow.camera.near = 20;
  moon.shadow.camera.far = 420;
  moon.shadow.bias = -0.0006;
  moon.shadow.normalBias = 0.025;
  scene.add(moon, moon.target);
  const MOON_OFF = new THREE.Vector3(110, 150, -130);

  /* static obstacles the car can hit: { x, z, r } — rendered as baked
     contact-shadow blots AND turned into static physics bodies later */
  const colliders = [];
  /* every streetlight's point light — only the nearest two stay live */
  const lampLights = [];

  /* ----- physics: a real cannon-es world. The car is a RaycastVehicle,
     the knockables are true rigid bodies — full 3D, not the old planar
     velocity-plus-y-hacks model ----- */
  const phys = new CANNON.World({ gravity: new CANNON.Vec3(0, -22, 0) });
  /* naive broadphase on purpose: SAP's aabbQuery serves the vehicle's wheel
     raycasts stale axis lists after a teleport (lake rescue, page restore)
     and the wheels never find the ground again. ~120 bodies is nothing. */
  phys.allowSleep = true;
  phys.defaultContactMaterial.friction = 0.25;
  phys.defaultContactMaterial.restitution = 0.12;
  {
    /* a huge box, not CANNON.Plane: the plane's ray/AABB path misses the
       vehicle's wheel raycasts at some coordinates — a box never does */
    const ground = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Box(new CANNON.Vec3(1300, 1, 1300)),
    });
    ground.position.set(0, -1, 0);
    phys.addBody(ground);
    ground.updateAABB();
  }

  /* ----- ground: vertex-noise plain ----- */

  {
    const g = new THREE.PlaneGeometry(2600, 2600, 80, 80);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const base = new THREE.Color(0x2c3666);
    const moss = new THREE.Color(0x251d4e);
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
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: groundTileTexture(),
        roughness: 0.96,
        metalness: 0,
      }),
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

  /* ----- the city on the horizon: dark towers, lit windows, haze ----- */

  {
    const win = shared('windows', () => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 128;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 64, 128);
      for (let y = 4; y < 124; y += 8)
        for (let x = 4; x < 60; x += 8) {
          const r = hash01(`w${x}:${y}`);
          if (r < 0.38) {
            ctx.fillStyle = r < 0.1 ? '#9fd8ff' : '#ffc97a';
            ctx.globalAlpha = 0.5 + r;
            ctx.fillRect(x, y, 4, 5);
          }
        }
      ctx.globalAlpha = 1;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    });
    const parts = [];
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2 + hash01(`bld${i}`) * 0.1;
      const r = 430 + hash01(`bldr${i}`) * 50;
      const w = 14 + hash01(`bldw${i}`) * 18;
      const h = 22 + hash01(`bldh${i}`) * 58;
      const g = new THREE.BoxGeometry(w, h, w);
      g.translate(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r);
      parts.push(g);
    }
    const skyline = new THREE.Mesh(
      mergeGeometries(parts),
      new THREE.MeshStandardMaterial({
        color: 0x0b0f22,
        roughness: 0.9,
        emissive: 0xffffff,
        emissiveMap: win,
        emissiveIntensity: 0.55,
      }),
    );
    scene.add(skyline);
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
    /* REAL light at every lamp — no additive cones, no fake pools: the
       point lights land on the road, the grass, the car, the props.
       Every third lamp runs pink, straight from the reference. Forward
       rendering pays per light per fragment, so only the nearest two are
       live at any moment (their pools don't reach further anyway) — the
       count must stay constant or three recompiles every program. */
    const lampCount = coarse ? 8 : 12;
    for (let i = 0; i < lampCount; i++) {
      const a = (i / lampCount) * Math.PI * 2 + 0.13;
      const side = i % 2 ? 1 : -1;
      const pink = i % 3 === 2;
      const lampColor = pink ? 0xff6ab8 : SODIUM;
      const r = ROAD_R + side * (ROAD_W + 1.5);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 7.5, 8), poleMat);
      pole.position.y = 3.75;
      pole.castShadow = true;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 2.4), poleMat);
      arm.position.set(0, 7.4, -side * 1.2);
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.18, 0.9),
        new THREE.MeshStandardMaterial({
          color: 0x553311,
          emissive: lampColor,
          emissiveIntensity: 2.6,
        }),
      );
      head.position.set(0, 7.3, -side * 2.2);
      const light = new THREE.PointLight(lampColor, pink ? 150 : 190, 34, 2);
      light.position.set(0, 7.1, -side * 2.2);
      light.visible = false; // the culler below turns the nearest ones on
      g.add(pole, arm, head, light);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      g.lookAt(0, 0, 0);
      scene.add(g);
      lampLights.push({ light, x: g.position.x, z: g.position.z });
      colliders.push({ x: g.position.x, z: g.position.z, r: 0.7 });
    }
    /* a cold counterweight: moonlight pooling over the lake */
    const lakeGlow = new THREE.PointLight(0x6fd8ff, 220, 130, 2);
    lakeGlow.position.set(0, 14, 0);
    scene.add(lakeGlow);
  }

  /* ----- road furniture: reflector posts + cat-eye studs ----- */

  {
    const postGeo = new THREE.BoxGeometry(0.1, 0.85, 0.1);
    postGeo.translate(0, 0.42, 0);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xc8cdd8, roughness: 0.6 });
    const headGeo = new THREE.BoxGeometry(0.12, 0.14, 0.05);
    headGeo.translate(0, 0.78, 0);
    const headMat = new THREE.MeshStandardMaterial({
      color: 0x444444,
      emissive: 0xfff2cf,
      emissiveIntensity: 1.6,
    });
    const PN = 96;
    const posts = new THREE.InstancedMesh(postGeo, postMat, PN);
    const heads = new THREE.InstancedMesh(headGeo, headMat, PN);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < PN; i++) {
      const a = (Math.floor(i / 2) / (PN / 2)) * Math.PI * 2 + 0.06;
      const side = i % 2 ? 1 : -1;
      const r = ROAD_R + side * (ROAD_W + 0.7);
      m4.makeRotationY(-a);
      m4.setPosition(Math.cos(a) * r, 0, Math.sin(a) * r);
      posts.setMatrixAt(i, m4);
      heads.setMatrixAt(i, m4);
    }
    scene.add(posts, heads);

    const studGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.05, 6);
    const studMat = new THREE.MeshStandardMaterial({
      color: 0x333322,
      emissive: 0xfff8d8,
      emissiveIntensity: 1.3,
    });
    const SN2 = 72;
    const studs = new THREE.InstancedMesh(studGeo, studMat, SN2);
    for (let i = 0; i < SN2; i++) {
      const a = ((i + 0.5) / SN2) * Math.PI * 2;
      m4.makeRotationY(-a);
      m4.setPosition(Math.cos(a) * ROAD_R, 0.05, Math.sin(a) * ROAD_R);
      studs.setMatrixAt(i, m4);
    }
    scene.add(studs);
  }

  /* ----- night flora: bushes + rocks between the trees ----- */

  {
    const blobS = (x, y, z, s) => {
      const g = new THREE.IcosahedronGeometry(s, 1);
      g.translate(x, y, z);
      return g;
    };
    const bushGeo = bakeVertexAO(
      mergeGeometries([blobS(0, 0, 0, 0.9), blobS(0.7, -0.1, 0.2, 0.6), blobS(-0.6, -0.1, -0.25, 0.55)]),
      -0.9,
      1,
      0.5,
    );
    const bushMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true, vertexColors: true });
    const BN = 110;
    const bushes = new THREE.InstancedMesh(bushGeo, bushMat, BN);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const cv = new THREE.Color();
    const UPY = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    for (let i = 0; i < BN; i++) {
      const a = hash01(`sba${i}`) * Math.PI * 2;
      let r = LAKE_R + 8 + hash01(`sbr${i}`) * 320;
      if (Math.abs(r - ROAD_R) < ROAD_W + 2) r = ROAD_R + ROAD_W + 2.5 + hash01(`sbf${i}`) * 6;
      const s = 0.7 + hash01(`sbs${i}`) * 1.1;
      q.setFromAxisAngle(UPY, hash01(`sbq${i}`) * Math.PI);
      sc.set(s, s, s);
      m4.compose(pos.set(Math.cos(a) * r, 0.4 * s, Math.sin(a) * r), q, sc);
      bushes.setMatrixAt(i, m4);
      if (i % 3 === 0) cv.setHSL(0.85 + hash01(`sbc${i}`) * 0.08, 0.45, 0.18 + hash01(`sbl${i}`) * 0.08);
      else cv.setHSL(0.45 + hash01(`sbc${i}`) * 0.1, 0.4, 0.13 + hash01(`sbl${i}`) * 0.08);
      bushes.setColorAt(i, cv);
    }
    scene.add(bushes);

    const rockGeo = bakeVertexAO(new THREE.DodecahedronGeometry(0.8, 0), -0.8, 0.8, 0.55);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true, vertexColors: true });
    const RN = 70;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, RN);
    for (let i = 0; i < RN; i++) {
      const a = hash01(`sra${i}`) * Math.PI * 2;
      let r = LAKE_R + 6 + hash01(`srr${i}`) * 340;
      if (Math.abs(r - ROAD_R) < ROAD_W + 2) r = ROAD_R - ROAD_W - 2.5 - hash01(`srf${i}`) * 4;
      const s = 0.5 + hash01(`srs${i}`) * 1.3;
      q.setFromAxisAngle(UPY, hash01(`srq${i}`) * Math.PI);
      sc.set(s, s * 0.6, s);
      m4.compose(pos.set(Math.cos(a) * r, 0.25 * s, Math.sin(a) * r), q, sc);
      rocks.setMatrixAt(i, m4);
      cv.setHSL(0.65 + hash01(`src${i}`) * 0.05, 0.12, 0.22 + hash01(`srl${i}`) * 0.1);
      rocks.setColorAt(i, cv);
    }
    scene.add(rocks);
  }

  /* ----- trees: instanced, shadowed ----- */

  {
    const N = 140;
    const trunkGeo = new THREE.CylinderGeometry(0.24, 0.4, 2.4, 6);
    /* blobby faceted canopy: a handful of merged icosahedra, flat-shaded —
       the toy-tree silhouette the whole look hangs on */
    const blob = (x, y, z, s) => {
      const g = new THREE.IcosahedronGeometry(s, 1);
      g.translate(x, y, z);
      return g;
    };
    const canopyGeo = bakeVertexAO(
      mergeGeometries([
        blob(0, 0, 0, 1.9),
        blob(1.15, 0.65, 0.3, 1.25),
        blob(-1.05, 0.5, -0.45, 1.3),
        blob(0.2, 1.45, -0.1, 1.15),
        blob(-0.25, 0.35, 1.1, 1.05),
      ]),
      -1.9,
      2.6,
      0.55,
    );
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x241a18, roughness: 0.9 });
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      flatShading: true,
      vertexColors: true,
    });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, N);
    trunks.castShadow = canopies.castShadow = true;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const cv = new THREE.Color();
    /* seeded like the billboards/rocks — trees are colliders, so a layout
       that shifts per reload also shifts collision under a parked car */
    let placed = 0;
    let guard = 0;
    while (placed < N && guard++ < 4000) {
      const a = hash01(`ta${guard}`) * Math.PI * 2;
      const r = LAKE_R + 14 + hash01(`tr${guard}`) * 380;
      if (Math.abs(r - ROAD_R) < ROAD_W + 6) continue;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const s = 0.75 + hash01(`ts${guard}`) * 1.5;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(`ty${guard}`) * Math.PI);
      sc.set(s, s, s);
      m4.compose(new THREE.Vector3(x, 1.2 * s, z), q, sc);
      trunks.setMatrixAt(placed, m4);
      m4.compose(new THREE.Vector3(x, (2.4 + 1.5) * s, z), q, sc);
      canopies.setMatrixAt(placed, m4);
      /* night autumn: most trees deep teal, every third one pink/magenta */
      if (placed % 3 === 0) cv.setHSL(0.83 + hash01(`th${guard}`) * 0.1, 0.5, 0.2 + hash01(`tl${guard}`) * 0.1);
      else cv.setHSL(0.42 + hash01(`th${guard}`) * 0.12, 0.45, 0.14 + hash01(`tl${guard}`) * 0.09);
      canopies.setColorAt(placed, cv);
      if (r < 420) colliders.push({ x, z, r: 1.4 * s });
      placed++;
    }
    /* if the guard ever exhausts first, unwritten slots must not render —
       an unset instance sits at the origin, mid-lake */
    trunks.count = placed;
    canopies.count = placed;
    scene.add(trunks, canopies);
  }

  /* ----- grass tufts: low-poly blades, instanced — the playset lawn ----- */

  {
    const blades = [];
    for (let b = 0; b < 7; b++) {
      const h = 0.8 + (b % 3) * 0.35;
      const g = new THREE.ConeGeometry(0.09, h, 4, 1);
      g.translate(0, h / 2, 0);
      const a = (b / 7) * Math.PI * 2;
      g.rotateX(0.3 * Math.cos(a));
      g.rotateZ(0.3 * Math.sin(a));
      g.translate(Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17);
      blades.push(g);
    }
    const tuftGeo = bakeVertexAO(mergeGeometries(blades), 0, 1.1, 0.5);
    const tuftMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      flatShading: true,
      vertexColors: true,
    });
    const N = coarse ? 350 : 700;
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, N);
    tufts.castShadow = !coarse;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const cv = new THREE.Color();
    const UP_Y = new THREE.Vector3(0, 1, 0);
    const tmpPos = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const a = hash01(`tuft-a${i}`) * Math.PI * 2;
      /* cluster near the road where the player actually drives */
      const band = hash01(`tuft-b${i}`);
      let r =
        band < 0.6
          ? ROAD_R + (hash01(`tuft-r${i}`) < 0.5 ? -1 : 1) * (ROAD_W + 2.5 + hash01(`tuft-d${i}`) * 26)
          : LAKE_R + 8 + hash01(`tuft-d${i}`) * 340;
      /* never skip an instance — an untouched slot renders at the origin */
      if (r < LAKE_R + 4) r = LAKE_R + 4 + hash01(`tuft-f${i}`) * 10;
      if (Math.abs(r - ROAD_R) < ROAD_W + 1.5)
        r = ROAD_R + Math.sign(r - ROAD_R || 1) * (ROAD_W + 1.8 + hash01(`tuft-g${i}`) * 4);
      const s = 0.75 + hash01(`tuft-s${i}`) * 1.1;
      q.setFromAxisAngle(UP_Y, hash01(`tuft-q${i}`) * Math.PI);
      sc.set(s, s * (0.85 + hash01(`tuft-h${i}`) * 0.5), s);
      m4.compose(tmpPos.set(Math.cos(a) * r, 0, Math.sin(a) * r), q, sc);
      tufts.setMatrixAt(i, m4);
      cv.setHSL(0.4 + hash01(`tuft-c${i}`) * 0.14, 0.5, 0.13 + hash01(`tuft-l${i}`) * 0.1);
      tufts.setColorAt(i, cv);
    }
    scene.add(tufts);
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

  /* drift smoke: pooled sprites puffing off the rear wheels */
  const smoke = [];
  {
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: cloudTexture(),
          color: 0xb9c2d8,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      s.visible = false;
      scene.add(s);
      smoke.push({ s, life: 0 });
    }
  }
  let smokeT = 0;
  function smokeAt(x, y, z) {
    const p = smoke.find((q) => q.life <= 0) ?? smoke[0];
    p.s.position.set(x, y, z);
    p.s.scale.setScalar(0.8);
    p.life = 0.7;
    p.s.visible = true;
  }

  /* a shooting star now and then */
  const meteor = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture('#cfe8ff'),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  meteor.scale.set(14, 0.7, 1);
  meteor.visible = false;
  scene.add(meteor);
  const meteorState = { t: 9, active: 0, dx: 0, dy: 0 };

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
    /* toy jeep: bright red tub, cream trim, chunky proportions — the
       hero must read like something off a playroom shelf */
    const paint = new THREE.MeshPhysicalMaterial({
      color: 0xc6394d,
      metalness: 0.25,
      roughness: 0.42,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.4,
      /* emissive floor: the hero never goes fully black, whatever the
         light does — every night racer cheats this way */
      emissive: 0x3a1018,
      emissiveIntensity: 0.55,
    });
    const cream = new THREE.MeshStandardMaterial({
      color: 0xe8dcc2,
      roughness: 0.55,
      emissive: 0x3a362c,
      emissiveIntensity: 0.4,
    });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1a1218, metalness: 0.2, roughness: 0.7 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x16233a,
      metalness: 0.9,
      roughness: 0.1,
      envMapIntensity: 1.8,
      emissive: 0x18243c,
      emissiveIntensity: 0.5,
    });

    /* tub + hood + grille — rounded geometry so the edges catch the lamp
       light like molded plastic, not CAD boxes */
    const chassis = new THREE.Mesh(new RoundedBoxGeometry(2.1, 0.82, 3.95, 4, 0.18), paint);
    chassis.position.y = 0.8;
    const hood = new THREE.Mesh(new RoundedBoxGeometry(1.72, 0.2, 1.2, 3, 0.08), paint);
    hood.position.set(0, 1.24, 1.25);
    const grille = new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.36, 0.14, 2, 0.06), cream);
    grille.position.set(0, 0.94, 1.99);
    /* cabin: glasshouse + rounded roof */
    const cabin = new THREE.Mesh(new RoundedBoxGeometry(1.84, 0.64, 1.9, 3, 0.14), glass);
    cabin.position.set(0, 1.48, -0.5);
    const roof = new THREE.Mesh(new RoundedBoxGeometry(2.02, 0.18, 2.12, 3, 0.09), paint);
    roof.position.set(0, 1.86, -0.5);
    /* roof rack + a four-pod light bar on the leading edge */
    const rackParts = [];
    for (const sx of [-0.8, 0.8]) {
      const rail = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.16, 1.9, 2, 0.05), cream);
      rail.position.set(sx, 2.02, -0.5);
      rackParts.push(rail);
    }
    for (const sz of [-1.25, -0.5, 0.25]) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.12), cream);
      rung.position.set(0, 2.02, sz);
      rackParts.push(rung);
    }
    const podMat = new THREE.MeshStandardMaterial({
      color: 0x445566,
      emissive: 0xfff2cf,
      emissiveIntensity: 2.2,
    });
    for (const sx of [-0.6, -0.2, 0.2, 0.6]) {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 8), podMat);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(sx, 2.06, 0.42);
      rackParts.push(pod);
    }
    /* fenders over each wheel */
    const fenders = [];
    for (const [sx, sz] of [
      [-1.05, 1.32],
      [1.05, 1.32],
      [-1.05, -1.32],
      [1.05, -1.32],
    ]) {
      const f = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.26, 1.3, 2, 0.1), trim);
      f.position.set(sx, 1.02, sz);
      fenders.push(f);
    }
    /* side steps under the doors */
    for (const sx of [-1.08, 1.08]) {
      const step = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.12, 1.3, 2, 0.05), cream);
      step.position.set(sx, 0.42, 0);
      fenders.push(step);
    }
    /* mirrors on the A-pillars */
    for (const sx of [-1.0, 1.0]) {
      const mirror = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.22, 0.1, 2, 0.04), trim);
      mirror.position.set(sx, 1.52, 0.42);
      fenders.push(mirror);
    }
    /* bumpers */
    const bumperF = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.26, 0.34, 2, 0.1), cream);
    bumperF.position.set(0, 0.5, 2.06);
    const bumperB = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.26, 0.34, 2, 0.1), cream);
    bumperB.position.set(0, 0.5, -2.06);
    /* spare on the tailgate + exhaust */
    const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.26, 16), trim);
    spare.rotation.x = Math.PI / 2;
    spare.position.set(0, 1.02, -2.1);
    const spareHub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 10), cream);
    spareHub.rotation.x = Math.PI / 2;
    spareHub.position.set(0, 1.02, -2.1);
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 8), trim);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(0.7, 0.34, -2.0);
    /* whip antenna */
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.035, 1.1, 5), trim);
    antenna.position.set(-0.9, 1.62, -1.6);
    antenna.rotation.x = -0.28;

    const solid = [chassis, hood, cabin, roof, grille, bumperF, bumperB, spare, ...fenders];
    for (const m of solid) m.castShadow = m.receiveShadow = true;
    body.add(...solid, spareHub, exhaust, ...rackParts, antenna);

    /* round headlights on the grille */
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x445566, emissive: 0xfff2cf, emissiveIntensity: 2.8 });
    for (const sx of [-0.58, 0.58]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 12), lampMat);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(sx, 1.0, 2.04);
      body.add(lamp);
    }
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.12, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x330808, emissive: 0xff2233, emissiveIntensity: 1.4 }),
    );
    tail.position.set(0, 1.18, -2.12);
    body.add(tail);

    /* chunky two-tone wheels: dark tire + cream hub */
    const tireGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.44, 14);
    tireGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.27, 0.27, 0.46, 10);
    hubGeo.rotateZ(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.9 });
    const wheels = [];
    const steerPivots = [];
    for (const [sx, sz, front] of [
      [-1.05, 1.32, true],
      [1.05, 1.32, true],
      [-1.05, -1.32, false],
      [1.05, -1.32, false],
    ]) {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      const hub = new THREE.Mesh(hubGeo, cream);
      wheel.add(tire, hub);
      const pivot = new THREE.Group();
      pivot.position.set(sx, 0.52, sz);
      pivot.add(wheel);
      car.add(pivot);
      wheels.push(wheel);
      if (front) steerPivots.push(pivot);
    }

    /* contact shadow: a soft dark blob under the chassis — the shadow map
       can't deliver the tight ambient occlusion that visually glues the
       car to the road */
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 5.8),
      new THREE.MeshBasicMaterial({
        map: glowTexture('#000000'),
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.05;
    blob.renderOrder = 1;
    car.add(blob);

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
    glow.renderOrder = 2;
    car.add(glow);

    /* headlight spots — no volumetric cones: the chase camera looks
       straight down the beam axis, so an additive cone reads as a
       permanent blob in the middle of the screen */
    const spots = [];
    for (const sx of [-0.6, 0.6]) {
      const s = new THREE.SpotLight(0xbfd8ff, 130, 100, 0.5, 0.55, 1.5);
      s.position.set(sx, 1.0, 2.0);
      const tgt = new THREE.Object3D();
      tgt.position.set(sx * 1.5, 0.2, 30);
      car.add(tgt);
      s.target = tgt;
      car.add(s);
      spots.push(s);
    }

    /* hero light: a soft cool fill above the rear — the chase camera
       always sees the car's unlit side, so without this the hero is a
       silhouette with tail lights */
    /* sits camera-side so it lands on the vertical rear panel — directly
       above the car it only grazes the faces the chase view sees */
    const fill = new THREE.PointLight(0xa9c4f2, 32, 16, 2);
    fill.position.set(0, 2.8, -5.2);
    car.add(fill);

    car.add(body);
    car.userData = { body, wheels, steerPivots, tail };
    return car;
  }

  const car = makeCar();
  scene.add(car);

  /* ----- the physics car: chassis body + RaycastVehicle ----- */

  /* visual origin is at ground level; the chassis body's center floats at
     wheel radius + suspension — VIS_OFF maps body space to mesh space */
  const VIS_OFF = 0.86;
  const chassisBody = new CANNON.Body({
    mass: 150,
    shape: new CANNON.Box(new CANNON.Vec3(1.05, 0.45, 2.0)),
    angularDamping: 0.25,
  });
  chassisBody.allowSleep = false; // a sleeping chassis ignores the engine AND its own suspension
  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });
  const WHEEL_OPTS = {
    radius: 0.52,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    axleLocal: new CANNON.Vec3(1, 0, 0),
    suspensionStiffness: 38,
    suspensionRestLength: 0.42,
    maxSuspensionTravel: 0.38,
    maxSuspensionForce: 1e5,
    dampingRelaxation: 2.4,
    dampingCompression: 4.4,
    frictionSlip: 2.1,
    rollInfluence: 0.04,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
  };
  /* FL, FR, RL, RR — steering drives 0/1, the engine drives 2/3 */
  for (const [sx, sz] of [
    [-1.05, 1.32],
    [1.05, 1.32],
    [-1.05, -1.32],
    [1.05, -1.32],
  ])
    vehicle.addWheel({ ...WHEEL_OPTS, chassisConnectionPointLocal: new CANNON.Vec3(sx, 0.05, sz) });
  vehicle.addToWorld(phys);

  /* QA hook for headless physics tests — inert unless the flag is set */
  const debugHook = (extra) => {
    try {
      if (localStorage.getItem('sodium-debug')) window.__sd = { chassisBody, vehicle, phys, CANNON, ...extra };
    } catch {}
  };

  let carA = 0; // heading, derived from the chassis each frame
  const vel = new THREE.Vector3(); // chassis velocity, mirrored each frame
  let steer = 0;
  let foundCount = posts.filter((p) => p.slug && found.has(p.slug)).length;
  const keys = { gas: false, brake: false, drift: false };

  const roadPoint = (a) => new THREE.Vector3(Math.cos(a) * ROAD_R, 0, Math.sin(a) * ROAD_R);
  const bbAngle = (i, slug) => (i / posts.length) * Math.PI * 2 + hash01(slug ?? String(i)) * 0.3;

  const placeCar = (x, z, yaw, y = VIS_OFF + 0.25) => {
    chassisBody.wakeUp();
    chassisBody.position.set(x, y, z);
    chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    carA = yaw;
  };

  {
    let placed = false;
    const saved = store.carState();
    /* validate field-by-field — NaN in a cannon body position poisons the
       whole physics step, not just the car */
    const finiteArr = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
    if (saved && finiteArr(saved.p, 3) && Date.now() - (saved.t ?? 0) < 45 * 60 * 1000) {
      try {
        chassisBody.position.set(saved.p[0], Math.max(saved.p[1] + VIS_OFF, VIS_OFF + 0.2), saved.p[2]);
        if (finiteArr(saved.q, 4)) chassisBody.quaternion.set(...saved.q);
        else chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Number.isFinite(saved.a) ? saved.a : 0);
        chassisBody.velocity.set(...(finiteArr(saved.v, 3) ? saved.v : [0, 0, 0]));
        carA = Number.isFinite(saved.a) ? saved.a : 0;
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
      const sp = roadPoint(a);
      placeCar(sp.x, sp.z, a + Math.PI / 2); // facing along the road, counter-clockwise
    }
    car.position.copy(chassisBody.position);
    car.position.y -= VIS_OFF;
  }

  /* ----- knockables: pin clusters + the name in letters, toy physics ----- */

  const props = [];
  const ramps = []; // { x, z, fx, fz, rx, rz, len, h, w } — jump physics
  const coneSpots = []; // resting cones: one InstancedMesh, knocked → real prop
  let coneInst = null;
  let coneGeoShared = null;
  let coneMatShared = null;
  let pinsDown = 0;
  let pinsTotal = 0;
  const propV = new THREE.Vector3();
  const coneM4 = new THREE.Matrix4();

  /* shared launch: pins, cones and letters take the hit through their real
     rigid bodies now — the impulse seeds the comedy, cannon does the rest */
  function knockProp(p, dx, dz) {
    p.body.wakeUp();
    const d = Math.max(0.001, Math.hypot(dx, dz));
    const sp = vel.length();
    p.body.velocity.set(vel.x * 0.8 + (dx / d) * 4, 2.2 + sp * 0.12, vel.z * 0.8 + (dz / d) * 4);
    p.body.angularVelocity.set(
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 8,
    );
    if (p.isPin) {
      if (!p.down) {
        p.down = true;
        pinsDown++;
        if (hud?.els?.pins) hud.els.pins.textContent = `pins ${pinsDown}/${pinsTotal}`;
        if (pinsDown === pinsTotal) hud?.toast('every pin down — strike!', 'ok');
      }
      audio.clack();
    } else if (p.isCone) {
      audio.clack();
    } else {
      audio.thud();
      shake = Math.min(1, shake + 0.2);
    }
  }

  /* outside the builder block — the cone-instance promoter needs it too.
     opts.half = the body box half-extents [hx, hy, hz] */
  const addProp = (g, opts) => {
    g.position.y = opts.restStand;
    scene.add(g);
    const body = new CANNON.Body({
      mass: opts.mass,
      shape: new CANNON.Box(new CANNON.Vec3(...opts.half)),
      position: new CANNON.Vec3(g.position.x, g.position.y, g.position.z),
      linearDamping: 0.15,
      angularDamping: 0.35,
      sleepSpeedLimit: 0.55,
      sleepTimeLimit: 0.4,
    });
    body.quaternion.copy(g.quaternion);
    body.sleep(); // settled until something real touches it
    phys.addBody(body);
    props.push({
      g,
      body,
      r: opts.r,
      isPin: !!opts.isPin,
      isCone: !!opts.isCone,
      down: false,
    });
  };

  {
    /* pins: white-and-red cylinders in triangle clusters on the shoulder */
    const pinGeo = new THREE.CylinderGeometry(0.17, 0.21, 1.1, 10);
    const stripeGeo = new THREE.CylinderGeometry(0.215, 0.215, 0.16, 10);
    const pinMat = new THREE.MeshStandardMaterial({
      color: 0xf2ecdf,
      roughness: 0.5,
      emissive: 0x4a463c,
      emissiveIntensity: 0.4,
    });
    const stripeMat = new THREE.MeshStandardMaterial({
      color: 0xd84b58,
      roughness: 0.5,
      emissive: 0x55161c,
      emissiveIntensity: 0.4,
    });
    for (let c = 0; c < 6; c++) {
      const a = hash01(`pins-${c}`) * Math.PI * 2;
      const side = c % 2 ? 1 : -1;
      const r = ROAD_R + side * (ROAD_W + 2.6);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      /* triangle: rows of 1 + 2 + 3, pointed at the road */
      let k = 0;
      for (let row = 0; row < 3; row++)
        for (let col = 0; col <= row; col++) {
          const g = new THREE.Group();
          const pin = new THREE.Mesh(pinGeo, pinMat);
          pin.castShadow = true;
          const stripeM = new THREE.Mesh(stripeGeo, stripeMat);
          stripeM.position.y = 0.3;
          g.add(pin, stripeM);
          const ox = (col - row / 2) * 0.62;
          const oz = row * 0.58;
          g.position.set(cx + ox, 0, cz + oz);
          addProp(g, { r: 0.5, mass: 1, restStand: 0.55, half: [0.21, 0.55, 0.21], isPin: true });
          k++;
        }
      pinsTotal += k;
    }

    /* the site's name, drivable: blocky letters built from boxes */
    const H = 1.7;
    const S = 0.27;
    const D = 0.36;
    /* rotation.z is CCW seen from the front: a stroke's top moves toward
       -x with positive angles — get a sign wrong and the R reads Я */
    const STROKES = {
      X: [[0, 0, S, H * 1.16, 0.6], [0, 0, S, H * 1.16, -0.6]],
      A: [[-0.24, 0, S, H * 1.1, -0.27], [0.24, 0, S, H * 1.1, 0.27], [0, -0.16, 0.62, S, 0]],
      N: [[-0.38, 0, S, H, 0], [0.38, 0, S, H, 0], [0, 0, S, H * 1.12, 0.52]],
      D: [[-0.38, 0, S, H, 0], [0.05, H / 2 - S / 2, 0.72, S, 0], [0.05, -H / 2 + S / 2, 0.72, S, 0], [0.38, 0, S, H * 0.66, 0]],
      R: [[-0.36, 0, S, H, 0], [0.05, H / 2 - S / 2, 0.7, S, 0], [0.05, H * 0.06, 0.7, S, 0], [0.36, H * 0.28, S, H * 0.42, 0], [0.18, -H * 0.27, S, H * 0.58, 0.36]],
      E: [[-0.34, 0, S, H, 0], [0.08, H / 2 - S / 2, 0.76, S, 0], [0.02, 0, 0.62, S, 0], [0.08, -H / 2 + S / 2, 0.76, S, 0]],
    };
    const letterMat = new THREE.MeshStandardMaterial({
      color: 0xeae2cf,
      roughness: 0.5,
      emissive: 0x46412f,
      emissiveIntensity: 0.45,
    });
    const word = 'XANDREED';
    const aMid = bbAngle(0, posts[0]?.slug) - 0.25 + 0.12; /* by the spawn */
    const rL = ROAD_R - 14;
    const dA = 1.7 / rL;
    [...word].forEach((ch, i) => {
      const g = new THREE.Group();
      for (const [x, y, w, h, rot] of STROKES[ch]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, D), letterMat);
        m.position.set(x, y, 0);
        m.rotation.z = rot;
        m.castShadow = true;
        g.add(m);
      }
      /* screen-right from the road viewpoint is decreasing angle — march
         the letters that way or the name reads mirrored */
      const a = aMid - (i - (word.length - 1) / 2) * dA;
      g.position.set(Math.cos(a) * rL, 0, Math.sin(a) * rL);
      g.lookAt(Math.cos(a) * ROAD_R, 0, Math.sin(a) * ROAD_R);
      addProp(g, { r: 0.8, mass: 2.6, restStand: H / 2, half: [0.55, H / 2, 0.18] });
    });

    /* stunt strips: every doc exit gets a seeded jump ramp + cone slalom
       on the approach — the docs become a stunt course, not just signs */
    const rampMat = new THREE.MeshStandardMaterial({
      map: chevronTexture(),
      roughness: 0.6,
      emissive: 0x3a342c,
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
    });
    /* one merged, vertex-colored cone geometry: ALL resting cones render
       as a single InstancedMesh — a cone only becomes a real physics mesh
       once the car hits it. ~120 individual cone groups cost ~270 draw
       calls and took the iGPU from 60fps to 10. */
    const colorize = (geo, hex) => {
      const cc = new THREE.Color(hex);
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        arr[k * 3] = cc.r;
        arr[k * 3 + 1] = cc.g;
        arr[k * 3 + 2] = cc.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return geo;
    };
    coneGeoShared = mergeGeometries([
      colorize(new THREE.ConeGeometry(0.32, 0.72, 9), 0xf08a3c),
      colorize(new THREE.CylinderGeometry(0.21, 0.25, 0.14, 9).translate(0, -0.08, 0), 0xf2ecdf),
    ]);
    coneMatShared = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      emissive: 0x2a1606,
      emissiveIntensity: 0.55,
    });
    /* tangent of the ring at angle a, pointing counter-clockwise (the
       direction the car spawns facing) */
    const tangentAt = (a, out) => {
      out.set(
        Math.cos(a + 0.04) * ROAD_R - Math.cos(a) * ROAD_R,
        0,
        Math.sin(a + 0.04) * ROAD_R - Math.sin(a) * ROAD_R,
      );
      return out.normalize();
    };
    const tanV = new THREE.Vector3();
    posts.forEach((post, i) => {
      const rnd = mulberry(hash32(`stunt-${post.slug ?? i}`));
      const aB = bbAngle(i, post.slug);
      /* ramp sits just before the exit, riding the outer half of the road */
      const len = 7 + rnd() * 2.5;
      const hgt = 1.5 + rnd() * 0.8;
      const aR = aB - (16 + rnd() * 6) / ROAD_R;
      const rr = ROAD_R + (rnd() - 0.35) * 5;
      const ramp = new THREE.Mesh(wedgeGeometry(4.2, hgt, len), rampMat);
      ramp.position.set(Math.cos(aR) * rr, 0.02, Math.sin(aR) * rr);
      tangentAt(aR, tanV);
      ramp.lookAt(ramp.position.x + tanV.x, 0.02, ramp.position.z + tanV.z);
      ramp.receiveShadow = true;
      scene.add(ramp);
      ramps.push({
        x: ramp.position.x,
        z: ramp.position.z,
        fx: tanV.x,
        fz: tanV.z,
        rx: tanV.z,
        rz: -tanV.x,
        len,
        h: hgt,
        w: 4.2,
      });
      /* the physics ramp: a static box pitched to match the wedge's slope,
         its top face flush with the visual surface. The vertical drop at
         the far end stays open — that's the launch */
      {
        const slope = Math.atan2(hgt, len);
        const slopeLen = Math.hypot(len, hgt);
        const body = new CANNON.Body({
          type: CANNON.Body.STATIC,
          shape: new CANNON.Box(new CANNON.Vec3(2.1, 0.25, slopeLen / 2)),
        });
        const qy = new CANNON.Quaternion().setFromAxisAngle(
          new CANNON.Vec3(0, 1, 0),
          Math.atan2(tanV.x, tanV.z),
        );
        const qp = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -slope);
        body.quaternion.copy(qy.mult(qp));
        const n = body.quaternion.vmult(new CANNON.Vec3(0, 1, 0));
        body.position.set(
          ramp.position.x + tanV.x * (len / 2) - n.x * 0.25,
          hgt / 2 - n.y * 0.25,
          ramp.position.z + tanV.z * (len / 2) - n.z * 0.25,
        );
        phys.addBody(body);
        body.updateAABB(); // statics never refresh it — set AFTER posing, or rays pass through
      }
      /* cone slalom on the approach — instances, not objects */
      const nCones = 4 + Math.floor(rnd() * 3);
      for (let k = 0; k < nCones; k++) {
        const aC = aR - (5 + k * 3.6) / ROAD_R;
        tangentAt(aC, tanV);
        const lat = (k % 2 ? 1 : -1) * (2.2 + rnd() * 1.4);
        coneSpots.push({
          x: Math.cos(aC) * ROAD_R + tanV.z * lat,
          z: Math.sin(aC) * ROAD_R - tanV.x * lat,
          alive: true,
        });
      }
    });

    coneInst = new THREE.InstancedMesh(coneGeoShared, coneMatShared, coneSpots.length);
    coneInst.castShadow = true;
    {
      const m4 = new THREE.Matrix4();
      coneSpots.forEach((c, k) => {
        c.idx = k;
        m4.makeRotationY(hash01(`cone-rot${k}`) * Math.PI);
        m4.setPosition(c.x, 0.36, c.z);
        coneInst.setMatrixAt(k, m4);
      });
    }
    scene.add(coneInst);
  }

  /* baked contact shadows: dark breath under trees, poles, props — the
     grounding that real-time shadows alone don't deliver at night */
  {
    const R = 280;
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');
    const blot = (x, z, r, a) => {
      if (x * x + z * z > R * R) return;
      const u = ((x / R) * 0.5 + 0.5) * 1024;
      const v = ((-z / R) * 0.5 + 0.5) * 1024; /* circle uv: +v is -z */
      const rr = Math.max(3, (r / R) * 0.5 * 1024);
      const g = ctx.createRadialGradient(u, v, 0, u, v, rr);
      g.addColorStop(0, `rgba(2, 4, 14, ${a})`);
      g.addColorStop(1, 'rgba(2, 4, 14, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(u, v, rr, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const cb of colliders) blot(cb.x, cb.z, cb.r * 2.5, 0.42);
    for (const p of props) blot(p.g.position.x, p.g.position.z, p.r * 2.2, 0.36);
    for (const cs of coneSpots) blot(cs.x, cs.z, 0.9, 0.3);
    const tex = new THREE.CanvasTexture(c);
    const overlay = new THREE.Mesh(
      new THREE.CircleGeometry(R, 48),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    overlay.rotation.x = -Math.PI / 2;
    overlay.position.y = 0.05;
    overlay.renderOrder = 1;
    scene.add(overlay);
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
    /* canvas touchMOVES are the game's, never the page's: stop the browser
       from claiming a held drag as a scroll and firing pointercancel
       mid-steer (CSS touch-action should cover this; Safari has dropped it
       before). Never cancel touchSTART — that kills the implicit pointer
       capture and Chrome ends the pointer stream after the first moves. */
    el.addEventListener('touchmove', (e) => e.preventDefault(), { signal, passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault(), { signal });

    addEventListener('pagehide', saveCar, { signal });

    const overlay = hud?.querySelector('[data-sd-overlay]');
    let overlayGone = false;
    const dismissOverlay = () => {
      if (overlayGone) return;
      overlayGone = true;
      overlay?.classList.add('hidden');
    };
    setTimeout(() => {
      if (!signal.aborted) dismissOverlay();
    }, 6000);

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
        else if (['r', 'R'].includes(e.key)) resetToRoad('⟲ reset — back on the road');
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
        /* pen counts as touch here — an Apple Pencil has no other way to
           steer the car (there's no mouse-follow path in this world) */
        if ((e.pointerType !== 'touch' && e.pointerType !== 'pen') || stick.id >= 0 || e.clientX > innerWidth * 0.55) return;
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
    hud?.querySelector('[data-sd-reset]')?.addEventListener('click', () => resetToRoad('⟲ reset — back on the road'), {
      signal,
    });
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
    store.carState({
      p: car.position.toArray(),
      a: carA,
      q: chassisBody.quaternion.toArray(),
      v: chassisBody.velocity.toArray(),
      t: Date.now(),
    });
  }

  /* ----- physics + game loop ----- */

  /* every {x, z, r} obstacle becomes a static cylinder in the cannon world
     (poles, trees, turbine towers, billboard legs) */
  for (const cb of colliders) {
    const b = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Cylinder(cb.r, cb.r, 8, 8),
    });
    b.position.set(cb.x, 4, cb.z);
    phys.addBody(b);
    b.updateAABB(); // statics never refresh it after posing
  }

  debugHook({ placeCar, props, ramps });

  const VMAX = 46;
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const camLook = new THREE.Vector3(); // never aliases fwd/tmpV
  let dockIdx = -1;
  let shake = 0;
  let hudTimer = 0;
  /* vertical: ramps launch the car, gravity brings it back */
  let airborne = false;
  let airT = 0;
  let squash = 0;
  let lampCullT = 9; // force an immediate first cull pass
  let crashCd = 0; // collision thud debounce
  let prevVy = 0;
  let flipT = 0; // dwell inverted-and-slow before the roof rescue fires

  const fwdOf = (a, out) => out.set(Math.sin(a), 0, Math.cos(a));

  function resetToRoad(msg = 'fished out — back on the road') {
    const a = Math.atan2(car.position.z, car.position.x);
    const sp = roadPoint(a);
    placeCar(sp.x, sp.z, a + Math.PI / 2);
    airborne = false;
    audio.splash();
    hud?.toast(msg);
    shake = 1;
  }

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    /* --- driving: feed the RaycastVehicle, then let cannon integrate --- */
    const steerTarget = stick.id >= 0 ? -stick.x : (keys.left ? 1 : 0) + (keys.right ? -1 : 0);
    steer = THREE.MathUtils.lerp(steer, THREE.MathUtils.clamp(steerTarget, -1, 1), 1 - Math.exp(-dt * 8));

    vel.set(chassisBody.velocity.x, chassisBody.velocity.y, chassisBody.velocity.z);
    car.quaternion.set(
      chassisBody.quaternion.x,
      chassisBody.quaternion.y,
      chassisBody.quaternion.z,
      chassisBody.quaternion.w,
    );
    const fwd = tmpV.set(0, 0, 1).applyQuaternion(car.quaternion);
    carA = Math.atan2(fwd.x, fwd.z);
    const speedAlong = vel.dot(fwd);
    const speed = vel.length();

    /* steering: full lock at parking speed, gentle at pace */
    const steerVal = (steer * 0.62) / (1 + speed * 0.012);
    vehicle.setSteeringValue(steerVal, 0);
    vehicle.setSteeringValue(steerVal, 1);

    /* engine / brake / reverse — AWD: per-wheel force stays under the
       traction cap, so the punch arrives instead of vaporizing as spin */
    const F = 950;
    let engine = 0;
    if (keys.gas) engine = -F;
    else if (keys.brake && speedAlong <= 1) engine = F * 0.55; // reverse
    for (let i = 0; i < 4; i++) vehicle.applyEngineForce(engine, i);
    const braking = keys.brake && speedAlong > 1 ? 16 : keys.gas ? 0 : 1.2; // light engine braking
    for (let i = 0; i < 4; i++) vehicle.setBrake(braking, i);

    /* handbrake: the rear tires let go and the car rotates into a slide */
    const rearSlip = keys.drift ? 0.55 : WHEEL_OPTS.frictionSlip;
    vehicle.wheelInfos[2].frictionSlip = rearSlip;
    vehicle.wheelInfos[3].frictionSlip = rearSlip;

    /* offroad: heavy grass drag */
    const radial = Math.hypot(chassisBody.position.x, chassisBody.position.z);
    const offroad = Math.abs(radial - ROAD_R) > ROAD_W + 1.2;
    if (offroad && !airborne) {
      const k = Math.exp(-dt * 0.9);
      chassisBody.velocity.x *= k;
      chassisBody.velocity.z *= k;
    }

    /* top speed + soft world edge */
    if (speed > VMAX) chassisBody.velocity.scale(VMAX / speed, chassisBody.velocity);
    if (radial > 560) {
      tmpV2.copy(car.position).setY(0).normalize();
      chassisBody.velocity.x -= tmpV2.x * dt * 30;
      chassisBody.velocity.z -= tmpV2.z * dt * 30;
    }

    prevVy = chassisBody.velocity.y;
    phys.step(1 / 60, dt, 4);

    /* sync the visual car: the mesh origin sits at ground level, the body
       center floats at suspension height — offset along the body's up */
    car.quaternion.set(
      chassisBody.quaternion.x,
      chassisBody.quaternion.y,
      chassisBody.quaternion.z,
      chassisBody.quaternion.w,
    );
    car.position.set(chassisBody.position.x, chassisBody.position.y, chassisBody.position.z);
    tmpV2.set(0, -VIS_OFF, 0).applyQuaternion(car.quaternion);
    car.position.add(tmpV2);
    vel.set(chassisBody.velocity.x, chassisBody.velocity.y, chassisBody.velocity.z);

    /* airtime: wheels report contact; landings thud and squash */
    const wasAirborne = airborne;
    airborne = vehicle.numWheelsOnGround === 0;
    if (airborne) airT += dt;
    else if (wasAirborne) {
      const impact = Math.max(0, -prevVy);
      squash = Math.min(1, Math.max(0.25, impact * 0.07));
      if (impact > 7) {
        audio.thud();
        shake = Math.min(1, shake + 0.3);
      }
      if (airT > 0.5)
        hud?.toast(`air ${airT.toFixed(1)}s${airT > 1.1 ? ' — send it!' : ''}`, airT > 1.1 ? 'ok' : '');
      airT = 0;
    }

    /* crash feedback: a hard stop against a static means we hit something */
    crashCd = Math.max(0, crashCd - dt);
    const lost = speed - vel.length();
    if (lost > 6 && crashCd <= 0 && !airborne) {
      crashCd = 0.5;
      audio.thud();
      shake = Math.min(1, shake + 0.5);
    }

    /* lake: splash + reset; flipped onto the roof: same rescue. NOT gated on
       !airborne — a roof-parked car has zero wheels on ground, so it counts
       as airborne forever and the rescue would never fire. A short dwell
       keeps mid-air rolls (which carry speed) from triggering it. */
    if (radial < LAKE_R - 2) resetToRoad();
    else if (tmpV2.set(0, 1, 0).applyQuaternion(car.quaternion).y < -0.45 && speed < 3) {
      flipT += dt;
      if (flipT > 1.5) {
        flipT = 0;
        const a = Math.atan2(car.position.z, car.position.x);
        placeCar(car.position.x, car.position.z, a + Math.PI / 2);
        hud?.toast('back on your wheels');
      }
    } else {
      flipT = 0;
    }

    /* resting cones are instances — promote to a live prop on contact */
    if (coneInst && speed > 3 && car.position.y < 1.1) {
      for (const c of coneSpots) {
        if (!c.alive) continue;
        const dx = c.x - car.position.x;
        const dz = c.z - car.position.z;
        if (dx * dx + dz * dz < 3.1) {
          c.alive = false;
          coneM4.makeScale(0, 0, 0);
          coneInst.setMatrixAt(c.idx, coneM4);
          coneInst.instanceMatrix.needsUpdate = true;
          const m = new THREE.Mesh(coneGeoShared, coneMatShared);
          m.castShadow = true;
          m.position.set(c.x, 0, c.z);
          addProp(m, { r: 0.42, mass: 0.5, restStand: 0.36, half: [0.3, 0.36, 0.3], isCone: true });
          knockProp(props[props.length - 1], dx, dz);
        }
      }
    }

    /* knockables: the launch trigger stays proximity-based (guaranteed
       comedy), but flight, tumbling and settling are all cannon's now —
       and a slow nudge topples them through real chassis contact too */
    for (const p of props) {
      if (p.body.sleepState === CANNON.Body.SLEEPING) {
        const dx = p.g.position.x - car.position.x;
        const dz = p.g.position.z - car.position.z;
        const rr = p.r + 1.35;
        if (dx * dx + dz * dz < rr * rr && speed > 3 && car.position.y < 1.1) {
          knockProp(p, dx, dz);
        }
        continue;
      }
      p.g.position.set(p.body.position.x, p.body.position.y, p.body.position.z);
      p.g.quaternion.set(
        p.body.quaternion.x,
        p.body.quaternion.y,
        p.body.quaternion.z,
        p.body.quaternion.w,
      );
      /* a pin counts as down once it tips past ~55° */
      if (p.isPin && !p.down) {
        propV.set(0, 1, 0).applyQuaternion(p.g.quaternion);
        if (propV.y < 0.55) {
          p.down = true;
          pinsDown++;
          if (hud?.els?.pins) hud.els.pins.textContent = `pins ${pinsDown}/${pinsTotal}`;
          if (pinsDown === pinsTotal) hud?.toast('every pin down — strike!', 'ok');
        }
      }
    }

    /* suspension feel: the REAL chassis rolls and pitches now — only the
       landing squash and wheel cosmetics remain hand-animated */
    const { body, wheels, steerPivots, tail } = car.userData;
    squash = Math.max(0, squash - dt * 2.8);
    body.scale.y = 1 - 0.2 * squash;
    body.position.y = -0.09 * squash;
    for (const w of wheels) w.rotation.x += speedAlong * dt * 2.4;
    for (const p of steerPivots)
      p.rotation.y = THREE.MathUtils.lerp(p.rotation.y, steer * 0.42, 1 - Math.exp(-dt * 10));
    tail.material.emissiveIntensity = keys.brake ? 3.4 : 1.4;

    /* sideways velocity = the slide the skid sound and smoke react to */
    const right = tmpV2.set(1, 0, 0).applyQuaternion(car.quaternion);
    const drifting = Math.abs(vel.dot(right)) > 6 && speed > 10 && !airborne;

    audio.engine(speed, keys.gas ? 1 : 0);
    audio.skid(drifting || (offroad && speed > 14 && !airborne));

    /* drift smoke pours off the rear wheels */
    if ((drifting || (offroad && speed > 16)) && !airborne) {
      smokeT -= dt;
      if (smokeT <= 0) {
        smokeT = 0.055;
        const back = fwdOf(carA, tmpV2).multiplyScalar(-1.6);
        smokeAt(
          car.position.x + back.x + (Math.random() - 0.5) * 1.2,
          car.position.y + 0.35,
          car.position.z + back.z + (Math.random() - 0.5) * 1.2,
        );
      }
    }
    for (const p of smoke) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.s.position.y += dt * 1.6;
      p.s.scale.addScalar(dt * 4.2);
      p.s.material.opacity = Math.max(0, p.life * 0.5);
      if (p.life <= 0) p.s.visible = false;
    }

    /* shooting stars */
    meteorState.t -= dt;
    if (meteorState.t <= 0 && !reduced) {
      meteorState.t = 9 + Math.random() * 14;
      meteorState.active = 0.9;
      const a = Math.random() * Math.PI * 2;
      meteor.position.set(
        car.position.x + Math.cos(a) * 240,
        130 + Math.random() * 60,
        car.position.z + Math.sin(a) * 240,
      );
      meteorState.dx = (Math.random() - 0.5) * 220;
      meteorState.dy = -60 - Math.random() * 40;
      meteor.visible = true;
    }
    if (meteorState.active > 0) {
      meteorState.active -= dt;
      meteor.position.x += meteorState.dx * dt;
      meteor.position.y += meteorState.dy * dt;
      meteor.material.opacity = Math.min(0.8, meteorState.active * 2);
      if (meteorState.active <= 0) meteor.visible = false;
    }

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

    /* --- lamp culling: only the two nearest pools light the shaders --- */
    if ((lampCullT += dt) > 0.3) {
      lampCullT = 0;
      for (const L of lampLights)
        L.d = (L.x - car.position.x) ** 2 + (L.z - car.position.z) ** 2;
      lampLights.sort((a, b) => a.d - b.d);
      for (let i = 0; i < lampLights.length; i++) lampLights[i].light.visible = i < 2;
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
      pins: hud.querySelector('[data-sd-pins]'),
    };
    if (hud.els.pins) hud.els.pins.textContent = `pins ${pinsDown}/${pinsTotal}`;
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
