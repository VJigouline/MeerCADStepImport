// Surfaces of ISO 10303-42 as evaluators with derivatives and point projection (the inverse
// mapping from 3D points to (u, v)), which trimmed face tessellation needs.

import { add, cross, dot, length, normalize, scale, sub, type Vec2, type Vec3 } from '../geometry/math.js';
import { BSplineSurfaceData } from './bspline.js';
import type { Curve } from './curves.js';

/** Axes of a placement: origin and a right-handed orthonormal frame. */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export interface Surface {
  /** Parameter domain; infinite where the surface is unbounded. */
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  readonly uPeriod: number | null;
  readonly vPeriod: number | null;
  /** Flat: no interior points are needed to tessellate it. */
  readonly planar: boolean;
  /** Point and first partial derivatives. The surface normal is du x dv. */
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3];
  /** (u, v) of the point on the surface nearest p, starting from a hint if given. */
  project(p: Vec3, hint?: Vec2): Vec2;
  /** Parameter values where the surface has a pole in v, where u is undefined (sphere, cone apex). */
  readonly poles?: { v0?: boolean; v1?: boolean; vApex?: number };
}

export function local(frame: Frame, p: Vec3): Vec3 {
  const d = sub(p, frame.origin);
  return [dot(d, frame.x), dot(d, frame.y), dot(d, frame.z)];
}

function at(frame: Frame, x: number, y: number, z: number): Vec3 {
  const o = frame.origin, a = frame.x, b = frame.y, c = frame.z;
  return [o[0] + x * a[0] + y * b[0] + z * c[0], o[1] + x * a[1] + y * b[1] + z * c[1], o[2] + x * a[2] + y * b[2] + z * c[2]];
}

function dir(frame: Frame, x: number, y: number, z: number): Vec3 {
  const a = frame.x, b = frame.y, c = frame.z;
  return [x * a[0] + y * b[0] + z * c[0], x * a[1] + y * b[1] + z * c[1], x * a[2] + y * b[2] + z * c[2]];
}

/** Moves a periodic parameter next to a reference value. */
export function nearPeriod(t: number, reference: number, period: number | null): number {
  if (period === null) return t;
  return t + period * Math.round((reference - t) / period);
}

/**
 * Gauss-Newton projection: solves J^T J d = J^T (p - S) for the (u, v) step. Points on the surface
 * have zero residual, so this converges quadratically for the boundary points it's used for.
 */
export function refine(surface: Surface, p: Vec3, start: Vec2, iterations = 30): Vec2 {
  let u = start[0], v = start[1];
  const clampU = (x: number) => (surface.uPeriod !== null ? x : Math.min(surface.u1, Math.max(surface.u0, x)));
  const clampV = (x: number) => (surface.vPeriod !== null ? x : Math.min(surface.v1, Math.max(surface.v0, x)));
  let [s] = surface.evaluate(u, v);
  let error = length(sub(p, s));
  for (let i = 0; i < iterations; i++) {
    const [point, du, dv] = surface.evaluate(u, v);
    const r = sub(p, point);
    const a11 = dot(du, du), a12 = dot(du, dv), a22 = dot(dv, dv);
    const b1 = dot(du, r), b2 = dot(dv, r);
    let det = a11 * a22 - a12 * a12;
    let su: number, sv: number;
    if (Math.abs(det) > 1e-30 * (a11 * a22 + 1e-300)) {
      su = (b1 * a22 - b2 * a12) / det;
      sv = (a11 * b2 - a12 * b1) / det;
    } else {
      // Singular, as at a pole: step along whichever direction moves the point.
      det = 0;
      su = a11 > 0 ? b1 / a11 : 0;
      sv = a22 > 0 ? b2 / a22 : 0;
    }
    // Halve the step until it improves the fit.
    let step = 1, accepted = false;
    for (let k = 0; k < 8; k++) {
      const nu = clampU(u + su * step), nv = clampV(v + sv * step);
      [s] = surface.evaluate(nu, nv);
      const e = length(sub(p, s));
      if (e <= error) {
        const moved = Math.abs(nu - u) + Math.abs(nv - v);
        u = nu;
        v = nv;
        error = e;
        accepted = true;
        if (moved < 1e-14 * (1 + Math.abs(u) + Math.abs(v))) return [u, v];
        break;
      }
      step /= 2;
    }
    if (!accepted) break;
  }
  return [u, v];
}

export class PlaneSurface implements Surface {
  readonly u0 = -Infinity;
  readonly u1 = Infinity;
  readonly v0 = -Infinity;
  readonly v1 = Infinity;
  readonly uPeriod = null;
  readonly vPeriod = null;
  readonly planar = true;
  constructor(readonly frame: Frame) {}
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    return [at(this.frame, u, v, 0), this.frame.x, this.frame.y];
  }
  project(p: Vec3): Vec2 {
    const l = local(this.frame, p);
    return [l[0], l[1]];
  }
}

export class CylinderSurface implements Surface {
  readonly u0 = 0;
  readonly u1 = 2 * Math.PI;
  readonly v0 = -Infinity;
  readonly v1 = Infinity;
  readonly uPeriod = 2 * Math.PI;
  readonly vPeriod = null;
  readonly planar = false;
  constructor(readonly frame: Frame, readonly radius: number) {}
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const c = Math.cos(u), s = Math.sin(u), r = this.radius;
    return [at(this.frame, r * c, r * s, v), dir(this.frame, -r * s, r * c, 0), this.frame.z];
  }
  project(p: Vec3, hint?: Vec2): Vec2 {
    const l = local(this.frame, p);
    return [nearPeriod(Math.atan2(l[1], l[0]), hint?.[0] ?? 0, this.uPeriod), l[2]];
  }
}

/** Cone: centre + (R + v tan a)(cos u x + sin u y) + v z, with v the distance along the axis. */
export class ConeSurface implements Surface {
  readonly u0 = 0;
  readonly u1 = 2 * Math.PI;
  readonly v0 = -Infinity;
  readonly v1 = Infinity;
  readonly uPeriod = 2 * Math.PI;
  readonly vPeriod = null;
  readonly planar = false;
  readonly poles: { vApex?: number };
  private readonly tan: number;
  constructor(readonly frame: Frame, readonly radius: number, semiAngle: number) {
    this.tan = Math.tan(semiAngle);
    this.poles = this.tan !== 0 ? { vApex: -radius / this.tan } : {};
  }
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const c = Math.cos(u), s = Math.sin(u), r = this.radius + v * this.tan;
    return [at(this.frame, r * c, r * s, v), dir(this.frame, -r * s, r * c, 0), dir(this.frame, this.tan * c, this.tan * s, 1)];
  }
  project(p: Vec3, hint?: Vec2): Vec2 {
    const l = local(this.frame, p);
    const rho = Math.hypot(l[0], l[1]);
    // Nearest point on a generator line in the plane through the axis and the point. Beyond the
    // apex the radius R + v tan is negative, so a point on that nappe lies on the generator at
    // the opposite angle: try both and keep the nearer.
    const angle = Math.atan2(l[1], l[0]);
    const k = 1 + this.tan * this.tan;
    let best: Vec2 = [angle, 0];
    let bestDistance = Infinity;
    for (const side of [1, -1]) {
      const signed = side * rho;
      const v = (l[2] + (signed - this.radius) * this.tan) / k;
      const r = this.radius + v * this.tan;
      const distance = Math.hypot(signed - r, l[2] - v);
      if (distance < bestDistance - 1e-12) {
        bestDistance = distance;
        best = [side > 0 ? angle : angle + Math.PI, v];
      }
    }
    return [nearPeriod(best[0], hint?.[0] ?? 0, this.uPeriod), best[1]];
  }
}

/** Sphere: centre + r cos v (cos u x + sin u y) + r sin v z, v in [-π/2, π/2]. */
export class SphereSurface implements Surface {
  readonly u0 = 0;
  readonly u1 = 2 * Math.PI;
  readonly v0 = -Math.PI / 2;
  readonly v1 = Math.PI / 2;
  readonly uPeriod = 2 * Math.PI;
  readonly vPeriod = null;
  readonly planar = false;
  readonly poles = { v0: true, v1: true };
  constructor(readonly frame: Frame, readonly radius: number) {}
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v), r = this.radius;
    return [
      at(this.frame, r * cv * cu, r * cv * su, r * sv),
      dir(this.frame, -r * cv * su, r * cv * cu, 0),
      dir(this.frame, -r * sv * cu, -r * sv * su, r * cv),
    ];
  }
  project(p: Vec3, hint?: Vec2): Vec2 {
    const l = local(this.frame, p);
    const rho = Math.hypot(l[0], l[1]);
    return [nearPeriod(Math.atan2(l[1], l[0]), hint?.[0] ?? 0, this.uPeriod), Math.atan2(l[2], rho)];
  }
}

/** Torus: centre + (R + r cos v)(cos u x + sin u y) + r sin v z. */
export class TorusSurface implements Surface {
  readonly u0 = 0;
  readonly u1 = 2 * Math.PI;
  readonly v0 = 0;
  readonly v1 = 2 * Math.PI;
  readonly uPeriod = 2 * Math.PI;
  readonly vPeriod = 2 * Math.PI;
  readonly planar = false;
  constructor(readonly frame: Frame, readonly major: number, readonly minor: number) {}
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
    const R = this.major, r = this.minor, rho = R + r * cv;
    return [
      at(this.frame, rho * cu, rho * su, r * sv),
      dir(this.frame, -rho * su, rho * cu, 0),
      dir(this.frame, -r * sv * cu, -r * sv * su, r * cv),
    ];
  }
  project(p: Vec3, hint?: Vec2): Vec2 {
    const l = local(this.frame, p);
    const angle = Math.atan2(l[1], l[0]);
    const rho = Math.hypot(l[0], l[1]);
    // Nearest point on a meridian circle in the plane through the axis and the point. When the
    // minor radius is larger than the major one (a spindle torus), the circle crosses the axis
    // and R + r cos v goes negative: a point there lies on the meridian at the opposite angle.
    // Try both and keep the nearer.
    let best: Vec2 = [angle, Math.atan2(l[2], rho - this.major)];
    let bestDistance = Infinity;
    for (const side of [1, -1]) {
      const signed = side * rho;
      const v = Math.atan2(l[2], signed - this.major);
      const distance = Math.abs(Math.hypot(signed - this.major, l[2]) - this.minor);
      if (distance < bestDistance - 1e-12) {
        bestDistance = distance;
        best = [side > 0 ? angle : angle + Math.PI, v];
      }
      if (this.minor <= this.major) break;
    }
    return [nearPeriod(best[0], hint?.[0] ?? 0, this.uPeriod), nearPeriod(best[1], hint?.[1] ?? 0, this.vPeriod)];
  }
}

/**
 * Surfaces without a closed-form inverse: projection starts from the nearest point of a sample
 * grid, or from the hint when that is close, and is refined by Gauss-Newton.
 */
abstract class NumericSurface implements Surface {
  abstract readonly u0: number;
  abstract readonly u1: number;
  abstract readonly v0: number;
  abstract readonly v1: number;
  uPeriod: number | null = null;
  vPeriod: number | null = null;
  readonly planar: boolean = false;
  private grid: { u: number; v: number; p: Vec3 }[] | null = null;
  abstract evaluate(u: number, v: number): [Vec3, Vec3, Vec3];
  protected abstract gridParameters(): [number[], number[]];

  protected detectPeriods(): void {
    const close = (a: Vec3, b: Vec3, size: number) => length(sub(a, b)) <= size * 1e-7;
    const size = this.size();
    let uClosed = true, vClosed = true;
    for (let i = 0; i <= 4; i++) {
      const v = this.v0 + ((this.v1 - this.v0) * i) / 4, u = this.u0 + ((this.u1 - this.u0) * i) / 4;
      if (!close(this.evaluate(this.u0, v)[0], this.evaluate(this.u1, v)[0], size)) uClosed = false;
      if (!close(this.evaluate(u, this.v0)[0], this.evaluate(u, this.v1)[0], size)) vClosed = false;
    }
    if (uClosed) this.uPeriod = this.u1 - this.u0;
    if (vClosed) this.vPeriod = this.v1 - this.v0;
  }

  private sizeCache = 0;

  /** About how big the surface is, from a 5 x 5 grid of its points. Measured once. */
  protected size(): number {
    if (this.sizeCache > 0) return this.sizeCache;
    const a = this.evaluate(this.u0, this.v0)[0];
    let s = 0;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const p = this.evaluate(this.u0 + ((this.u1 - this.u0) * i) / 4, this.v0 + ((this.v1 - this.v0) * j) / 4)[0];
      s = Math.max(s, length(sub(p, a)));
    }
    // Only once the domain is known: subclasses call this from their constructors.
    if (Number.isFinite(this.u0) && Number.isFinite(this.v0)) this.sizeCache = s || 1;
    return s || 1;
  }

  /** Brings periodic parameters into the domain for evaluation. */
  protected wrap(u: number, v: number): Vec2 {
    if (this.uPeriod !== null) {
      u = this.u0 + ((((u - this.u0) % this.uPeriod) + this.uPeriod) % this.uPeriod);
    }
    if (this.vPeriod !== null) {
      v = this.v0 + ((((v - this.v0) % this.vPeriod) + this.vPeriod) % this.vPeriod);
    }
    return [u, v];
  }

  project(p: Vec3, hint?: Vec2): Vec2 {
    const distance = (uv: Vec2) => length(sub(this.evaluate(uv[0], uv[1])[0], p));
    let hinted: Vec2 | null = null, hintedError = Infinity;
    if (hint) {
      hinted = refine(this, p, hint, 12);
      hintedError = distance(hinted);
      if (hintedError <= this.size() * 1e-6) return hinted;
    }
    if (!this.grid) {
      const [us, vs] = this.gridParameters();
      this.grid = [];
      for (const u of us) for (const v of vs) this.grid.push({ u, v, p: this.evaluate(u, v)[0] });
    }
    // Refine from the few nearest grid points and keep the best.
    const candidates: { g: { u: number; v: number; p: Vec3 }; d: number }[] = [];
    for (const g of this.grid) {
      const d = (g.p[0] - p[0]) ** 2 + (g.p[1] - p[1]) ** 2 + (g.p[2] - p[2]) ** 2;
      if (candidates.length === 4 && d >= candidates[3]!.d) continue;
      let i = candidates.length < 4 ? candidates.length : 3;
      candidates[i] = { g, d };
      while (i > 0 && candidates[i - 1]!.d > d) {
        [candidates[i - 1], candidates[i]] = [candidates[i]!, candidates[i - 1]!];
        i--;
      }
    }
    let best: Vec2 = [candidates[0]?.g.u ?? this.u0, candidates[0]?.g.v ?? this.v0], bestError = Infinity;
    for (const { g } of candidates) {
      const uv = refine(this, p, [g.u, g.v]);
      const e = distance(uv);
      if (e < bestError) {
        bestError = e;
        best = uv;
      }
      if (e <= this.size() * 1e-9) break;
    }
    // Boundary points are only as close to the surface as the file's modelling tolerance, so the
    // result next to the previous point wins unless another is clearly closer: on surfaces that
    // wind round, like threads, a far-off point can be nearly as close.
    if (hinted && !(bestError < hintedError * 0.5)) return hinted;
    if (hint) best = [nearPeriod(best[0], hint[0], this.uPeriod), nearPeriod(best[1], hint[1], this.vPeriod)];
    return best;
  }
}

/** Sample parameters: `per` in each knot span, thinned to at most `cap`. */
function spans(breaks: number[], per: number, cap: number): number[] {
  const out: number[] = [];
  const total = (breaks.length - 1) * per;
  const step = Math.max(1, Math.ceil(total / cap));
  let k = 0;
  for (let i = 0; i + 1 < breaks.length; i++) {
    for (let j = 0; j < per; j++, k++) if (k % step === 0) out.push(breaks[i]! + ((breaks[i + 1]! - breaks[i]!) * j) / per);
  }
  out.push(breaks[breaks.length - 1]!);
  return out;
}

export class BSplineSurface extends NumericSurface {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  constructor(readonly data: BSplineSurfaceData) {
    super();
    this.u0 = data.u0;
    this.u1 = data.u1;
    this.v0 = data.v0;
    this.v1 = data.v1;
    this.detectPeriods();
  }
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const [wu, wv] = this.wrap(u, v);
    return this.data.evaluate(Math.min(this.u1, Math.max(this.u0, wu)), Math.min(this.v1, Math.max(this.v0, wv)));
  }
  protected gridParameters(): [number[], number[]] {
    return [
      spans(this.data.breaks('u'), Math.max(3, this.data.uDegree * 2), 256),
      spans(this.data.breaks('v'), Math.max(3, this.data.vDegree * 2), 256),
    ];
  }
  /** Distinct knots, where a tessellation should start subdividing. */
  breaks(direction: 'u' | 'v'): number[] {
    return this.data.breaks(direction);
  }
}

/** curve(u) + v * direction, with the vector's magnitude. */
export class ExtrusionSurface extends NumericSurface {
  readonly u0: number;
  readonly u1: number;
  readonly v0 = -Infinity;
  readonly v1 = Infinity;
  private readonly h: number;
  constructor(readonly curve: Curve, readonly direction: Vec3, range: [number, number]) {
    super();
    this.u0 = range[0];
    this.u1 = range[1];
    this.uPeriod = curve.period;
    this.h = (this.u1 - this.u0) * 1e-6 || 1e-6;
  }
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const c = this.curve.point(u);
    const du = scale(sub(this.curve.point(u + this.h), this.curve.point(u - this.h)), 1 / (2 * this.h));
    return [add(c, scale(this.direction, v)), du, this.direction];
  }
  protected override size(): number {
    const a = Number.isFinite(this.u0) ? this.u0 : 0, b = Number.isFinite(this.u1) ? this.u1 : a + 1;
    return length(sub(this.curve.point(a), this.curve.point((a + b) / 2))) + length(this.direction) || 1;
  }
  override project(p: Vec3, hint?: Vec2): Vec2 {
    // The nearest curve point after removing the offset along the direction gives a good start.
    const dd = dot(this.direction, this.direction) || 1;
    let u = hint?.[0] ?? this.curve.closest(p);
    for (let i = 0; i < 3; i++) {
      const v = dot(sub(p, this.curve.point(u)), this.direction) / dd;
      u = this.curve.closest(sub(p, scale(this.direction, v)));
    }
    const v = dot(sub(p, this.curve.point(u)), this.direction) / dd;
    const uv = refine(this, p, [u, v], 12);
    return hint ? [nearPeriod(uv[0], hint[0], this.uPeriod), uv[1]] : uv;
  }
  protected gridParameters(): [number[], number[]] {
    return [[this.u0], [0]];
  }
}

/** The curve's point at v rotated by angle u about the axis. */
export class RevolutionSurface extends NumericSurface {
  readonly u0 = 0;
  readonly u1 = 2 * Math.PI;
  readonly v0: number;
  readonly v1: number;
  private readonly h: number;
  private readonly frame: Frame;
  constructor(readonly curve: Curve, origin: Vec3, axis: Vec3, range: [number, number]) {
    super();
    const z = normalize(axis);
    const x = Math.abs(z[0]) < 0.9 ? normalize(cross(z, [1, 0, 0])) : normalize(cross(z, [0, 1, 0]));
    this.frame = { origin, x, y: cross(z, x), z };
    this.v0 = range[0];
    this.v1 = range[1];
    this.uPeriod = 2 * Math.PI;
    this.vPeriod = curve.period;
    this.h = (this.v1 - this.v0) * 1e-6 || 1e-6;
  }
  private rotate(p: Vec3, u: number): Vec3 {
    const l = local(this.frame, p);
    const c = Math.cos(u), s = Math.sin(u);
    return at(this.frame, l[0] * c - l[1] * s, l[0] * s + l[1] * c, l[2]);
  }
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const c = this.curve.point(v);
    const p = this.rotate(c, u);
    const l = local(this.frame, p);
    const du = dir(this.frame, -l[1], l[0], 0);
    const dc = scale(sub(this.curve.point(v + this.h), this.curve.point(v - this.h)), 1 / (2 * this.h));
    const dv = sub(this.rotate(add(c, dc), u), p);
    return [p, du, dv];
  }
  override project(p: Vec3, hint?: Vec2): Vec2 {
    const l = local(this.frame, p);
    const rho = Math.hypot(l[0], l[1]);
    // Find the curve point at the same radius and height, then the angle between them.
    let v = hint?.[1] ?? this.curve.closest(at(this.frame, rho, 0, l[2]));
    if (!hint && Number.isFinite(this.v0) && Number.isFinite(this.v1)) {
      // The profile may not lie in the x-z plane, so search the profile's rotated copies.
      let best = Infinity;
      for (let i = 0; i <= 64; i++) {
        const t = this.v0 + ((this.v1 - this.v0) * i) / 64;
        const cl = local(this.frame, this.curve.point(t));
        const d = (Math.hypot(cl[0], cl[1]) - rho) ** 2 + (cl[2] - l[2]) ** 2;
        if (d < best) {
          best = d;
          v = t;
        }
      }
    }
    const cl = local(this.frame, this.curve.point(v));
    let u = Math.atan2(l[1], l[0]) - Math.atan2(cl[1], cl[0]);
    u = nearPeriod(u, hint?.[0] ?? Math.PI, 2 * Math.PI);
    const uv = refine(this, p, [u, v], 20);
    return hint ? [nearPeriod(uv[0], hint[0], this.uPeriod), nearPeriod(uv[1], hint[1], this.vPeriod)] : uv;
  }
  protected override size(): number {
    const a = Number.isFinite(this.v0) ? this.v0 : 0, b = Number.isFinite(this.v1) ? this.v1 : a + 1;
    return length(sub(this.curve.point(a), this.curve.point(b))) + length(local(this.frame, this.curve.point(a))) + 1e-9;
  }
  protected gridParameters(): [number[], number[]] {
    return [[0], [this.v0]];
  }
}

/** basis + distance * unit normal. */
export class OffsetSurface implements Surface {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
  readonly uPeriod: number | null;
  readonly vPeriod: number | null;
  readonly planar: boolean;
  constructor(readonly basis: Surface, readonly distance: number) {
    this.u0 = basis.u0; this.u1 = basis.u1; this.v0 = basis.v0; this.v1 = basis.v1;
    this.uPeriod = basis.uPeriod;
    this.vPeriod = basis.vPeriod;
    this.planar = basis.planar;
  }
  evaluate(u: number, v: number): [Vec3, Vec3, Vec3] {
    const n = (uu: number, vv: number): Vec3 => {
      const [p, du, dv] = this.basis.evaluate(uu, vv);
      return add(p, scale(normalize(cross(du, dv)), this.distance));
    };
    const h = 1e-6;
    const p = n(u, v);
    return [p, scale(sub(n(u + h, v), n(u - h, v)), 1 / (2 * h)), scale(sub(n(u, v + h), n(u, v - h)), 1 / (2 * h))];
  }
  project(p: Vec3, hint?: Vec2): Vec2 {
    return refine(this, p, this.basis.project(p, hint), 10);
  }
}

/** Unit normal du x dv; null where it is undefined. */
export function surfaceNormal(du: Vec3, dv: Vec3): Vec3 | null {
  const n = cross(du, dv);
  const l = length(n);
  return l > 1e-300 && l > 1e-14 * length(du) * length(dv) ? [n[0] / l, n[1] / l, n[2] / l] : null;
}
