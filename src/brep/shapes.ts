// Tessellates shape representation items: B-rep solids, shells and surface models through their
// faces, loops and edges, and AP242 tessellated items, into meshes grouped by colour.

import { length, sub, type Vec3 } from '../geometry/math.js';
import { MeshBuilder, vertexNormals, type MeshData } from '../geometry/mesh.js';
import { triangulate3D } from '../geometry/triangulate.js';
import { bool, list, num, numbers, refId, refIds, str, type StepModel } from '../step/access.js';
import type { StepEntity } from '../step/step.js';
import type { Curve } from './curves.js';
import { tessellateFace, type FaceOptions } from './face.js';
import type { GeometryReader } from './geometry.js';
import { DEFAULT_STYLE, styleKey, type StepStyle, type StyleTable } from './styles.js';

export interface TessellationOptions {
  /** Chord tolerance as a fraction of each solid's size. */
  relativeTolerance: number;
  /** Chord tolerance in the representation's length units; overrides the relative one. */
  absoluteTolerance: number | null;
  /** Largest angle between neighbouring normals, and per curve segment, in radians. */
  angularTolerance: number;
  /** Refinement stops at this many triangles per face. */
  maxTrianglesPerFace: number;
}

export interface StyledMesh {
  /** Name of the item: the solid's or shell's own, if it has one. */
  name: string;
  /** Id of the shape representation item it came from. */
  itemId: number;
  /** The STEP type of that item, such as MANIFOLD_SOLID_BREP. */
  itemType: string;
  style: StepStyle;
  data: MeshData;
  /**
   * The faces' boundary loops (their edges) as line segments: pairs of points in the same
   * coordinates as `data`. An edge two faces share is in once. Null where there are no loops,
   * as for AP242 tessellated shapes.
   */
  edges: Float32Array | null;
}

export interface TessellationStats {
  faces: number;
  failedFaces: number;
  triangles: number;
}

/** Collects repeated messages so a file with many similar problems gives a short list. */
export class Warnings {
  private readonly counts = new Map<string, number>();
  add(message: string): void {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([message, count]) => (count > 1 ? `${message} (${count} times)` : message));
  }
}

const SOLIDS = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'FACETED_BREP_AND_BREP_WITH_VOIDS'];
const SURFACE_MODELS = ['SHELL_BASED_SURFACE_MODEL', 'FACE_BASED_SURFACE_MODEL'];
const SHELLS = ['CLOSED_SHELL', 'OPEN_SHELL', 'CONNECTED_FACE_SET', 'ORIENTED_CLOSED_SHELL', 'ORIENTED_OPEN_SHELL'];
const FACES = ['ADVANCED_FACE', 'FACE_SURFACE', 'FACE', 'ORIENTED_FACE'];
const TESSELLATED = ['TESSELLATED_SOLID', 'TESSELLATED_SHELL', 'TRIANGULATED_FACE', 'COMPLEX_TRIANGULATED_FACE', 'TRIANGULATED_SURFACE_SET', 'COMPLEX_TRIANGULATED_SURFACE_SET'];

/** Types of representation items this module draws. */
export const SHAPE_ITEM_TYPES = [...SOLIDS, ...SURFACE_MODELS, ...SHELLS, ...FACES, ...TESSELLATED];

interface FaceRef {
  id: number;
  flip: boolean;
  style: StepStyle | null;
}

export class ShapeTessellator {
  private readonly edges = new Map<number, Vec3[]>();

  constructor(
    readonly model: StepModel,
    readonly geometry: GeometryReader,
    readonly styles: StyleTable,
    readonly options: TessellationOptions,
    readonly warnings: Warnings,
    readonly stats: TessellationStats,
  ) {}

  isShape(entity: StepEntity | undefined): boolean {
    return this.model.is(entity, ...SHAPE_ITEM_TYPES);
  }

  /** Meshes of one item, one per colour. Hidden items and those without faces give none. */
  tessellate(itemId: number, inherited: StepStyle | null): StyledMesh[] {
    const m = this.model;
    const e = m.get(itemId);
    if (!e || this.styles.hidden.has(itemId)) return [];
    const faces: FaceRef[] = [];
    const tessellated: FaceRef[] = [];
    this.collect(itemId, false, this.styles.byItem.get(itemId) ?? inherited, faces, tessellated, 0);
    const groups = new Map<string, { style: StepStyle; builder: MeshBuilder; edges: EdgeCollector }>();
    const drawn = new Set<number>();
    const groupOf = (style: StepStyle | null) => {
      const s = style ?? DEFAULT_STYLE;
      const key = styleKey(s);
      let g = groups.get(key);
      if (!g) {
        g = { style: s, builder: new MeshBuilder(), edges: new EdgeCollector(drawn) };
        groups.set(key, g);
      }
      return g;
    };
    if (faces.length) {
      const options = this.faceOptions(faces);
      for (const face of faces) {
        const g = groupOf(face.style);
        this.face(face, options, g.builder, g.edges);
      }
    }
    for (const face of tessellated) this.tessellatedFace(face, groupOf(face.style).builder);
    const name = str(e.args[0]);
    const out: StyledMesh[] = [];
    for (const { style, builder, edges } of groups.values()) {
      if (builder.triangleCount === 0) continue;
      this.stats.triangles += builder.triangleCount;
      out.push({ name, itemId, itemType: m.displayType(e), style, data: builder.build(), edges: edges.build() });
    }
    return out;
  }

  private collect(id: number, flip: boolean, style: StepStyle | null, faces: FaceRef[], tessellated: FaceRef[], depth: number): void {
    const m = this.model;
    const e = m.get(id);
    if (!e || depth > 16 || this.styles.hidden.has(id)) return;
    const own = this.styles.byItem.get(id) ?? style;
    const t = e.type;
    if (SOLIDS.includes(t)) {
      this.collect(refId(e.args[1])!, flip, own, faces, tessellated, depth + 1);
      if (t !== 'MANIFOLD_SOLID_BREP' && t !== 'FACETED_BREP') for (const v of refIds(e.args[2])) this.collect(v, flip, own, faces, tessellated, depth + 1);
    } else if (t === 'SHELL_BASED_SURFACE_MODEL' || t === 'FACE_BASED_SURFACE_MODEL') {
      for (const s of refIds(e.args[1])) this.collect(s, flip, own, faces, tessellated, depth + 1);
    } else if (t === 'ORIENTED_CLOSED_SHELL' || t === 'ORIENTED_OPEN_SHELL') {
      // (name, *, element, orientation)
      this.collect(refId(e.args[2])!, flip !== !bool(e.args[3], true), own, faces, tessellated, depth + 1);
    } else if (t === 'CLOSED_SHELL' || t === 'OPEN_SHELL' || t === 'CONNECTED_FACE_SET') {
      for (const f of refIds(e.args[1])) this.collect(f, flip, own, faces, tessellated, depth + 1);
    } else if (t === 'ORIENTED_FACE') {
      const face = refId(e.args[2]);
      if (face !== null) {
        const faceStyle = this.styles.byItem.get(face) ?? own;
        faces.push({ id: face, flip: flip !== !bool(e.args[3], true), style: faceStyle });
      }
    } else if (t === 'ADVANCED_FACE' || t === 'FACE_SURFACE' || t === 'FACE') {
      faces.push({ id, flip, style: own });
    } else if (t === 'TESSELLATED_SOLID' || t === 'TESSELLATED_SHELL') {
      for (const f of refIds(e.args[1])) this.collect(f, flip, own, faces, tessellated, depth + 1);
    } else if (TESSELLATED.includes(t)) {
      tessellated.push({ id, flip, style: own });
    }
  }

  /** Tolerances for a set of faces, from the size of their vertices' bounding box. */
  private faceOptions(faces: FaceRef[]): FaceOptions {
    const o = this.options;
    let tolerance = o.absoluteTolerance;
    if (tolerance === null || !(tolerance > 0)) {
      const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
      const add = (p: Vec3) => {
        for (let k = 0; k < 3; k++) {
          if (p[k]! < min[k]!) min[k] = p[k]!;
          if (p[k]! > max[k]!) max[k] = p[k]!;
        }
      };
      // An edge's vertices, and for curves that bulge away from them, their extent.
      const seen = new Set<number>();
      const addEdge = (edge: StepEntity) => {
        if (seen.has(edge.id)) return;
        seen.add(edge.id);
        add(this.safePoint(refId(edge.args[1])));
        add(this.safePoint(refId(edge.args[2])));
        let curve = this.model.deref(edge.args[3]);
        for (let depth = 0; curve && /^(SURFACE_CURVE|SEAM_CURVE|INTERSECTION_CURVE|TRIMMED_CURVE)$/.test(curve.type) && depth < 4; depth++) curve = this.model.deref(curve.args[1]);
        if (!curve) return;
        if (curve.type === 'CIRCLE' || curve.type === 'ELLIPSE') {
          // An arc's extent is that of the arc between its vertices, not of its whole circle: a
          // short arc of a large circle, such as a meridian of a flat dome, would otherwise make
          // the solid seem many times its size and its tolerance that much coarser.
          const arc = refId(edge.args[1]) !== refId(edge.args[2]) ? this.arcPoints(edge) : null;
          if (arc) {
            for (const p of arc) add(p);
          } else {
            const centre = this.safePoint(refId(this.model.deref(curve.args[1])?.args[1]));
            const r = Math.max(num(curve.args[2]), num(curve.args[3]));
            add([centre[0] - r, centre[1] - r, centre[2] - r]);
            add([centre[0] + r, centre[1] + r, centre[2] + r]);
          }
        } else if (this.model.is(curve, 'B_SPLINE_CURVE', 'B_SPLINE_CURVE_WITH_KNOTS', 'BEZIER_CURVE', 'UNIFORM_CURVE', 'QUASI_UNIFORM_CURVE')) {
          const args = curve.parts ? this.model.partArgs(curve, 'B_SPLINE_CURVE') : curve.args.slice(1);
          for (const p of refIds(args?.[1])) add(this.safePoint(p));
        }
      };
      for (const face of faces) {
        const f = this.model.get(face.id);
        if (!f) continue;
        for (const bound of refIds(f.args[1])) {
          const loop = this.model.deref(this.model.get(bound)?.args[1]);
          if (!loop) continue;
          if (loop.type === 'POLY_LOOP') {
            for (const p of refIds(loop.args[1])) add(this.safePoint(p));
          } else if (loop.type === 'EDGE_LOOP') {
            for (const oe of refIds(loop.args[1])) {
              const edge = this.model.deref(this.model.get(oe)?.args[3]);
              if (edge) addEdge(edge);
            }
          }
        }
      }
      let size = Number.isFinite(min[0]) ? length(sub(max, min)) : 0;
      if (!(size > 0)) {
        // No edges to measure, as for a closed surface without boundary: use the surface's size.
        for (const face of faces) {
          const surface = this.model.deref(this.model.get(face.id)?.args[2]);
          if (surface?.type === 'SPHERICAL_SURFACE' || surface?.type === 'CYLINDRICAL_SURFACE') size = Math.max(size, 2 * num(surface.args[2]));
          else if (surface?.type === 'TOROIDAL_SURFACE' || surface?.type === 'DEGENERATE_TOROIDAL_SURFACE') size = Math.max(size, 2 * (num(surface.args[2]) + num(surface.args[3])));
        }
      }
      tolerance = size > 0 ? size * o.relativeTolerance : 1e-3;
    }
    return { tolerance, angle: o.angularTolerance, maxTriangles: o.maxTrianglesPerFace };
  }

  /** Points along an open circular or elliptical edge, a few degrees apart; null if it can't be read. */
  private arcPoints(edge: StepEntity): Vec3[] | null {
    try {
      const g = this.geometry;
      const curve = g.curve(refId(edge.args[3]));
      const start = g.point(refId(edge.args[1])), end = g.point(refId(edge.args[2]));
      // Finite, so that the ends count as apart, and loose: the turn angle sets the spacing.
      const options: FaceOptions = { tolerance: length(sub(end, start)), angle: 0.2, maxTriangles: 0 };
      return sampleEdge(curve, start, end, false, bool(edge.args[4], true), options);
    } catch {
      return null;
    }
  }

  private safePoint(id: number | null): Vec3 {
    try {
      return this.geometry.point(id);
    } catch {
      return [Number.NaN, Number.NaN, Number.NaN];
    }
  }

  private face(ref: FaceRef, options: FaceOptions, out: MeshBuilder, edges: EdgeCollector): void {
    const m = this.model;
    const e = m.get(ref.id);
    if (!e) return;
    this.stats.faces++;
    try {
      // Each bound as its edges' point runs, in the bound's direction.
      const bounds: LoopPart[][] = [];
      for (const boundId of refIds(e.args[1])) {
        const bound = m.get(boundId);
        if (!bound) continue;
        // FACE_BOUND(name, bound, orientation)
        const parts = this.loop(refId(bound.args[1]), options);
        if (!parts.length) continue;
        bounds.push(bool(bound.args[2], true) ? parts : parts.reverse().map(part => ({ edge: part.edge, points: part.points.slice().reverse() })));
      }
      // An edge the face uses twice is a seam, with the face on both sides: not drawn as a loop.
      const uses = new Map<number, number>();
      for (const parts of bounds) for (const part of parts) if (part.edge !== null) uses.set(part.edge, (uses.get(part.edge) ?? 0) + 1);
      for (const parts of bounds) for (const part of parts) if (part.edge === null || uses.get(part.edge) === 1) edges.add(part);
      if (e.type === 'FACE' || e.args[2] === undefined) {
        // A face without a surface: a planar polygon.
        this.planarFace(bounds.map(joinParts).filter(loop => loop.length >= 3), ref.flip, out);
        return;
      }
      const surface = this.geometry.surface(refId(e.args[2]));
      const sense = bool(e.args[3], true);
      let loops: Vec3[][];
      if (surface.uPeriod !== null || surface.vPeriod !== null) {
        // On a closed surface, leave seams out, and the face is closed across the seam instead.
        loops = bounds.flatMap(parts => splitAtSeams(parts, edge => (uses.get(edge) ?? 0) > 1));
      } else {
        loops = bounds.map(joinParts);
      }
      loops = loops.filter(loop => loop.length >= 2);
      if (loops.length === 0 && surface.uPeriod === null && surface.vPeriod === null) throw new Error('face has no bounds');
      const mesh = tessellateFace(surface, sense, loops, options);
      if (mesh.indices.length === 0) throw new Error('face gave no triangles');
      out.append(mesh.positions, mesh.normals, mesh.indices, ref.flip);
    } catch (error) {
      this.stats.failedFaces++;
      const message = error instanceof Error ? error.message : String(error);
      this.warnings.add(`Face left out: ${message}`);
    }
  }

  private planarFace(loops: Vec3[][], flip: boolean, out: MeshBuilder): void {
    if (!loops.length) return;
    const [outer, ...holes] = loops;
    const indices = triangulate3D(outer!, holes);
    const points = [outer!, ...holes].flat();
    const positions = points.flat();
    out.append(positions, vertexNormals(positions, indices), indices, flip);
  }

  /** A loop as its edges' point runs, each from the edge's start to its end in the loop's direction. */
  private loop(id: number | null, options: FaceOptions): LoopPart[] {
    const m = this.model;
    const loop = m.get(id);
    if (!loop) return [];
    if (loop.type === 'POLY_LOOP') return [{ edge: null, points: refIds(loop.args[1]).map(p => this.geometry.point(p)) }];
    if (loop.type === 'VERTEX_LOOP') return [];
    if (loop.type !== 'EDGE_LOOP') throw new Error(`${loop.type} loops are not supported`);
    const out: LoopPart[] = [];
    for (const oe of refIds(loop.args[1])) {
      const points = this.orientedEdge(oe, options);
      if (points.length) out.push({ edge: this.edgeId(oe), points });
    }
    return out;
  }

  /** The EDGE_CURVE behind an ORIENTED_EDGE. */
  private edgeId(id: number): number | null {
    let e = this.model.get(id);
    for (let depth = 0; e && e.type === 'ORIENTED_EDGE' && depth < 8; depth++) e = this.model.deref(e.args[3]);
    return e ? e.id : null;
  }

  private orientedEdge(id: number, options: FaceOptions): Vec3[] {
    const e = this.model.get(id);
    if (!e) return [];
    if (e.type === 'ORIENTED_EDGE') {
      // (name, *, *, edge_element, orientation)
      const points = this.orientedEdge(refId(e.args[3])!, options);
      return bool(e.args[4], true) ? points : points.slice().reverse();
    }
    return this.edge(e, options);
  }

  /** Points along an edge from its start vertex to its end vertex. Cached: faces share edges. */
  private edge(e: StepEntity, options: FaceOptions): Vec3[] {
    const cached = this.edges.get(e.id);
    if (cached) return cached;
    const g = this.geometry;
    const start = g.point(refId(e.args[1]));
    const end = g.point(refId(e.args[2]));
    let points: Vec3[];
    if (e.type === 'EDGE_CURVE') {
      const curve = g.curve(refId(e.args[3]));
      const sameSense = bool(e.args[4], true);
      points = sampleEdge(curve, start, end, refId(e.args[1]) === refId(e.args[2]), sameSense, options);
    } else {
      points = [start, end];
    }
    this.edges.set(e.id, points);
    return points;
  }

  private tessellatedFace(ref: FaceRef, out: MeshBuilder): void {
    const m = this.model;
    const e = m.get(ref.id);
    if (!e) return;
    this.stats.faces++;
    // TRIANGULATED_FACE(name, coordinates, pnmax, normals, geometric_link, pnindex, triangles) and
    // the surface set variants, which have no geometric_link.
    const isFace = e.type === 'TRIANGULATED_FACE' || e.type === 'COMPLEX_TRIANGULATED_FACE';
    const k = isFace ? 1 : 0;
    const coordinates = m.deref(e.args[1]);
    const coords = coordinates ? list(coordinates.args[2]).map(c => numbers(c)) : [];
    const normalsIn = list(e.args[3]).map(n => numbers(n));
    const pnindex = numbers(e.args[4 + k]);
    // Face vertex i (1-based) is coordinate pnindex[i - 1], or coordinate i without a pnindex.
    const vertexCount = pnindex.length || coords.length;
    const positions: number[] = [];
    for (let i = 0; i < vertexCount; i++) {
      const c = coords[(pnindex.length ? pnindex[i]! : i + 1) - 1] ?? [0, 0, 0];
      positions.push(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
    }
    const indices: number[] = [];
    const push = (a: number, b: number, c: number) => {
      if (a === b || b === c || a === c) return;
      if (a < 1 || b < 1 || c < 1 || a > vertexCount || b > vertexCount || c > vertexCount) return;
      indices.push(a - 1, b - 1, c - 1);
    };
    if (e.type === 'TRIANGULATED_FACE' || e.type === 'TRIANGULATED_SURFACE_SET') {
      for (const t of list(e.args[5 + k])) {
        const v = numbers(t);
        push(v[0]!, v[1]!, v[2]!);
      }
    } else {
      for (const strip of list(e.args[5 + k])) {
        const v = numbers(strip);
        for (let i = 0; i + 2 < v.length; i++) {
          if (i % 2 === 0) push(v[i]!, v[i + 1]!, v[i + 2]!);
          else push(v[i + 1]!, v[i]!, v[i + 2]!);
        }
      }
      for (const fan of list(e.args[6 + k])) {
        const v = numbers(fan);
        for (let i = 1; i + 1 < v.length; i++) push(v[0]!, v[i]!, v[i + 1]!);
      }
    }
    if (!indices.length) return;
    let normals: number[];
    if (normalsIn.length === vertexCount) normals = normalsIn.flatMap(n => [n[0] ?? 0, n[1] ?? 0, n[2] ?? 1]);
    else if (normalsIn.length === 1) normals = Array.from({ length: vertexCount }, () => normalsIn[0]!.slice(0, 3)).flat();
    else normals = vertexNormals(positions, indices);
    out.append(positions, normals, indices, ref.flip);
  }
}

/** Line segments along loops, each edge once across the faces of an item. */
class EdgeCollector {
  private readonly points: number[] = [];

  constructor(private readonly drawn: Set<number>) {}

  add(part: LoopPart): void {
    if (part.edge !== null) {
      if (this.drawn.has(part.edge)) return;
      this.drawn.add(part.edge);
    }
    const p = part.points;
    // A POLY_LOOP is closed back to its first point.
    const count = part.edge === null && p.length > 2 ? p.length : p.length - 1;
    for (let i = 0; i < count; i++) {
      const a = p[i]!, b = p[(i + 1) % p.length]!;
      if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
      this.points.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }

  build(): Float32Array | null {
    return this.points.length ? new Float32Array(this.points) : null;
  }
}

interface LoopPart {
  /** The edge, or null for a POLY_LOOP. */
  edge: number | null;
  points: Vec3[];
}

/** A loop's points in order, without repeating the first at the end. */
function joinParts(parts: readonly LoopPart[]): Vec3[] {
  const out: Vec3[] = [];
  for (const part of parts) {
    // Each edge starts where the last one ended.
    for (let i = out.length ? 1 : 0; i < part.points.length; i++) out.push(part.points[i]!);
  }
  if (out.length > 1) {
    const a = out[0]!, b = out[out.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) out.pop();
    else if (parts.length === 1 && parts[0]!.edge === null) return out;
    else if (length(sub(a, b)) <= 1e-9 * (Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]) + 1)) out.pop();
  }
  return out;
}

/** The runs of a loop between seam edges, each a loop of its own. Without seams, the loop itself. */
function splitAtSeams(parts: readonly LoopPart[], isSeam: (edge: number) => boolean): Vec3[][] {
  const seam = parts.map(part => part.edge !== null && isSeam(part.edge));
  const first = seam.indexOf(true);
  if (first < 0) return [joinParts(parts)];
  const out: Vec3[][] = [];
  let run: LoopPart[] = [];
  for (let k = 1; k <= parts.length; k++) {
    const i = (first + k) % parts.length;
    if (seam[i]) {
      if (run.length) out.push(joinParts(run));
      run = [];
    } else {
      run.push(parts[i]!);
    }
  }
  return out;
}

/**
 * Samples a curve between an edge's vertices: from start to end along the curve's direction, or
 * against it when `sameSense` is false. A closed edge (one vertex) goes once round its curve.
 */
export function sampleEdge(curve: Curve, start: Vec3, end: Vec3, closed: boolean, sameSense: boolean, options: FaceOptions): Vec3[] {
  if (curve.straight && !closed) return [start, end];
  let t0 = curve.closest(start);
  let t1 = curve.closest(end);
  const period = curve.period;
  const isClosed = closed || length(sub(start, end)) <= options.tolerance * 1e-3;
  if (sameSense) {
    if (period !== null) {
      if (isClosed) t1 = t0 + period;
      else while (t1 <= t0) t1 += period;
      while (t1 - t0 > period + 1e-9) t1 -= period;
    } else if (isClosed) {
      t0 = curve.t0;
      t1 = curve.t1;
    }
  } else {
    if (period !== null) {
      if (isClosed) t1 = t0 - period;
      else while (t1 >= t0) t1 -= period;
      while (t0 - t1 > period + 1e-9) t1 += period;
    } else if (isClosed) {
      t0 = curve.t1;
      t1 = curve.t0;
    }
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return [start, end];
  const ts = curve.sample(t0, t1, options.tolerance, options.angle);
  const points = ts.map(t => curve.point(t));
  points[0] = start;
  points[points.length - 1] = end;
  return points;
}
