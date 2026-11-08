// B-spline basis functions and evaluation of (rational) B-spline curves and surfaces, after
// Piegl and Tiller, The NURBS Book, algorithms A2.1 and A2.3. Points are evaluated in homogeneous
// coordinates so rational and polynomial splines share the code.

import type { Vec3 } from '../geometry/math.js';

/** Knot vector from STEP's distinct knots and multiplicities. */
export function expandKnots(multiplicities: readonly number[], knots: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < knots.length; i++) for (let k = 0; k < (multiplicities[i] ?? 1); k++) out.push(knots[i]!);
  return out;
}

/**
 * Implicit knot vectors of B_SPLINE_CURVE subtypes without knots (ISO 10303-42): UNIFORM_* ones
 * are -degree, ..., spaced by one; QUASI_UNIFORM_* ones are clamped with uniform interior knots;
 * BEZIER_* ones are piecewise Bezier, each segment over [i, i + 1].
 */
export function implicitKnots(kind: 'uniform' | 'quasi_uniform' | 'bezier', degree: number, count: number): number[] {
  const total = count + degree + 1;
  const out: number[] = [];
  if (kind === 'uniform') {
    for (let i = 0; i < total; i++) out.push(i - degree);
  } else if (kind === 'quasi_uniform') {
    const interior = total - 2 * (degree + 1);
    for (let i = 0; i <= degree; i++) out.push(0);
    for (let i = 1; i <= interior; i++) out.push(i);
    for (let i = 0; i <= degree; i++) out.push(interior + 1);
  } else {
    const segments = Math.max(1, Math.round((count - 1) / Math.max(1, degree)));
    for (let i = 0; i <= degree; i++) out.push(0);
    for (let s = 1; s < segments; s++) for (let i = 0; i < degree; i++) out.push(s);
    for (let i = 0; i <= degree; i++) out.push(segments);
  }
  return out;
}

/** The knot span index i with knots[i] <= t < knots[i + 1], for n + 1 control points. */
export function findSpan(n: number, degree: number, t: number, knots: readonly number[]): number {
  if (t >= knots[n + 1]!) return n;
  if (t <= knots[degree]!) return degree;
  let low = degree, high = n + 1;
  let mid = (low + high) >> 1;
  while (t < knots[mid]! || t >= knots[mid + 1]!) {
    if (t < knots[mid]!) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/** Scratch space for basis evaluation, grown as needed: evaluation is single-threaded. */
let ndu = new Float64Array(64);
let left = new Float64Array(8);
let right = new Float64Array(8);

/**
 * Non-zero basis functions at t and their first derivatives, written to `values` and
 * `derivatives` (p + 1 entries each), without allocating.
 */
export function basisInto(span: number, t: number, degree: number, knots: readonly number[], values: Float64Array, derivatives: Float64Array): void {
  const p = degree, w = p + 1;
  if (ndu.length < w * w) ndu = new Float64Array(w * w * 2);
  if (left.length < w) {
    left = new Float64Array(w * 2);
    right = new Float64Array(w * 2);
  }
  // ndu[j * w + r]: the table of A2.3, basis values above the diagonal, knot differences below.
  ndu[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - knots[span + 1 - j]!;
    right[j] = knots[span + j]! - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const d = right[r + 1]! + left[j - r]!;
      ndu[j * w + r] = d;
      const temp = d !== 0 ? ndu[r * w + j - 1]! / d : 0;
      ndu[r * w + j] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    ndu[j * w + j] = saved;
  }
  for (let j = 0; j <= p; j++) values[j] = ndu[j * w + p]!;
  if (p === 0) {
    derivatives[0] = 0;
    return;
  }
  // N'_{r,p} = p (N_{r,p-1} / (u_{r+p} - u_r) - N_{r+1,p-1} / (u_{r+p+1} - u_{r+1})).
  for (let r = 0; r <= p; r++) {
    let d = 0;
    if (r >= 1) {
      const den = ndu[p * w + r - 1]!;
      if (den !== 0) d += ndu[(r - 1) * w + p - 1]! / den;
    }
    if (r <= p - 1) {
      const den = ndu[p * w + r]!;
      if (den !== 0) d -= ndu[r * w + p - 1]! / den;
    }
    derivatives[r] = d * p;
  }
}

/** Non-zero basis functions at t and their first derivatives: [values, derivatives]. */
export function basisWithDerivative(span: number, t: number, degree: number, knots: readonly number[]): [Float64Array, Float64Array] {
  const values = new Float64Array(degree + 1), derivatives = new Float64Array(degree + 1);
  basisInto(span, t, degree, knots, values, derivatives);
  return [values, derivatives];
}

/** A (rational) B-spline curve over [knots[degree], knots[n + 1]]. */
export class BSplineCurveData {
  readonly n: number;
  readonly t0: number;
  readonly t1: number;
  constructor(
    readonly degree: number,
    readonly points: readonly Vec3[],
    readonly knots: readonly number[],
    readonly weights: readonly number[] | null,
  ) {
    this.n = points.length - 1;
    this.t0 = knots[degree]!;
    this.t1 = knots[this.n + 1]!;
    this.bufferN = new Float64Array(degree + 1);
    this.bufferD = new Float64Array(degree + 1);
  }
  private readonly bufferN: Float64Array;
  private readonly bufferD: Float64Array;

  /** Point and first derivative at t. */
  evaluate(t: number): [Vec3, Vec3] {
    const p = this.degree;
    const span = findSpan(this.n, p, t, this.knots);
    const N = this.bufferN, dN = this.bufferD;
    basisInto(span, t, p, this.knots, N, dN);
    let x = 0, y = 0, z = 0, w = 0, dx = 0, dy = 0, dz = 0, dw = 0;
    for (let j = 0; j <= p; j++) {
      const i = span - p + j;
      const cp = this.points[i]!;
      const wi = this.weights ? this.weights[i]! : 1;
      const a = N[j]! * wi, b = dN[j]! * wi;
      x += a * cp[0]; y += a * cp[1]; z += a * cp[2]; w += a;
      dx += b * cp[0]; dy += b * cp[1]; dz += b * cp[2]; dw += b;
    }
    if (w === 0) w = 1;
    const px = x / w, py = y / w, pz = z / w;
    return [[px, py, pz], [(dx - dw * px) / w, (dy - dw * py) / w, (dz - dw * pz) / w]];
  }

  /** Distinct knots inside the range, for starting adaptive sampling at the curve's joints. */
  breaks(): number[] {
    const out: number[] = [];
    for (let i = this.degree; i <= this.n + 1; i++) {
      const k = this.knots[i]!;
      if (out.length === 0 || k > out[out.length - 1]!) out.push(k);
    }
    return out;
  }
}

/** A (rational) B-spline surface; points[i][j] runs along u with i and along v with j. */
export class BSplineSurfaceData {
  readonly nu: number;
  readonly nv: number;
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  constructor(
    readonly uDegree: number,
    readonly vDegree: number,
    readonly points: readonly (readonly Vec3[])[],
    readonly uKnots: readonly number[],
    readonly vKnots: readonly number[],
    readonly weights: readonly (readonly number[])[] | null,
  ) {
    this.nu = points.length - 1;
    this.nv = (points[0]?.length ?? 1) - 1;
    this.u0 = uKnots[uDegree]!;
    this.u1 = uKnots[this.nu + 1]!;
    this.v0 = vKnots[vDegree]!;
    this.v1 = vKnots[this.nv + 1]!;
    this.bufferNu = new Float64Array(uDegree + 1);
    this.bufferDu = new Float64Array(uDegree + 1);
    this.bufferNv = new Float64Array(vDegree + 1);
    this.bufferDv = new Float64Array(vDegree + 1);
  }
  private readonly bufferNu: Float64Array;
  private readonly bufferDu: Float64Array;
  private readonly bufferNv: Float64Array;
  private readonly bufferDv: Float64Array;

  /** Point and first partial derivatives at (u, v). */
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const p = this.uDegree, q = this.vDegree;
    const su = findSpan(this.nu, p, u, this.uKnots);
    const sv = findSpan(this.nv, q, v, this.vKnots);
    const Nu = this.bufferNu, dNu = this.bufferDu, Nv = this.bufferNv, dNv = this.bufferDv;
    basisInto(su, u, p, this.uKnots, Nu, dNu);
    basisInto(sv, v, q, this.vKnots, Nv, dNv);
    // Homogeneous sums: S = A / w, S_u = (A_u - w_u S) / w.
    let x = 0, y = 0, z = 0, w = 0;
    let ux = 0, uy = 0, uz = 0, uw = 0;
    let vx = 0, vy = 0, vz = 0, vw = 0;
    for (let a = 0; a <= p; a++) {
      const i = su - p + a;
      const row = this.points[i]!;
      const wrow = this.weights ? this.weights[i]! : null;
      for (let b = 0; b <= q; b++) {
        const j = sv - q + b;
        const cp = row[j]!;
        const wij = wrow ? wrow[j]! : 1;
        const n = Nu[a]! * Nv[b]! * wij, nu = dNu[a]! * Nv[b]! * wij, nv = Nu[a]! * dNv[b]! * wij;
        x += n * cp[0]; y += n * cp[1]; z += n * cp[2]; w += n;
        ux += nu * cp[0]; uy += nu * cp[1]; uz += nu * cp[2]; uw += nu;
        vx += nv * cp[0]; vy += nv * cp[1]; vz += nv * cp[2]; vw += nv;
      }
    }
    if (w === 0) w = 1;
    const px = x / w, py = y / w, pz = z / w;
    return [
      [px, py, pz],
      [(ux - uw * px) / w, (uy - uw * py) / w, (uz - uw * pz) / w],
      [(vx - vw * px) / w, (vy - vw * py) / w, (vz - vw * pz) / w],
    ];
  }

  /** Distinct knots in u or v within the domain. */
  breaks(direction: 'u' | 'v'): number[] {
    const knots = direction === 'u' ? this.uKnots : this.vKnots;
    const degree = direction === 'u' ? this.uDegree : this.vDegree;
    const n = direction === 'u' ? this.nu : this.nv;
    const out: number[] = [];
    for (let i = degree; i <= n + 1; i++) {
      const k = knots[i]!;
      if (out.length === 0 || k > out[out.length - 1]!) out.push(k);
    }
    return out;
  }
}
