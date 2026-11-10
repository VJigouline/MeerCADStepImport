// Curves of ISO 10303-42 as evaluators: lines, conics, B-splines, polylines, curves on surfaces
// and composites, with closest-point parameters and adaptive sampling for edges.

import { add, cross, dot, length, lerp, scale, sub, type Vec3 } from '../geometry/math.js';
import { BSplineCurveData } from './bspline.js';

export interface Curve {
  /** Natural parameter range; infinite for unbounded lines. */
  readonly t0: number;
  readonly t1: number;
  /** Parameter period of closed periodic curves, such as 2π for circles. */
  readonly period: number | null;
  /** Straight between any two of its points. */
  readonly straight: boolean;
  point(t: number): Vec3;
  /** Parameter of the point nearest p. */
  closest(p: Vec3): number;
  /** Sampling parameters from a to b (either order), within the tolerances. */
  sample(a: number, b: number, tolerance: number, angle: number): number[];
}

/** Bisects segments until the midpoint is within tolerance of the chord and the turn is small. */
function adaptive(curve: Curve, starts: number[], tolerance: number, angle: number): number[] {
  const out: number[] = [starts[0]!];
  // The two half chords of an arc turn by half its angle.
  const cosAngle = Math.cos(angle / 2);
  const refine = (ta: number, pa: Vec3, tb: number, pb: Vec3, depth: number) => {
    const tm = (ta + tb) / 2;
    const pm = curve.point(tm);
    const chord = sub(pb, pa);
    const chordLength = length(chord);
    let split = false;
    if (depth < 12) {
      // Distance from the midpoint to the chord, and the turn between the two half chords.
      const deviation = chordLength > 0 ? length(cross(sub(pm, pa), chord)) / chordLength : length(sub(pm, pa));
      const d1 = sub(pm, pa), d2 = sub(pb, pm);
      const l1 = length(d1), l2 = length(d2);
      const turn = l1 > 0 && l2 > 0 ? dot(d1, d2) / (l1 * l2) : 1;
      split = deviation > tolerance || turn < cosAngle;
    }
    if (split) {
      refine(ta, pa, tm, pm, depth + 1);
      refine(tm, pm, tb, pb, depth + 1);
    } else {
      out.push(tb);
    }
  };
  for (let i = 0; i + 1 < starts.length; i++) {
    refine(starts[i]!, curve.point(starts[i]!), starts[i + 1]!, curve.point(starts[i + 1]!), 0);
  }
  return out;
}

/** Evenly spaced parameters from a to b with at least `count` segments. */
function even(a: number, b: number, count: number): number[] {
  const n = Math.max(1, Math.ceil(count));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

/** Parameter of the nearest of `samples` points, refined by Newton's method on (C(t) - p) · C'(t). */
function numericClosest(curve: Curve, p: Vec3, t0: number, t1: number, samples = 64): number {
  let best = t0, bestDistance = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = t0 + ((t1 - t0) * i) / samples;
    const d = length(sub(curve.point(t), p));
    if (d < bestDistance) {
      bestDistance = d;
      best = t;
    }
  }
  let t = best;
  const h = (t1 - t0) * 1e-6 || 1e-6;
  for (let iteration = 0; iteration < 20; iteration++) {
    const c = curve.point(t);
    const cp = scale(sub(curve.point(Math.min(t1, t + h)), curve.point(Math.max(t0, t - h))), 1 / (Math.min(t1, t + h) - Math.max(t0, t - h)));
    const cpp = scale(add(sub(curve.point(Math.min(t1, t + h)), scale(c, 2)), curve.point(Math.max(t0, t - h))), 1 / (h * h));
    const r = sub(c, p);
    const f = dot(r, cp);
    const df = dot(cp, cp) + dot(r, cpp);
    if (!(Math.abs(df) > 0)) break;
    let next = t - f / df;
    if (curve.period === null) next = Math.min(t1, Math.max(t0, next));
    if (Math.abs(next - t) < 1e-12 * Math.max(1, Math.abs(t1 - t0))) {
      t = next;
      break;
    }
    // Keep Newton from wandering off to a worse point.
    if (length(sub(curve.point(next), p)) > length(r) * 1.5 + 1e-12) break;
    t = next;
  }
  return t;
}

export class LineCurve implements Curve {
  readonly t0 = -Infinity;
  readonly t1 = Infinity;
  readonly period = null;
  readonly straight = true;
  /** p(t) = origin + t * direction, the direction including the vector's magnitude. */
  constructor(readonly origin: Vec3, readonly direction: Vec3) {}
  point(t: number): Vec3 {
    return add(this.origin, scale(this.direction, t));
  }
  closest(p: Vec3): number {
    const dd = dot(this.direction, this.direction);
    return dd > 0 ? dot(sub(p, this.origin), this.direction) / dd : 0;
  }
  sample(a: number, b: number): number[] {
    return [a, b];
  }
}

/** Circle or ellipse: centre + a cos t x + b sin t y. */
export class ConicCurve implements Curve {
  readonly t0 = 0;
  readonly t1 = 2 * Math.PI;
  readonly period = 2 * Math.PI;
  readonly straight = false;
  constructor(readonly centre: Vec3, readonly x: Vec3, readonly y: Vec3, readonly a: number, readonly b: number) {}
  point(t: number): Vec3 {
    const c = Math.cos(t), s = Math.sin(t);
    return [
      this.centre[0] + this.a * c * this.x[0] + this.b * s * this.y[0],
      this.centre[1] + this.a * c * this.x[1] + this.b * s * this.y[1],
      this.centre[2] + this.a * c * this.x[2] + this.b * s * this.y[2],
    ];
  }
  closest(p: Vec3): number {
    const d = sub(p, this.centre);
    // Exact for circles; a good start for ellipses, which Newton then refines.
    const t = Math.atan2(dot(d, this.y) / (this.b || 1), dot(d, this.x) / (this.a || 1));
    if (Math.abs(this.a - this.b) <= 1e-12 * Math.max(this.a, this.b)) return t;
    let u = t;
    for (let i = 0; i < 12; i++) {
      const c = Math.cos(u), s = Math.sin(u);
      const x = dot(d, this.x), y = dot(d, this.y);
      // f(u) = derivative of squared distance / 2.
      const f = (this.a * c - x) * -this.a * s + (this.b * s - y) * this.b * c;
      const df = this.a * this.a * (s * s - c * c) + this.a * x * c + this.b * this.b * (c * c - s * s) + this.b * y * s;
      if (!(Math.abs(df) > 0)) break;
      const next = u - f / df;
      if (Math.abs(next - u) < 1e-14) break;
      u = next;
    }
    return u;
  }
  sample(a: number, b: number, tolerance: number, angle: number): number[] {
    const r = Math.max(this.a, this.b);
    // The step whose sagitta r (1 - cos(step / 2)) is the tolerance.
    const chordStep = tolerance < r ? 2 * Math.acos(1 - tolerance / r) : Math.PI;
    const step = Math.max(1e-3, Math.min(angle, chordStep));
    return even(a, b, Math.abs(b - a) / step);
  }
}

/** Parabola, centre + f t² x + 2 f t y, and hyperbola, centre + a cosh t x + b sinh t y. */
export class GeneralCurve implements Curve {
  readonly period = null;
  readonly straight = false;
  constructor(private readonly f: (t: number) => Vec3, readonly t0 = -1e3, readonly t1 = 1e3) {}
  point(t: number): Vec3 {
    return this.f(t);
  }
  closest(p: Vec3): number {
    return numericClosest(this, p, this.t0, this.t1, 256);
  }
  sample(a: number, b: number, tolerance: number, angle: number): number[] {
    return adaptive(this, even(a, b, 8), tolerance, angle);
  }
}

export class BSplineCurve implements Curve {
  readonly t0: number;
  readonly t1: number;
  readonly period: number | null;
  readonly straight: boolean;
  private readonly samples: { t: number; p: Vec3 }[] = [];
  constructor(readonly data: BSplineCurveData) {
    this.t0 = data.t0;
    this.t1 = data.t1;
    const first = data.evaluate(this.t0)[0], last = data.evaluate(this.t1)[0];
    let size = 0;
    for (const cp of data.points) size = Math.max(size, length(sub(cp, data.points[0]!)));
    this.period = length(sub(first, last)) <= size * 1e-9 ? this.t1 - this.t0 : null;
    this.straight = data.degree === 1 && data.points.length === 2;
    // Samples for closest-point searches: a few per knot span.
    const breaks = data.breaks();
    const per = Math.max(4, data.degree * 3);
    for (let i = 0; i + 1 < breaks.length; i++) {
      for (let k = 0; k < per; k++) {
        const t = breaks[i]! + ((breaks[i + 1]! - breaks[i]!) * k) / per;
        this.samples.push({ t, p: data.evaluate(t)[0] });
      }
    }
    this.samples.push({ t: this.t1, p: last });
  }
  private wrap(t: number): number {
    if (this.period === null) return Math.min(this.t1, Math.max(this.t0, t));
    let w = (t - this.t0) % this.period;
    if (w < 0) w += this.period;
    return this.t0 + w;
  }
  point(t: number): Vec3 {
    return this.data.evaluate(this.wrap(t))[0];
  }
  closest(p: Vec3): number {
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i]!.p;
      const d = (s[0] - p[0]) ** 2 + (s[1] - p[1]) ** 2 + (s[2] - p[2]) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    let t = this.samples[best]!.t;
    for (let iteration = 0; iteration < 30; iteration++) {
      const [c, d] = this.data.evaluate(t);
      const r = sub(c, p);
      const dd = dot(d, d);
      if (!(dd > 0)) break;
      // Gauss-Newton: points on the curve have zero residual, so this converges quadratically there.
      let next = t - dot(r, d) / dd;
      next = Math.min(this.t1, Math.max(this.t0, next));
      if (Math.abs(next - t) <= 1e-13 * Math.max(1, Math.abs(this.t1 - this.t0))) {
        t = next;
        break;
      }
      t = next;
    }
    return t;
  }
  sample(a: number, b: number, tolerance: number, angle: number): number[] {
    if (this.straight) return [a, b];
    const lo = Math.min(a, b), hi = Math.max(a, b);
    // Start from the knots inside [lo, hi], each span split by the degree.
    const starts: number[] = [lo];
    const breaks = this.data.breaks();
    const k = this.period !== null ? Math.floor((lo - this.t0) / this.period) : 0;
    for (let shift = k; shift <= k + 1; shift++) {
      for (const br of breaks) {
        const t = br + (this.period !== null ? shift * this.period : 0);
        if (t > lo && t < hi && t - starts[starts.length - 1]! > 1e-12) starts.push(t);
      }
    }
    starts.push(hi);
    const refined: number[] = [starts[0]!];
    const per = Math.max(1, this.data.degree);
    for (let i = 0; i + 1 < starts.length; i++) {
      for (let j = 1; j <= per; j++) refined.push(starts[i]! + ((starts[i + 1]! - starts[i]!) * j) / per);
    }
    // Knots can be far denser than the tolerances need, as on curves exported with a knot every
    // few degrees: thin the points out, but well within the tolerances, as edges of sliver
    // faces can run closer together than the tolerance and coarse chords of the two could cross.
    // Keep at least the `degree` segments a single knot span gets: faces never split their
    // boundary edges, and a long edge across a curved surface would leave slivers along it.
    const out = simplify(this, adaptive(this, refined, tolerance, angle), tolerance / 4, angle / 2, per);
    return a <= b ? out : out.reverse();
  }
}

/**
 * Drops sample parameters while every dropped point stays within `tolerance` of the chord that
 * replaces it and the curve turns by no more than `angle` along the chord. The ends are kept, and
 * at least `minSegments` segments (fewer only if there were fewer to start with).
 */
function simplify(curve: Curve, ts: number[], tolerance: number, angle: number, minSegments: number): number[] {
  if (ts.length - 1 <= minSegments) return ts;
  const ps = ts.map(t => curve.point(t));
  const out = [ts[0]!];
  let anchor = 0;
  while (anchor < ts.length - 1) {
    // Extend the chord from the anchor as far as it stays within the tolerances.
    let end = anchor + 1;
    let turning = 0;
    // At most 256 points to a chord, which keeps the checks linear in the number of points.
    for (let j = anchor + 2; j < Math.min(ts.length, anchor + 256); j++) {
      const d0 = sub(ps[j - 1]!, ps[j - 2]!), d1 = sub(ps[j]!, ps[j - 1]!);
      const l0 = length(d0), l1 = length(d1);
      if (l0 > 0 && l1 > 0) turning += Math.acos(Math.min(1, Math.max(-1, dot(d0, d1) / (l0 * l1))));
      if (turning > angle) break;
      const a = ps[anchor]!, chord = sub(ps[j]!, a), cl = length(chord);
      let within = true;
      for (let i = anchor + 1; i < j && within; i++) {
        const d = cl > 0 ? length(cross(sub(ps[i]!, a), chord)) / cl : length(sub(ps[i]!, a));
        within = d <= tolerance;
      }
      if (!within) break;
      end = j;
    }
    out.push(ts[end]!);
    anchor = end;
  }
  if (out.length - 1 >= minSegments) return out;
  // Too few: evenly spread picks from the samples instead.
  const picked: number[] = [];
  for (let i = 0; i <= minSegments; i++) picked.push(ts[Math.round((i * (ts.length - 1)) / minSegments)]!);
  return picked;
}

/** Polyline through points; the parameter runs from 0 at the first point by one per segment. */
export class PolylineCurve implements Curve {
  readonly t0 = 0;
  readonly t1: number;
  readonly period = null;
  readonly straight: boolean;
  constructor(readonly points: readonly Vec3[]) {
    this.t1 = Math.max(0, points.length - 1);
    this.straight = points.length <= 2;
  }
  point(t: number): Vec3 {
    const n = this.points.length;
    if (n === 0) return [0, 0, 0];
    if (n === 1) return this.points[0]!;
    const i = Math.min(n - 2, Math.max(0, Math.floor(t)));
    return lerp(this.points[i]!, this.points[i + 1]!, t - i);
  }
  closest(p: Vec3): number {
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i + 1 < this.points.length; i++) {
      const a = this.points[i]!, d = sub(this.points[i + 1]!, a);
      const dd = dot(d, d);
      const s = dd > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), d) / dd)) : 0;
      const distance = length(sub(add(a, scale(d, s)), p));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i + s;
      }
    }
    return best;
  }
  sample(a: number, b: number): number[] {
    const out = [a];
    if (a <= b) for (let i = Math.floor(a) + 1; i < b; i++) out.push(i);
    else for (let i = Math.ceil(a) - 1; i > b; i--) out.push(i);
    out.push(b);
    return out;
  }
}

/** The same curve traversed the other way: parameter -t. */
export class ReversedCurve implements Curve {
  readonly t0: number;
  readonly t1: number;
  readonly period: number | null;
  readonly straight: boolean;
  constructor(readonly basis: Curve) {
    this.t0 = -basis.t1;
    this.t1 = -basis.t0;
    this.period = basis.period;
    this.straight = basis.straight;
  }
  point(t: number): Vec3 {
    return this.basis.point(-t);
  }
  closest(p: Vec3): number {
    return -this.basis.closest(p);
  }
  sample(a: number, b: number, tolerance: number, angle: number): number[] {
    return this.basis.sample(-a, -b, tolerance, angle).map(t => -t);
  }
}

/** A curve limited to [t0, t1] of its basis, as TRIMMED_CURVE and composite segments are. */
export class TrimmedCurve implements Curve {
  readonly period = null;
  readonly straight: boolean;
  constructor(readonly basis: Curve, readonly t0: number, readonly t1: number) {
    this.straight = basis.straight;
  }
  point(t: number): Vec3 {
    return this.basis.point(t);
  }
  closest(p: Vec3): number {
    const t = this.basis.closest(p);
    if (t >= this.t0 && t <= this.t1) return t;
    if (this.basis.period !== null) {
      const shifted = t + this.basis.period * Math.round((this.t0 - t) / this.basis.period);
      for (const c of [shifted, shifted + this.basis.period, shifted - this.basis.period]) if (c >= this.t0 - 1e-9 && c <= this.t1 + 1e-9) return c;
    }
    return length(sub(this.point(this.t0), p)) <= length(sub(this.point(this.t1), p)) ? this.t0 : this.t1;
  }
  sample(a: number, b: number, tolerance: number, angle: number): number[] {
    return this.basis.sample(a, b, tolerance, angle);
  }
}

/** Segments joined end to end; segment i covers parameters [i, i + 1]. */
export class CompositeCurve implements Curve {
  readonly t0 = 0;
  readonly t1: number;
  readonly period = null;
  readonly straight = false;
  constructor(readonly segments: readonly { curve: Curve; a: number; b: number }[]) {
    this.t1 = segments.length;
  }
  private locate(t: number): [number, number] {
    const i = Math.min(this.segments.length - 1, Math.max(0, Math.floor(t)));
    const s = this.segments[i]!;
    return [i, s.a + (s.b - s.a) * (t - i)];
  }
  point(t: number): Vec3 {
    const [i, local] = this.locate(t);
    return this.segments[i]!.curve.point(local);
  }
  closest(p: Vec3): number {
    let best = 0, bestDistance = Infinity;
    this.segments.forEach((s, i) => {
      let local = s.curve.closest(p);
      const lo = Math.min(s.a, s.b), hi = Math.max(s.a, s.b);
      if (s.curve.period !== null) local += s.curve.period * Math.round((lo - local) / s.curve.period);
      if (local < lo && s.curve.period !== null) local += s.curve.period;
      local = Math.min(hi, Math.max(lo, local));
      const d = length(sub(s.curve.point(local), p));
      if (d < bestDistance) {
        bestDistance = d;
        best = i + (s.b !== s.a ? (local - s.a) / (s.b - s.a) : 0);
      }
    });
    return best;
  }
  sample(a: number, b: number, tolerance: number, angle: number): number[] {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const out: number[] = [];
    for (let i = Math.floor(lo); i < Math.ceil(hi) && i < this.segments.length; i++) {
      const s = this.segments[i]!;
      const from = Math.max(lo, i), to = Math.min(hi, i + 1);
      const la = s.a + (s.b - s.a) * (from - i), lb = s.a + (s.b - s.a) * (to - i);
      const local = s.curve.sample(la, lb, tolerance, angle);
      const ts = local.map(t => (s.b !== s.a ? i + (t - s.a) / (s.b - s.a) : i));
      for (const t of ts) if (out.length === 0 || t - out[out.length - 1]! > 1e-12) out.push(t);
    }
    if (out.length === 0) out.push(lo, hi);
    return a <= b ? out : out.reverse();
  }
}

/** A curve given as a function, sampled numerically, such as a pcurve on a surface. */
export class FunctionCurve implements Curve {
  readonly straight = false;
  constructor(
    private readonly f: (t: number) => Vec3,
    readonly t0: number,
    readonly t1: number,
    readonly period: number | null,
    private readonly starts: (a: number, b: number) => number[],
  ) {}
  point(t: number): Vec3 {
    return this.f(t);
  }
  closest(p: Vec3): number {
    const lo = Number.isFinite(this.t0) ? this.t0 : -1e3, hi = Number.isFinite(this.t1) ? this.t1 : 1e3;
    return numericClosest(this, p, lo, hi, 128);
  }
  sample(a: number, b: number, tolerance: number, angle: number): number[] {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const out = adaptive(this, this.starts(lo, hi), tolerance, angle);
    return a <= b ? out : out.reverse();
  }
}

export { even as evenParameters };
