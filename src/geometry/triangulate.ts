// Triangulation of simple polygons with holes, by ear clipping after bridging each hole into the
// outer boundary. Face boundaries can run to many thousands of points, so ears are found on a
// linked ring and checked against a grid.

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

/**
 * Ear clipping over a linked ring: after each ear it carries on from the next vertex rather than
 * starting again, and checks an ear only against the vertices in the grid cells under it, so
 * boundaries of many thousands of points take about linear time.
 */
function earClip(ring: number[], points: Vec2[]): number[] {
  const n = ring.length;
  const out: number[] = [];
  if (n < 3) return out;
  // Ring positions, linked both ways.
  const prev = new Int32Array(n), next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
  }
  const removed = new Uint8Array(n);
  const P = (i: number) => points[ring[i]!]!;

  // A grid of about one ring position per cell.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = P(i);
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const w = maxX - minX, h = maxY - minY;
  let cell = Math.sqrt((w * h) / n);
  if (!(cell > 0)) cell = Math.max(w, h) / n || 1;
  const nx = Math.max(1, Math.min(4096, Math.ceil(w / cell) + 1)), ny = Math.max(1, Math.min(4096, Math.ceil(h / cell) + 1));
  const cx = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor(((x - minX) / (w || 1)) * (nx - 1))));
  const cy = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor(((y - minY) / (h || 1)) * (ny - 1))));
  // Counting sort of the positions into cells.
  const cellOf = new Int32Array(n);
  const start = new Int32Array(nx * ny + 1);
  for (let i = 0; i < n; i++) {
    const p = P(i);
    cellOf[i] = cy(p[1]) * nx + cx(p[0]);
    start[cellOf[i]! + 1]!++;
  }
  for (let c = 0; c < nx * ny; c++) start[c + 1]! += start[c]!;
  const items = new Int32Array(n);
  const fill = start.slice(0, nx * ny);
  for (let i = 0; i < n; i++) items[fill[cellOf[i]!]!++] = i;

  const isEar = (i: number): boolean => {
    const ia = prev[i]!, ic = next[i]!;
    const a = P(ia), b = P(i), c = P(ic);
    // Reflex or collinear vertices are not ears. Collinear ones are kept rather than dropped:
    // on curved surfaces, points in a straight (u, v) line need not be in a straight 3D line, and
    // the faces next to this one share them.
    if (cross2(a, b, c) <= 0) return false;
    const x0 = Math.min(a[0], b[0], c[0]), x1 = Math.max(a[0], b[0], c[0]);
    const y0 = Math.min(a[1], b[1], c[1]), y1 = Math.max(a[1], b[1], c[1]);
    const gx0 = cx(x0), gx1 = cx(x1), gy0 = cy(y0), gy1 = cy(y1);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const g = gy * nx + gx;
        for (let s = start[g]!; s < start[g + 1]!; s++) {
          const k = items[s]!;
          if (removed[k] || k === ia || k === i || k === ic) continue;
          const p = P(k);
          if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
          // Bridge vertices repeat by position; ignore copies of the ear's own corners.
          if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
          if (pointInTriangle(p, a, b, c)) return false;
        }
      }
    }
    return true;
  };

  let remaining = n;
  let ear = 0, stop = 0;
  while (remaining > 3) {
    if (isEar(ear)) {
      const ia = prev[ear]!, ic = next[ear]!;
      out.push(ring[ia]!, ring[ear]!, ring[ic]!);
      removed[ear] = 1;
      next[ia] = ic;
      prev[ic] = ia;
      remaining--;
      // Carry on from the vertex before, which may have become an ear.
      ear = ia;
      stop = ia;
      continue;
    }
    ear = next[ear]!;
    if (ear === stop) {
      // Round the whole ring without an ear: self-intersecting or numerically awkward input.
      // Fan out what's left.
      const rest: number[] = [];
      let k = ear;
      do {
        rest.push(ring[k]!);
        k = next[k]!;
      } while (k !== ear);
      for (let i = 1; i + 1 < rest.length; i++) out.push(rest[0]!, rest[i]!, rest[i + 1]!);
      return out;
    }
  }
  out.push(ring[prev[ear]!]!, ring[ear]!, ring[next[ear]!]!);
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
