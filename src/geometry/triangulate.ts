// Triangulation of simple polygons with holes, by ear clipping after bridging each hole into the
// outer boundary. Face boundaries are small, so the quadratic cost is fine.

import { cross, dot, normalize, perpendicular, sub, type Vec2, type Vec3 } from './math.js';

/** Twice the signed area: positive for counter-clockwise. */
export function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j]![0] - points[i]![0]) * (points[j]![1] + points[i]![1]);
  }
  return a;
}

/** Removes repeated points, including a closing point equal to the first. */
export function cleanPolygon<T extends Vec2 | Vec3>(points: readonly T[], eps: number): T[] {
  const out: T[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) > eps) out.push(p);
  }
  while (out.length > 1 && distance(out[0]!, out[out.length - 1]!) <= eps) out.pop();
  return out;
}

function distance(a: Vec2 | Vec3, b: Vec2 | Vec3): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s);
}

function cross2(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross2(c, d, a), d2 = cross2(c, d, b), d3 = cross2(a, b, c), d4 = cross2(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Triangulates a polygon (counter-clockwise or not) with optional holes. Returns triangles as
 * index triples into the concatenation [outer, ...holes]. Degenerate input returns what it can.
 */
export function triangulate(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): number[] {
  if (outer.length < 3) return [];
  const points: Vec2[] = [];
  const pushRing = (ring: readonly Vec2[], ccw: boolean): number[] => {
    const indices = ring.map(p => points.push(p) - 1);
    const isCcw = signedArea(ring) > 0;
    return isCcw === ccw ? indices : indices.reverse();
  };
  let ring = pushRing(outer, true);
  const holeRings = holes.filter(h => h.length >= 3).map(h => pushRing(h, false));
  // Bridge holes, rightmost first, into the outer ring.
  holeRings.sort((a, b) => Math.max(...b.map(i => points[i]![0])) - Math.max(...a.map(i => points[i]![0])));
  for (const hole of holeRings) ring = bridge(ring, hole, points);
  return earClip(ring, points);
}

/** Joins a hole into the ring through a visible pair of vertices. */
function bridge(ring: number[], hole: number[], points: Vec2[]): number[] {
  // Hole vertex furthest right.
  let hi = 0;
  for (let i = 1; i < hole.length; i++) if (points[hole[i]!]![0] > points[hole[hi]!]![0]) hi = i;
  const h = points[hole[hi]!]!;
  // Nearest ring vertex whose connection to h crosses no edge.
  let best = -1, bestDistance = Infinity;
  const candidates = ring.map((index, i) => ({ i, d: (points[index]![0] - h[0]) ** 2 + (points[index]![1] - h[1]) ** 2 }))
    .sort((a, b) => a.d - b.d);
  for (const { i, d } of candidates) {
    const r = points[ring[i]!]!;
    let blocked = false;
    for (const loop of [ring, hole]) {
      for (let k = 0; k < loop.length && !blocked; k++) {
        const a = points[loop[k]!]!, b = points[loop[(k + 1) % loop.length]!]!;
        if (a === r || b === r || a === h || b === h) continue;
        if (segmentsIntersect(r, h, a, b)) blocked = true;
      }
    }
    if (!blocked) {
      best = i;
      bestDistance = d;
      break;
    }
  }
  if (best < 0 || bestDistance === Infinity) best = candidates[0]?.i ?? 0;
  const rotatedHole = [...hole.slice(hi), ...hole.slice(0, hi)];
  return [...ring.slice(0, best + 1), ...rotatedHole, hole[hi]!, ...ring.slice(best)];
}

function earClip(ring: number[], points: Vec2[]): number[] {
  const out: number[] = [];
  const remaining = ring.slice();
  // Each pass clips one vertex or gives up, so ring.length passes are always enough.
  let guard = 0;
  const limit = ring.length + 10;
  while (remaining.length > 3 && guard < limit) {
    guard++;
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i + remaining.length - 1) % remaining.length]!, ib = remaining[i]!, ic = remaining[(i + 1) % remaining.length]!;
      const a = points[ia]!, b = points[ib]!, c = points[ic]!;
      const turn = cross2(a, b, c);
      // Reflex or collinear vertices are not ears. Collinear ones are kept rather than dropped:
      // on curved surfaces, points in a straight (u, v) line need not be in a straight 3D line, and
      // the faces next to this one share them.
      if (turn <= 0) continue;
      let contains = false;
      for (const k of remaining) {
        if (k === ia || k === ib || k === ic) continue;
        const p = points[k]!;
        // Bridge vertices repeat by position; ignore copies of the ear's own corners.
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (pointInTriangle(p, a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      out.push(ia, ib, ic);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Self-intersecting or numerically awkward input: fan out what's left.
      for (let i = 1; i + 1 < remaining.length; i++) out.push(remaining[0]!, remaining[i]!, remaining[i + 1]!);
      return out;
    }
  }
  if (remaining.length === 3) out.push(remaining[0]!, remaining[1]!, remaining[2]!);
  return out;
}

/** Newell's method: the normal of a 3D polygon, robust to concave and slightly non-planar input. */
export function polygonNormal(points: readonly Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!, b = points[i]!;
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize([x, y, z]);
}

/**
 * Triangulates a planar 3D polygon with holes, keeping the outer boundary's orientation:
 * triangles wind the same way as `outer`. Returns index triples into [outer, ...holes].
 */
export function triangulate3D(outer: readonly Vec3[], holes: readonly (readonly Vec3[])[] = []): number[] {
  if (outer.length < 3) return [];
  if (outer.length === 3 && holes.length === 0) return [0, 1, 2];
  const n = polygonNormal(outer);
  if (n[0] === 0 && n[1] === 0 && n[2] === 0) return [];
  const u = perpendicular(n), v = cross(n, u);
  const origin = outer[0]!;
  const project = (p: Vec3): Vec2 => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)];
  };
  // In (u, v), the outer polygon is counter-clockwise because n = u x v.
  const indices = triangulate(outer.map(project), holes.map(h => h.map(project)));
  return indices;
}
