// main.js (FULL COPY-PASTE) --- Stable Tap Design ---
// - NO array.filter allocations (in-place, pool w/ alive flags)
// - Fixed 45fps update (stable dt)
// - Hit processing: max 1 per frame (frame-synced)
// - Cached canvas rect (no getBoundingClientRect per tap)
// - touch-action: none (prevent browser gesture cost on mobile)
// - UI: darker gray background, black HUD/text
// - Audio: can be disabled by setting SOUND_ENABLED=false

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const elScore = document.getElementById("score");
const elTime = document.getElementById("time");
const elBest = document.getElementById("best");
const overlay = document.getElementById("overlay");
const titleEl = document.getElementById("title");
const resultEl = document.getElementById("result");
const btn = document.getElementById("btn");

const BEST_KEY = "facebop_best_v4";
const IS_MOBILE = matchMedia("(pointer: coarse)").matches;

// ====== IMPORTANT: prevent browser touch gesture overhead ======
canvas.style.touchAction = "none"; // critical for mobile tapping stability

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

// ====== viewport / canvas ======
function getViewportSize() {
  const vv = window.visualViewport;
  return { w: vv ? vv.width : innerWidth, h: vv ? vv.height : innerHeight };
}

let canvasRect = null;
function updateCanvasRect() {
  canvasRect = canvas.getBoundingClientRect();
}

function fitCanvas() {
  const { w, h } = getViewportSize();
  const dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  updateCanvasRect();
}
addEventListener("resize", fitCanvas);
visualViewport?.addEventListener("resize", fitCanvas);
fitCanvas();

// DOM HUD color => black (in case CSS is white)
elScore.style.color = "#111";
elTime.style.color = "#111";
elBest.style.color = "#111";

// ====== visuals ======
const BG_COLOR = "#d6dbe3";                 // slightly darker gray
const TEXT_FILL = "rgba(15,15,15,0.95)";    // black-ish
const TEXT_STROKE = "rgba(255,255,255,0.22)";

// ====== sprite ======
let dotSprite = null;
(function makeDotSprite() {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 32;
  const g = c.getContext("2d");
  const cx = 16, cy = 16;
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, 16);
  grad.addColorStop(0.0, "rgba(0,0,0,0.22)");
  grad.addColorStop(0.6, "rgba(0,0,0,0.10)");
  grad.addColorStop(1.0, "rgba(0,0,0,0.0)");
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI * 2); g.fill();
  dotSprite = c;
})();

// ====== assets ======
const assets = {
  face: new Image(),
  faceHit: new Image(),
};
assets.face.src = "./assets/face.png";
assets.faceHit.src = "./assets/face_hit.png"; // if missing, copy face.png

// ====== audio (optional) ======
const SOUND_ENABLED = false; // ←原因切り分けしたい時は false にして試して
const audio = {
  bgm: null,
  hit01: null,
  hit02: null,
  count: null,
};
function safeAudio(src, loop = false, volume = 0.6) {
  const a = new Audio(src);
  a.loop = loop;
  a.volume = volume;
  a.preload = "auto";
  return a;
}
function makeAudioPool(src, size, volume) {
  const list = [];
  for (let i = 0; i < size; i++) {
    const a = new Audio(src);
    a.loop = false;
    a.volume = volume;
    a.preload = "auto";
    list.push(a);
  }
  return { list, i: 0 };
}
function initAudio() {
  if (!SOUND_ENABLED) return;
  if (!audio.bgm) audio.bgm = safeAudio("./assets/bgm.mp3", true, 0.18);
  if (!audio.hit01) audio.hit01 = makeAudioPool("./assets/hit01.mp3", IS_MOBILE ? 4 : 8, 0.75);
  if (!audio.hit02) audio.hit02 = makeAudioPool("./assets/hit02.mp3", IS_MOBILE ? 3 : 6, 0.85);
  if (!audio.count) audio.count = makeAudioPool("./assets/count.mp3", 2, 0.75);
}
let lastSeTime = 0;
function playPool(pool) {
  if (!SOUND_ENABLED || !pool) return;
  const now = performance.now();
  if (IS_MOBILE && now - lastSeTime < 90) return;
  lastSeTime = now;

  const a = pool.list[pool.i];
  pool.i = (pool.i + 1) % pool.list.length;
  try { a.currentTime = 0; } catch {}
  a.play().catch(() => {});
}
function playHitNormal() { playPool(audio.hit01); }
function playHitBonus()  { playPool(audio.hit02); }
function playCount()     { playPool(audio.count); }
function startBGM() {
  if (!SOUND_ENABLED || !audio.bgm) return;
  audio.bgm.play().catch(() => {});
}

// ====== game constants ======
const INTRO_FIRST_SECONDS = 7.0;
const INTRO_RETRY_SECONDS = 3.0;
const GO_HOLD_SECONDS = 1.0;
const GAME_SECONDS = 30.0;

function speedLimit() {
  const { w, h } = getViewportSize();
  const s = Math.min(w, h);
  return clamp(s * 0.85, 520, 900);
}

// ====== pooled particles / floaters ======
const MAX_PARTICLES = IS_MOBILE ? 64 : 220;
const MAX_FLOATERS  = IS_MOBILE ? 20 : 48;

const particles = new Array(MAX_PARTICLES);
for (let i = 0; i < MAX_PARTICLES; i++) {
  particles[i] = { alive:false, x:0,y:0,vx:0,vy:0,t:0,life:0 };
}

const floaters = new Array(MAX_FLOATERS);
for (let i = 0; i < MAX_FLOATERS; i++) {
  floaters[i] = { alive:false, text:"", x0:0,y0:0,t:0,life:0,rise:0,wobble:0,size:0,weight:0 };
}

function spawnParticles(x, y, n, rapid) {
  const want = rapid ? Math.min(6, n) : n;
  let spawned = 0;
  for (let i = 0; i < particles.length && spawned < want; i++) {
    const p = particles[i];
    if (p.alive) continue;
    const a = rand(0, Math.PI * 2);
    const sp = rapid ? rand(120, 360) : rand(140, 620);
    p.alive = true;
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp;
    p.t = 0;
    p.life = rapid ? rand(0.12, 0.22) : rand(0.18, 0.42);
    spawned++;
  }
}

function addFloater(text, x, y, opts = {}) {
  const {
    size = 26,
    life = IS_MOBILE ? 0.50 : 0.70,
    rise = IS_MOBILE ? 90 : 130,
    wobble = IS_MOBILE ? 6 : 10,
    weight = 900,
  } = opts;

  for (let i = 0; i < floaters.length; i++) {
    const f = floaters[i];
    if (f.alive) continue;
    f.alive = true;
    f.text = text;
    f.x0 = x; f.y0 = y;
    f.t = 0; f.life = life;
    f.rise = rise; f.wobble = wobble;
    f.size = size; f.weight = weight;
    return;
  }
}

// ====== state ======
let best = Number(localStorage.getItem(BEST_KEY) || 0);
elBest.textContent = String(best);

const state = {
  running: false,
  phase: "intro",
  introLeft: INTRO_FIRST_SECONDS,
  introTotal: INTRO_FIRST_SECONDS,
  countPlayed: false,
  goHold: 0,

  score: 0,
  timeLeft: GAME_SECONDS,

  shake: 0,

  combo: 0,
  comboTimer: 0,
  comboWindow: 1.0,
  fever: false,
  feverTimer: 0,
  scoreMul: 1,

  face: {
    x: 120, y: 220, r: 64,
    vx: 0, vy: 0,
    baseVx: 0, baseVy: 0,
    hitTimer: 0,
    scalePop: 0,
  }
};

function stopFever() {
  state.fever = false;
  state.feverTimer = 0;
  state.scoreMul = 1;
}

function startFever(seconds = 7.0) {
  state.fever = true;
  state.feverTimer = seconds;
  state.scoreMul = 2;
  playHitBonus();
  addFloater("FEVER x2!!", state.face.x, state.face.y - state.face.r - 12, {
    size: IS_MOBILE ? 34 : 40, life: 1.0, rise: IS_MOBILE ? 60 : 80, wobble: 16, weight: 1000
  });
  state.shake = Math.max(state.shake, IS_MOBILE ? 0.20 : 0.26);
}

function resetPools() {
  for (const p of particles) p.alive = false;
  for (const f of floaters) f.alive = false;
}

function resetGameForIntro(introSeconds) {
  state.phase = "intro";
  state.introTotal = introSeconds;
  state.introLeft = introSeconds;
  state.countPlayed = false;
  state.goHold = 0;

  state.score = 0;
  state.timeLeft = GAME_SECONDS;

  state.shake = 0;
  state.combo = 0;
  state.comboTimer = 0;
  stopFever();

  resetPools();
  hitRequested = false;

  const { w, h } = getViewportSize();
  state.face.r = Math.min(w, h) * 0.10;
  state.face.x = rand(state.face.r, w - state.face.r);
  state.face.y = rand(state.face.r + 90, h - state.face.r);

  state.face.baseVx = rand(220, 340) * (Math.random() < 0.5 ? -1 : 1);
  state.face.baseVy = rand(180, 300) * (Math.random() < 0.5 ? -1 : 1);
  state.face.vx = 0;
  state.face.vy = 0;

  state.face.hitTimer = 0;
  state.face.scalePop = 0;

  elScore.textContent = "0";
  elTime.textContent = GAME_SECONDS.toFixed(1);
}

function endGame() {
  state.running = false;
  overlay.classList.remove("hidden");

  if (state.score > best) {
    best = state.score;
    localStorage.setItem(BEST_KEY, String(best));
    elBest.textContent = String(best);
    titleEl.textContent = "NEW BEST!";
  } else {
    titleEl.textContent = "RESULT";
  }
  resultEl.textContent = `Score: ${state.score} / Best: ${best}`;
  btn.textContent = "RETRY";
}

// ====== hit request (frame synced) ======
let hasStartedOnce = false;
let hitRequested = false;
let hitX = 0, hitY = 0;

let lastHitPerf = 0;
function isRapidHit() {
  const now = performance.now();
  const rapid = (now - lastHitPerf) < 90;
  lastHitPerf = now;
  return rapid;
}

function pointInFace(px, py) {
  const dx = px - state.face.x;
  const dy = py - state.face.y;
  const pad = IS_MOBILE ? 1.45 : 1.15;
  const rr = state.face.r * pad;
  return (dx * dx + dy * dy) <= (rr * rr);
}

function getPointerPos(e) {
  // cached rect => no layout cost per tap
  if (!canvasRect) updateCanvasRect();
  return { x: (e.clientX - canvasRect.left), y: (e.clientY - canvasRect.top) };
}

canvas.addEventListener("pointerdown", (e) => {
  if (!state.running) return;
  if (state.phase !== "play") return;
  const p = getPointerPos(e);
  hitRequested = true;
  hitX = p.x; hitY = p.y;
}, { passive: true });

function processHitOncePerFrame() {
  if (!hitRequested) return;
  hitRequested = false;

  const x = hitX, y = hitY;

  if (pointInFace(x, y)) {
    const rapid = isRapidHit();

    if (state.comboTimer > 0) state.combo += 1;
    else state.combo = 1;
    state.comboTimer = state.comboWindow;

    const add = 1 * state.scoreMul;
    state.score += add;
    elScore.textContent = String(state.score); // DOM update only here (once per frame max)

    // floaters: keep light
    if (!rapid || (state.combo % 2 === 0)) {
      addFloater(`+${add}`, state.face.x, state.face.y - state.face.r * 0.15, {
        size: IS_MOBILE ? (rapid ? 22 : 26) : (rapid ? 26 : 30),
        life: rapid ? 0.40 : 0.65,
        rise: rapid ? 80 : 120,
        wobble: rapid ? 6 : 10,
        weight: 900
      });
    }

    playHitNormal();

    if (state.combo === 5) {
      const bonus = 10 * state.scoreMul;
      state.score += bonus;
      elScore.textContent = String(state.score);

      if (!rapid) {
        addFloater(`+${bonus} BONUS!!`, state.face.x, state.face.y, {
          size: IS_MOBILE ? 34 : 44, life: 1.0, rise: 150, wobble: 18, weight: 1000
        });
      }
      playHitBonus();
      state.shake = Math.max(state.shake, IS_MOBILE ? 0.26 : 0.33);
    }

    if (state.combo === 10 && !state.fever) startFever(3.0);

    state.face.hitTimer = 0.18;
    state.face.scalePop = 0.20;

    state.shake = Math.max(
      state.shake,
      (state.fever ? (IS_MOBILE ? 0.16 : 0.20) : (IS_MOBILE ? 0.13 : 0.16)) + Math.min(0.20, state.combo * 0.010)
    );

    // particles: no allocation
    spawnParticles(state.face.x, state.face.y, 18, rapid);

    const mult = rapid ? rand(0.995, 1.02) : rand(0.97, 1.05);
    state.face.vx *= mult;
    state.face.vy *= mult;

    const vmax = speedLimit();
    state.face.vx = clamp(state.face.vx, -vmax, vmax);
    state.face.vy = clamp(state.face.vy, -vmax, vmax);

  } else {
    state.comboTimer = 0;
    state.combo = 0;
    state.timeLeft = Math.max(0, state.timeLeft - 0.25);
  }
}

// ====== intro draw ======
function drawIntroCountdown() {
  const { w, h } = getViewportSize();
  const left = state.introLeft;
  const waiting = (left > 5.0);
  const n = Math.max(0, Math.min(5, Math.ceil(left)));
  const isGo = (left <= 0.0);

  const p = (state.introTotal > 0) ? (left / state.introTotal) : 0;
  const pulse = 1 + 0.08 * Math.sin((1 - p) * Math.PI * 6);

  ctx.save();
  ctx.globalAlpha = 0.98;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = `900 24px system-ui, sans-serif`;
  if (!IS_MOBILE) {
    ctx.lineWidth = 6;
    ctx.strokeStyle = TEXT_STROKE;
    ctx.strokeText("GET READY", w / 2, h / 2 - 110);
  }
  ctx.fillStyle = TEXT_FILL;
  ctx.fillText("GET READY", w / 2, h / 2 - 110);

  if (waiting) { ctx.restore(); return; }

  const text = isGo ? "GO!" : String(n);

  ctx.font = `${Math.floor((IS_MOBILE ? 100 : 120) * pulse)}px system-ui, sans-serif`;
  if (!IS_MOBILE) {
    ctx.lineWidth = 10;
    ctx.strokeStyle = TEXT_STROKE;
    ctx.strokeText(text, w / 2, h / 2);
  }
  ctx.fillStyle = TEXT_FILL;
  ctx.fillText(text, w / 2, h / 2);

  ctx.restore();
}

// ====== update/draw fixed tick ======
function updateFixed(dt) {
  if (state.phase === "intro") {
    if (state.goHold > 0) {
      state.goHold = Math.max(0, state.goHold - dt);
      elTime.textContent = GAME_SECONDS.toFixed(1);

      // update pools (in place)
      for (const f of floaters) {
        if (!f.alive) continue;
        f.t += dt;
        if (f.t >= f.life) f.alive = false;
      }
      for (const p of particles) {
        if (!p.alive) continue;
        p.t += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        // fixed damping (cheap, stable)
        p.vx *= 0.86;
        p.vy *= 0.86;
        if (p.t >= p.life) p.alive = false;
      }

      if (state.goHold <= 0) {
        state.phase = "play";
        state.timeLeft = GAME_SECONDS;
        elTime.textContent = state.timeLeft.toFixed(1);
        state.face.vx = state.face.baseVx;
        state.face.vy = state.face.baseVy;
      }
      return;
    }

    state.introLeft = Math.max(0, state.introLeft - dt);
    elTime.textContent = GAME_SECONDS.toFixed(1);

    if (!state.countPlayed && state.introLeft <= 3.0) {
      playCount();
      state.countPlayed = true;
    }

    for (const f of floaters) {
      if (!f.alive) continue;
      f.t += dt;
      if (f.t >= f.life) f.alive = false;
    }
    for (const p of particles) {
      if (!p.alive) continue;
      p.t += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.86;
      p.vy *= 0.86;
      if (p.t >= p.life) p.alive = false;
    }

    if (state.introLeft <= 0) {
      state.goHold = GO_HOLD_SECONDS;
      addFloater("GO!!", state.face.x, state.face.y - state.face.r - 10, {
        size: IS_MOBILE ? 46 : 52, life: GO_HOLD_SECONDS, rise: 120, wobble: 12, weight: 1000
      });
      state.shake = Math.max(state.shake, IS_MOBILE ? 0.16 : 0.20);
    }
    return;
  }

  // play
  state.timeLeft -= dt;
  if (state.timeLeft <= 0) {
    state.timeLeft = 0;
    elTime.textContent = "0.0";
    endGame();
    return;
  }
  elTime.textContent = state.timeLeft.toFixed(1);

  // max 1 hit per frame
  processHitOncePerFrame();

  const f = state.face;
  f.x += f.vx * dt;
  f.y += f.vy * dt;

  const { w, h } = getViewportSize();
  const topMargin = 56;
  if (f.x - f.r < 0) { f.x = f.r; f.vx *= -1; }
  if (f.x + f.r > w) { f.x = w - f.r; f.vx *= -1; }
  if (f.y - f.r < topMargin) { f.y = topMargin + f.r; f.vy *= -1; }
  if (f.y + f.r > h) { f.y = h - f.r; f.vy *= -1; }

  f.hitTimer = Math.max(0, f.hitTimer - dt);
  f.scalePop = Math.max(0, f.scalePop - dt);
  state.shake = Math.max(0, state.shake - dt);

  for (const p of particles) {
    if (!p.alive) continue;
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.86;
    p.vy *= 0.86;
    if (p.t >= p.life) p.alive = false;
  }

  for (const fl of floaters) {
    if (!fl.alive) continue;
    fl.t += dt;
    if (fl.t >= fl.life) fl.alive = false;
  }

  if (state.comboTimer > 0) {
    state.comboTimer = Math.max(0, state.comboTimer - dt);
    if (state.comboTimer === 0) state.combo = 0;
  }

  if (state.fever) {
    state.feverTimer -= dt;
    if (state.feverTimer <= 0) stopFever();
  }
}

function draw() {
  const { w, h } = getViewportSize();

  let ox = 0, oy = 0;
  if (state.shake > 0) {
    const base = state.fever ? 12 : 9;
    const s = state.shake * base;
    ox = rand(-s, s);
    oy = rand(-s, s);
  }

  ctx.save();
  ctx.translate(ox, oy);

  ctx.clearRect(-20, -20, w + 40, h + 40);
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, w, h);

  // particles
  if (dotSprite) {
    for (const p of particles) {
      if (!p.alive) continue;
      const a = 1 - (p.t / p.life);
      ctx.globalAlpha = a;
      const r = (IS_MOBILE ? 7 : 9) * a + 2;
      ctx.drawImage(dotSprite, p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  // floaters
  for (const ft of floaters) {
    if (!ft.alive) continue;
    const pp = ft.t / ft.life;
    const ease = 1 - Math.pow(1 - pp, 3);
    const yy = ft.y0 - ft.rise * ease;
    const xx = ft.x0 + Math.sin(pp * Math.PI * 2) * ft.wobble;
    const alpha = 1 - pp;

    ctx.globalAlpha = alpha;
    ctx.font = `${ft.weight} ${ft.size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (!IS_MOBILE) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = TEXT_STROKE;
      ctx.strokeText(ft.text, xx, yy);
    }
    ctx.fillStyle = TEXT_FILL;
    ctx.fillText(ft.text, xx, yy);
  }
  ctx.globalAlpha = 1;

  // face
  const f = state.face;
  const img = (f.hitTimer > 0 ? assets.faceHit : assets.face);
  const pop = (f.scalePop > 0) ? (1 + 0.18 * (f.scalePop / 0.20)) : 1;
  const size = (f.r * 2) * pop;

  ctx.globalAlpha = 0.10;
  ctx.beginPath();
  ctx.ellipse(f.x, f.y + f.r * 0.78, f.r * 0.95, f.r * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.beginPath();
  ctx.arc(f.x, f.y, (f.r * pop), 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, f.x - size / 2, f.y - size / 2, size, size);
  ctx.restore();

  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath();
  ctx.arc(f.x, f.y, (f.r * pop), 0, Math.PI * 2);
  ctx.stroke();

  if (state.phase === "intro") drawIntroCountdown();

  ctx.restore();
}

// ====== fixed tick loop (45fps) ======
const STEP_MS = 1000 / 45;
let acc = 0;
let lastT = 0;

function loop(t) {
  if (!state.running) return;

  if (!lastT) lastT = t;
  acc += (t - lastT);
  lastT = t;

  // clamp acc to avoid spiral
  acc = Math.min(acc, 250);

  while (acc >= STEP_MS) {
    updateFixed(STEP_MS / 1000);
    acc -= STEP_MS;
    if (!state.running) break;
  }

  if (state.running) {
    draw();
    requestAnimationFrame(loop);
  }
}

// ====== start ======
function startGame() {
  initAudio();
  startBGM();

  const introSeconds = hasStartedOnce ? INTRO_RETRY_SECONDS : INTRO_FIRST_SECONDS;
  resetGameForIntro(introSeconds);

  state.running = true;
  overlay.classList.add("hidden");

  addFloater("GET READY...", state.face.x, state.face.y - state.face.r - 10, {
    size: IS_MOBILE ? 28 : 34, life: 1.0, rise: 40, wobble: 6, weight: 1000
  });

  hasStartedOnce = true;
  acc = 0; lastT = 0;
  requestAnimationFrame(loop);
}
btn.addEventListener("click", startGame);

// ====== initial overlay ======
overlay.classList.remove("hidden");
titleEl.textContent = "Atack Oohigashi!!";
resultEl.textContent = "STARTを押してね";
btn.textContent = "START";
