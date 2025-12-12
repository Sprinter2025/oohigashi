// main.js (FULL COPY-PASTE) --- Mobile ultra-light ver (WebAudio + low-GC) ---
// - iOS Safari bottom bar safe: use visualViewport for sizing
// - Tap hitbox bigger on mobile
// - Performance: cap DPR to 2
// - Particles: pre-rendered sprite + MAX_PARTICLES cap (fast)
// - Floaters/Particles: in-place compaction (NO Array.filter allocations)
// - Sounds: WebAudio (AudioBuffer) + throttle (fix tap-stutter)
// - Background: light gray
// - HUD text: black
// - Enemy shadow: visible gray (not blended)

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: false });

const elScore = document.getElementById("score");
const elTime = document.getElementById("time");
const elBest = document.getElementById("best");
const overlay = document.getElementById("overlay");
const titleEl = document.getElementById("title");
const resultEl = document.getElementById("result");
const btn = document.getElementById("btn");

const BEST_KEY = "facebop_best_v4";

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

// ---- Mobile detect & viewport size ----
const IS_MOBILE = matchMedia("(pointer: coarse)").matches;

function getViewportSize() {
  const vv = window.visualViewport;
  const w = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  return { w, h };
}

function fitCanvas() {
  const { w, h } = getViewportSize();
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1)); // cap for performance
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", fitCanvas, { passive: true });
window.visualViewport?.addEventListener("resize", fitCanvas, { passive: true });
fitCanvas();

// ---- particle sprite (fast) ----
let dotSprite = null;
function makeDotSprite() {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const g = c.getContext("2d");

  const cx = 16, cy = 16;
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, 16);
  grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.65)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");

  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, 16, 0, Math.PI * 2);
  g.fill();

  dotSprite = c;
}
makeDotSprite();

// ---- image assets ----
const assets = {
  face: new Image(),
  faceHit: new Image(),
};
assets.face.src = "./assets/face.png";
assets.faceHit.src = "./assets/face_hit.png"; // 無ければ face.png をコピーでOK

// ---- WebAudio (fast, tap-safe) ----
let audioCtx = null;
let gainBgm = null;
let gainSe = null;
let buffers = { hit01: null, hit02: null, count: null, bgm: null };
let bgmSource = null;

async function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  gainBgm = audioCtx.createGain();
  gainSe = audioCtx.createGain();
  gainBgm.gain.value = 0.18; // bgm volume
  gainSe.gain.value = 0.85;  // se volume
  gainBgm.connect(audioCtx.destination);
  gainSe.connect(audioCtx.destination);

  async function loadBuf(url) {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return await audioCtx.decodeAudioData(arr);
  }

  // decode once
  const [b1, b2, b3, b4] = await Promise.all([
    loadBuf("./assets/hit01.mp3"),
    loadBuf("./assets/hit02.mp3"),
    loadBuf("./assets/count.mp3"),
    loadBuf("./assets/bgm.mp3"),
  ]);
  buffers.hit01 = b1;
  buffers.hit02 = b2;
  buffers.count = b3;
  buffers.bgm  = b4;
}

function startBGM() {
  if (!audioCtx || !buffers.bgm) return;
  if (bgmSource) return; // already playing

  bgmSource = audioCtx.createBufferSource();
  bgmSource.buffer = buffers.bgm;
  bgmSource.loop = true;
  bgmSource.connect(gainBgm);
  bgmSource.start(0);
}

let lastSeTime = 0;
function playSE(buf, volMul = 1.0) {
  if (!audioCtx || !buf) return;

  const now = performance.now();
  // throttle to avoid audio spam stutter
  if (IS_MOBILE && now - lastSeTime < 70) return;
  lastSeTime = now;

  const src = audioCtx.createBufferSource();
  src.buffer = buf;

  // per-hit gain (cheap)
  const g = audioCtx.createGain();
  g.gain.value = volMul;
  src.connect(g);
  g.connect(gainSe);

  src.start(0);
}

function playHitNormal() { playSE(buffers.hit01, 0.95); }
function playHitBonus()  { playSE(buffers.hit02, 1.00); }
function playCount()     { playSE(buffers.count, 0.95); }

// ---- best ----
let best = Number(localStorage.getItem(BEST_KEY) || 0);
elBest.textContent = best.toString();

// ---- timing ----
const INTRO_FIRST_SECONDS = 7.0;
const INTRO_RETRY_SECONDS = 3.0;
const GO_HOLD_SECONDS = 1.0;
const GAME_SECONDS = 30.0;

// 速度の上限（暴走防止）
function speedLimit() {
  const { w, h } = getViewportSize();
  const s = Math.min(w, h);
  return clamp(s * 0.85, 520, 900); // px/s
}

const state = {
  running: false,
  lastT: 0,

  phase: "intro", // "intro" -> "play"
  introLeft: INTRO_FIRST_SECONDS,
  introTotal: INTRO_FIRST_SECONDS,
  countPlayed: false,
  goHold: 0,

  score: 0,
  timeLeft: GAME_SECONDS,

  // pooled arrays (in-place compaction)
  particles: [],
  floaters: [],

  shake: 0,

  combo: 0,
  comboTimer: 0,
  comboWindow: 1.0,
  fever: false,
  feverTimer: 0,
  scoreMul: 1,

  face: {
    x: 120,
    y: 220,
    r: 64,
    vx: 0,
    vy: 0,
    baseVx: 0,
    baseVy: 0,
    hitTimer: 0,
    scalePop: 0,
  }
};

let hasStartedOnce = false;

// ---- floaters (pool + cap) ----
const MAX_FLOATERS = IS_MOBILE ? 18 : 60;

function addFloater(text, x, y, opts = {}) {
  const {
    size = 26,
    life = IS_MOBILE ? 0.55 : 0.7,
    rise = IS_MOBILE ? 110 : 140,
    wobble = IS_MOBILE ? 8 : 10,
    weight = 900,
  } = opts;

  if (state.floaters.length >= MAX_FLOATERS) return;

  state.floaters.push({
    text,
    x0: x,
    y0: y,
    t: 0,
    life,
    rise,
    wobble,
    size,
    weight,
  });
}

function startFever(seconds = 7.0) {
  state.fever = true;
  state.feverTimer = seconds;
  state.scoreMul = 2;

  playHitBonus();

  addFloater("FEVER x2!!", state.face.x, state.face.y - state.face.r - 12, {
    size: IS_MOBILE ? 34 : 40,
    life: 1.0,
    rise: IS_MOBILE ? 70 : 90,
    wobble: 20,
    weight: 1000
  });

  state.shake = Math.max(state.shake, IS_MOBILE ? 0.22 : 0.28);
}

function stopFever() {
  state.fever = false;
  state.feverTimer = 0;
  state.scoreMul = 1;
}

function resetGameForIntro(introSeconds) {
  state.phase = "intro";
  state.introTotal = introSeconds;
  state.introLeft = introSeconds;
  state.countPlayed = false;
  state.goHold = 0;

  state.score = 0;
  state.timeLeft = GAME_SECONDS;

  // clear arrays without realloc
  state.particles.length = 0;
  state.floaters.length = 0;

  state.shake = 0;

  state.combo = 0;
  state.comboTimer = 0;
  stopFever();

  const { w, h } = getViewportSize();

  state.face.r = Math.min(w, h) * 0.10;
  state.face.x = rand(state.face.r, w - state.face.r);
  state.face.y = rand(state.face.r + 90, h - state.face.r);

  const baseVx = rand(220, 340) * (Math.random() < 0.5 ? -1 : 1);
  const baseVy = rand(180, 300) * (Math.random() < 0.5 ? -1 : 1);
  state.face.baseVx = baseVx;
  state.face.baseVy = baseVy;

  state.face.vx = 0;
  state.face.vy = 0;
  state.face.hitTimer = 0;
  state.face.scalePop = 0;

  elScore.textContent = "0";
  elTime.textContent = GAME_SECONDS.toFixed(1);
}

// ---- particles (cap + in-place update) ----
const MAX_PARTICLES = IS_MOBILE ? 60 : 220;

function spawnParticles(x, y, n = 18) {
  if (state.particles.length >= MAX_PARTICLES) return;

  const nn = IS_MOBILE ? Math.max(4, Math.floor(n * 0.35)) : n;

  for (let i = 0; i < nn; i++) {
    if (state.particles.length >= MAX_PARTICLES) break;

    const a = rand(0, Math.PI * 2);
    const sp = rand(140, 620);
    state.particles.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: rand(0.18, 0.42),
      t: 0
    });
  }
}

function pointInFace(px, py) {
  const dx = px - state.face.x;
  const dy = py - state.face.y;
  const pad = IS_MOBILE ? 1.40 : 1.15;
  const rr = state.face.r * pad;
  return (dx * dx + dy * dy) <= (rr * rr);
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

async function startGame() {
  // IMPORTANT: must be called from user gesture
  await ensureAudio();
  if (audioCtx.state === "suspended") {
    try { await audioCtx.resume(); } catch (_) {}
  }
  startBGM();

  const introSeconds = hasStartedOnce ? INTRO_RETRY_SECONDS : INTRO_FIRST_SECONDS;
  resetGameForIntro(introSeconds);

  state.running = true;
  overlay.classList.add("hidden");
  state.lastT = performance.now();

  addFloater("GET READY...", state.face.x, state.face.y - state.face.r - 10, {
    size: IS_MOBILE ? 30 : 34,
    life: 1.0,
    rise: 50,
    wobble: 8,
    weight: 900
  });

  hasStartedOnce = true;
  requestAnimationFrame(loop);
}

btn.addEventListener("click", startGame);

// ---- pointer ----
function getPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left);
  const y = (e.clientY - rect.top);
  return { x, y };
}

canvas.addEventListener("pointerdown", (e) => {
  if (!state.running) return;
  if (state.phase !== "play") return;

  const { x, y } = getPointerPos(e);

  if (pointInFace(x, y)) {
    if (state.comboTimer > 0) state.combo += 1;
    else state.combo = 1;
    state.comboTimer = state.comboWindow;

    const add = 1 * state.scoreMul;
    state.score += add;
    elScore.textContent = String(state.score);

    addFloater(`+${add}`, state.face.x, state.face.y - state.face.r * 0.15, {
      size: IS_MOBILE ? 24 : 28, life: 0.60, rise: 120, wobble: 8, weight: 900
    });

    // hit SE
    playHitNormal();

    // 5 combo bonus
    if (state.combo === 5) {
      const bonus = 10 * state.scoreMul;
      state.score += bonus;
      elScore.textContent = String(state.score);

      addFloater(`+${bonus} BONUS!!`, state.face.x, state.face.y, {
        size: IS_MOBILE ? 34 : 44, life: 0.95, rise: 150, wobble: 18, weight: 1000
      });

      playHitBonus();
      state.shake = Math.max(state.shake, IS_MOBILE ? 0.26 : 0.33);
    }

    if (state.combo === 10 && !state.fever) {
      startFever(3.0);
    }

    state.face.hitTimer = 0.18;
    state.face.scalePop = 0.20;

    state.shake = Math.max(
      state.shake,
      (state.fever ? (IS_MOBILE ? 0.16 : 0.20) : (IS_MOBILE ? 0.13 : 0.16)) + Math.min(0.22, state.combo * 0.012)
    );

    spawnParticles(state.face.x, state.face.y, 26);

    const mult = rand(0.97, 1.05);
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
}, { passive: true });

// ---- update helpers: in-place compaction (no filter) ----
function updateParticles(dt) {
  const arr = state.particles;
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    p.t += dt;
    if (p.t >= p.life) continue;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const damp = Math.pow(0.06, dt);
    p.vx *= damp;
    p.vy *= damp;

    arr[w++] = p;
  }
  arr.length = w;
}

function updateFloaters(dt) {
  const arr = state.floaters;
  let w = 0;
  for (let i = 0; i < arr.length; i++) {
    const ft = arr[i];
    ft.t += dt;
    if (ft.t >= ft.life) continue;
    arr[w++] = ft;
  }
  arr.length = w;
}

function update(dt) {
  // intro
  if (state.phase === "intro") {
    if (state.goHold > 0) {
      state.goHold = Math.max(0, state.goHold - dt);
      elTime.textContent = GAME_SECONDS.toFixed(1);

      updateFloaters(dt);
      updateParticles(dt);

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

    updateFloaters(dt);
    updateParticles(dt);

    if (state.introLeft <= 0) {
      state.goHold = GO_HOLD_SECONDS;
      elTime.textContent = GAME_SECONDS.toFixed(1);

      addFloater("GO!!", state.face.x, state.face.y - state.face.r - 10, {
        size: IS_MOBILE ? 46 : 52, life: GO_HOLD_SECONDS, rise: 140, wobble: 16, weight: 1000
      });

      state.shake = Math.max(state.shake, IS_MOBILE ? 0.18 : 0.22);
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

  updateParticles(dt);
  updateFloaters(dt);

  if (state.comboTimer > 0) {
    state.comboTimer = Math.max(0, state.comboTimer - dt);
    if (state.comboTimer === 0) state.combo = 0;
  }

  if (state.fever) {
    state.feverTimer -= dt;
    if (state.feverTimer <= 0) stopFever();
  }
}

// ---- intro countdown drawing ----
function drawIntroCountdown() {
  const { w, h } = getViewportSize();
  const left = state.introLeft;

  // 最初の2秒(7→5)は数字を表示しない
  const waiting = (left > 5.0);
  const n = Math.max(0, Math.min(5, Math.ceil(left)));
  const isGo = (left <= 0.0);

  const p = (state.introTotal > 0) ? (left / state.introTotal) : 0;
  const pulse = 1 + 0.08 * Math.sin((1 - p) * Math.PI * 6);

  ctx.save();
  ctx.globalAlpha = 0.98;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // GET READY
  ctx.font = `900 24px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(0,0,0,0.88)";
  ctx.fillText("GET READY", w / 2, h / 2 - 110);

  if (waiting) { ctx.restore(); return; }

  const text = isGo ? "GO!" : String(n);

  ctx.font = `${Math.floor((IS_MOBILE ? 100 : 120) * pulse)}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(0,0,0,0.92)";
  ctx.fillText(text, w / 2, h / 2);

  ctx.restore();
}

// ---- draw ----
const BG_COLOR = "#d6d6d6"; // 薄いグレー（背景）
const HUD_COLOR = "rgba(0,0,0,0.92)";

function draw() {
  const { w, h } = getViewportSize();

  let ox = 0, oy = 0;
  if (state.shake > 0) {
    const base = state.fever ? 14 : 10;
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
    for (let i = 0; i < state.particles.length; i++) {
      const p = state.particles[i];
      const a = 1 - (p.t / p.life);
      ctx.globalAlpha = a;

      const r = (IS_MOBILE ? 8 : 10) * a + 2;
      ctx.drawImage(dotSprite, p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  // floaters (mobile: fill only)
  for (let i = 0; i < state.floaters.length; i++) {
    const ft = state.floaters[i];
    const p = ft.t / ft.life;
    const ease = 1 - Math.pow(1 - p, 3);
    const yy = ft.y0 - ft.rise * ease;
    const xx = ft.x0 + Math.sin(p * Math.PI * 2) * ft.wobble;
    const alpha = 1 - p;

    ctx.globalAlpha = alpha;
    ctx.font = `${ft.weight} ${ft.size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // shadow-like (cheap): draw slightly offset
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillText(ft.text, xx + 2, yy + 2);

    ctx.fillStyle = "rgba(0,0,0,0.92)";
    ctx.fillText(ft.text, xx, yy);
  }
  ctx.globalAlpha = 1;

  // enemy (face)
  const f = state.face;
  const img = (f.hitTimer > 0 ? assets.faceHit : assets.face);

  const pop = (f.scalePop > 0) ? (1 + 0.18 * (f.scalePop / 0.20)) : 1;
  const size = (f.r * 2) * pop;

  // ---- shadow: visible gray on gray background ----
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.ellipse(f.x, f.y + f.r * 0.78, f.r * 0.95, f.r * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(90,90,90,0.55)"; // 影をグレー寄りにして背景に同化しない
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.beginPath();
  ctx.arc(f.x, f.y, (f.r * pop), 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, f.x - size / 2, f.y - size / 2, size, size);
  ctx.restore();

  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.arc(f.x, f.y, (f.r * pop), 0, Math.PI * 2);
  ctx.stroke();

  if (state.phase === "intro") {
    drawIntroCountdown();
  }

  ctx.restore();

  // HUD (right top)
  ctx.save();
  ctx.globalAlpha = 0.98;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";

  const pad = 14;
  const hudX = w - pad;
  const hudY = 60;
  const lineH = 28;

  function drawHudText(text, x, y, font) {
    ctx.font = font;
    // cheap shadow (no stroke)
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(text, x + 2, y + 2);
    ctx.fillStyle = HUD_COLOR;
    ctx.fillText(text, x, y);
  }

  if (state.phase === "play") {
    if (state.combo >= 2) {
      drawHudText(`COMBO: ${state.combo}`, hudX, hudY, `900 20px system-ui, sans-serif`);
    }
    if (state.fever) {
      const t = Math.max(0, state.feverTimer).toFixed(1);
      drawHudText(`FEVER x2  ${t}s`, hudX, hudY + lineH, `900 22px system-ui, sans-serif`);
    }
  }

  ctx.restore();
}

function loop(t) {
  if (!state.running) return;
  const dt = clamp((t - state.lastT) / 1000, 0, 0.033);
  state.lastT = t;

  update(dt);
  if (state.running) {
    draw();
    requestAnimationFrame(loop);
  }
}

// ---- initial overlay ----
overlay.classList.remove("hidden");
titleEl.textContent = "Atack Oohigashi!!";
resultEl.textContent = "STARTを押してね";
btn.textContent = "START";
