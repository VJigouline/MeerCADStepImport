// Small double-precision vector and matrix helpers. Matrices are 4 x 4, column-major, as in
// three.js, so they can be copied into a three.js Matrix4 unchanged.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Mat4 = Float64Array;

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Matrix whose columns are the given axes and origin. */
export function fromAxes(x: Vec3, y: Vec3, z: Vec3, origin: Vec3): Mat4 {
  const m = new Float64Array(16);
  m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
  m[4] = y[0]; m[5] = y[1]; m[6] = y[2];
  m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
  m[12] = origin[0]; m[13] = origin[1]; m[14] = origin[2]; m[15] = 1;
  return m;
}

export function translation(t: Vec3): Mat4 {
  const m = identity();
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

/** a * b: applies b first, then a. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = a[row]! * b[col * 4]! + a[4 + row]! * b[col * 4 + 1]! + a[8 + row]! * b[col * 4 + 2]! + a[12 + row]! * b[col * 4 + 3]!;
    }
  }
  return out;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

export function transformDirection(m: Mat4, d: Vec3): Vec3 {
  return [
    m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2],
    m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2],
    m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2],
  ];
}

export function determinant3(m: Mat4): number {
  return m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
}

/** Inverse of an affine matrix. */
export function invert(m: Mat4): Mat4 {
  const a = m[0]!, b = m[4]!, c = m[8]!, d = m[1]!, e = m[5]!, f = m[9]!, g = m[2]!, h = m[6]!, i = m[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = det !== 0 ? 1 / det : 0;
  const out = new Float64Array(16);
  out[0] = A * s; out[4] = -(b * i - c * h) * s; out[8] = (b * f - c * e) * s;
  out[1] = B * s; out[5] = (a * i - c * g) * s; out[9] = -(a * f - c * d) * s;
  out[2] = C * s; out[6] = -(a * h - b * g) * s; out[10] = (a * e - b * d) * s;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  out[12] = -(out[0]! * tx + out[4]! * ty + out[8]! * tz);
  out[13] = -(out[1]! * tx + out[5]! * ty + out[9]! * tz);
  out[14] = -(out[2]! * tx + out[6]! * ty + out[10]! * tz);
  out[15] = 1;
  return out;
}

export function isIdentity(m: Mat4, eps = 1e-12): boolean {
  const id = identity();
  for (let i = 0; i < 16; i++) if (Math.abs(m[i]! - id[i]!) > eps) return false;
  return true;
}

/** A unit vector perpendicular to n. */
export function perpendicular(n: Vec3): Vec3 {
  return Math.abs(n[0]) < 0.9 ? normalize(cross(n, [1, 0, 0])) : normalize(cross(n, [0, 1, 0]));
}
