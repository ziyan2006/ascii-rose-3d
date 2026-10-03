import { buildRosePoints, clampPitch, writeRotation, MIN_POINTS, MAX_POINTS } from './geometry.js';
import { createRenderer, DEFAULT_CHARSET } from './renderer.js';

// URL controls: ?points=18000&chars=@%25%23*%2B=-:.&sensitivity=0.006&inertia=0.92
// points/count: 3000…200000; chars/charset: dense → sparse (up to 24 glyphs).
// sensitivity: radians per pixel; inertia: velocity retained per 60 Hz frame.
const query = new URLSearchParams(location.search);
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const cores = navigator.hardwareConcurrency || 4;
const memory = navigator.deviceMemory || 4;
const lowPower = cores <= 4 && memory <= 2;
const defaultCount = lowPower ? 9000 : coarsePointer ? 16000 : 24000;

function queryNumber(name, alias, fallback, low, high) {
  const raw = query.get(name) ?? (alias ? query.get(alias) : null);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
}

const requestedCount = Math.round(queryNumber('points', 'count', defaultCount, MIN_POINTS, MAX_POINTS));
const sensitivity = queryNumber('sensitivity', null, 0.006, 0.0005, 0.025);
const inertia = queryNumber('inertia', null, reducedMotion ? 0.82 : 0.92, 0, 0.985);
let charset = query.get('chars') || query.get('charset') || DEFAULT_CHARSET;
const stage = document.getElementById('stage');
const gallery = document.getElementById('gallery');
const pointLabel = document.getElementById('point-count');
const fpsLabel = document.getElementById('fps');
const modeLabel = document.getElementById('render-mode');
const spinButton = document.getElementById('spin-button');
const fullscreenButton = document.getElementById('fullscreen-button');
const resetButton = document.getElementById('reset-button');
const rotationStatus = document.getElementById('rotation-status');
const characterButtons = document.querySelectorAll('[data-charset]');
const numberFormat = new Intl.NumberFormat('en-US');
const rotation = new Float32Array(9);
const INITIAL_YAW = -0.46;
const INITIAL_PITCH = 0.36;
const TAU = Math.PI * 2;

let points;
let renderer;
let canvas;
let yaw = INITIAL_YAW;
let pitch = INITIAL_PITCH;
let velocityYaw = 0;
let velocityPitch = 0;
let autoRotate = false;
let resetting = false;
let pointerId = -1;
let pointerX = 0;
let pointerY = 0;
let pointerTime = 0;
let hasMoved = false;
let frameId = 0;
let previousTime = 0;
let fpsElapsed = 0;
let fpsFrames = 0;
let slowWindows = 0;
let fastWindows = 0;
let qualityScale = 1;
let restoreTimer = 0;
let resizing = false;
let needsDraw = true;
let drawnYaw = NaN;
let drawnPitch = NaN;
let renderedFrames = 0;

function updatePointLabel() {
  pointLabel.textContent = `${numberFormat.format(renderer.count)} 个字符`;
  modeLabel.textContent = renderer.mode === 'webgl' ? 'LIVE / 3D' : 'LIVE / 轻量模式';
}

function resize() {
  if (!renderer || resizing || renderer.lost) return;
  resizing = true;
  const bounds = stage.getBoundingClientRect();
  const maximumRatio = coarsePointer || lowPower ? 1.5 : 1.75;
  const ratio = Math.max(0.85, Math.min(devicePixelRatio || 1, maximumRatio) * qualityScale);
  renderer.resize(bounds.width, bounds.height, ratio);
  needsDraw = true;
  // Do not classify layout/orientation changes as sustained device slowness.
  slowWindows = 0;
  fastWindows = 0;
  fpsElapsed = 0;
  fpsFrames = 0;
  resizing = false;
}

function setSpin(enabled) {
  autoRotate = enabled;
  resetting = false;
  velocityYaw = 0;
  velocityPitch = 0;
  spinButton.setAttribute('aria-pressed', String(enabled));
  spinButton.setAttribute('aria-label', enabled ? '停止自动旋转' : '自动旋转');
  spinButton.title = enabled ? '停止自动旋转' : '自动旋转';
}

function resetView() {
  setSpin(false);
  yaw = ((yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
  resetting = !reducedMotion;
  if (reducedMotion) {
    yaw = INITIAL_YAW;
    pitch = INITIAL_PITCH;
  }
  rotationStatus.textContent = '已回到初始视角';
}

function pointerDown(event) {
  if (pointerId !== -1 || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  setSpin(false);
  pointerId = event.pointerId;
  pointerX = event.clientX;
  pointerY = event.clientY;
  pointerTime = event.timeStamp;
  hasMoved = false;
  canvas.setPointerCapture(pointerId);
  canvas.classList.add('is-dragging');
  canvas.classList.add('pointer-focused');
  if (event.pointerType === 'mouse') canvas.focus({ preventScroll: true });
}

function pointerMove(event) {
  if (event.pointerId !== pointerId) return;
  event.preventDefault();
  const now = event.timeStamp;
  const dt = Math.max(0.008, Math.min(0.12, (now - pointerTime) / 1000));
  const dx = (event.clientX - pointerX) * sensitivity;
  const dy = (event.clientY - pointerY) * sensitivity;
  yaw += dx;
  const targetPitch = pitch + dy;
  pitch = clampPitch(targetPitch);
  velocityYaw = velocityYaw * 0.35 + Math.max(-5, Math.min(5, dx / dt)) * 0.65;
  velocityPitch = targetPitch === pitch ? velocityPitch * 0.35 + Math.max(-4, Math.min(4, dy / dt)) * 0.65 : 0;
  pointerX = event.clientX;
  pointerY = event.clientY;
  pointerTime = now;
  if (dx !== 0 || dy !== 0) hasMoved = true;
}

function finishPointer(event) {
  if (event.pointerId !== pointerId) return;
  if (event.type === 'pointercancel' || !hasMoved || event.timeStamp - pointerTime > 200) {
    velocityYaw = 0;
    velocityPitch = 0;
  }
  const capturedId = pointerId;
  pointerId = -1;
  canvas.classList.remove('is-dragging');
  if (canvas.hasPointerCapture(capturedId)) canvas.releasePointerCapture(capturedId);
  rotationStatus.textContent = '玫瑰视角已更新';
}

function keyboard(event) {
  canvas.classList.remove('pointer-focused');
  if (event.key.startsWith('Arrow')) {
    event.preventDefault();
    setSpin(false);
    if (event.key === 'ArrowLeft') yaw -= 0.12;
    if (event.key === 'ArrowRight') yaw += 0.12;
    if (event.key === 'ArrowUp') pitch = clampPitch(pitch - 0.08);
    if (event.key === 'ArrowDown') pitch = clampPitch(pitch + 0.08);
    rotationStatus.textContent = '玫瑰视角已更新';
  } else if (event.key === 'Home') {
    event.preventDefault();
    resetView();
  } else if (event.code === 'Space') {
    event.preventDefault();
    setSpin(!autoRotate);
  }
}

function bindCanvas() {
  canvas = renderer.canvas;
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', finishPointer);
  canvas.addEventListener('lostpointercapture', finishPointer);
  canvas.addEventListener('keydown', keyboard);
  canvas.addEventListener('blur', () => canvas.classList.remove('pointer-focused'));
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
}

function useFallback() {
  clearTimeout(restoreTimer);
  pointerId = -1;
  velocityYaw = 0;
  velocityPitch = 0;
  renderer = createRenderer(canvas, points, charset, true);
  bindCanvas();
  canvas.classList.remove('is-dragging');
  resize();
  updatePointLabel();
}

function contextLost(event) {
  event.preventDefault();
  renderer.lost = true;
  velocityYaw = 0;
  velocityPitch = 0;
  modeLabel.textContent = '正在恢复画面';
  restoreTimer = window.setTimeout(useFallback, 1800);
}

function contextRestored() {
  clearTimeout(restoreTimer);
  try {
    renderer.restore();
    resize();
    updatePointLabel();
  } catch {
    useFallback();
  }
}

function adjustQuality(fps) {
  if (renderer.mode !== 'webgl' || renderer.lost || document.hidden) return;
  const minimum = Math.min(requestedCount, 6500);
  if (fps < 29) {
    slowWindows++;
    fastWindows = 0;
    if (slowWindows >= 2) {
      if (renderer.count > minimum) renderer.setActiveCount(Math.max(minimum, renderer.count * 0.8));
      else if (qualityScale > 0.68) {
        qualityScale = Math.max(0.68, qualityScale * 0.88);
        resize();
      }
      slowWindows = 0;
      needsDraw = true;
      updatePointLabel();
    }
  } else if (fps > 53) {
    slowWindows = 0;
    fastWindows++;
    if (fastWindows >= 6 && renderer.count < requestedCount) {
      renderer.setActiveCount(Math.min(requestedCount, renderer.count * 1.1));
      needsDraw = true;
      fastWindows = 0;
      updatePointLabel();
    }
  } else {
    slowWindows = 0;
    fastWindows = 0;
  }
}

/** No arrays, objects, point generation, sorting or GPU uploads in this loop. */
function frame(now) {
  const elapsed = previousTime ? now - previousTime : 16.667;
  const dt = Math.min(0.05, elapsed / 1000);
  previousTime = now;
  if (pointerId === -1) {
    if (resetting) {
      const ease = 1 - Math.exp(-elapsed * 0.01);
      yaw += (INITIAL_YAW - yaw) * ease;
      pitch += (INITIAL_PITCH - pitch) * ease;
      if (Math.abs(yaw - INITIAL_YAW) + Math.abs(pitch - INITIAL_PITCH) < 0.0005) {
        yaw = INITIAL_YAW;
        pitch = INITIAL_PITCH;
        resetting = false;
      }
    } else if (autoRotate) {
      yaw += dt * 0.2;
    } else {
      const decay = Math.pow(inertia, elapsed * 0.06);
      velocityYaw *= decay;
      velocityPitch *= decay;
      if (Math.abs(velocityYaw) < 0.003) velocityYaw = 0;
      if (Math.abs(velocityPitch) < 0.003) velocityPitch = 0;
      yaw += velocityYaw * dt;
      const nextPitch = pitch + velocityPitch * dt;
      pitch = clampPitch(nextPitch);
      if (pitch !== nextPitch) velocityPitch = 0;
    }
  }
  if (yaw > Math.PI * 2 || yaw < -Math.PI * 2) yaw %= TAU;
  writeRotation(pitch, yaw, rotation);
  // A still specimen keeps its composited image; idle frames do no GPU work.
  if (needsDraw || yaw !== drawnYaw || pitch !== drawnPitch) {
    renderer.render(rotation);
    drawnYaw = yaw;
    drawnPitch = pitch;
    needsDraw = false;
    renderedFrames++;
  }
  fpsElapsed += elapsed;
  fpsFrames++;
  if (fpsElapsed >= 1000) {
    const fps = Math.min(240, Math.round(fpsFrames * 1000 / fpsElapsed));
    fpsLabel.textContent = `${fps} FPS`;
    if (renderedFrames > 0 && renderedFrames * 3 >= fpsFrames) adjustQuality(fps);
    renderedFrames = 0;
    fpsElapsed = 0;
    fpsFrames = 0;
  }
  frameId = requestAnimationFrame(frame);
}

function updateFullscreenButton(active) {
  fullscreenButton.setAttribute('aria-pressed', String(active));
  fullscreenButton.setAttribute('aria-label', active ? '退出沉浸模式' : '沉浸模式');
  fullscreenButton.title = active ? '退出沉浸模式' : '沉浸模式';
}

async function toggleFullscreen() {
  const active = gallery.classList.contains('immersive');
  if (active) {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    gallery.classList.remove('immersive');
  } else {
    gallery.classList.add('immersive');
    if (gallery.requestFullscreen) await gallery.requestFullscreen().catch(() => {});
  }
  updateFullscreenButton(!active);
  resize();
}

function chooseCharacters(event) {
  const selected = event.currentTarget;
  charset = selected.dataset.charset;
  renderer.setCharset(charset);
  needsDraw = true;
  for (let i = 0; i < characterButtons.length; i++) characterButtons[i].setAttribute('aria-pressed', String(characterButtons[i] === selected));
  rotationStatus.textContent = `已切换到${selected.title}`;
}

resetButton.addEventListener('click', resetView);
spinButton.addEventListener('click', () => setSpin(!autoRotate));
fullscreenButton.addEventListener('click', toggleFullscreen);
for (let i = 0; i < characterButtons.length; i++) {
  characterButtons[i].setAttribute('aria-pressed', String(characterButtons[i].dataset.charset === charset));
  characterButtons[i].addEventListener('click', chooseCharacters);
}

const dialog = document.getElementById('about-dialog');
document.getElementById('about-button').addEventListener('click', () => dialog.showModal());
document.getElementById('dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  gallery.classList.toggle('immersive', active);
  updateFullscreenButton(active);
  resize();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !dialog.open && gallery.classList.contains('immersive') && !document.fullscreenElement) {
    gallery.classList.remove('immersive');
    updateFullscreenButton(false);
    resize();
  }
});
document.addEventListener('gesturestart', event => event.preventDefault(), { passive: false });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(frameId);
    frameId = 0;
    pointerId = -1;
    velocityYaw = 0;
    velocityPitch = 0;
    if (canvas) canvas.classList.remove('is-dragging');
  } else if (renderer && !frameId) {
    previousTime = 0;
    fpsElapsed = 0;
    fpsFrames = 0;
    frameId = requestAnimationFrame(frame);
  }
});
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);

try {
  points = buildRosePoints({ count: requestedCount });
  renderer = createRenderer(document.getElementById('rose-canvas'), points, charset, query.get('renderer') === '2d');
  bindCanvas();
  resize();
  updatePointLabel();
  document.body.classList.add('ready');
  frameId = requestAnimationFrame(frame);
} catch (error) {
  document.getElementById('loading-text').textContent = `画面暂时无法显示：${error.message}`;
  document.querySelector('.loading-symbol').style.display = 'none';
  modeLabel.textContent = '画布不可用';
}
