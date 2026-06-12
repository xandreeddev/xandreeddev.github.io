/* ---------------------------------------------------------------------------
   CANOPY — the deep forest.

   The blog as a sunny action-adventure. The homepage is a dense forest you
   explore as an axe-wielding adventurer: every article is a treasure chest
   along the winding trail — locked shut until you read it, then it stands
   open and glowing. Reading articles unlocks combat talents (double jump,
   cyclone, ground slam, berserk); gremlins prowl around their camps; three
   mossy gates warp to boss arenas where a forest ogre guards a star.

   Combat (TERA-berserker grammar): a 3-hit basic chain that cancels into
   itself, a hold-to-block that eats frontal hits, a charge, a spin skill on
   cooldown and a rage-fueled ground-slam ultimate. Hero, gremlin and ogre
   are Meshy-generated rigged GLBs (cel-shaded in-engine); everything else
   stays procedural.

   Controls (desktop): WASD run · space jump · LMB/F attack · RMB/C block ·
   E cyclone · Q slam · shift charge · drag orbits · ↵ open chest / gate ·
   M sound. Touch: left stick, right cluster (A jump · B charge · ⚔ · 🛡 ·
   🌀 · 💥); tap the card to open.

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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/* GTAOPass parks Points/Lines while rendering its G-buffer but forgets
   Sprites — any nearby sprite (dust puff, cloud) becomes an opaque quad in
   the AO input and composites as a floating black rectangle. Park sprites
   the same way; _restoreVisibility brings back everything cached. */
const gtaoOverrideVisibility = GTAOPass.prototype._overrideVisibility;
GTAOPass.prototype._overrideVisibility = function () {
  gtaoOverrideVisibility.call(this);
  const cache = this._visibilityCache;
  this.scene.traverse((object) => {
    if (object.isSprite && object.visible) {
      object.visible = false;
      cache.push(object);
    }
  });
};

const SKY = 0xa9cdf2;
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

/* talents unlock from articles read — chests opened grow the warrior */
const POWERS = [
  { id: 'djump', name: 'double jump', desc: 'jump again mid-air', need: 1 },
  { id: 'skill', name: 'cyclone', desc: 'E: spinning axe storm', need: 3 },
  { id: 'ult', name: 'ground slam', desc: 'Q: rage-fueled cataclysm', need: 6 },
  { id: 'berserk', name: 'berserk', desc: 'hit harder, run faster', need: 10 },
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

/* ----- synth audio: chirpy adventure sounds, no sample assets ----- */

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
    /* --- combat --- */
    swing: () => blip('sawtooth', 320, 80, 0.12, 0.09),
    hit: () => {
      blip('square', 190, 60, 0.09, 0.14);
      blip('triangle', 90, 40, 0.12, 0.1, 0.01);
    },
    block: () => blip('triangle', 950, 480, 0.08, 0.13),
    skillWhirl: () => {
      blip('sawtooth', 180, 720, 0.45, 0.1);
      blip('sawtooth', 240, 880, 0.4, 0.07, 0.08);
    },
    ultBoom: () => {
      blip('sine', 130, 28, 0.7, 0.3);
      blip('sawtooth', 90, 30, 0.5, 0.14, 0.04);
    },
    hurt: () => blip('square', 230, 80, 0.16, 0.16),
    chest: () => {
      blip('triangle', 420, 860, 0.18, 0.12);
      blip('square', 1175, 1175, 0.14, 0.08, 0.16);
    },
    gremlin: () => {
      const f = 620 + Math.random() * 320;
      blip('square', f, f * 1.6, 0.06, 0.05);
      blip('square', f * 1.2, f * 0.8, 0.06, 0.04, 0.07);
    },
    roar: () => {
      blip('sawtooth', 95, 42, 0.85, 0.22);
      blip('square', 70, 38, 0.7, 0.12, 0.1);
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

/* forest floor: deeper mossy checker with leaf-litter speckles */
function meadowTexture() {
  return shared('meadow', () => {
    const t = 32;
    const c = document.createElement('canvas');
    c.width = c.height = t * 8;
    const ctx = c.getContext('2d');
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const v = ((x + y) % 2 ? 0.92 : 1) * (0.94 + hash01(`m${x}:${y}`) * 0.12);
        ctx.fillStyle = `rgb(${Math.round(112 * v)}, ${Math.round(172 * v)}, ${Math.round(98 * v)})`;
        ctx.fillRect(x * t, y * t, t, t);
      }
    for (let i = 0; i < 26; i++) {
      const x = hash01(`fx${i}`) * 256;
      const y = hash01(`fy${i}`) * 256;
      ctx.fillStyle = ['#f7e07a', '#caa86a', '#f0a8c0'][i % 3];
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

/* a wooden trail sign for each treasure chest */
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
  ctx.fillText(read ? `${post.date} · ⚿ plundered` : `${post.date} · press ⏎ to open`, 256, 222);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* ----- rigged assets: Meshy GLBs, cel-shaded in-engine ----- */

const MODEL_BASE = '/models/canopy/';

/* hero clip → file map; walk/run ship with the rig, the rest are presets */
const HERO_CLIPS = ['idle', 'walk', 'run', 'jump', 'fall', 'atk1', 'atk2', 'atk3', 'block', 'charge', 'skill', 'ult'];
const MINION_CLIPS = ['idle', 'walk', 'run', 'atk', 'hit', 'die'];
const BOSS_CLIPS = ['idle', 'walk', 'taunt', 'swing', 'slam', 'die'];

/* Meshy clips carry root motion on Hips — pin the XZ so physics stays the
   only thing that moves the character (Y keeps crouch/leap bob). The clips
   NEED their position tracks: with them removed the rig renders sunk, so
   wrong-unit tracks are rescaled (fixRootUnits) rather than dropped. */
const rootTrackOf = (clip) =>
  clip.tracks.find((t) => {
    if (!t.name.endsWith('.position')) return false;
    const node = t.name.slice(0, -'.position'.length);
    return node === 'Hips' || node === 'Armature';
  });

function pinRoot(clip) {
  const tr = rootTrackOf(clip);
  if (tr) {
    const v = tr.values;
    for (let i = 3; i < v.length; i += 3) {
      v[i] = v[0];
      v[i + 2] = v[2];
    }
  }
  return clip;
}

/* some presets (Block1) author the root position an order of magnitude off
   the rig's unit family — compare against the set's idle clip and rescale */
function fixRootUnits(clips) {
  const ref = rootTrackOf(clips.idle ?? clips.walk)?.values[1];
  if (!ref) return;
  for (const clip of Object.values(clips)) {
    const tr = rootTrackOf(clip);
    if (!tr || !tr.values[1]) continue;
    const ratio = Math.abs(ref / tr.values[1]);
    if (ratio > 5 || ratio < 0.2) {
      for (let i = 0; i < tr.values.length; i++) tr.values[i] *= ratio;
    }
  }
}

/* swap baked PBR for toon: same base color map, hard 3-step terminator */
function toonify(root, ramp) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const old = o.material;
    if (!old) return;
    const m = new THREE.MeshToonMaterial({ map: old.map ?? null, color: old.color?.clone() ?? 0xffffff, gradientMap: ramp });
    if (old.map) old.map.colorSpace = THREE.SRGBColorSpace;
    o.material = m;
    o.castShadow = true;
    o.frustumCulled = false; // skinned bounds lag the pose; tiny scene, draw always
    old.dispose();
  });
}

/* scale + ground a model: feet at y=0, exact height in world units.
   Meshy's rigged GLBs are internally inconsistent about units: the hero
   measures right through node transforms (geometry cm × armature 0.01)
   but its skinned bind sampling lands in cm; the gremlin/ogre are the
   exact opposite (geometry meters under a 0.01 node, bind sampling in
   meters). No single measurement works for both — so take both, and trust
   whichever yields a character-plausible height. */
function normalizeHeight(root, height) {
  root.updateWorldMatrix(true, true);
  const nodeBox = new THREE.Box3().setFromObject(root);
  const skinBox = new THREE.Box3();
  const v = new THREE.Vector3();
  let skinned = false;
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    skinned = true;
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 240));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      o.applyBoneTransform(i, v); // mesh-local, skeleton-posed
      v.applyMatrix4(o.bindMatrix); // → skeleton-world at root scale 1
      skinBox.expandByPoint(v);
    }
  });
  const plausible = (b) => {
    const h = b.max.y - b.min.y;
    return h > 0.3 && h < 6;
  };
  const box = skinned && plausible(skinBox) ? skinBox : nodeBox;
  const h = Math.max(box.max.y - box.min.y, 1e-3);
  const s = height / h;
  root.scale.setScalar(s);
  root.position.y = -box.min.y * s;
  return s;
}

async function loadAssets(signal) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const get = (file) =>
    new Promise((resolve, reject) => {
      loader.load(MODEL_BASE + file, resolve, undefined, () => reject(new Error(`failed: ${file}`)));
    });
  const clipSet = async (prefix, names) => {
    const entries = await Promise.all(
      names.map(async (n) => {
        const g = await get(`${prefix}.${n}.glb`);
        const clip = g.animations[0];
        clip.name = n;
        return [n, clip];
      }),
    );
    const clips = Object.fromEntries(entries);
    fixRootUnits(clips);
    for (const clip of Object.values(clips)) pinRoot(clip);
    return clips;
  };
  const [hero, minion, boss, axe, heroClips, minionClips, bossClips] = await Promise.all([
    get('hero.glb'),
    get('minion.glb'),
    get('boss.glb'),
    get('axe.glb'),
    clipSet('hero', HERO_CLIPS),
    clipSet('minion', MINION_CLIPS),
    clipSet('boss', BOSS_CLIPS),
  ]);
  if (signal.aborted) throw new Error('aborted');
  return {
    hero: { scene: hero.scene, clips: heroClips },
    minion: { scene: minion.scene, clips: minionClips },
    boss: { scene: boss.scene, clips: bossClips },
    axe: axe.scene,
  };
}

/* a tiny clip-state machine around THREE.AnimationMixer */
function makeAnimator(root, clips) {
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const [name, clip] of Object.entries(clips)) actions[name] = mixer.clipAction(clip);
  let current = null;
  const play = (name, { fade = 0.16, once = false, timeScale = 1, clamp = false } = {}) => {
    if (current === name && !once) return actions[name];
    const next = actions[name];
    if (!next) return null;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = clamp || once;
    next.timeScale = timeScale;
    next.fadeIn(fade).play();
    if (current && actions[current] && current !== name) actions[current].fadeOut(fade);
    current = name;
    return next;
  };
  return {
    mixer,
    actions,
    play,
    get current() {
      return current;
    },
    duration: (name) => clips[name]?.duration ?? 1,
  };
}

/* ----- HUD ----- */

/* iPad gets the same legend as desktop — it just spells the touch binds */
const HELP = coarse
  ? 'stick runs · A jump · B charge · ⚔ attack · 🛡 hold to block · drag to look · tap the card to open'
  : 'WASD run · space jump · click/F attack · RMB/C block · E cyclone · Q slam · shift charge · ↵ open · M sound';

function makeHud(powers, coins, stars, total) {
  const hud = document.createElement('div');
  hud.className = 'canopy-hud';
  hud.innerHTML = `
    <div class="cp-meta">
      <div><span class="cp-coin">●</span> <b data-cp-coins>${coins}</b> &nbsp; ★ <b data-cp-stars>${stars}/3</b> &nbsp; ⚿ <b data-cp-read>0/${total}</b></div>
      <div class="cp-vitals">
        <div class="cp-bar cp-hp" title="health"><i data-cp-hp></i></div>
        <div class="cp-bar cp-rage" title="rage — fuels the ultimate"><i data-cp-rage></i></div>
      </div>
      <div class="cp-kit" data-cp-kit>
        <span data-cp-k="skill" class="off"><b>🌀</b><i>E</i><em data-cp-cd="skill"></em></span>
        <span data-cp-k="ult" class="off"><b>💥</b><i>Q</i><em data-cp-cd="ult"></em></span>
      </div>
      <div class="cp-powers" data-cp-powers></div>
    </div>
    <div class="cp-corner"><button type="button" data-cp-fx aria-label="Toggle fancy rendering"></button><button type="button" data-cp-mute aria-label="Toggle sound"></button></div>
    <div class="cp-toasts" data-cp-toasts aria-live="polite"></div>
    <div class="cp-bossbar" data-cp-bossbar hidden><b data-cp-bossname></b><div class="cp-bar cp-bosshp"><i data-cp-bosshp></i></div></div>
    <div class="cp-course" data-cp-course hidden></div>
    <div class="cp-card" data-cp-card hidden></div>
    <div class="cp-help" aria-hidden="true">${HELP}</div>
    <div class="cp-overlay" data-cp-overlay><b>⚔ the deep forest</b><span data-cp-overlay-sub>growing the forest…</span></div>
    ${
      coarse
        ? `<div class="cp-stick" data-cp-stick hidden><i></i></div>
    <div class="cp-cluster cp-cluster-combat" data-cp-cluster>
      <button type="button" data-cp-ult>💥</button>
      <button type="button" data-cp-skill>🌀</button>
      <button type="button" data-cp-block>🛡</button>
      <button type="button" data-cp-dash>B</button>
      <button type="button" data-cp-atk>⚔</button>
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

  /* article pages: record the read (this is how talents grow) + way home */
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
          ? `⚿ new talent: ${next.name} — ${next.desc}`
          : `⚿ chest plundered — ${n} opened`;
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
  scene.fog = new THREE.Fog(0xc6d6ec, 90, 380);

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
     shadows cool into lavender, highlights warm into cream. uHurt pulses
     the edges red when the warrior takes a hit */
  const gradePass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uHurt: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uHurt;
      varying vec2 vUv;
      void main() {
        vec2 c = vUv - 0.5;
        vec3 col = texture2D(tDiffuse, vUv).rgb;
        float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col += vec3(0.028, 0.022, 0.06) * (1.0 - smoothstep(0.0, 0.45, luma));
        col *= mix(vec3(1.0), vec3(1.04, 1.0, 0.94), smoothstep(0.6, 1.0, luma) * 0.5);
        col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 1.12);
        col *= 1.0 - smoothstep(0.2, 0.9, dot(c, c)) * 0.16;
        col = mix(col, vec3(0.78, 0.12, 0.1), smoothstep(0.12, 0.85, dot(c, c)) * uHurt);
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

  /* shared 3-step ramp: hard terminator, Genshin-style */
  const toneRamp = new THREE.DataTexture(new Uint8Array([95, 170, 255]), 3, 1, THREE.RedFormat);
  toneRamp.minFilter = toneRamp.magFilter = THREE.NearestFilter;
  toneRamp.needsUpdate = true;
  signal.addEventListener('abort', () => toneRamp.dispose());

  /* ----- collision world: everything walkable is an AABB ----- */

  /* box: { x, y, z (center), hx, hy, hz, mesh?, mover?, round? } */
  const boxes = [];
  const movers = [];
  const treeCols = []; // cylinders: { x, z, r }

  const addBox = (x, y, z, hx, hy, hz, opts = {}) => {
    const b = { x, y, z, hx, hy, hz, ...opts };
    boxes.push(b);
    if (b.mover) movers.push(b);
    return b;
  };

  /* ----- the forest floor ----- */

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

  /* the trail spiral the chests live on — keep trees off it */
  const trailAt = (i) => {
    const a = i * 0.55 + hash01(posts[i]?.slug ?? String(i)) * 0.2;
    const r = Math.min(13 + i * 1.85, HUB_R - 14);
    return { a, r, x: Math.cos(a) * r, z: Math.sin(a) * r };
  };
  const chestSpots = posts.map((_, i) => trailAt(i));

  /* gremlin camps: three clearings in the mid-ring */
  const CAMPS = [0.9, 2.6, 4.6].map((a, i) => ({
    x: Math.cos(a) * HUB_R * 0.52,
    z: Math.sin(a) * HUB_R * 0.52,
    idx: i,
  }));

  /* ----- the elder tree: the landmark the whole forest bends around ----- */

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
    const roots = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const root = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.1, 4.5, 6), trunkMat);
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

  /* ----- decor: the DENSE forest — trees everywhere the game isn't ----- */

  const arenaTreeSpots = []; // filled by buildArena, instanced with the rest
  let plantForest; // called after arenas exist so one InstancedMesh covers all
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

    /* hub trees: pack the disc, then carve out everything playable —
       the trail, chest clearings, camps, the platform yard, the gates */
    const spots = [];
    const clearOf = (x, z) => {
      if (Math.hypot(x, z) < 11) return false; // elder tree + spawn
      if (x > -16 && x < 10 && z > -20 && z < 0) return false; // platform yard
      for (const c of chestSpots) if (Math.hypot(x - c.x, z - c.z) < 5.5) return false;
      for (const c of CAMPS) if (Math.hypot(x - c.x, z - c.z) < 9) return false;
      /* the spiral trail itself: distance to the nearest sample */
      for (let i = 0; i <= posts.length; i++) {
        const t = trailAt(Math.min(i, posts.length - 1));
        if (Math.hypot(x - t.x, z - t.z) < 4.6) return false;
      }
      /* gates ring */
      for (let k = 0; k < 3; k++) {
        const a = -0.5 + k * 0.55;
        if (Math.hypot(x - Math.cos(a) * (HUB_R - 22), z - Math.sin(a) * (HUB_R - 22)) < 7) return false;
      }
      return true;
    };
    for (let i = 0; i < 600 && spots.length < 210; i++) {
      const a = hash01(`ta${i}`) * Math.PI * 2;
      const r = HUB_R * (0.16 + Math.sqrt(hash01(`tr${i}`)) * 0.82);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!clearOf(x, z)) continue;
      let ok = true;
      for (const s of spots)
        if (Math.hypot(x - s.x, z - s.z) < 3.4) {
          ok = false;
          break;
        }
      if (ok) spots.push({ x, z, s: 0.9 + hash01(`ts${i}`) * 1.7, seed: i });
    }

    plantForest = () => {
      const all = [...spots, ...arenaTreeSpots];
      const N = all.length;
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
      const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, N);
      trunks.castShadow = canopies.castShadow = true;
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const cv = new THREE.Color();
      const UPY = new THREE.Vector3(0, 1, 0);
      const pos = new THREE.Vector3();
      all.forEach((sp, i) => {
        const s = sp.s;
        q.setFromAxisAngle(UPY, hash01(`tq${sp.seed}`) * Math.PI);
        sc.set(s, s, s);
        m4.compose(pos.set(sp.x, 1.5 * s + (sp.y ?? 0), sp.z), q, sc);
        trunks.setMatrixAt(i, m4);
        m4.compose(pos.set(sp.x, (3 + 1.6) * s + (sp.y ?? 0), sp.z), q, sc);
        canopies.setMatrixAt(i, m4);
        cv.setHSL(0.3 + hash01(`tc${sp.seed}`) * 0.12, 0.55, 0.38 + hash01(`tl${sp.seed}`) * 0.14);
        canopies.setColorAt(i, cv);
        treeCols.push({ x: sp.x, z: sp.z, r: 1.1 * s, y: sp.y ?? 0 });
      });
      scene.add(trunks, canopies);
    };

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
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const cv = new THREE.Color();
    const UPY = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
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
    const BN = 110;
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

    /* gremlin camp dressing: a crooked totem + a banner each */
    for (const cmp of CAMPS) {
      const g = new THREE.Group();
      const totemMat = new THREE.MeshStandardMaterial({ color: 0x6e4a26, roughness: 0.9, flatShading: true });
      let ty = 0;
      for (let i = 0; i < 3; i++) {
        const s = 0.55 - i * 0.1;
        const seg = new THREE.Mesh(new RoundedBoxGeometry(s * 2, 0.7, s * 2, 2, 0.1), totemMat);
        seg.position.y = ty + 0.35;
        seg.rotation.y = hash01(`tot${cmp.idx}:${i}`) * 0.8;
        seg.castShadow = true;
        g.add(seg);
        ty += 0.7;
      }
      const skullM = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.34, 1),
        new THREE.MeshStandardMaterial({ color: 0xe8dcc2, roughness: 0.7, flatShading: true }),
      );
      skullM.position.y = ty + 0.3;
      g.add(skullM);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.8, 5), totemMat);
      pole.position.set(1.4, 1.4, 0.6);
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.6),
        new THREE.MeshStandardMaterial({ color: 0xb33a2e, side: THREE.DoubleSide, roughness: 0.8 }),
      );
      flag.position.set(1.85, 2.45, 0.6);
      g.add(pole, flag);
      g.position.set(cmp.x, 0, cmp.z);
      scene.add(g);
      addBox(cmp.x, 1.1, cmp.z, 0.6, 1.1, 0.6);
    }
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
    for (let i = 0; i < 18; i++) {
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

  /* ----- treasure chests: one per article, on the trail spiral ----- */

  const chests = [];
  {
    /* a thin BOX, not a plane: single-sided planes are invisible from
       behind in the beauty pass but NOT in GTAO's depth pre-pass — the
       mismatch composites a floating black rectangle */
    const signGeo = new THREE.BoxGeometry(3.2, 1.6, 0.08);
    const postGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.6, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9 });
    const signBackMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 });
    const woodM = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.85 });
    const woodDarkM = new THREE.MeshStandardMaterial({ color: 0x6e4426, roughness: 0.9 });
    const goldM = new THREE.MeshStandardMaterial({ color: GOLD, metalness: 0.55, roughness: 0.35, emissive: 0x4a3406, emissiveIntensity: 0.25 });
    const glowM = new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.85 });

    posts.forEach((post, i) => {
      const isRead = post.slug && read.has(post.slug);
      const { x, z } = chestSpots[i];
      const g = new THREE.Group();

      /* body: rounded box with gold straps and feet */
      const body = new THREE.Mesh(bakeVertexAO(new RoundedBoxGeometry(1.5, 0.85, 1.0, 2, 0.1), -0.45, 0.45, 0.6), woodM);
      body.position.y = 0.45;
      body.castShadow = true;
      const strapL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.88, 1.04), goldM);
      strapL.position.set(-0.45, 0.45, 0);
      const strapR = strapL.clone();
      strapR.position.x = 0.45;
      g.add(body, strapL, strapR);

      /* lid: hinged at the back edge — open = read */
      const lid = new THREE.Group();
      lid.position.set(0, 0.88, -0.5);
      const lidMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.5, 10, 1, false, 0, Math.PI), woodDarkM);
      lidMesh.rotation.z = Math.PI / 2;
      lidMesh.position.set(0, 0, 0.5);
      lidMesh.castShadow = true;
      const lidStrap = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.16, 10, 1, false, 0, Math.PI), goldM);
      lidStrap.rotation.z = Math.PI / 2;
      lidStrap.position.set(0, 0, 0.5);
      const lock = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.1), goldM);
      lock.position.set(0, 0.05, 1.03);
      lid.add(lidMesh, lidStrap, lock);
      g.add(lid);

      /* the hoard inside (only shows once open) + the glow column */
      const loot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), goldM);
      loot.position.set(0, 0.78, 0);
      loot.visible = !!isRead;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.5, 2.6, 10, 1, true), glowM.clone());
      beam.position.y = 2.1;
      beam.visible = !!isRead;
      beam.material.side = THREE.DoubleSide;
      beam.material.depthWrite = false;
      g.add(loot, beam);
      if (isRead) lid.rotation.x = -1.9;

      /* the sign, angled toward the center path */
      const sPost = new THREE.Mesh(postGeo, postMat);
      sPost.position.set(1.9, 0.8, 0);
      const faceMat = new THREE.MeshStandardMaterial({ map: signTexture(post, isRead), roughness: 0.8 });
      /* box face order: +x -x +y -y +z(front) -z(back) */
      const sign = new THREE.Mesh(signGeo, [signBackMat, signBackMat, signBackMat, signBackMat, faceMat, signBackMat]);
      sign.userData.faceMat = faceMat;
      sign.position.set(1.9, 1.9, 0);
      sign.castShadow = true;
      g.add(sPost, sign);
      g.position.set(x, 0, z);
      g.lookAt(0, 0, 0);
      scene.add(g);
      addBox(x, 0.45, z, 0.85, 0.45, 0.7);
      chests.push({ group: g, lid, beam, loot, sign, post, read: !!isRead, x, z });
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
    /* rings along the trail; arenas and drops add their own */
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

  /* ----- boss gates → arenas ----- */

  const BOSS_NAMES = ['Mossback', 'Old Knucklebark', 'the Hollow King'];
  const gates = [];
  const stars = [];
  const gotStars = store.stars();
  {
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8e9aa8, roughness: 0.8, flatShading: true });
    const mossMat = new THREE.MeshStandardMaterial({ color: 0x4fae5e, roughness: 0.9, flatShading: true });
    for (let k = 0; k < 3; k++) {
      const a = -0.5 + k * 0.55;
      const x = Math.cos(a) * (HUB_R - 22);
      const z = Math.sin(a) * (HUB_R - 22);
      const g = new THREE.Group();
      /* a mossy stone arch */
      const pillL = new THREE.Mesh(bakeVertexAO(new RoundedBoxGeometry(0.9, 4.2, 0.9, 2, 0.16), -2.1, 2.1, 0.55), stoneMat);
      pillL.position.set(-1.7, 2.1, 0);
      const pillR = pillL.clone();
      pillR.position.x = 1.7;
      const lintel = new THREE.Mesh(bakeVertexAO(new RoundedBoxGeometry(4.6, 0.9, 1.1, 2, 0.16), -0.45, 0.45, 0.6), stoneMat);
      lintel.position.y = 4.45;
      const mossL = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), mossMat);
      mossL.position.set(-1.7, 4.1, 0.2);
      mossL.scale.set(1, 0.5, 1);
      const mossT = mossL.clone();
      mossT.position.set(0.8, 4.9, 0);
      pillL.castShadow = pillR.castShadow = lintel.castShadow = true;
      /* the swirling dark between the pillars */
      const veil = new THREE.Mesh(
        new THREE.PlaneGeometry(2.6, 3.6),
        new THREE.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      veil.position.y = 2.1;
      g.add(pillL, pillR, lintel, mossL, mossT, veil);
      g.position.set(x, 0, z);
      g.lookAt(0, 0, 0);
      scene.add(g);
      addBox(x, 2.1, z, 1.2, 2.1, 1.2);
      gates.push({ x, z, idx: k, veil, done: gotStars.includes(k) });
    }
  }

  /* baked contact shadows: a dark breath under everything standing on the
     forest floor — grounding the shadow map alone can't deliver at this size */
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
    /* the trail: a sandy path tracing the chest spiral */
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
    /* the forest is dense now — light blots, or the floor goes night-dark */
    for (const t of treeCols) blot(t.x, t.z, t.r * 2.2, 0.18);
    for (const p of gates) blot(p.x, p.z, 3.6, 0.4);
    for (const s of shrooms) blot(s.x, s.z, 2.6, 0.34);
    for (const cmp of CAMPS) blot(cmp.x, cmp.z, 5, 0.3);
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

  /* ----- boss arenas: forest clearings far past the fog ----- */

  /* arena k: a flat ring clearing at ox = 700 + k*700, walled by giant trees */
  const arenas = [];
  function buildArena(k) {
    const rnd = mulberry(hash32(`arena-${k}`));
    const ox = 700 + k * 700;
    const R = 27;
    const ground = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R + 5, 9, 48),
      new THREE.MeshStandardMaterial({ map: meadowTexture(), roughness: 0.95 }),
    );
    ground.position.set(ox, -4.5, 0);
    ground.receiveShadow = true;
    scene.add(ground);
    addBox(ox, -4.5, 0, R, 4.5, R, { round: R });
    const under = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 5, R * 0.4, 30, 32),
      new THREE.MeshStandardMaterial({ color: 0x7a5536, roughness: 1 }),
    );
    under.position.set(ox, -24, 0);
    scene.add(under);

    /* tree wall: a tight double ring of big trees */
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const rr = R - 2.2 - (i % 2) * 2.4;
      arenaTreeSpots.push({
        x: ox + Math.cos(a) * rr,
        z: Math.sin(a) * rr,
        s: 1.9 + rnd() * 1.3,
        seed: 1000 + k * 100 + i,
      });
    }
    /* a few rocks + coins inside */
    for (let i = 0; i < 5; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = 6 + rnd() * (R - 12);
      coins.addCoin(ox + Math.cos(a) * rr, 1.1, Math.sin(a) * rr);
    }

    /* return gate at the south edge */
    const back = new THREE.Group();
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8e9aa8, roughness: 0.8, flatShading: true });
    const pillL = new THREE.Mesh(new RoundedBoxGeometry(0.7, 3.4, 0.7, 2, 0.14), stoneMat);
    pillL.position.set(-1.3, 1.7, 0);
    const pillR = pillL.clone();
    pillR.position.x = 1.3;
    const lintel = new THREE.Mesh(new RoundedBoxGeometry(3.6, 0.7, 0.9, 2, 0.14), stoneMat);
    lintel.position.y = 3.6;
    const veil = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 2.9),
      new THREE.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    veil.position.y = 1.7;
    back.add(pillL, pillR, lintel, veil);
    back.position.set(ox, 0, R - 5);
    back.lookAt(ox, 0, 0);
    scene.add(back);

    /* the star, hidden until the boss falls */
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
    star.position.set(ox, 3.4, 0);
    star.castShadow = true;
    star.visible = false;
    scene.add(star);
    stars.push({ mesh: star, idx: k, x: ox, y: 3.4, z: 0 });

    const arena = {
      idx: k,
      ox,
      R,
      spawn: new THREE.Vector3(ox, 1.2, R - 9),
      exit: { x: ox, z: R - 5 },
      boss: null, // attached once assets land
      adds: [],
      cleared: gotStars.includes(k),
    };
    arenas.push(arena);
    return arena;
  }
  buildArena(0);
  buildArena(1);
  buildArena(2);
  plantForest(); // hub + arena walls in one InstancedMesh pair

  /* ----- the player shell: physics moves the group, the GLB rides it ----- */

  const player = new THREE.Group();
  const body = new THREE.Group();
  player.add(body);
  /* placeholder until the GLB lands (and fallback if it never does) */
  const placeholder = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.34, 0.9, 4, 10),
    new THREE.MeshToonMaterial({ color: 0x4fbb66, gradientMap: toneRamp }),
  );
  placeholder.position.y = 0.85;
  placeholder.castShadow = true;
  body.add(placeholder);
  const blobShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 18),
    new THREE.MeshBasicMaterial({ color: 0x1a3a20, transparent: true, opacity: 0.25, depthWrite: false }),
  );
  blobShadow.rotation.x = -Math.PI / 2;
  player.add(blobShadow);
  scene.add(player);

  let heroAnim = null; // animator once the GLB lands
  let assetsReady = false;

  /* ----- combat state ----- */

  const ATK_STEPS = [
    { clip: 'atk1', dur: 0.5, hitAt: 0.42, dmg: 1, range: 2.7, rage: 8 },
    { clip: 'atk2', dur: 0.5, hitAt: 0.42, dmg: 1, range: 2.7, rage: 8 },
    { clip: 'atk3', dur: 0.78, hitAt: 0.52, dmg: 2, range: 3.0, rage: 14 },
  ];
  const SKILL_DUR = 1.15;
  const SKILL_CD = 6;
  const ULT_DUR = 1.7;

  const combat = {
    hp: 100,
    maxHp: 100,
    rage: 0,
    iframes: 0,
    sinceHurt: 99,
    chain: 0,
    atkT: 0,
    atkDur: 0,
    atkStep: null,
    atkHitDone: false,
    queued: false,
    chainGrace: 0,
    blocking: false,
    skillCd: 0,
    skillT: 0,
    skillHitDone: false,
    ultT: 0,
    ultHitDone: false,
    chargeHits: new Set(),
  };
  const busy = () => combat.atkT > 0 || combat.skillT > 0 || combat.ultT > 0;
  const dmgMul = () => (powerOn('berserk') ? 1.35 : 1);

  let shake = 0;
  let hurtFlash = 0;

  /* damage pops: DOM chips projected from world space each frame. NOT
     sprites — the GTAO pre-pass renders sprites as opaque quads into its
     G-buffer (it only hides Points/Lines), which composites a solid black
     rectangle wherever a number should float */
  const pops = [];
  const popV = new THREE.Vector3();
  function popDamage(x, y, z, txt, color = '#ffe9a0') {
    if (!hud) return;
    const el = document.createElement('div');
    el.className = 'cp-pop';
    el.textContent = txt;
    el.style.color = color;
    hud.append(el);
    pops.push({ el, x, y, z, life: 0.8 });
    if (pops.length > 14) {
      pops[0].el.remove();
      pops.shift();
    }
  }

  /* shockwave rings (ult + boss slam) */
  const rings = [];
  {
    const ringGeo = new THREE.TorusGeometry(1, 0.16, 6, 40);
    ringGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0xffd766, transparent: true, opacity: 0, depthWrite: false }),
      );
      m.visible = false;
      scene.add(m);
      rings.push({ m, r: 0, maxR: 0, speed: 0, life: 0, lethal: false, x: 0, z: 0, hit: true });
    }
  }
  function ringAt(x, y, z, { maxR = 8, speed = 11, color = 0xffd766, lethal = false } = {}) {
    const rg = rings.find((q) => q.life <= 0) ?? rings[0];
    rg.m.material.color.set(color);
    rg.m.position.set(x, y, z);
    rg.r = 1.2;
    rg.maxR = maxR;
    rg.speed = speed;
    rg.life = 1;
    rg.lethal = lethal;
    rg.hit = false;
    rg.x = x;
    rg.z = z;
    rg.m.visible = true;
  }

  /* ----- foes: gremlins and ogres, cloned from the Meshy rigs ----- */

  const foes = [];

  function makeFoe(kind, asset, opts) {
    const model = cloneSkinned(asset.scene);
    /* every foe needs its own materials for the hit flash */
    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) o.material = o.material.clone();
    });
    const group = new THREE.Group();
    group.add(model);
    normalizeHeight(model, opts.height);
    const anim = makeAnimator(model, asset.clips);
    group.position.set(opts.x, opts.y ?? 0, opts.z);
    scene.add(group);
    const foe = {
      kind,
      group,
      model,
      anim,
      hp: opts.hp,
      maxHp: opts.hp,
      radius: opts.radius,
      dmg: opts.dmg,
      speed: opts.speed,
      zone: opts.zone, // -1 hub, 0..2 arena idx
      home: { x: opts.x, z: opts.z },
      state: 'idle',
      t: 0,
      cdT: 0,
      slamT: opts.slamT ?? 0,
      kx: 0,
      kz: 0,
      flashT: 0,
      respawnT: 0,
      respawns: opts.respawns ?? false,
      boss: opts.boss ?? false,
      enraged: false,
      dead: false,
    };
    anim.play('idle');
    foes.push(foe);
    return foe;
  }

  function flashFoe(foe) {
    foe.flashT = 0.12;
    foe.model.traverse((o) => {
      if (o.material?.emissive) o.material.emissive.set(0xb33a2e);
    });
  }
  function unflashFoe(foe) {
    foe.model.traverse((o) => {
      if (o.material?.emissive) o.material.emissive.set(0x000000);
    });
  }

  function killFoe(foe) {
    foe.dead = true;
    foe.state = 'dead';
    foe.t = foe.boss ? 2.4 : 1.4;
    const ts = foe.anim.duration('die');
    foe.anim.play('die', { once: true, clamp: true, timeScale: ts / (foe.boss ? 2.2 : 1.2) });
    const { x, z } = foe.group.position;
    const y = foe.group.position.y;
    puffAt(x, y + 0.8, z, 0xf2c4be, foe.boss ? 2.2 : 1.2, 0.7);
    const drops = foe.boss ? 10 : 3;
    for (let i = 0; i < drops; i++) {
      const a = (i / drops) * Math.PI * 2;
      coins.addCoin(x + Math.cos(a) * (1 + (i % 2)), 1.1, z + Math.sin(a) * (1 + ((i + 1) % 2)));
    }
    if (foe.respawns) foe.respawnT = 26;
    if (foe.boss) onBossDown(foe);
  }

  function damageFoe(foe, dmg, fromX, fromZ, popColor) {
    if (foe.dead || foe.state === 'dormant') return;
    const dealt = Math.round(dmg * dmgMul());
    foe.hp -= dealt;
    flashFoe(foe);
    const dx = foe.group.position.x - fromX;
    const dz = foe.group.position.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    const kb = foe.boss ? 1.2 : 7;
    foe.kx += (dx / d) * kb;
    foe.kz += (dz / d) * kb;
    combat.rage = Math.min(100, combat.rage + (foe.boss ? 10 : 8));
    popDamage(foe.group.position.x, foe.group.position.y + (foe.boss ? 3.6 : 1.4), foe.group.position.z, String(dealt), popColor);
    puffAt(foe.group.position.x, foe.group.position.y + 1, foe.group.position.z, 0xffd1b8, 0.8, 0.5);
    audio.hit();
    if (foe.hp <= 0) killFoe(foe);
    else if (!foe.boss && foe.state !== 'dead') {
      /* gremlins stagger; ogres power through */
      foe.state = 'hit';
      foe.t = 0.32;
      const ts = foe.anim.duration('hit');
      foe.anim.play('hit', { once: true, timeScale: ts / 0.32 });
    }
  }

  function damagePlayer(dmg, fromX, fromZ) {
    if (combat.iframes > 0 || !assetsReady) return;
    /* hold-to-block eats frontal hits, TERA-style */
    const toFoe = Math.atan2(fromX - player.position.x, fromZ - player.position.z);
    let dAng = toFoe - facing;
    while (dAng > Math.PI) dAng -= Math.PI * 2;
    while (dAng < -Math.PI) dAng += Math.PI * 2;
    if (combat.blocking && Math.abs(dAng) < 1.25) {
      audio.block();
      combat.rage = Math.min(100, combat.rage + 6);
      puffAt(player.position.x + Math.sin(facing) * 0.6, player.position.y + 1.1, player.position.z + Math.cos(facing) * 0.6, 0xc8e6ff, 0.7, 0.4);
      popDamage(player.position.x, player.position.y + 2, player.position.z, 'block', '#9adcf0');
      return;
    }
    combat.hp = Math.max(0, combat.hp - dmg);
    combat.iframes = 0.9;
    combat.sinceHurt = 0;
    hurtFlash = 1;
    shake = Math.min(0.5, shake + 0.25);
    audio.hurt();
    const dx = player.position.x - fromX;
    const dz = player.position.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    vel.x += (dx / d) * 9;
    vel.z += (dz / d) * 9;
    squash = 0.5;
    popDamage(player.position.x, player.position.y + 2.2, player.position.z, String(dmg), '#ff9a8a');
    syncVitals();
    if (combat.hp <= 0) defeat();
  }

  function defeat() {
    hud?.toast('☠ knocked out — back on your feet', 'gold');
    combat.hp = combat.maxHp;
    combat.rage = 0;
    combat.iframes = 2;
    respawn();
    /* hub gremlins lose interest */
    for (const f of foes) {
      if (f.dead || f.boss) continue;
      f.state = 'idle';
      f.group.position.set(f.home.x, 0, f.home.z);
      f.anim.play('idle');
    }
    syncVitals();
  }

  /* melee arc vs all live foes in the player's zone */
  function meleeHit(range, arc, dmg, popColor) {
    const px = player.position.x;
    const pz = player.position.z;
    let landed = false;
    for (const foe of foes) {
      if (foe.dead || foe.zone !== inCourse) continue;
      const dx = foe.group.position.x - px;
      const dz = foe.group.position.z - pz;
      const d = Math.hypot(dx, dz);
      if (d > range + foe.radius) continue;
      if (arc < Math.PI) {
        let dAng = Math.atan2(dx, dz) - facing;
        while (dAng > Math.PI) dAng -= Math.PI * 2;
        while (dAng < -Math.PI) dAng += Math.PI * 2;
        if (Math.abs(dAng) > arc) continue;
      }
      damageFoe(foe, dmg, px, pz, popColor);
      landed = true;
    }
    return landed;
  }

  /* ----- ability triggers (wired to input below) ----- */

  function attackPress() {
    if (!assetsReady || combat.skillT > 0 || combat.ultT > 0) return;
    combat.blocking = false;
    if (combat.atkT > 0) {
      if (combat.atkT > combat.atkDur * 0.4) combat.queued = true;
      return;
    }
    startAttack(combat.chainGrace > 0 ? combat.chain : 0);
  }

  function startAttack(step) {
    const s = ATK_STEPS[step];
    combat.chain = step;
    combat.atkStep = s;
    combat.atkDur = s.dur / (powerOn('berserk') ? 1.12 : 1);
    combat.atkT = 0.0001;
    combat.atkHitDone = false;
    combat.queued = false;
    combat.chainGrace = 0;
    audio.swing();
    if (heroAnim) {
      const ts = heroAnim.duration(s.clip) / combat.atkDur;
      heroAnim.play(s.clip, { once: true, fade: 0.08, timeScale: ts });
    }
  }

  function skillPress() {
    if (!assetsReady || !powerOn('skill') || combat.skillCd > 0 || busy()) return;
    combat.blocking = false;
    combat.skillT = 0.0001;
    combat.skillHitDone = false;
    combat.skillCd = SKILL_CD;
    audio.skillWhirl();
    if (heroAnim) {
      const ts = heroAnim.duration('skill') / SKILL_DUR;
      heroAnim.play('skill', { once: true, fade: 0.08, timeScale: ts });
    }
  }

  function ultPress() {
    if (!assetsReady || !powerOn('ult') || combat.rage < 100 || busy()) return;
    combat.blocking = false;
    combat.ultT = 0.0001;
    combat.ultHitDone = false;
    combat.rage = 0;
    if (heroAnim) {
      const ts = heroAnim.duration('ult') / ULT_DUR;
      heroAnim.play('ult', { once: true, fade: 0.08, timeScale: ts });
    }
    syncVitals();
  }

  /* ----- boss orchestration ----- */

  function onBossDown(foe) {
    const arena = arenas[foe.zone];
    if (!arena) return;
    arena.cleared = true;
    audio.roar();
    shake = 0.6;
    hud?.toast(`☠ ${BOSS_NAMES[foe.zone]} has fallen!`, 'gold');
    const st = stars.find((s) => s.idx === foe.zone);
    if (st) st.mesh.visible = true;
    if (hud?.els) hud.els.course.textContent = `★ claim the star`;
    /* the adds give up */
    for (const f of foes) {
      if (f.zone === foe.zone && !f.boss && !f.dead) killFoe(f);
    }
  }

  function spawnFoes(assets) {
    /* hub camps: small packs that respawn */
    for (const cmp of CAMPS) {
      const n = 2 + (cmp.idx % 2);
      for (let i = 0; i < n; i++) {
        const a = hash01(`grm${cmp.idx}:${i}`) * Math.PI * 2;
        makeFoe('minion', assets.minion, {
          x: cmp.x + Math.cos(a) * 3.2,
          z: cmp.z + Math.sin(a) * 3.2,
          height: 1.0,
          hp: 3,
          dmg: 8,
          speed: 4.4,
          radius: 0.5,
          zone: -1,
          respawns: true,
        });
      }
    }
    /* arenas: a boss + adds, skipped once cleared */
    for (const arena of arenas) {
      if (arena.cleared) continue;
      const boss = makeFoe('boss', assets.boss, {
        x: arena.ox,
        z: -6,
        height: 3.4 + arena.idx * 0.5,
        hp: 60 + arena.idx * 30,
        dmg: 16 + arena.idx * 4,
        speed: 3.1 + arena.idx * 0.4,
        radius: 1.9,
        zone: arena.idx,
        boss: true,
        slamT: 7,
      });
      boss.state = 'dormant';
      arena.boss = boss;
      for (let i = 0; i < 2 + arena.idx; i++) {
        const a = (i / (2 + arena.idx)) * Math.PI * 2 + 0.7;
        arena.adds.push(
          makeFoe('minion', assets.minion, {
            x: arena.ox + Math.cos(a) * 9,
            z: Math.sin(a) * 9,
            height: 1.0,
            hp: 3,
            dmg: 8,
            speed: 4.8,
            radius: 0.5,
            zone: arena.idx,
          }),
        );
      }
    }
  }

  function updateFoe(foe, dt) {
    if (foe.flashT > 0) {
      foe.flashT -= dt;
      if (foe.flashT <= 0) unflashFoe(foe);
    }
    if (foe.dead) {
      foe.t -= dt;
      if (foe.t <= 0 && foe.group.visible) {
        foe.group.position.y -= dt * 1.4;
        if (foe.group.position.y < -2.4) foe.group.visible = false;
      }
      if (foe.respawns && (foe.respawnT -= dt) <= 0) {
        foe.dead = false;
        foe.hp = foe.maxHp;
        foe.state = 'idle';
        foe.group.visible = true;
        foe.group.position.set(foe.home.x, 0, foe.home.z);
        foe.anim.play('idle');
        puffAt(foe.home.x, 1, foe.home.z, 0xcdf2d2, 1, 0.6);
      }
      foe.anim.mixer.update(dt);
      return;
    }

    /* knockback decay */
    if (Math.abs(foe.kx) + Math.abs(foe.kz) > 0.01) {
      foe.group.position.x += foe.kx * dt;
      foe.group.position.z += foe.kz * dt;
      foe.kx *= Math.exp(-dt * 7);
      foe.kz *= Math.exp(-dt * 7);
    }

    const samezone = foe.zone === inCourse;
    const px = player.position.x;
    const pz = player.position.z;
    const dx = px - foe.group.position.x;
    const dz = pz - foe.group.position.z;
    const dist = Math.hypot(dx, dz);

    if (foe.boss) {
      updateBoss(foe, dt, dist, dx, dz, samezone);
      foe.anim.mixer.update(dt);
      return;
    }

    if (!samezone) {
      if (foe.state !== 'idle') {
        foe.state = 'idle';
        foe.group.position.set(foe.home.x, 0, foe.home.z);
        foe.anim.play('idle');
      }
      foe.anim.mixer.update(dt);
      return;
    }

    foe.cdT = Math.max(0, foe.cdT - dt);
    switch (foe.state) {
      case 'idle': {
        foe.anim.play('idle');
        if (dist < 9) {
          foe.state = 'chase';
          audio.gremlin();
          puffAt(foe.group.position.x, foe.group.position.y + 1.4, foe.group.position.z, 0xffe9a0, 0.5, 0.9);
        }
        break;
      }
      case 'chase': {
        const homeD = Math.hypot(foe.group.position.x - foe.home.x, foe.group.position.z - foe.home.z);
        if (dist > 13 || homeD > 26) {
          foe.state = 'idle';
          foe.hp = foe.maxHp;
          break;
        }
        foe.anim.play(dist > 5 ? 'run' : 'walk');
        const sp = foe.speed * (dist > 5 ? 1.25 : 1);
        foe.group.position.x += (dx / dist) * sp * dt;
        foe.group.position.z += (dz / dist) * sp * dt;
        foe.group.rotation.y = Math.atan2(dx, dz);
        /* don't pile into packmates */
        for (const other of foes) {
          if (other === foe || other.dead || other.zone !== foe.zone) continue;
          const sx = foe.group.position.x - other.group.position.x;
          const sz = foe.group.position.z - other.group.position.z;
          const sd = Math.hypot(sx, sz);
          if (sd > 1e-4 && sd < 1.1) {
            foe.group.position.x += (sx / sd) * (1.1 - sd) * 0.5;
            foe.group.position.z += (sz / sd) * (1.1 - sd) * 0.5;
          }
        }
        if (dist < 2.0 && foe.cdT <= 0) {
          foe.state = 'attack';
          foe.t = 0;
          const ts = foe.anim.duration('atk');
          foe.anim.play('atk', { once: true, fade: 0.08, timeScale: ts / 0.7 });
        }
        break;
      }
      case 'attack': {
        foe.t += dt;
        foe.group.rotation.y = Math.atan2(dx, dz);
        if (foe.t > 0.42 && foe.t - dt <= 0.42 && dist < 2.6) damagePlayer(foe.dmg, foe.group.position.x, foe.group.position.z);
        if (foe.t > 0.7) {
          foe.state = 'chase';
          foe.cdT = 0.9;
        }
        break;
      }
      case 'hit': {
        foe.t -= dt;
        if (foe.t <= 0) foe.state = 'chase';
        break;
      }
    }
    foe.anim.mixer.update(dt);
  }

  function updateBoss(foe, dt, dist, dx, dz, samezone) {
    const arena = arenas[foe.zone];
    if (!samezone) {
      if (foe.state !== 'dormant') {
        /* player fled — the ogre stomps home and shakes it off */
        foe.state = 'dormant';
        foe.group.position.set(arena.ox, 0, -6);
        foe.anim.play('idle');
        if (hud?.els) hud.els.bossbar.hidden = true;
      }
      return;
    }
    const ts = foe.enraged ? 1.2 : 1;
    switch (foe.state) {
      case 'dormant': {
        foe.anim.play('idle');
        if (dist < 20) {
          foe.state = 'taunt';
          foe.t = 2.2;
          const d = foe.anim.duration('taunt');
          foe.anim.play('taunt', { once: true, timeScale: d / 2.2 });
          audio.roar();
          shake = Math.min(0.5, shake + 0.35);
          if (hud?.els) {
            hud.els.bossbar.hidden = false;
            hud.els.bossname.textContent = BOSS_NAMES[foe.zone];
            hud.els.bosshp.style.width = '100%';
          }
        }
        break;
      }
      case 'taunt': {
        foe.t -= dt;
        foe.group.rotation.y = Math.atan2(dx, dz);
        if (foe.t <= 0) foe.state = 'chase';
        break;
      }
      case 'chase': {
        foe.slamT -= dt;
        foe.group.rotation.y = Math.atan2(dx, dz);
        if (foe.slamT <= 0) {
          foe.state = 'slam';
          foe.t = 0;
          const d = foe.anim.duration('slam');
          foe.anim.play('slam', { once: true, timeScale: (d / 1.7) * ts });
          break;
        }
        if (dist < 4.6) {
          foe.state = 'swing';
          foe.t = 0;
          const d = foe.anim.duration('swing');
          foe.anim.play('swing', { once: true, timeScale: (d / 1.15) * ts });
          break;
        }
        foe.anim.play('walk');
        const sp = foe.speed * ts;
        foe.group.position.x += (dx / dist) * sp * dt;
        foe.group.position.z += (dz / dist) * sp * dt;
        /* stay in the arena */
        const ax = foe.group.position.x - arena.ox;
        const az = foe.group.position.z;
        const ad = Math.hypot(ax, az);
        if (ad > arena.R - 4) {
          foe.group.position.x = arena.ox + (ax / ad) * (arena.R - 4);
          foe.group.position.z = (az / ad) * (arena.R - 4);
        }
        break;
      }
      case 'swing': {
        foe.t += dt;
        const hitMoment = 0.55 / ts;
        if (foe.t > hitMoment && foe.t - dt <= hitMoment && dist < 6) {
          let dAng = Math.atan2(dx, dz) - foe.group.rotation.y;
          while (dAng > Math.PI) dAng -= Math.PI * 2;
          while (dAng < -Math.PI) dAng += Math.PI * 2;
          if (Math.abs(dAng) < 1.2) damagePlayer(foe.dmg, foe.group.position.x, foe.group.position.z);
        }
        if (foe.t > 1.15 / ts) {
          foe.state = 'chase';
        }
        break;
      }
      case 'slam': {
        foe.t += dt;
        const impact = 0.95 / ts;
        if (foe.t > impact && foe.t - dt <= impact) {
          ringAt(foe.group.position.x, 0.4, foe.group.position.z, {
            maxR: 17,
            speed: 10,
            color: 0xb33a2e,
            lethal: true,
          });
          shake = Math.min(0.6, shake + 0.4);
          audio.ultBoom();
          puffAt(foe.group.position.x, 0.6, foe.group.position.z, 0xd9c8a8, 2.4, 1);
        }
        if (foe.t > 1.7 / ts) {
          foe.state = 'chase';
          foe.slamT = (foe.enraged ? 6.5 : 10) + hash01(`slam${foe.zone}${Date.now() % 997}`) * 3;
        }
        break;
      }
    }
    if (!foe.enraged && foe.hp <= foe.maxHp * 0.5) {
      foe.enraged = true;
      audio.roar();
      hud?.toast(`${BOSS_NAMES[foe.zone]} is enraged!`);
    }
    if (hud?.els && !hud.els.bossbar.hidden) {
      hud.els.bosshp.style.width = `${Math.max(0, (foe.hp / foe.maxHp) * 100)}%`;
    }
  }

  /* ----- state ----- */

  const vel = new THREE.Vector3();
  let onGround = false;
  let groundBox = null;
  let coyote = 0;
  let jumpBuf = 0;
  let usedDouble = false;
  let dashT = 0;
  let dashCd = 0;
  let facing = 0;
  let squash = 0;
  let inCourse = -1; // -1 = hub, 0..2 = arena idx
  let coinCount = store.coins();
  let camYaw = 0.6;
  let camPitch = 0.38;
  let camDist = 13;
  const keys = { f: false, b: false, l: false, r: false, jump: false, dash: false, block: false };
  let nearChest = -1;
  let nearGate = -1;
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
      const t = chests.find((a) => a.post.slug && a.post.slug === atSlug);
      if (t) player.position.set(t.x * 0.92, 1.2, t.z * 0.92);
      else player.position.copy(SPAWN);
    }
  }

  function savePlayer() {
    if (!isWorld) return;
    store.playerState({ p: player.position.toArray(), c: inCourse, t: Date.now() });
  }

  function respawn() {
    const at = inCourse >= 0 ? arenas[inCourse].spawn : SPAWN;
    player.position.copy(at);
    vel.set(0, 0, 0);
    audio.land();
  }

  function warpTo(idx) {
    audio.warp();
    if (idx >= 0) {
      inCourse = idx;
      player.position.copy(arenas[idx].spawn);
      const el = hud?.els?.course;
      if (el) {
        el.hidden = false;
        el.textContent = arenas[idx].cleared
          ? `★ ${BOSS_NAMES[idx]} — already conquered`
          : `☠ ${BOSS_NAMES[idx]} — fell the beast`;
      }
    } else {
      inCourse = -1;
      player.position.copy(SPAWN);
      if (hud?.els?.course) hud.els.course.hidden = true;
      if (hud?.els?.bossbar) hud.els.bossbar.hidden = true;
    }
    vel.set(0, 0, 0);
    camYaw = facing + Math.PI;
  }

  /* ----- input ----- */

  const stick = { id: -1, x0: 0, y0: 0, x: 0, y: 0, live: false };
  const STICK_R = 52;
  const drag = { id: -1, lx: 0, ly: 0, moved: 0 };

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
      if (overlayGone || !assetsReady) return;
      overlayGone = true;
      overlay?.classList.add('hidden');
    };
    setTimeout(() => {
      const tick = setInterval(() => {
        if (signal.aborted) return clearInterval(tick);
        if (assetsReady) {
          clearInterval(tick);
          setTimeout(dismissOverlay, 2600);
        }
      }, 250);
    }, 4000);

    const kset = (k, v) => {
      if (['w', 'W', 'ArrowUp'].includes(k)) keys.f = v;
      else if (['s', 'S', 'ArrowDown'].includes(k)) keys.b = v;
      else if (['a', 'A', 'ArrowLeft'].includes(k)) keys.l = v;
      else if (['d', 'D', 'ArrowRight'].includes(k)) keys.r = v;
      else if (k === ' ') {
        if (v && !keys.jump) jumpBuf = 0.12;
        keys.jump = v;
      } else if (k === 'Shift') keys.dash = v;
      else if (['c', 'C'].includes(k)) keys.block = v;
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
        else if (['f', 'F'].includes(e.key)) attackPress();
        else if (['e', 'E'].includes(e.key)) skillPress();
        else if (['q', 'Q'].includes(e.key)) ultPress();
        else if (e.key === 'Enter' && document.activeElement === document.body) {
          if (nearChest >= 0) location.href = chests[nearChest].post.href;
          else if (nearGate === 99) warpTo(-1);
          else if (nearGate >= 0) warpTo(gates[nearGate].idx);
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
        } else if (e.button === 2) {
          keys.block = true;
        } else if (drag.id < 0) {
          drag.id = e.pointerId;
          drag.lx = e.clientX;
          drag.ly = e.clientY;
          drag.moved = 0;
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
          drag.moved += Math.abs(e.clientX - drag.lx) + Math.abs(e.clientY - drag.ly);
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
      if (e.button === 2) keys.block = false;
      if (e.pointerId === drag.id) {
        /* a clean click (no orbit) is a swing — Genshin's left hand */
        if (e.pointerType !== 'touch' && e.button === 0 && drag.moved < 6) attackPress();
        drag.id = -1;
      }
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
    bindBtn('[data-cp-atk]', () => attackPress());
    bindBtn('[data-cp-block]', () => (keys.block = true), () => (keys.block = false));
    bindBtn('[data-cp-skill]', () => skillPress());
    bindBtn('[data-cp-ult]', () => ultPress());

    hud?.querySelector('[data-cp-card]')?.addEventListener(
      'click',
      () => {
        if (nearChest >= 0) location.href = chests[nearChest].post.href;
        else if (nearGate === 99) warpTo(-1);
        else if (nearGate >= 0) warpTo(gates[nearGate].idx);
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
          read.size >= p.need ? '' : ` ⚿${p.need}`
        }</span>`,
    ).join('');
    const readEl = hud?.querySelector('[data-cp-read]');
    if (readEl) readEl.textContent = `${read.size}/${posts.length}`;
  }

  function syncVitals() {
    if (!hud?.els) return;
    hud.els.hp.style.width = `${(combat.hp / combat.maxHp) * 100}%`;
    hud.els.rage.style.width = `${combat.rage}%`;
    hud.els.kitUlt.classList.toggle('ready', powerOn('ult') && combat.rage >= 100);
  }

  function syncKit() {
    if (!hud?.els) return;
    hud.els.kitSkill.classList.toggle('off', !powerOn('skill'));
    hud.els.kitUlt.classList.toggle('off', !powerOn('ult'));
    hud.els.cdSkill.textContent = combat.skillCd > 0.05 ? Math.ceil(combat.skillCd) : '';
    const bSkill = hud.querySelector('[data-cp-skill]');
    const bUlt = hud.querySelector('[data-cp-ult]');
    if (bSkill) bSkill.disabled = !powerOn('skill') || combat.skillCd > 0;
    if (bUlt) bUlt.disabled = !powerOn('ult') || combat.rage < 100;
  }

  /* ----- physics + game loop ----- */

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const camLook = new THREE.Vector3(); // dedicated — never aliases the scratch
  let hudTimer = 0;

  const maxRun = () => (powerOn('berserk') ? 15 : 13);
  const jumpV = () => (powerOn('berserk') ? 17.5 : 15.5);

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
        if ((px - b.x) * (px - b.x) + (pz - b.z) * (pz - b.z) > b.round * b.round) continue;
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

    /* --- combat timers --- */
    combat.iframes = Math.max(0, combat.iframes - dt);
    combat.skillCd = Math.max(0, combat.skillCd - dt);
    combat.chainGrace = Math.max(0, combat.chainGrace - dt);
    combat.sinceHurt += dt;
    if (combat.sinceHurt > 5 && combat.hp < combat.maxHp) {
      combat.hp = Math.min(combat.maxHp, combat.hp + 6 * dt);
    }
    hurtFlash = Math.max(0, hurtFlash - dt * 2.2);
    gradePass.uniforms.uHurt.value = hurtFlash * 0.55;

    /* block only holds while grounded and not mid-ability */
    combat.blocking = keys.block && !busy() && assetsReady;

    /* attack chain progress */
    if (combat.atkT > 0) {
      combat.atkT += dt;
      const s = combat.atkStep;
      const hitMoment = s.hitAt * combat.atkDur;
      if (!combat.atkHitDone && combat.atkT >= hitMoment) {
        combat.atkHitDone = true;
        meleeHit(s.range, 1.15, s.dmg, '#ffe9a0'); /* rage accrues per foe struck, in damageFoe */
        puffAt(
          player.position.x + Math.sin(facing) * 1.6,
          player.position.y + 1.0,
          player.position.z + Math.cos(facing) * 1.6,
          0xfff1d6,
          0.7,
          0.3,
        );
      }
      if (combat.atkT >= combat.atkDur) {
        const next = (combat.chain + 1) % ATK_STEPS.length;
        combat.atkT = 0;
        combat.chain = next;
        combat.chainGrace = 0.5;
        if (combat.queued) startAttack(next);
      }
    }

    /* cyclone */
    if (combat.skillT > 0) {
      combat.skillT += dt;
      if (!combat.skillHitDone && combat.skillT >= SKILL_DUR * 0.45) {
        combat.skillHitDone = true;
        meleeHit(4.0, Math.PI, 2, '#9adcf0');
        ringAt(player.position.x, 0.4, player.position.z, { maxR: 4.6, speed: 9, color: 0x9adcf0 });
      }
      if (combat.skillT >= SKILL_DUR) combat.skillT = 0;
    }

    /* ground slam ultimate */
    if (combat.ultT > 0) {
      combat.ultT += dt;
      if (!combat.ultHitDone && combat.ultT >= ULT_DUR * 0.55) {
        combat.ultHitDone = true;
        meleeHit(7.2, Math.PI, 5, '#ffd766');
        ringAt(player.position.x, 0.4, player.position.z, { maxR: 8.5, speed: 12, color: 0xffd766 });
        shake = Math.min(0.6, shake + 0.45);
        audio.ultBoom();
        puffAt(player.position.x, 0.6, player.position.z, 0xfff1d6, 2.2, 0.9);
      }
      if (combat.ultT >= ULT_DUR) combat.ultT = 0;
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
    const sin = Math.sin(camYaw);
    const cos = Math.cos(camYaw);
    const wx = ix * cos - iz * sin;
    const wz = ix * sin + iz * cos;

    dashCd = Math.max(0, dashCd - dt);
    if (keys.dash && dashCd <= 0 && dashT <= 0 && ilen > 0.2 && !busy()) {
      dashT = 0.22;
      dashCd = 0.9;
      combat.chargeHits.clear();
      audio.dash();
    }
    dashT = Math.max(0, dashT - dt);

    /* charging through a foe knocks it aside */
    if (dashT > 0 && assetsReady) {
      for (const foe of foes) {
        if (foe.dead || foe.zone !== inCourse || combat.chargeHits.has(foe)) continue;
        const d = Math.hypot(foe.group.position.x - player.position.x, foe.group.position.z - player.position.z);
        if (d < 1.6 + foe.radius) {
          combat.chargeHits.add(foe);
          damageFoe(foe, 1, player.position.x - vel.x, player.position.z - vel.z, '#ffe9a0');
        }
      }
    }

    /* heavy moves root the warrior */
    const moveMul = combat.ultT > 0 ? 0.06 : combat.atkT > 0 ? 0.22 : combat.skillT > 0 ? 0.45 : combat.blocking ? 0.32 : 1;

    const accel = onGround ? 70 : 26;
    const target = maxRun() * (dashT > 0 ? 2.1 : 1) * moveMul;
    if ((ilen > 0.05 || dashT > 0) && moveMul > 0.05) {
      vel.x = THREE.MathUtils.lerp(vel.x, wx * target, 1 - Math.exp((-dt * accel) / Math.max(target, 1)));
      vel.z = THREE.MathUtils.lerp(vel.z, wz * target, 1 - Math.exp((-dt * accel) / Math.max(target, 1)));
      if (combat.atkT <= 0 && combat.ultT <= 0) facing = Math.atan2(vel.x, vel.z);
    } else if (onGround) {
      vel.x *= Math.exp(-dt * 10);
      vel.z *= Math.exp(-dt * 10);
    }

    /* --- jumping --- */
    jumpBuf = Math.max(0, jumpBuf - dt);
    coyote = Math.max(0, coyote - dt);
    if (jumpBuf > 0 && combat.ultT <= 0 && combat.skillT <= 0) {
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
    vel.y -= 42 * dt;
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

    /* --- foes --- */
    if (assetsReady) for (const foe of foes) updateFoe(foe, dt);

    /* --- shockwave rings --- */
    for (const rg of rings) {
      if (rg.life <= 0) continue;
      rg.r += rg.speed * dt;
      rg.life = 1 - rg.r / rg.maxR;
      if (rg.life <= 0) {
        rg.m.visible = false;
        continue;
      }
      rg.m.scale.set(rg.r, 1, rg.r);
      rg.m.material.opacity = Math.min(0.85, rg.life * 1.4);
      if (rg.lethal && !rg.hit) {
        const d = Math.hypot(player.position.x - rg.x, player.position.z - rg.z);
        const grounded = player.position.y - (findGround().top > -Infinity ? findGround().top : 0) < 1.1;
        if (Math.abs(d - rg.r) < 1.3 && grounded) {
          rg.hit = true;
          damagePlayer(22, rg.x, rg.z);
        }
      }
    }

    /* --- damage pops drift up (world → screen each frame) --- */
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.el.remove();
        pops.splice(i, 1);
        continue;
      }
      p.y += dt * 1.6;
      popV.set(p.x, p.y, p.z).project(camera);
      const vis = popV.z < 1;
      p.el.style.opacity = vis ? String(Math.min(1, p.life * 2.2)) : '0';
      p.el.style.transform = `translate(-50%, -50%) translate(${((popV.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px, ${((-popV.y * 0.5 + 0.5) * innerHeight).toFixed(1)}px)`;
    }

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
        hud?.toast(`★ the star of ${BOSS_NAMES[st.idx]} is yours!`, 'gold');
        if (hud?.els) hud.els.stars.textContent = `${store.stars().length}/3`;
        setTimeout(() => {
          if (!signal.aborted) warpTo(-1);
        }, 1400);
      }
    }

    /* --- near a chest or a gate? --- */
    let bestChest = -1;
    let bestD = 30;
    for (let i = 0; i < chests.length; i++) {
      const t = chests[i];
      const dx = t.x - player.position.x;
      const dz = t.z - player.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        bestChest = i;
      }
    }
    let bestGate = -1;
    if (inCourse < 0) {
      for (let i = 0; i < gates.length; i++) {
        const dx = gates[i].x - player.position.x;
        const dz = gates[i].z - player.position.z;
        if (dx * dx + dz * dz < 22) bestGate = i;
      }
    } else {
      /* the return gate */
      const arena = arenas[inCourse];
      const dx = arena.exit.x - player.position.x;
      const dz = arena.exit.z - player.position.z;
      if (dx * dx + dz * dz < 16) bestGate = 99; // sentinel: exit
    }
    if (bestGate >= 0) bestChest = -1;
    if (bestChest !== nearChest || bestGate !== nearGate) {
      nearChest = bestChest;
      nearGate = bestGate;
      const card = hud?.els?.card;
      if (card) {
        if (nearGate === 99) {
          card.hidden = false;
          card.innerHTML = `<b>⤴ forest gate</b><span>back to the deep forest</span><i>${coarse ? 'TAP TO RETURN' : 'PRESS ⏎ TO RETURN'}</i>`;
        } else if (nearGate >= 0) {
          const p = gates[nearGate];
          card.hidden = false;
          card.innerHTML = `<b>☠ boss gate: ${BOSS_NAMES[p.idx]}</b><span>${
            p.done || arenas[p.idx].cleared ? 'conquered — visit the arena again' : 'an ogre guards a star beyond'
          }</span><i>${coarse ? 'TAP TO ENTER' : 'PRESS ⏎ TO ENTER'}</i>`;
        } else if (nearChest >= 0) {
          const t = chests[nearChest];
          card.hidden = false;
          card.innerHTML = `<b>${t.read ? '⚿' : '🔒'} ${t.post.title}</b><span>${t.post.date}${
            t.read ? ' · plundered' : ' · opening grows a talent'
          }</span><i>${coarse ? 'TAP TO OPEN' : 'PRESS ⏎ TO OPEN'}</i>`;
        } else card.hidden = true;
      }
    }

    /* --- player visuals: clip machine, squash, blob shadow --- */
    body.rotation.y = THREE.MathUtils.lerp(body.rotation.y, facing, 1 - Math.exp(-dt * 12));
    squash *= Math.exp(-dt * 7);
    body.scale.y = 1 - squash * 0.3;
    body.scale.x = body.scale.z = 1 + squash * 0.18;
    const spd = Math.hypot(vel.x, vel.z);
    if (heroAnim) {
      if (!busy() && !combat.blocking) {
        const desired = !onGround
          ? vel.y > 1
            ? 'jump'
            : 'fall'
          : dashT > 0
            ? 'charge'
            : spd > 6.5
              ? 'run'
              : spd > 0.7
                ? 'walk'
                : 'idle';
        if (heroAnim.current !== desired)
          heroAnim.play(desired, { once: desired === 'jump', clamp: desired === 'jump', fade: 0.14 });
      } else if (combat.blocking) {
        if (heroAnim.current !== 'block') {
          const d = heroAnim.duration('block');
          heroAnim.play('block', { once: true, clamp: true, fade: 0.1, timeScale: d / 0.5 });
        }
        /* freeze at the guard-up frame — the clip's tail lowers the guard
           and its end pose sinks the rig through the floor */
        const act = heroAnim.actions.block;
        if (act && act.time > heroAnim.duration('block') * 0.38) act.paused = true;
      }
      heroAnim.mixer.update(dt);
    }
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
      /* open chests shimmer */
      for (const ch of chests) {
        if (ch.read && ch.beam.visible) {
          ch.beam.material.opacity = 0.5 + Math.sin(time * 2.4 + ch.x) * 0.25;
          ch.loot.rotation.y += dt * 1.4;
        }
      }
      /* gate veils swirl */
      for (const gt of gates) gt.veil.material.opacity = 0.66 + Math.sin(time * 1.8 + gt.idx * 2) * 0.12;
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

    /* --- camera: orbit follow + impact shake --- */
    shake = Math.max(0, shake - dt * 1.6);
    const cy = Math.sin(camPitch) * camDist;
    const ch = Math.cos(camPitch) * camDist;
    tmpV2.set(
      player.position.x + Math.sin(camYaw) * ch,
      player.position.y + cy + 1.2,
      player.position.z + Math.cos(camYaw) * ch,
    );
    camera.position.lerp(tmpV2, reduced ? 1 : 1 - Math.exp(-dt * 6));
    if (shake > 0.01 && !reduced) {
      camera.position.x += (Math.random() - 0.5) * shake * 0.5;
      camera.position.y += (Math.random() - 0.5) * shake * 0.5;
    }
    camLook.copy(player.position);
    camLook.y += 1.4;
    camera.lookAt(camLook);

    /* --- HUD tick --- */
    if ((hudTimer += dt) > 0.2 && hud?.els) {
      hudTimer = 0;
      syncVitals();
      syncKit();
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
    for (const t of chests) {
      const tex = signTexture(t.post, t.read);
      const m = t.sign.userData.faceMat;
      m.map?.dispose();
      m.map = tex;
      m.needsUpdate = true;
    }
    hud = makeHud(POWERS, coinCount, store.stars().length, posts.length);
    hud.els = {
      coins: hud.querySelector('[data-cp-coins]'),
      stars: hud.querySelector('[data-cp-stars]'),
      card: hud.querySelector('[data-cp-card]'),
      course: hud.querySelector('[data-cp-course]'),
      hp: hud.querySelector('[data-cp-hp]'),
      rage: hud.querySelector('[data-cp-rage]'),
      bossbar: hud.querySelector('[data-cp-bossbar]'),
      bossname: hud.querySelector('[data-cp-bossname]'),
      bosshp: hud.querySelector('[data-cp-bosshp]'),
      kitSkill: hud.querySelector('[data-cp-k="skill"]'),
      kitUlt: hud.querySelector('[data-cp-k="ult"]'),
      cdSkill: hud.querySelector('[data-cp-cd="skill"]'),
      overlaySub: hud.querySelector('[data-cp-overlay-sub]'),
    };
    renderPowers();
    syncVitals();
    syncKit();
    document.documentElement.dataset.world = 'on';
    bindInput();
    if (inCourse >= 0) {
      const el = hud.els.course;
      el.hidden = false;
      el.textContent = arenas[inCourse].cleared
        ? `★ ${BOSS_NAMES[inCourse]} — already conquered`
        : `☠ ${BOSS_NAMES[inCourse]} — fell the beast`;
    }
    camera.position.copy(player.position).add(new THREE.Vector3(0, 6, 13));
    raf = requestAnimationFrame(frame);

    /* the rigged cast loads alongside the world — swap in when ready */
    try {
      const assets = await loadAssets(signal);
      if (signal.aborted) return;
      toonify(assets.hero.scene, toneRamp);
      const heroScale = normalizeHeight(assets.hero.scene, 1.72);
      body.remove(placeholder);
      placeholder.geometry.dispose();
      placeholder.material.dispose();
      body.add(assets.hero.scene);
      heroAnim = makeAnimator(assets.hero.scene, assets.hero.clips);
      heroAnim.play('idle');

      /* the axe rides the right hand bone. The bones carry the rig's
         centimeter bind scale (~0.01) — a child of a bone inherits it, so
         counter the hand's WORLD scale or the axe shrinks to a speck */
      toonify(assets.axe, toneRamp);
      const AXE_LEN = 1.7;
      normalizeHeight(assets.axe, AXE_LEN);
      assets.axe.position.set(0, -0.32, 0); // grip the upper shaft (axe origin = bbox center)
      const hand = assets.hero.scene.getObjectByName('RightHand');
      if (hand) {
        assets.hero.scene.updateWorldMatrix(true, true);
        const handScale = new THREE.Vector3();
        hand.getWorldScale(handScale);
        const wrap = new THREE.Group();
        wrap.scale.set(1 / handScale.x, 1 / handScale.y, 1 / handScale.z);
        /* shaft along the fist's Z — the blade arcs with the swing plane */
        wrap.rotation.set(0, 0, Math.PI / 2);
        wrap.position.set(0, 0.04, 0.02);
        wrap.add(assets.axe);
        hand.add(wrap);
        /* grip tuning + scene probing hook for headless QA — inert unless
           the flag is set */
        try {
          if (localStorage.getItem('canopy-debug'))
            window.__cw = {
              wrap,
              axe: assets.axe,
              hand,
              hero: assets.hero.scene,
              foes,
              player,
              damageFoe,
              pick: (nx, ny) => {
                const rc = new THREE.Raycaster();
                rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
                return rc.intersectObjects(scene.children, true).slice(0, 5).map((h) => ({
                  name: h.object.name || h.object.type,
                  geo: h.object.geometry?.type,
                  mat: h.object.material?.type,
                  color: h.object.material?.color?.getHexString?.(),
                  hasMap: !!h.object.material?.map,
                  d: +h.distance.toFixed(1),
                }));
              },
            };
        } catch {}
      }

      toonify(assets.minion.scene, toneRamp);
      toonify(assets.boss.scene, toneRamp);
      spawnFoes(assets);
      assetsReady = true;
      if (hud.els.overlaySub)
        hud.els.overlaySub.textContent = coarse
          ? 'left thumb runs · ⚔ swings the axe · 🛡 blocks · open chests to grow talents'
          : 'every chest is an article — open them to grow your talents. gremlins bite back.';
    } catch (err) {
      console.warn('canopy: rigged cast failed to load', err);
      if (hud.els.overlaySub) hud.els.overlaySub.textContent = 'the warrior is lost in the fog — wandering in spirit form (assets failed to load)';
      hud.toast('⚠ could not load the 3D cast — exploration only');
    }
  };
  start();

  function unmount() {
    savePlayer();
    audio.dispose();
    ac.abort();
    cancelAnimationFrame(raf);
    for (const foe of foes) foe.anim.mixer.stopAllAction();
    heroAnim?.mixer.stopAllAction();
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



