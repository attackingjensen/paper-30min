// 启动页：左侧 WebGL「流光丝缎」动效（浅底 + 蓝金）+ 微尘粒子层，右侧进入栏。
// 无账号体系，进入按钮仅收起启动页。零依赖；WebGL 不可用时回退 CSS 渐变底（.su-no-gl）。
let showImpl = null;
/** 重新展示启动页（顶栏「启动页」按钮）。 */
export function showStartup() { showImpl?.(); }

const view = document.getElementById('startup-view');

if (view) {
  const scene = view.querySelector('.su-scene');
  const glCanvas = document.getElementById('su-gl');
  const dustCanvas = document.getElementById('su-dust');
  const enterBtn = document.getElementById('su-enter');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0;
  let rafId = 0;
  let leaving = false;
  let mx = 0, my = 0, tmx = 0, tmy = 0;   // 鼠标（-0.5..0.5），lerp 平滑
  const lerp = (a, b, t) => a + (b - a) * t;

  addEventListener('mousemove', e => {
    const r = scene.getBoundingClientRect();
    tmx = (e.clientX - r.left - r.width / 2) / r.width;
    tmy = (e.clientY - r.top - r.height / 2) / r.height;
  });

  // ---------------- WebGL 绸缎层 ----------------
  const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.55;
  mat2 r = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++){ v += a * noise(p); p = r * p; a *= 0.5; }
  return v;
}

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float t = uTime * 0.045;
  vec2 m = uMouse * 0.45;

  /* 双层域扭曲，制造丝绸般的连续流动 */
  vec2 q = vec2(fbm(p * 1.7 + t), fbm(p * 1.7 + vec2(5.2, 1.3) - t * 0.7));
  vec2 r = vec2(fbm(p * 1.7 + 2.4 * q + vec2(1.7, 9.2) + t * 1.1 + m),
                fbm(p * 1.7 + 2.4 * q + vec2(8.3, 2.8) - t * 0.9));
  float f = fbm(p * 1.7 + 2.6 * r);

  vec3 paper = vec3(0.976, 0.984, 0.996);
  vec3 blueD = vec3(0.294, 0.333, 0.886);
  vec3 blueL = vec3(0.545, 0.694, 0.976);
  vec3 gold  = vec3(0.949, 0.714, 0.235);
  vec3 goldL = vec3(0.996, 0.878, 0.588);

  /* 蓝色主绸带 */
  float silkB = smoothstep(0.38, 0.72, f);
  vec3 col = mix(paper, mix(blueL, blueD, clamp(f * f * 2.4, 0.0, 1.0)), silkB * 0.62);
  /* 金色副绸带，沿扭曲场走，避开蓝色最浓处 */
  float band = fbm(p * 3.1 + r * 2.6 - t * 1.6);
  float silkG = smoothstep(0.52, 0.78, band) * smoothstep(0.72, 0.40, f);
  col = mix(col, mix(goldL, gold, band), silkG * 0.55);
  /* 缎面高光 */
  float sheen = smoothstep(0.62, 0.92, fbm(p * 4.3 - r * 3.2 + t * 2.0));
  col += vec3(1.0) * sheen * 0.10;
  /* 边缘向纸色收拢 + 细颗粒 */
  col = mix(col, paper, smoothstep(0.35, 1.25, length(p - m * 0.25)) * 0.45);
  col += (hash(gl_FragCoord.xy * 0.7 + uTime) - 0.5) * 0.014;
  gl_FragColor = vec4(col, 1.0);
}`;

  const VERT = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }';

  let gl = null, glLoc = {};
  function initGL() {
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    let prog = null;
    if (vs && fs) {
      prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) prog = null;
    }
    if (!prog) { gl = null; scene.classList.add('su-no-gl'); return; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    glLoc = {
      res: gl.getUniformLocation(prog, 'uRes'),
      time: gl.getUniformLocation(prog, 'uTime'),
      mouse: gl.getUniformLocation(prog, 'uMouse'),
    };
  }
  try { gl = glCanvas.getContext('webgl', { antialias: false, alpha: false }); } catch { /* 回退 */ }
  if (gl) initGL();
  if (!gl) scene.classList.add('su-no-gl');
  // display:none 可能让 WebView2 丢失 GL 上下文：允许恢复，恢复后重建全部 GL 对象。
  glCanvas.addEventListener('webglcontextlost', e => e.preventDefault());
  glCanvas.addEventListener('webglcontextrestored', () => { if (gl) initGL(); });

  // ---------------- 微尘粒子层（2D canvas，蓝金双色、景深视差） ----------------
  const dctx = dustCanvas.getContext('2d');
  const makeSprite = (r, g, b) => {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d');
    const grad = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, `rgba(${r},${g},${b},.9)`);
    grad.addColorStop(0.35, `rgba(${r},${g},${b},.35)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grad;
    x.fillRect(0, 0, 32, 32);
    return c;
  };
  const sprites = [makeSprite(99, 102, 241), makeSprite(242, 182, 60), makeSprite(96, 165, 250)];
  const DUST_N = 80;
  const dust = Array.from({ length: DUST_N }, (_, i) => ({
    x: Math.random(), y: Math.random(),
    z: 0.25 + Math.random() * 0.75,                    // 景深：越小越远越慢
    r: 2.6 + Math.random() * 6.5,
    sprite: sprites[i % 3],
    phase: Math.random() * Math.PI * 2,
    speed: 0.006 + Math.random() * 0.014,
    alpha: 0.30 + Math.random() * 0.38,
  }));

  function resize() {
    const rect = scene.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    // 绸缎层模糊柔和，低分辨率渲染再放大，兼顾性能与柔感
    const glScale = 0.6;
    glCanvas.width = Math.round(W * glScale);
    glCanvas.height = Math.round(H * glScale);
    const dpr = Math.min(devicePixelRatio || 1, 1.6);
    dustCanvas.width = Math.round(W * dpr);
    dustCanvas.height = Math.round(H * dpr);
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  const t0 = performance.now();
  function frame(now) {
    if (leaving) return;
    if (document.hidden) { rafId = requestAnimationFrame(frame); return; }
    const t = (now - t0) / 1000;
    mx = lerp(mx, tmx, 0.05);
    my = lerp(my, tmy, 0.05);

    if (gl) {
      gl.viewport(0, 0, glCanvas.width, glCanvas.height);
      gl.uniform2f(glLoc.res, glCanvas.width, glCanvas.height);
      gl.uniform1f(glLoc.time, t);
      gl.uniform2f(glLoc.mouse, mx, my);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    dctx.clearRect(0, 0, W, H);
    for (const p of dust) {
      const px = (p.x + Math.sin(t * 0.18 + p.phase) * 0.012) * W + mx * 46 * (1 - p.z);
      const py = ((p.y - t * p.speed) % 1 + 1) % 1 * H + my * 34 * (1 - p.z);
      const size = p.r * p.z * 2.4;
      dctx.globalAlpha = p.alpha * (0.72 + 0.28 * Math.sin(t * 0.9 + p.phase * 3));
      dctx.drawImage(p.sprite, px - size / 2, py - size / 2, size, size);
    }
    dctx.globalAlpha = 1;

    if (!reducedMotion) rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  // ---------------- 进入与退出 ----------------
  // 进入后启动页不销毁，用 visibility 隐藏（display:none 会让 WebView2 丢失 GL 上下文），
  // 顶栏「启动页」按钮可随时经 showStartup() 唤回。
  function leave() {
    if (leaving) return;
    leaving = true;
    cancelAnimationFrame(rafId);
    view.classList.add('leaving');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => view.classList.add('su-hidden'), 700);
  }
  function onKey(e) {
    if (e.key === 'Enter' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) leave();
  }
  enterBtn.addEventListener('click', leave);
  document.addEventListener('keydown', onKey);

  /** 重新展示启动页（顶栏「启动页」按钮）：恢复可见性并重启动效。 */
  showImpl = () => {
    if (!leaving) return;
    leaving = false;
    view.classList.remove('su-hidden');
    void view.offsetWidth;              // 强制 reflow，让移除 leaving 的淡入生效
    view.classList.remove('leaving');
    resize();
    rafId = requestAnimationFrame(frame);
    document.addEventListener('keydown', onKey);
  };
}
