// Tekutá „skleněná“ plocha – WebGL shader (s jednoduchou 2D zálohou).
// Čistý abstraktní tvar: zaoblený čtverec s měkce vlnícím se okrajem, uvnitř
// pomalu se přelévající světlo, teplý odlesk a tmavá kapsa s duhovým lomem.
// Hlasitost (mikrofon, předčítání, přicházející text) zrychluje a zesiluje pohyb.

const VERT = `
attribute vec2 a;
varying vec2 vUv;
void main() { vUv = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uLevel;
varying vec2 vUv;

vec2 hash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash(i), f), dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  float s = min(uRes.x, uRes.y);
  vec2 p = (vUv * uRes - 0.5 * uRes) / s;
  float t = uTime;
  float L = uLevel;

  // --- tvar: zaoblený čtverec s měkce vlnícím se okrajem
  vec2 halfSize = 0.5 * uRes / s - 0.045;
  float ang = atan(p.y, p.x);
  float wob = sin(ang * 2.0 + t * 0.7) * 0.45 + sin(ang * 3.0 - t * 1.05 + 1.3) * 0.3
            + sin(ang * 5.0 + t * 1.6 + 0.4) * 0.12 + noise(vec2(ang * 1.3, t * 0.35)) * 0.55;
  float d = sdRoundBox(p, halfSize, 0.17) - wob * (0.012 + L * 0.035);
  float aa = 1.6 / s;
  float mask = 1.0 - smoothstep(-aa, aa, d);
  if (mask <= 0.0) { gl_FragColor = vec4(0.0); return; }

  // --- tekuté pokřivení prostoru
  vec2 q = p + 0.07 * vec2(noise(p * 1.6 + vec2(0.0, t * 0.22)), noise(p * 1.6 + vec2(5.2, -t * 0.2)));
  q += (0.02 + 0.05 * L) * vec2(noise(p * 3.5 + t * 0.8), noise(p * 3.5 - t * 0.8));
  vec2 n = q / (halfSize * 2.0);          // zhruba -0.5 .. 0.5, y nahoru

  // --- základ: šedá vlevo nahoře, temně modrá vpravo
  vec3 gray = vec3(0.34, 0.35, 0.39);
  vec3 navy = vec3(0.11, 0.12, 0.21);
  vec3 col = mix(gray, navy, smoothstep(-0.2, 0.45, n.x + 0.3 * n.y + 0.06 * sin(t * 0.3)));
  col = mix(col, vec3(0.6, 0.61, 0.66), smoothstep(0.15, 0.55, -n.x - 0.2 * n.y) * 0.45);
  col *= mix(1.0, 0.8, smoothstep(0.1, 0.5, n.y));

  // --- velká měkká bílá záře (vlevo dole / uprostřed)
  vec2 gp = vec2(-0.17 + 0.07 * sin(t * 0.31), -0.2 + 0.06 * cos(t * 0.23));
  vec2 gd = rot(-0.7 + 0.15 * sin(t * 0.2)) * (n - gp);
  gd *= vec2(0.9, 2.0);
  float glow = exp(-dot(gd, gd) / (0.042 + 0.02 * L));
  col = mix(col, vec3(0.97, 0.975, 0.99), glow * 0.9);

  // --- teplý odlesk vpravo nahoře
  vec2 wp = vec2(0.2 + 0.05 * sin(t * 0.47), 0.32 + 0.04 * cos(t * 0.59));
  vec2 wd = (n - wp) * vec2(1.0, 1.9);
  float warm = exp(-dot(wd, wd) / (0.0045 + 0.005 * L));
  col += vec3(0.82, 0.6, 0.32) * warm * (0.5 + 0.6 * L);

  // --- tmavá kapsa vlevo dole s duhovým lomem
  vec2 pc = vec2(-0.21 + 0.05 * sin(t * 0.41), -0.42 + 0.025 * cos(t * 0.53));
  vec2 pd = (n - pc) * vec2(0.76, 1.1);
  float pa = atan(pd.y, pd.x);
  float pr = length(pd) - (0.18 + 0.045 * L)
           - 0.03 * noise(vec2(pa * 1.7, t * 0.5)) - 0.012 * sin(pa * 3.0 + t * 0.9);
  float side = 0.45 + 0.55 * max(0.0, dot(normalize(pd + 1e-5), normalize(vec2(-0.55, 0.85))));
  float bw = 0.013;
  col += vec3(1.0, 0.22, 0.08) * exp(-pow((pr - 0.034) / bw, 2.0)) * 0.85 * side;
  col += vec3(1.0, 0.8, 0.3) * exp(-pow((pr - 0.021) / bw, 2.0)) * 0.55 * side;
  col += vec3(1.0) * exp(-pow((pr - 0.01) / (bw * 0.9), 2.0)) * 0.75 * side;
  col += vec3(0.25, 0.55, 1.0) * exp(-pow((pr + 0.002) / bw, 2.0)) * 0.85;
  float inside = smoothstep(0.004, -0.03, pr);
  vec3 dark = mix(vec3(0.025, 0.03, 0.055), vec3(0.16, 0.17, 0.26), smoothstep(-0.16, 0.0, pr));
  col = mix(col, dark, inside);

  // --- jemné světlo podél okraje (sklo), bez obrysu
  float edge = exp(-pow(d / 0.025, 2.0));
  col += vec3(1.0) * edge * (0.06 + 0.14 * smoothstep(0.3, -0.6, n.x + n.y));

  gl_FragColor = vec4(col * mask, mask);
}
`;

function createGL(canvas, dpr) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  try {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const bufObj = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufObj);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uLevel = gl.getUniformLocation(prog, 'uLevel');
    gl.clearColor(0, 0, 0, 0);
    return (t, level) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uRes, canvas.width / dpr(), canvas.height / dpr());
      gl.uniform1f(uTime, t);
      gl.uniform1f(uLevel, level);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
  } catch (e) {
    console.warn('WebGL plocha nejde, používám 2D:', e);
    return null;
  }
}

// Záloha bez WebGL: jednodušší měkké přechody v canvasu 2D.
function create2D(canvas, dpr) {
  const ctx = canvas.getContext('2d');
  return (t, level) => {
    const k = dpr();
    const w = canvas.width / k;
    const h = canvas.height / k;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const path = new Path2D();
    const r = Math.min(w, h) * 0.17;
    const m = Math.min(w, h) * 0.045;
    path.roundRect(m, m, w - 2 * m, h - 2 * m, r);
    ctx.save();
    ctx.clip(path);
    let g = ctx.createLinearGradient(0, 0, w, h * 0.7);
    g.addColorStop(0, '#5a5c66');
    g.addColorStop(0.55, '#2a2c40');
    g.addColorStop(1, '#1c1e36');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const glow = (x, y, rad, c) => {
      const gg = ctx.createRadialGradient(x, y, 0, x, y, rad);
      gg.addColorStop(0, c);
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gg;
      ctx.fillRect(0, 0, w, h);
    };
    glow(w * (0.42 + 0.06 * Math.sin(t * 0.3)), h * 0.66, w * (0.42 + level * 0.1), 'rgba(250,250,253,.95)');
    glow(w * 0.72, h * 0.18, w * (0.1 + level * 0.06), `rgba(220,160,90,${0.5 + level * 0.4})`);
    ctx.restore();
  };
}

export function createBlob(canvas) {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const dpr = () => Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr()));
    canvas.height = Math.max(1, Math.round(r.height * dpr()));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();
  const render = createGL(canvas, dpr) || create2D(canvas, dpr);

  let level = 0;
  let pulse = 0;
  let mode = 'idle';
  let clock = Math.random() * 100;
  let last = performance.now();
  let analyser = null;
  let buf = null;
  let micStream = null;
  let micCtx = null;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let input = 0;
    if (analyser) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      input = Math.min(1, Math.sqrt(sum / buf.length) * 7);
    }
    const tt = now / 1000;
    if (mode === 'speaking') input = Math.max(input, 0.25 + 0.3 * Math.abs(Math.sin(tt * 7.3) * Math.sin(tt * 2.9)));
    if (mode === 'working') input = Math.max(input, 0.12 + 0.08 * Math.sin(tt * 2.2));
    if (mode === 'listening') input = Math.max(input, 0.15);
    input = Math.max(input, pulse);
    pulse *= 0.9;
    level += (input - level) * (input > level ? 0.25 : 0.045);
    clock += dt * (1 + level * 3.2);
    render(clock, level);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    setMode(m) { mode = m; },
    pulse(v = 0.4) { pulse = Math.max(pulse, Math.min(1, v)); },
    async attachMic() {
      if (analyser || !navigator.mediaDevices?.getUserMedia) return;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        micCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = micCtx.createMediaStreamSource(micStream);
        const an = micCtx.createAnalyser();
        an.fftSize = 1024;
        src.connect(an);
        buf = new Float32Array(an.fftSize);
        analyser = an;
      } catch { /* bez mikrofonu se plocha hýbe podle událostí */ }
    },
    detachMic() {
      analyser = null;
      micStream?.getTracks().forEach(tr => tr.stop());
      micCtx?.close().catch(() => {});
      micStream = null;
      micCtx = null;
    },
  };
}
