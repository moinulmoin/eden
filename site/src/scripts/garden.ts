import fragment from "../shaders/garden.glsl?raw";

const VERTEX = "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }";
const PAPER = [245, 245, 243];
const INK = [17, 17, 17];
const SUN = [244, 129, 32];

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const mobile = window.matchMedia("(max-width: 900px)");

type Garden = {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  gl: WebGLRenderingContext;
  uniforms: Record<string, WebGLUniformLocation | null>;
  visible: boolean;
  mouse: [number, number];
  follow: number;
  followTarget: number;
};

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn(gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

function setup(canvas: HTMLCanvasElement): Garden | null {
  const host = canvas.closest<HTMLElement>("[data-garden-host]") ?? canvas.parentElement!;
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vertex || !frag) return null;

  const program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const names = [
    "u_resolution", "u_time", "u_mouse", "u_follow", "u_pixel", "u_dpr",
    "u_sunX", "u_sunY", "u_sunR", "u_paper", "u_ink", "u_sun",
  ];
  const uniforms = Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
  const rgb = (c: number[]) => c.map((v) => v / 255) as [number, number, number];
  gl.uniform3f(uniforms.u_paper!, ...rgb(PAPER));
  gl.uniform3f(uniforms.u_ink!, ...rgb(INK));
  gl.uniform3f(uniforms.u_sun!, ...rgb(SUN));

  canvas.dataset.ready = "true";
  return { canvas, host, gl, uniforms, visible: true, mouse: [0, 0], follow: 0, followTarget: 0 };
}

function sunParams(canvas: HTMLCanvasElement) {
  const d = canvas.dataset;
  const pick = (desktop?: string, phone?: string) => Number(mobile.matches && phone ? phone : desktop);
  return {
    x: pick(d.sunX, d.mobileSunX),
    y: pick(d.sunY, d.mobileSunY),
    r: pick(d.sunR, d.mobileSunR),
  };
}

function resize(g: Garden) {
  const { gl, uniforms, canvas } = g;
  const pixel = Number(canvas.dataset.pixel ?? 6) - (mobile.matches ? 1 : 0);
  // One texel per pixel-art cell; CSS scales it up with image-rendering: pixelated.
  const scale = 1 / pixel;
  const width = Math.max(1, Math.ceil(canvas.clientWidth * scale));
  const height = Math.max(1, Math.ceil(canvas.clientHeight * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  gl.uniform2f(uniforms.u_resolution!, width, height);
  gl.uniform1f(uniforms.u_dpr!, scale);
  gl.uniform1f(uniforms.u_pixel!, pixel);
  const sun = sunParams(canvas);
  gl.uniform1f(uniforms.u_sunX!, sun.x);
  gl.uniform1f(uniforms.u_sunY!, sun.y);
  gl.uniform1f(uniforms.u_sunR!, sun.r);
}

function draw(g: Garden, time: number) {
  const { gl, uniforms } = g;
  g.follow += (g.followTarget - g.follow) * 0.06;
  gl.uniform1f(uniforms.u_time!, time);
  gl.uniform2f(uniforms.u_mouse!, g.mouse[0], g.mouse[1]);
  gl.uniform1f(uniforms.u_follow!, g.follow);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const gardens = [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-garden]")]
  .map(setup)
  .filter((g): g is Garden => g !== null);

const STILL_FRAME = 14;
const start = performance.now();

function renderAll(now: number) {
  const time = reducedMotion.matches ? STILL_FRAME : STILL_FRAME + (now - start) / 1000;
  for (const g of gardens) if (g.visible) draw(g, time);
}

let frame = 0;
function loop(now: number) {
  renderAll(now);
  frame = gardens.some((g) => g.visible) && !reducedMotion.matches ? requestAnimationFrame(loop) : 0;
}

function kick() {
  if (reducedMotion.matches) {
    renderAll(performance.now());
    return;
  }
  if (!frame) frame = requestAnimationFrame(loop);
}

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const g = gardens.find((item) => item.canvas === entry.target);
    if (g) g.visible = entry.isIntersecting;
  }
  kick();
});

for (const g of gardens) {
  resize(g);
  new ResizeObserver(() => {
    resize(g);
    if (reducedMotion.matches) renderAll(performance.now());
  }).observe(g.canvas);
  observer.observe(g.canvas);

  g.host.addEventListener("pointermove", (event) => {
    const rect = g.canvas.getBoundingClientRect();
    g.mouse = [event.clientX - rect.left, rect.height - (event.clientY - rect.top)];
    g.followTarget = event.pointerType === "mouse" ? 1 : 0;
  });
  g.host.addEventListener("pointerleave", () => {
    g.followTarget = 0;
  });
}

reducedMotion.addEventListener("change", kick);
mobile.addEventListener("change", () => gardens.forEach(resize));
kick();
