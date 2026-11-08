// Tessellation of a trimmed surface: the face's boundary loops are projected into the surface's
// (u, v) domain, closed across seams and poles, triangulated there, and refined until the mesh is
// within the chord and angle tolerances of the surface. Boundary points keep their 3D positions,
// so faces sharing an edge share its points and the mesh has no cracks.

import { cross, dot, length, sub, type Vec2, type Vec3 } from '../geometry/math.js';
import { signedArea, triangulate } from '../geometry/triangulate.js';
import { nearPeriod, surfaceNormal, type Surface } from './surfaces.js';

export interface FaceMesh {
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface FaceOptions {
  /** Largest distance between the mesh and the surface. */
  tolerance: number;
  /** Largest angle between normals across a triangle edge, in radians. */
  angle: number;
  /** Stop refining a face beyond this many triangles. */
  maxTriangles: number;
}

/** A boundary point: its parameters, its 3D position, and whether it is on a real edge. */
interface BoundaryPoint {
  uv: Vec2;
  p: Vec3;
}

export class FaceError extends Error {}

/** Interior edges may be this many times the chord tolerance from the surface. */
const INTERIOR_MARGIN = 2;

/**
 * Tessellates one face. `loops` are the face's bounds as 3D polylines in STEP's orientation (the
 * face on the left when seen from the face normal); `sense` is whether the face normal agrees
 * with the surface normal.
 */
export function tessellateFace(surface: Surface, sense: boolean, loops: readonly (readonly Vec3[])[], options: FaceOptions): FaceMesh {
  // In (u, v), counter-clockwise is the surface normal's side. Reversing the loops of faces whose
  // normal is the other way puts the face on the left of every loop there too.
  const oriented = loops.filter(loop => loop.length >= 2).map(loop => (sense ? loop.slice() : loop.slice().reverse()));
  const rings = oriented.map(loop => projectLoop(surface, loop));
  const regions = buildRegions(surface, rings, options);
  const out: FaceMesh = { positions: [], normals: [], indices: [] };
  for (const region of regions) meshRegion(surface, sense, region, options, out);
  return out;
}

/** Projects a loop into (u, v), keeping periodic parameters continuous and opening up poles. */
function projectLoop(surface: Surface, loop: readonly Vec3[]): BoundaryPoint[] {
  const raw: { uv: Vec2; p: Vec3; singularU: boolean; singularV: boolean }[] = [];
  let hint: Vec2 | undefined;
  for (const p of loop) {
    const uv = surface.project(p, hint);
    const [, du, dv] = surface.evaluate(uv[0], uv[1]);
    const lu = length(du), lv = length(dv);
    const singularU = lu <= 1e-9 * Math.max(lv, 1e-300) || (lu === 0 && lv === 0);
    const singularV = !singularU && lv <= 1e-9 * Math.max(lu, 1e-300);
    raw.push({ uv, p, singularU, singularV });
    if (!singularU && !singularV) hint = uv;
  }
  const first = raw.findIndex(r => !r.singularU && !r.singularV);
  if (first < 0) return raw.map(r => ({ uv: r.uv, p: r.p }));
  const n = raw.length;
  // Unwrap the regular points in loop order, starting at the first one.
  let ref = raw[first]!.uv;
  const order: number[] = [];
  for (let k = 0; k < n; k++) order.push((first + k) % n);
  for (const i of order) {
    const r = raw[i]!;
    if (r.singularU || r.singularV) continue;
    r.uv = [nearPeriod(r.uv[0], ref[0], surface.uPeriod), nearPeriod(r.uv[1], ref[1], surface.vPeriod)];
    ref = r.uv;
  }
  // A pole point is where u (or v) is undefined: it becomes a segment along the pole, from the
  // previous point's parameter to the next one's.
  const out: BoundaryPoint[] = [];
  for (let k = 0; k < n; k++) {
    const i = order[k]!;
    const r = raw[i]!;
    if (!r.singularU && !r.singularV) {
      out.push({ uv: r.uv, p: r.p });
      continue;
    }
    let prev: Vec2 | null = null, next: Vec2 | null = null;
    for (let j = k - 1; j >= 0; j--) {
      const q = raw[order[j]!]!;
      if (!q.singularU && !q.singularV) {
        prev = q.uv;
        break;
      }
    }
    for (let j = k + 1; j < n + k; j++) {
      const q = raw[order[j % n]!]!;
      if (!q.singularU && !q.singularV) {
        next = q.uv;
        // Past the end of the loop, the next point's parameters continue from the last ones.
        if (j >= n && prev) next = [nearPeriod(next[0], prev[0], surface.uPeriod), nearPeriod(next[1], prev[1], surface.vPeriod)];
        break;
      }
    }
    prev ??= next;
    next ??= prev;
    if (!prev || !next) {
      out.push({ uv: r.uv, p: r.p });
      continue;
    }
    if (r.singularU) {
      const v = r.uv[1];
      out.push({ uv: [prev[0], v], p: r.p });
      if (Math.abs(next[0] - prev[0]) > 1e-12) out.push({ uv: [next[0], v], p: r.p });
    } else {
      const u = r.uv[0];
      out.push({ uv: [u, prev[1]], p: r.p });
      if (Math.abs(next[1] - prev[1]) > 1e-12) out.push({ uv: [u, next[1]], p: r.p });
    }
  }
  return out;
}

interface Region {
  outer: BoundaryPoint[];
  holes: BoundaryPoint[][];
}

/**
 * Points along an artificial boundary segment (a seam, pole or domain edge), excluding `from`:
 * bisected until within the tolerances, and along a periodic direction at least one point per
 * angle step, as pole lines carry the triangles fanning into the pole.
 */
function artificial(surface: Surface, from: Vec2, to: Vec2, options: FaceOptions): BoundaryPoint[] {
  const at = (t: number): BoundaryPoint => {
    const uv: Vec2 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    return { uv, p: surface.evaluate(uv[0], uv[1])[0] };
  };
  let count = 1;
  if (surface.uPeriod !== null) count = Math.max(count, Math.ceil((Math.abs(to[0] - from[0]) / surface.uPeriod) * ((2 * Math.PI) / options.angle)));
  if (surface.vPeriod !== null) count = Math.max(count, Math.ceil((Math.abs(to[1] - from[1]) / surface.vPeriod) * ((2 * Math.PI) / options.angle)));
  // Enough for the turning and curvature along the segment, from samples along all of it:
  // bisection alone can miss a segment that winds round, as a seam on a thread does.
  if (!surface.planar) {
    const samples = 64;
    let turning = 0, total = 0, curvature = 0;
    let prev = at(0).p, d0: Vec3 | null = null;
    for (let i = 1; i <= samples; i++) {
      const p = at(i / samples).p;
      const d = sub(p, prev);
      const l = length(d);
      total += l;
      if (d0 && l > 0) {
        const l0 = length(d0);
        if (l0 > 0) {
          const turn = Math.acos(Math.min(1, Math.max(-1, dot(d0, d) / (l0 * l))));
          turning += turn;
          curvature = Math.max(curvature, (2 * turn) / (l0 + l));
        }
      }
      if (l > 0) d0 = d;
      prev = p;
    }
    const byAngle = turning / options.angle;
    const byChord = curvature > 0 ? total * Math.sqrt(curvature / (8 * options.tolerance)) : 0;
    count = Math.max(count, Math.ceil(Math.max(byAngle, byChord)));
  }
  count = Math.min(count, 512);
  const cosAngle = Math.cos(options.angle);
  const normalAt = (t: number) => {
    const uv = at(t).uv;
    const [, du, dv] = surface.evaluate(uv[0], uv[1]);
    return surfaceNormal(du, dv);
  };
  const out: BoundaryPoint[] = [];
  const refine = (ta: number, a: BoundaryPoint, tb: number, b: BoundaryPoint, depth: number) => {
    const tm = (ta + tb) / 2;
    const m = at(tm);
    const chord = sub(b.p, a.p), cl = length(chord);
    const deviation = cl > 0 ? length(cross(sub(m.p, a.p), chord)) / cl : length(sub(m.p, a.p));
    let split = deviation > options.tolerance;
    if (!split) {
      const na = normalAt(ta), nb = normalAt(tb);
      split = !!na && !!nb && dot(na, nb) < cosAngle;
    }
    if (split && depth < 10) {
      refine(ta, a, tm, m, depth + 1);
      refine(tm, m, tb, b, depth + 1);
    } else {
      out.push(b);
    }
  };
  let prev = at(0);
  for (let i = 1; i <= count; i++) {
    const next = at(i / count);
    refine((i - 1) / count, prev, i / count, next, 0);
    prev = next;
  }
  return out;
}

/** Canonical frame for a wrapping direction: the wrapping parameter first, the face to +second. */
function toCanonical(uv: Vec2, axis: 0 | 1): Vec2 {
  return axis === 0 ? [uv[0], uv[1]] : [uv[1], -uv[0]];
}
function fromCanonical(c: Vec2, axis: 0 | 1): Vec2 {
  return axis === 0 ? [c[0], c[1]] : [-c[1], c[0]];
}

/** Whether a point is inside a polygon in (u, v), by crossings. */
function inside(p: Vec2, polygon: readonly BoundaryPoint[]): boolean {
  let c = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!.uv, b = polygon[j]!.uv;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

function area(ring: readonly BoundaryPoint[]): number {
  return signedArea(ring.map(p => p.uv)) / 2;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** A run of a cut ring between two seam crossings, moved into the base sheet. */
interface Piece {
  points: BoundaryPoint[];
  /** Which seam line it starts and ends on: 0 for a = cut, 1 for a = cut + period. */
  startSide: 0 | 1;
  endSide: 0 | 1;
  /** The second (canonical) parameter where it starts and ends. */
  startB: number;
  endB: number;
}

/**
 * Cuts rings along a periodic direction, so the face can be meshed in one period of it. The
 * rings are cut where they cross the seam lines a = cut + k·period, the runs between crossings
 * moved into [cut, cut + period], and joined again into polygons by walking along the seam lines,
 * and along the domain's edge where they run off it (a pole, or the end of a B-spline's domain).
 * This handles bands round a cylinder, caps at poles and threads that wind round many times
 * alike. `limit(b, up)` gives the domain's edge above or below b in the second parameter, or null.
 * If the second parameter is periodic too (`bPeriod`, as on a torus), the walk along a seam line
 * goes on round it instead of meeting an edge.
 */
function cutAtSeam(
  surface: Surface,
  rings: BoundaryPoint[][],
  axis: 0 | 1,
  limit: (b: number, up: boolean) => number | null,
  bPeriod: number | null,
  options: FaceOptions,
): { rings: BoundaryPoint[][]; cut: number } {
  const period = (axis === 0 ? surface.uPeriod : surface.vPeriod)!;
  const A = (p: BoundaryPoint) => toCanonical(p.uv, axis)[0];
  const B = (p: BoundaryPoint) => toCanonical(p.uv, axis)[1];
  const make = (a: number, b: number, p?: Vec3): BoundaryPoint => {
    const uv = fromCanonical([a, b], axis);
    return { uv, p: p ?? surface.evaluate(uv[0], uv[1])[0] };
  };
  const mod = (x: number) => ((x % period) + period) % period;
  // Where a ring winds round, cut through one of its points, usually the seam vertex, so the cut
  // adds no points that the neighbouring faces don't have. Otherwise cut through the widest gap
  // between the rings' points, so nothing crosses it.
  const winding = (ring: BoundaryPoint[]) => {
    const first = A(ring[0]!), last = A(ring[ring.length - 1]!);
    let total = 0;
    for (let i = 1; i < ring.length; i++) total += A(ring[i]!) - A(ring[i - 1]!);
    return Math.round((total + nearPeriod(first, last, period) - last) / period);
  };
  const wrapping = rings.find(r => winding(r) !== 0);
  const values = rings.flatMap(r => r.map(p => mod(A(p)))).sort((x, y) => x - y);
  let cut = 0;
  if (wrapping) {
    cut = mod(A(wrapping[0]!));
  } else if (values.length) {
    let gap = values[0]! + period - values[values.length - 1]!;
    cut = mod(values[values.length - 1]! + gap / 2);
    for (let i = 1; i < values.length; i++) {
      if (values[i]! - values[i - 1]! > gap) {
        gap = values[i]! - values[i - 1]!;
        cut = (values[i]! + values[i - 1]!) / 2;
      }
    }
  }
  // Points on a seam line count as on its far side, so a ring through one crosses next to it.
  const sheet = (a: number) => Math.floor((a - cut) / period + 1e-9);
  const shift = (p: BoundaryPoint, k: number): BoundaryPoint => (k === 0 ? p : make(A(p) - k * period, B(p), p.p));

  const closed: BoundaryPoint[][] = [];
  const pieces: Piece[] = [];
  for (const ring of rings) {
    // The ring as a closed walk: the first point again at the end, one winding on.
    const first = ring[0]!, last = ring[ring.length - 1]!;
    const end = make(nearPeriod(A(first), A(last), period), B(first), first.p);
    const walk = [...ring, end];
    const crossings: { index: number; point: BoundaryPoint }[] = [];
    for (let i = 0; i + 1 < walk.length; i++) {
      const a0 = A(walk[i]!), a1 = A(walk[i + 1]!);
      const k0 = sheet(a0), k1 = sheet(a1);
      if (k0 === k1) continue;
      const step = k1 > k0 ? 1 : -1;
      for (let k = k0; k !== k1; k += step) {
        const line = cut + (step > 0 ? k + 1 : k) * period;
        const t = (line - a0) / (a1 - a0);
        // A crossing at a point is the point itself; elsewhere, it is on the chord between the
        // edge points, so the neighbouring face has no gap there.
        const point = t <= 1e-7 ? walk[i]! : t >= 1 - 1e-7 ? walk[i + 1]! : null;
        if (point) crossings.push({ index: i, point: make(line, B(point), point.p) });
        else crossings.push({ index: i, point: make(line, B(walk[i]!) + (B(walk[i + 1]!) - B(walk[i]!)) * t, lerp3(walk[i]!.p, walk[i + 1]!.p, t)) });
      }
    }
    if (crossings.length === 0) {
      const k = sheet(A(first));
      closed.push(ring.map(p => shift(p, k)));
      continue;
    }
    // Runs from each crossing to the next, round the end of the walk back to the start.
    const n = walk.length - 1;
    const windingShift = A(end) - A(first);
    const side = (p: BoundaryPoint): 0 | 1 => (Math.abs(A(p) - cut) < Math.abs(A(p) - cut - period) ? 0 : 1);
    for (let c = 0; c < crossings.length; c++) {
      const from = crossings[c]!, to = crossings[(c + 1) % crossings.length]!;
      const run: BoundaryPoint[] = [from.point];
      const wraps = c + 1 === crossings.length;
      if (!wraps) {
        for (let i = from.index + 1; i <= to.index; i++) run.push(walk[i]!);
        run.push(to.point);
      } else {
        for (let i = from.index + 1; i <= n; i++) run.push(walk[i]!);
        // Past the end of the walk, the points continue one winding on.
        for (let i = 1; i <= to.index; i++) run.push(make(A(walk[i]!) + windingShift, B(walk[i]!), walk[i]!.p));
        run.push(make(A(to.point) + windingShift, B(to.point), to.point.p));
      }
      // The run's sheet, from the middle of its first segment.
      const k = sheet((A(run[0]!) + A(run[1]!)) / 2);
      const moved = run.map(p => shift(p, k));
      pieces.push({
        points: moved,
        startSide: side(moved[0]!),
        endSide: side(moved[moved.length - 1]!),
        startB: B(moved[0]!),
        endB: B(moved[moved.length - 1]!),
      });
    }
  }

  // Join the pieces: from a piece's end, follow its seam line with the face on the left (up the
  // high line, down the low one) to the next piece starting on it, or round the domain's edge.
  const polygons: BoundaryPoint[][] = [];
  const used = new Set<Piece>();
  const lineA = (s: 0 | 1) => (s === 0 ? cut : cut + period);
  for (const start of pieces) {
    if (used.has(start)) continue;
    const polygon: BoundaryPoint[] = [];
    let current = start, currentShift = 0;
    const shiftB = (p: BoundaryPoint, d: number): BoundaryPoint => (d === 0 ? p : make(A(p), B(p) + d, p.p));
    for (let guard = 0; ; guard++) {
      if (guard > pieces.length + 1) throw new FaceError('could not close a face boundary across its seam');
      used.add(current);
      const points = current.points.map(p => shiftB(p, currentShift));
      polygon.push(...points.slice(0, -1));
      let s = current.endSide, b = current.endB + currentShift, next: Piece | null = null, nextShift = 0;
      let from = points[points.length - 1]!;
      for (let turn = 0; turn < 3 && !next; turn++) {
        const up = s === 1;
        let best: Piece | null = null, bestDistance = Infinity;
        for (const piece of pieces) {
          if (piece.startSide !== s || (used.has(piece) && piece !== start)) continue;
          let d = up ? piece.startB - b : b - piece.startB;
          if (bPeriod !== null) {
            d = ((d % bPeriod) + bPeriod) % bPeriod;
            if (d > bPeriod - 1e-9) d = 0;
          }
          if (d < -1e-12 || d >= bestDistance) continue;
          best = piece;
          bestDistance = d;
        }
        if (best) {
          const target = up ? b + bestDistance : b - bestDistance;
          nextShift = target - best.startB;
          const first = shiftB(best.points[0]!, nextShift);
          polygon.push(from, ...artificial(surface, from.uv, first.uv, options).slice(0, -1));
          next = best;
          break;
        }
        // Nothing further along this line: follow the domain's edge to the other line.
        const edge = limit(b, up);
        if (edge === null) throw new FaceError('a face boundary runs off an unbounded surface');
        const corner = make(lineA(s), edge), across = make(lineA(s === 0 ? 1 : 0), edge);
        polygon.push(from, ...artificial(surface, from.uv, corner.uv, options).slice(0, -1));
        polygon.push(corner, ...artificial(surface, corner.uv, across.uv, options).slice(0, -1));
        from = across;
        s = s === 0 ? 1 : 0;
        b = edge;
      }
      if (!next) throw new FaceError('could not close a face boundary across its seam');
      if (next === start) break;
      current = next;
      currentShift = nextShift;
    }
    polygons.push(polygon);
  }
  return { rings: [...polygons, ...closed], cut };
}

function buildRegions(surface: Surface, rings: BoundaryPoint[][], options: FaceOptions): Region[] {
  let all = rings.filter(r => r.length >= 2);
  let uRange: [number, number] = [surface.u0, surface.u1];
  let vRange: [number, number] = [surface.v0, surface.v1];
  if (surface.uPeriod !== null && all.length) {
    const apex = surface.poles?.vApex;
    const result = cutAtSeam(surface, all, 0, (b, up) => {
      if (up) return Number.isFinite(surface.v1) ? surface.v1 : apex !== undefined && apex >= b ? apex : null;
      return Number.isFinite(surface.v0) ? surface.v0 : apex !== undefined && apex <= b ? apex : null;
    }, surface.vPeriod, options);
    all = result.rings;
    uRange = [result.cut, result.cut + surface.uPeriod];
  }
  if (surface.vPeriod !== null && all.length) {
    // In the canonical frame for v, the second parameter is -u.
    const [u0, u1] = uRange;
    const result = cutAtSeam(surface, all, 1, (_b, up) => {
      if (up) return Number.isFinite(u0) ? -u0 : null;
      return Number.isFinite(u1) ? -u1 : null;
    }, null, options);
    all = result.rings;
    vRange = [result.cut, result.cut + surface.vPeriod];
  }
  const outers: BoundaryPoint[][] = [];
  let holes: BoundaryPoint[][] = [];
  for (const ring of all) if (ring.length >= 3) (area(ring) >= 0 ? outers : holes).push(ring);

  if (outers.length === 0) {
    const finite = (r: [number, number]) => Number.isFinite(r[0]) && Number.isFinite(r[1]);
    if ((surface.uPeriod !== null || surface.vPeriod !== null) && finite(uRange) && finite(vRange)) {
      // Only holes, or no loops at all, on a closed surface: the face is the whole domain minus them.
      const [u0, u1] = uRange, [v0, v1] = vRange;
      const corners: Vec2[] = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      const outer: BoundaryPoint[] = [];
      for (let i = 0; i < 4; i++) outer.push(...artificial(surface, corners[i]!, corners[(i + 1) % 4]!, options));
      outers.push(outer);
    } else if (holes.length) {
      // Loops all clockwise on an open surface: the orientation is inconsistent, so take the
      // largest loop as the outer boundary.
      holes.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
      outers.push(holes.shift()!.slice().reverse());
      holes = holes.map(h => (area(h) > 0 ? h.slice().reverse() : h));
    }
  }
  const regions: Region[] = outers.map(outer => ({ outer, holes: [] }));
  if (regions.length === 0) return regions;
  const areas = regions.map(r => Math.abs(area(r.outer)));
  for (const hole of holes) {
    // The smallest outer boundary containing the hole.
    let target = -1;
    const q = hole[0]!.uv;
    regions.forEach((r, i) => {
      if (inside(q, r.outer) && (target < 0 || areas[i]! < areas[target]!)) target = i;
    });
    if (target < 0) target = areas.indexOf(Math.max(...areas));
    regions[target]!.holes.push(hole);
  }
  return regions;
}

/** Removes points that coincide in (u, v) with the one before. */
function cleanRing(ring: BoundaryPoint[], su: number, sv: number, eps: number): BoundaryPoint[] {
  const out: BoundaryPoint[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot((p.uv[0] - last.uv[0]) * su, (p.uv[1] - last.uv[1]) * sv) <= eps) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0]!, b = out[out.length - 1]!;
    if (Math.hypot((a.uv[0] - b.uv[0]) * su, (a.uv[1] - b.uv[1]) * sv) <= eps) out.pop();
    else break;
  }
  return out;
}

class Refiner {
  uv: Vec2[] = [];
  /** Output positions: the exact edge points on the boundary, surface points inside. */
  p: Vec3[] = [];
  /** Surface points at each vertex's (u, v), for measuring how flat the surface is. */
  q: Vec3[] = [];
  n: (Vec3 | null)[] = [];
  /** 1 where u is undefined (a pole, where du is zero), 2 where v is, 0 elsewhere. */
  singular: number[] = [];
  /** Triangles, three vertex indices each, counter-clockwise in (u, v); -1 for removed ones. */
  tris: number[] = [];
  private edges = new Map<number, number[]>();
  boundary = new Set<number>();

  constructor(readonly surface: Surface, readonly su: number, readonly sv: number) {}

  key(a: number, b: number): number {
    return a < b ? a * 0x4000000 + b : b * 0x4000000 + a;
  }

  addVertex(uv: Vec2, p?: Vec3): number {
    const [point, du, dv] = this.surface.evaluate(uv[0], uv[1]);
    this.uv.push(uv);
    this.p.push(p ?? point);
    this.q.push(point);
    this.n.push(surfaceNormal(du, dv));
    const lu = length(du), lv = length(dv);
    this.singular.push(lu <= 1e-9 * lv ? 1 : lv <= 1e-9 * lu ? 2 : 0);
    return this.uv.length - 1;
  }

  /**
   * The (u, v) halfway along edge (a, b). At a pole the undefined parameter is taken from the
   * other end, so the midpoint is on the meridian rather than off to one side.
   */
  midpoint(a: number, b: number): Vec2 {
    const ua = this.uv[a]!, ub = this.uv[b]!;
    let u = (ua[0] + ub[0]) / 2, v = (ua[1] + ub[1]) / 2;
    const sa = this.singular[a], sb = this.singular[b];
    if (sa === 1 && sb !== 1) u = ub[0];
    else if (sb === 1 && sa !== 1) u = ua[0];
    if (sa === 2 && sb !== 2) v = ub[1];
    else if (sb === 2 && sa !== 2) v = ua[1];
    return [u, v];
  }

  private link(t: number): void {
    for (let k = 0; k < 3; k++) {
      const a = this.tris[t * 3 + k]!, b = this.tris[t * 3 + ((k + 1) % 3)]!;
      const key = this.key(a, b);
      const list = this.edges.get(key);
      if (list) list.push(t);
      else this.edges.set(key, [t]);
    }
  }

  private unlink(t: number): void {
    for (let k = 0; k < 3; k++) {
      const a = this.tris[t * 3 + k]!, b = this.tris[t * 3 + ((k + 1) % 3)]!;
      const key = this.key(a, b);
      const list = this.edges.get(key);
      if (!list) continue;
      const i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.edges.delete(key);
    }
  }

  addTriangle(a: number, b: number, c: number): number {
    const t = this.tris.length / 3;
    this.tris.push(a, b, c);
    this.link(t);
    this.touch(t);
    return t;
  }

  private replace(t: number, a: number, b: number, c: number): void {
    this.unlink(t);
    this.tris[t * 3] = a;
    this.tris[t * 3 + 1] = b;
    this.tris[t * 3 + 2] = c;
    this.link(t);
    this.touch(t);
  }

  get triangleCount(): number {
    return this.tris.length / 3;
  }

  private s(i: number): Vec2 {
    const uv = this.uv[i]!;
    return [uv[0] * this.su, uv[1] * this.sv];
  }

  private orient(a: number, b: number, c: number): number {
    const A = this.s(a), B = this.s(b), C = this.s(c);
    return (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
  }

  /** orient() with a point given by its (u, v) in place of one or two vertices. */
  private orientAt(a: number | Vec2, b: number | Vec2, c: number | Vec2): number {
    const s = (x: number | Vec2): Vec2 => (typeof x === 'number' ? this.s(x) : [x[0] * this.su, x[1] * this.sv]);
    const A = s(a), B = s(b), C = s(c);
    return (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
  }

  /** The vertex of triangle t opposite edge (a, b). */
  private opposite(t: number, a: number, b: number): number {
    for (let k = 0; k < 3; k++) {
      const v = this.tris[t * 3 + k]!;
      if (v !== a && v !== b) return v;
    }
    return -1;
  }

  /** Whether (a, b) runs a -> b in triangle t. */
  private forward(t: number, a: number, b: number): boolean {
    for (let k = 0; k < 3; k++) if (this.tris[t * 3 + k] === a && this.tris[t * 3 + ((k + 1) % 3)] === b) return true;
    return false;
  }

  /** Splits edge (a, b) at its (u, v) midpoint, and each triangle on it in two. */
  splitEdge(a: number, b: number): boolean {
    const key = this.key(a, b);
    const list = this.edges.get(key);
    if (!list || list.length === 0 || this.boundary.has(key)) return false;
    // The new vertex must be strictly inside both triangles on the edge, or they would fold.
    const fits = (uv: Vec2) => list.every(t => {
      const [x, y] = this.forward(t, a, b) ? [a, b] : [b, a];
      const c = this.opposite(t, x, y);
      return this.orientAt(x, uv, c) > 0 && this.orientAt(uv, y, c) > 0;
    });
    let uv = this.midpoint(a, b);
    if (!fits(uv)) {
      const ua = this.uv[a]!, ub = this.uv[b]!;
      uv = [(ua[0] + ub[0]) / 2, (ua[1] + ub[1]) / 2];
      if (!fits(uv)) return false;
    }
    const m = this.addVertex(uv);
    for (const t of list.slice()) {
      const [x, y] = this.forward(t, a, b) ? [a, b] : [b, a];
      const c = this.opposite(t, x, y);
      this.replace(t, x, m, c);
      this.addTriangle(m, y, c);
    }
    return true;
  }

  /** Splits a triangle into three at a point inside it. */
  splitTriangle(t: number, uv: Vec2): void {
    const a = this.tris[t * 3]!, b = this.tris[t * 3 + 1]!, c = this.tris[t * 3 + 2]!;
    const m = this.addVertex(uv);
    this.replace(t, a, b, m);
    this.addTriangle(b, c, m);
    this.addTriangle(c, a, m);
  }

  /**
   * Inserts a point inside the mesh: finds the triangle holding it by walking across edges
   * towards it, and splits that triangle in three. Points on edges or outside are skipped.
   */
  insert(uv: Vec2): boolean {
    const count = this.triangleCount;
    if (count === 0) return false;
    let t = this.lastFound < count ? this.lastFound : 0;
    for (let steps = 0; steps < count + 8; steps++) {
      let moved = false;
      for (let k = 0; k < 3; k++) {
        const a = this.tris[t * 3 + k]!, b = this.tris[t * 3 + ((k + 1) % 3)]!;
        if (this.orientAt(a, b, uv) >= 0) continue;
        // The point is beyond edge (a, b): step to the triangle on the other side, if any.
        const list = this.edges.get(this.key(a, b));
        const other = list?.find(x => x !== t);
        if (other === undefined) return this.insertSlow(uv);
        t = other;
        moved = true;
        break;
      }
      if (!moved) {
        this.lastFound = t;
        return this.splitAt(t, uv);
      }
    }
    return this.insertSlow(uv);
  }

  private lastFound = 0;

  private insertSlow(uv: Vec2): boolean {
    for (let t = 0; t < this.triangleCount; t++) {
      const a = this.tris[t * 3]!, b = this.tris[t * 3 + 1]!, c = this.tris[t * 3 + 2]!;
      if (this.orientAt(a, b, uv) > 0 && this.orientAt(b, c, uv) > 0 && this.orientAt(c, a, uv) > 0) return this.splitAt(t, uv);
    }
    return false;
  }

  private splitAt(t: number, uv: Vec2): boolean {
    const a = this.tris[t * 3]!, b = this.tris[t * 3 + 1]!, c = this.tris[t * 3 + 2]!;
    const area = this.orient(a, b, c);
    const eps = 1e-6 * Math.abs(area);
    if (this.orientAt(a, b, uv) <= eps || this.orientAt(b, c, uv) <= eps || this.orientAt(c, a, uv) <= eps) return false;
    this.splitTriangle(t, uv);
    return true;
  }

  /** Lawson flips towards a Delaunay triangulation in scaled (u, v). */
  /** Edges whose Delaunay condition may no longer hold: the edges of changed triangles. */
  private dirty = new Set<number>();
  private dirtyAll = true;

  private touch(t: number): void {
    for (let k = 0; k < 3; k++) this.dirty.add(this.key(this.tris[t * 3 + k]!, this.tris[t * 3 + ((k + 1) % 3)]!));
  }

  /**
   * Lawson flips towards a Delaunay triangulation in scaled (u, v), checking only edges near the
   * triangles changed since the last call (all of them the first time).
   */
  flipAll(limit: number): void {
    let queue = this.dirtyAll ? [...this.edges.keys()] : [...this.dirty];
    this.dirtyAll = false;
    this.dirty.clear();
    for (let pass = 0; pass < limit && queue.length; pass++) {
      const next = new Set<number>();
      for (const key of queue) {
        const list = this.edges.get(key);
        if (!list || list.length !== 2 || this.boundary.has(key)) continue;
        const [t1, t2] = list as [number, number];
        let a = -1, b = -1;
        for (let k = 0; k < 3; k++) {
          const x = this.tris[t1 * 3 + k]!, y = this.tris[t1 * 3 + ((k + 1) % 3)]!;
          if (this.key(x, y) === key) {
            a = x;
            b = y;
          }
        }
        if (a < 0) continue;
        const c = this.opposite(t1, a, b), d = this.opposite(t2, a, b);
        if (c < 0 || d < 0 || c === d) continue;
        if (!this.inCircle(a, b, c, d)) continue;
        // The flipped triangles must both stay counter-clockwise.
        if (this.orient(c, a, d) <= 0 || this.orient(d, b, c) <= 0) continue;
        if (this.edges.has(this.key(c, d))) continue;
        this.replace(t1, c, a, d);
        this.replace(t2, d, b, c);
        // The quad's outer edges may now need flipping.
        for (const [x, y] of [[c, a], [a, d], [d, b], [b, c]] as const) next.add(this.key(x, y));
      }
      queue = [...next];
    }
    this.dirty.clear();
  }

  private inCircle(a: number, b: number, c: number, d: number): boolean {
    const A = this.s(a), B = this.s(b), C = this.s(c), D = this.s(d);
    const ax = A[0] - D[0], ay = A[1] - D[1], bx = B[0] - D[0], by = B[1] - D[1], cx = C[0] - D[0], cy = C[1] - D[1];
    const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
    const scale = (ax * ax + ay * ay + bx * bx + by * by + cx * cx + cy * cy) ** 2;
    return det > 1e-12 * scale;
  }

  /** One pass of refinement: splits edges and triangles that are too far from the surface. */
  refinePass(options: FaceOptions): number {
    // Diagonals across a boundary step turn by up to about √2 times the step's angle.
    const cosAngle = Math.cos(Math.min(Math.PI / 2, options.angle * 1.5));
    const edgeSplits = new Map<number, [number, number, number]>();
    const triangleSplits: [number, Vec2][] = [];
    const count = this.triangleCount;
    for (let t = 0; t < count; t++) {
      const v = [this.tris[t * 3]!, this.tris[t * 3 + 1]!, this.tris[t * 3 + 2]!] as const;
      let worstEdge = -1, worst = 0;
      for (let k = 0; k < 3; k++) {
        const a = v[k]!, b = v[(k + 1) % 3]!;
        const key = this.key(a, b);
        if (this.boundary.has(key)) continue;
        const already = edgeSplits.get(key);
        let error: number;
        if (already) error = already[2];
        else {
          error = this.edgeError(a, b, options, cosAngle);
        }
        if (error > worst) {
          worst = error;
          worstEdge = k;
        }
      }
      if (worstEdge >= 0 && worst > 1) {
        const a = v[worstEdge]!, b = v[(worstEdge + 1) % 3]!;
        edgeSplits.set(this.key(a, b), [a, b, worst]);
        continue;
      }
      // Edges are fine: check the middle of the triangle.
      const uv: Vec2 = [(this.uv[v[0]]![0] + this.uv[v[1]]![0] + this.uv[v[2]]![0]) / 3, (this.uv[v[0]]![1] + this.uv[v[1]]![1] + this.uv[v[2]]![1]) / 3];
      const s = this.surface.evaluate(uv[0], uv[1])[0];
      // Against the surface's own points: boundary points may be off the surface by the file's
      // modelling tolerance, and no amount of splitting closes that gap.
      const pa = this.q[v[0]]!, pb = this.q[v[1]]!, pc = this.q[v[2]]!;
      const normal = cross(sub(pb, pa), sub(pc, pa));
      const nl = length(normal);
      const deviation = nl > 0 ? Math.abs(dot(sub(s, pa), normal)) / nl : 0;
      if (deviation > options.tolerance * INTERIOR_MARGIN) {
        // Split the longest interior edge, or the triangle itself if all its edges are boundary.
        let longest = -1, longestLength = 0;
        for (let k = 0; k < 3; k++) {
          const a = v[k]!, b = v[(k + 1) % 3]!;
          if (this.boundary.has(this.key(a, b))) continue;
          const l = length(sub(this.q[a]!, this.q[b]!));
          if (l > longestLength) {
            longestLength = l;
            longest = k;
          }
        }
        if (longest >= 0) {
          const a = v[longest]!, b = v[(longest + 1) % 3]!;
          if (!edgeSplits.has(this.key(a, b))) edgeSplits.set(this.key(a, b), [a, b, deviation / (options.tolerance * INTERIOR_MARGIN)]);
        } else {
          triangleSplits.push([t, uv]);
        }
      }
    }
    let splits = 0;
    for (const [t, uv] of triangleSplits) {
      this.splitTriangle(t, uv);
      splits++;
    }
    const ordered = [...edgeSplits.values()].sort((x, y) => y[2] - x[2]);
    for (const [a, b] of ordered) {
      if (this.triangleCount >= options.maxTriangles) break;
      if (this.splitEdge(a, b)) splits++;
    }
    return splits;
  }

  /** How far over the tolerances an edge is: above 1 means split it. */
  private edgeError(a: number, b: number, options: FaceOptions, cosAngle: number): number {
    const mid2 = this.midpoint(a, b);
    const s = this.surface.evaluate(mid2[0], mid2[1])[0];
    const pa = this.q[a]!, pb = this.q[b]!;
    const mid: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
    // Boundary curves are sampled to the tolerance, so a diagonal between neighbouring boundary
    // points is about that far from the surface too; the margin keeps those from being split.
    let error = length(sub(s, mid)) / (options.tolerance * INTERIOR_MARGIN);
    const na = this.n[a], nb = this.n[b];
    if (na && nb) {
      const c = dot(na, nb);
      if (c < cosAngle) error = Math.max(error, 1 + (cosAngle - c) * 10);
    }
    return error;
  }
}

/** Distance from a point to a segment, in 2D. */
function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

interface GridEstimate {
  /** Grid steps each direction needs; 1 for a flat direction. */
  steps: [number, number];
  /** Largest curvature found along each direction, per unit length. */
  curvature: [number, number];
  /** Average length of an iso-line across the region in each direction. */
  length: [number, number];
}

/**
 * How many grid steps each direction of a region needs: from the turning and the curvature of
 * iso-lines sampled across it, against the angle and chord tolerances. Flat directions need one.
 */
function gridSteps(surface: Surface, box: [number, number, number, number], options: FaceOptions): GridEstimate {
  const [u0, u1, v0, v1] = box;
  const along = (direction: 0 | 1): [number, number, number] => {
    let steps = 1, maxCurvature = 0, lengths = 0;
    const samples = 64;
    for (let line = 0; line <= 4; line++) {
      const across = direction === 0 ? v0 + ((v1 - v0) * line) / 4 : u0 + ((u1 - u0) * line) / 4;
      const pts: Vec3[] = [];
      for (let i = 0; i <= samples; i++) {
        const t = direction === 0 ? u0 + ((u1 - u0) * i) / samples : v0 + ((v1 - v0) * i) / samples;
        pts.push(direction === 0 ? surface.evaluate(t, across)[0] : surface.evaluate(across, t)[0]);
      }
      let turning = 0, total = length(sub(pts[1]!, pts[0]!)), curvature = 0;
      for (let i = 1; i < samples; i++) {
        const a = sub(pts[i]!, pts[i - 1]!), b = sub(pts[i + 1]!, pts[i]!);
        const la = length(a), lb = length(b);
        total += lb;
        if (!(la > 0 && lb > 0)) continue;
        const turn = Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (la * lb))));
        turning += turn;
        curvature = Math.max(curvature, (2 * turn) / (la + lb));
      }
      // Steps for the turning angle, and for the sagitta c²κ/8 to stay within the tolerance.
      const byAngle = turning / options.angle;
      const byChord = curvature > 0 ? total * Math.sqrt(curvature / (8 * options.tolerance)) : 0;
      steps = Math.max(steps, Math.ceil(Math.max(byAngle, byChord)));
      maxCurvature = Math.max(maxCurvature, curvature);
      lengths += total / 5;
    }
    return [Math.min(256, steps), maxCurvature, lengths];
  };
  const [nu, ku, lu] = along(0);
  const [nv, kv, lv] = along(1);
  return { steps: [nu, nv], curvature: [ku, kv], length: [lu, lv] };
}

/**
 * Adds interior points on a grid fitted to the surface's curvature, so refinement starts from a
 * well-spread mesh instead of long triangles between boundary points.
 */
function seedInterior(refiner: Refiner, outer: BoundaryPoint[], holes: BoundaryPoint[][], steps: [number, number], options: FaceOptions): void {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of outer) {
    u0 = Math.min(u0, p.uv[0]); u1 = Math.max(u1, p.uv[0]);
    v0 = Math.min(v0, p.uv[1]); v1 = Math.max(v1, p.uv[1]);
  }
  if (!(u1 > u0) || !(v1 > v0)) return;
  let [nu, nv] = steps;
  if (nu < 2 && nv < 2) return;
  // Keep the seed within the face's triangle budget.
  const budget = options.maxTriangles / 4;
  if (nu * nv > budget) {
    const k = Math.sqrt(budget / (nu * nv));
    nu = Math.max(1, Math.floor(nu * k));
    nv = Math.max(1, Math.floor(nv * k));
  }
  const su = refiner.su, sv = refiner.sv;
  const cell = Math.min(nu > 1 ? ((u1 - u0) * su) / nu : Infinity, nv > 1 ? ((v1 - v0) * sv) / nv : Infinity);
  const clearance = cell * 0.4;
  // Boundary segments in scaled (u, v), bucketed by cells of the clearance's size.
  const segments: [Vec2, Vec2][] = [];
  for (const ring of [outer, ...holes]) {
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k]!.uv, b = ring[(k + 1) % ring.length]!.uv;
      segments.push([[a[0] * su, a[1] * sv], [b[0] * su, b[1] * sv]]);
    }
  }
  const size = clearance > 0 && Number.isFinite(clearance) ? clearance : 1;
  const buckets = new Map<string, number[]>();
  segments.forEach(([a, b], index) => {
    const x0 = Math.floor(Math.min(a[0], b[0]) / size), x1 = Math.floor(Math.max(a[0], b[0]) / size);
    const y0 = Math.floor(Math.min(a[1], b[1]) / size), y1 = Math.floor(Math.max(a[1], b[1]) / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x},${y}`;
      const list = buckets.get(key);
      if (list) list.push(index);
      else buckets.set(key, [index]);
    }
  });
  const nearBoundary = (s: Vec2) => {
    const bx = Math.floor(s[0] / size), by = Math.floor(s[1] / size);
    for (let x = bx - 1; x <= bx + 1; x++) for (let y = by - 1; y <= by + 1; y++) {
      for (const index of buckets.get(`${x},${y}`) ?? []) {
        const [a, b] = segments[index]!;
        if (segmentDistance(s, a, b) < clearance) return true;
      }
    }
    return false;
  };
  const rings = [outer, ...holes];
  for (let j = nv > 1 ? 1 : 0; j < (nv > 1 ? nv : 1); j++) {
    const v = nv > 1 ? v0 + ((v1 - v0) * j) / nv : (v0 + v1) / 2;
    // Where this row crosses the boundary: points between odd and even crossings are inside.
    const xs: number[] = [];
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k]!.uv, b = ring[(k + 1) % ring.length]!.uv;
        if (a[1] > v !== b[1] > v) xs.push(a[0] + ((b[0] - a[0]) * (v - a[1])) / (b[1] - a[1]));
      }
    }
    xs.sort((x, y) => x - y);
    let crossing = 0;
    for (let i = nu > 1 ? 1 : 0; i < (nu > 1 ? nu : 1); i++) {
      const u = nu > 1 ? u0 + ((u1 - u0) * i) / nu : (u0 + u1) / 2;
      while (crossing < xs.length && xs[crossing]! < u) crossing++;
      if (crossing % 2 === 0) continue;
      if (nearBoundary([u * su, v * sv])) continue;
      refiner.insert([u, v]);
    }
  }
}

function meshRegion(surface: Surface, sense: boolean, region: Region, options: FaceOptions, out: FaceMesh): void {
  // Scale (u, v) by the surface's average speed in each direction so the domain is close to
  // isometric, which keeps the triangles' shapes sensible in 3D.
  const all = region.outer.map(p => p.uv);
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const uv of all) {
    umin = Math.min(umin, uv[0]); umax = Math.max(umax, uv[0]);
    vmin = Math.min(vmin, uv[1]); vmax = Math.max(vmax, uv[1]);
  }
  let su = 0, sv = 0, samples = 0;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const u = umin + ((umax - umin) * i) / 4, v = vmin + ((vmax - vmin) * j) / 4;
    const [, du, dv] = surface.evaluate(u, v);
    const lu = length(du), lv = length(dv);
    if (lu > 0 && lv > 0 && Number.isFinite(lu) && Number.isFinite(lv)) {
      su += lu;
      sv += lv;
      samples++;
    }
  }
  if (samples === 0 || !(su > 0) || !(sv > 0)) {
    su = 1;
    sv = 1;
  } else {
    su /= samples;
    sv /= samples;
  }
  // Only points that really coincide: faces can be slivers far thinner than the tolerance.
  const eps = options.tolerance * 1e-6;
  const outer = cleanRing(region.outer, su, sv, eps);
  const holes = region.holes.map(h => cleanRing(h, su, sv, eps)).filter(h => h.length >= 3);
  if (outer.length < 3) return;
  // On curved surfaces, scale by the grid density the curvature needs in each direction instead,
  // so the grid's cells are square and Delaunay flips connect grid neighbours.
  const estimate = surface.planar || !(umax > umin) || !(vmax > vmin) ? null : gridSteps(surface, [umin, umax, vmin, vmax], options);
  const steps: [number, number] = estimate ? estimate.steps : [1, 1];
  if (steps[0] >= 2 && steps[1] >= 2) {
    su = steps[0] / (umax - umin);
    sv = steps[1] / (vmax - vmin);
  } else if (steps[0] >= 2) {
    const ratio = sv / su;
    su = steps[0] / (umax - umin);
    sv = su * ratio;
  } else if (steps[1] >= 2) {
    const ratio = su / sv;
    sv = steps[1] / (vmax - vmin);
    su = sv * ratio;
  }

  const refiner = new Refiner(surface, su, sv);
  const rings = [outer, ...holes];
  const ringStart: number[] = [];
  for (const ring of rings) {
    ringStart.push(refiner.uv.length);
    for (const p of ring) refiner.addVertex(p.uv, p.p);
  }
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) refiner.boundary.add(refiner.key(ringStart[r]! + i, ringStart[r]! + ((i + 1) % ring.length)));
  });
  const scaled = (ring: BoundaryPoint[]) => ring.map(p => [p.uv[0] * su, p.uv[1] * sv] as Vec2);
  const triangles = triangulate(scaled(outer), holes.map(scaled));
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = triangles[i]!, b = triangles[i + 1]!, c = triangles[i + 2]!;
    if (a === b || b === c || a === c) continue;
    refiner.addTriangle(a, b, c);
  }
  refiner.flipAll(200);
  if (!surface.planar) {
    seedInterior(refiner, outer, holes, steps, options);
    refiner.flipAll(200);
    for (let pass = 0; pass < 24; pass++) {
      if (refiner.triangleCount >= options.maxTriangles) break;
      if (refiner.refinePass(options) === 0) break;
      refiner.flipAll(200);
    }
  }
  emit(refiner, sense, out);
}

function emit(refiner: Refiner, sense: boolean, out: FaceMesh): void {
  const base = out.positions.length / 3;
  const count = refiner.uv.length;
  // Normals undefined at poles come from the triangles around them.
  const fallback: Vec3[] = [];
  for (let i = 0; i < count; i++) fallback.push([0, 0, 0]);
  const kept: number[] = [];
  for (let t = 0; t < refiner.triangleCount; t++) {
    const a = refiner.tris[t * 3]!, b = refiner.tris[t * 3 + 1]!, c = refiner.tris[t * 3 + 2]!;
    const pa = refiner.p[a]!, pb = refiner.p[b]!, pc = refiner.p[c]!;
    const n = cross(sub(pb, pa), sub(pc, pa));
    const l = length(n);
    const size = Math.max(length(sub(pb, pa)), length(sub(pc, pa)), length(sub(pc, pb)));
    if (!(l > 1e-14 * size * size)) continue;
    kept.push(a, b, c);
    for (const v of [a, b, c]) {
      const f = fallback[v]!;
      f[0] += n[0]; f[1] += n[1]; f[2] += n[2];
    }
  }
  const sign = sense ? 1 : -1;
  for (let i = 0; i < count; i++) {
    const p = refiner.p[i]!;
    out.positions.push(p[0], p[1], p[2]);
    let n = refiner.n[i];
    if (!n) {
      const f = fallback[i]!;
      const l = length(f) || 1;
      n = [f[0] / l, f[1] / l, f[2] / l];
    }
    out.normals.push(n[0] * sign, n[1] * sign, n[2] * sign);
  }
  for (let i = 0; i < kept.length; i += 3) {
    if (sense) out.indices.push(base + kept[i]!, base + kept[i + 1]!, base + kept[i + 2]!);
    else out.indices.push(base + kept[i]!, base + kept[i + 2]!, base + kept[i + 1]!);
  }
}
