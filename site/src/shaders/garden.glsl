precision highp float;

uniform vec2 u_resolution;

uniform float u_time;

uniform vec2 u_mouse;
uniform float u_follow;

uniform float u_pixel;

uniform float u_dpr;

uniform float u_sunX;

uniform float u_sunY;

uniform float u_sunR;

uniform vec3 u_paper;

uniform vec3 u_ink;

uniform vec3 u_sun;

float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }

float ridge(float x, float base, float a1, float f1, float p1, float a2, float f2, float p2) {
  return base + a1 * sin(x * f1 + p1) + a2 * sin(x * f2 + p2);
}

void main() {
  vec2 res = u_resolution / u_dpr;
  vec2 cell = floor(gl_FragCoord.xy / u_dpr / u_pixel);
  vec2 p = (cell + 0.5) * u_pixel;
  vec2 uv = p / res;
  float t = u_time;
  float th = bayer8(cell);

  vec3 col = u_paper;

  vec2 sc = vec2(
    mix(u_sunX * res.x, u_mouse.x, 0.18 * u_follow),
    (u_sunY + 0.02 * sin(t * 0.35)) * res.y
  );
  float R = u_sunR * res.y;
  float d = length(p - sc);

  float glow = (1.0 - smoothstep(R, R * 1.7, d)) * 0.22;
  if (glow > th) col = u_sun;

  float below = (sc.y - p.y) / R;
  float bandH = R * 0.17;
  float band = mod(p.y + t * 12.0, bandH) / bandH;
  float gapW = clamp(below, 0.0, 1.0) * 0.6;
  bool sliced = below > 0.08 && band < gapW;
  float core = mix(1.0, 0.62, clamp(d / R, 0.0, 1.0));
  if (d < R && !sliced && core > th * 0.85) col = u_sun;

  float x = p.x;
  float h1 = ridge(x, 0.40, 0.07, 0.0035, 1.3 + t * 0.05, 0.025, 0.012, t * 0.09);
  float h2 = ridge(x, 0.27, 0.06, 0.0029, 4.0 - t * 0.04, 0.02, 0.017, 2.0);
  float h3 = ridge(x, 0.13, 0.045, 0.0024, 2.2 + t * 0.03, 0.015, 0.023, 5.0);

  float tone = -1.0;
  if (uv.y < h1) tone = 0.3 + 0.2 * smoothstep(h1, h1 - 0.12, uv.y);
  if (uv.y < h2) tone = 0.62 + 0.2 * smoothstep(h2, h2 - 0.1, uv.y);
  if (uv.y < h3) tone = 1.1;
  if (tone >= 0.0) col = tone > th ? u_ink : u_paper;

  for (int i = 0; i < 22; i++) {
    float fi = float(i);
    float speed = 16.0 + 34.0 * hash(fi + 3.0);
    float span = res.y * 0.95;
    float y = mod(hash(fi + 7.0) * span + t * speed, span);
    float xx = hash(fi) * res.x + 12.0 * sin(t * 0.7 + fi * 1.7);
    vec2 q = (floor(vec2(xx, y) / u_pixel) + 0.5) * u_pixel;
    float blink = step(0.25, fract(t * (0.3 + hash(fi + 11.0)) + hash(fi + 5.0)));
    if (blink > 0.5 && length(p - q) < u_pixel * 0.5) col = u_sun;
  }

  gl_FragColor = vec4(col, 1.0);
}
