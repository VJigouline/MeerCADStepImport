// Builds small STEP files for tests: a writer for geometry and topology entities, B-rep solids of
// the common surface types, and a file with a product structure around them.

import { readStep, type StepImportOptions, type StepImportResult, type StepMesh, type StepNode } from '../src/index.js';
import type { MeshData } from '../src/geometry/mesh.js';
import { transformPoint, type Mat4, type Vec3 } from '../src/geometry/math.js';

const f = (x: number) => {
  const s = Number(x.toPrecision(15)).toString();
  return /[.eE]/.test(s) ? s : `${s}.`;
};

export class StepWriter {
  readonly lines: string[] = [];
  private next: number;
  constructor(start = 100) {
    this.next = start;
  }
  add(entity: string): string {
    const id = `#${this.next++}`;
    this.lines.push(`${id}=${entity};`);
    return id;
  }
  point(p: Vec3 | [number, number]): string {
    return this.add(`CARTESIAN_POINT('',(${p.map(f).join(',')}))`);
  }
  dir(d: Vec3 | [number, number]): string {
    return this.add(`DIRECTION('',(${d.map(f).join(',')}))`);
  }
  axis(origin: Vec3, z: Vec3 = [0, 0, 1], x: Vec3 = [1, 0, 0]): string {
    return this.add(`AXIS2_PLACEMENT_3D('',${this.point(origin)},${this.dir(z)},${this.dir(x)})`);
  }
  vertex(p: Vec3): string {
    return this.add(`VERTEX_POINT('',${this.point(p)})`);
  }
  line(from: Vec3, to: Vec3): string {
    const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const l = Math.hypot(...d);
    return this.add(`LINE('',${this.point(from)},${this.add(`VECTOR('',${this.dir([d[0] / l, d[1] / l, d[2] / l])},${f(l)})`)})`);
  }
  circle(centre: Vec3, radius: number, z: Vec3 = [0, 0, 1], x: Vec3 = [1, 0, 0]): string {
    return this.add(`CIRCLE('',${this.axis(centre, z, x)},${f(radius)})`);
  }
  edge(v1: string, v2: string, curve: string, sameSense = true): string {
    return this.add(`EDGE_CURVE('',${v1},${v2},${curve},${sameSense ? '.T.' : '.F.'})`);
  }
  oriented(edge: string, orientation: boolean): string {
    return this.add(`ORIENTED_EDGE('',*,*,${edge},${orientation ? '.T.' : '.F.'})`);
  }
  loop(edges: [string, boolean][]): string {
    return this.add(`EDGE_LOOP('',(${edges.map(([e, o]) => this.oriented(e, o)).join(',')}))`);
  }
  face(surface: string, bounds: { loop: string; orientation?: boolean; outer?: boolean }[], sameSense = true): string {
    const ids = bounds.map(b => this.add(`${b.outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${b.loop},${b.orientation === false ? '.F.' : '.T.'})`));
    return this.add(`ADVANCED_FACE('',(${ids.join(',')}),${surface},${sameSense ? '.T.' : '.F.'})`);
  }
  solid(faces: string[], name = ''): string {
    return this.add(`MANIFOLD_SOLID_BREP('${name}',${this.add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
  }
}

/** An axis-aligned box from `min` to `max`, planes facing out. */
export function box(w: StepWriter, min: Vec3, max: Vec3, name = 'box'): string {
  const c = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const vertices = Array.from({ length: 8 }, (_, i) => w.vertex(c(i)));
  const edges = new Map<string, string>();
  const edge = (a: number, b: number): [string, boolean] => {
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    let e = edges.get(key);
    if (!e) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      e = w.edge(vertices[lo]!, vertices[hi]!, w.line(c(lo), c(hi)));
      edges.set(key, e);
    }
    return [e, a < b];
  };
  // Corner indices counter-clockwise seen from outside, with the outward normal.
  const quads: [number[], Vec3][] = [
    [[0, 2, 3, 1], [0, 0, -1]], [[4, 5, 7, 6], [0, 0, 1]],
    [[0, 1, 5, 4], [0, -1, 0]], [[2, 6, 7, 3], [0, 1, 0]],
    [[0, 4, 6, 2], [-1, 0, 0]], [[1, 3, 7, 5], [1, 0, 0]],
  ];
  const faces = quads.map(([q, n]) => {
    const x: Vec3 = Math.abs(n[0]) > 0.5 ? [0, 1, 0] : [1, 0, 0];
    const plane = w.add(`PLANE('',${w.axis(c(q[0]!), n, x)})`);
    const loop = w.loop(q.map((a, i) => edge(a, q[(i + 1) % 4]!)));
    return w.face(plane, [{ loop, outer: true }]);
  });
  return w.solid(faces, name);
}

/** A cylinder of radius r from z = 0 to z = h, with a seam edge at +x. */
export function cylinder(w: StepWriter, r: number, h: number): string {
  const v0 = w.vertex([r, 0, 0]), v1 = w.vertex([r, 0, h]);
  const bottom = w.edge(v0, v0, w.circle([0, 0, 0], r));
  const top = w.edge(v1, v1, w.circle([0, 0, h], r));
  const seam = w.edge(v0, v1, w.line([r, 0, 0], [r, 0, h]));
  const side = w.face(w.add(`CYLINDRICAL_SURFACE('',${w.axis([0, 0, 0])},${f(r)})`), [{ loop: w.loop([[bottom, true], [seam, true], [top, false], [seam, false]]), outer: true }]);
  const lower = w.face(w.add(`PLANE('',${w.axis([0, 0, 0], [0, 0, -1])})`), [{ loop: w.loop([[bottom, false]]), outer: true }]);
  const upper = w.face(w.add(`PLANE('',${w.axis([0, 0, h])})`), [{ loop: w.loop([[top, true]]), outer: true }]);
  return w.solid([side, lower, upper], 'cylinder');
}

/** A sphere of radius r: one face whose only edge is the seam, a half meridian from pole to pole. */
export function sphere(w: StepWriter, r: number, centre: Vec3 = [0, 0, 0]): string {
  const s = w.vertex([centre[0], centre[1], centre[2] - r]), n = w.vertex([centre[0], centre[1], centre[2] + r]);
  const meridian = w.edge(s, n, w.circle(centre, r, [0, -1, 0], [1, 0, 0]));
  const face = w.face(w.add(`SPHERICAL_SURFACE('',${w.axis(centre)},${f(r)})`), [{ loop: w.loop([[meridian, true], [meridian, false]]), outer: true }]);
  return w.solid([face], 'sphere');
}

/** A torus about z: one face bounded by its two seams. */
export function torus(w: StepWriter, major: number, minor: number): string {
  const v = w.vertex([major + minor, 0, 0]);
  const ring = w.edge(v, v, w.circle([0, 0, 0], major + minor));
  const tube = w.edge(v, v, w.circle([major, 0, 0], minor, [0, -1, 0], [1, 0, 0]));
  const face = w.face(w.add(`TOROIDAL_SURFACE('',${w.axis([0, 0, 0])},${f(major)},${f(minor)})`), [{ loop: w.loop([[ring, true], [tube, true], [ring, false], [tube, false]]), outer: true }]);
  return w.solid([face], 'torus');
}

/** A cone with its apex at the origin and a base of radius h tan(angle) at z = h. */
export function cone(w: StepWriter, h: number, angle: number, angleUnit = 1): string {
  const rho = h * Math.tan(angle);
  const apex = w.vertex([0, 0, 0]), b = w.vertex([rho, 0, h]);
  const base = w.edge(b, b, w.circle([0, 0, h], rho));
  const seam = w.edge(apex, b, w.line([0, 0, 0], [rho, 0, h]));
  const side = w.face(w.add(`CONICAL_SURFACE('',${w.axis([0, 0, 0])},0.,${f(angle / angleUnit)})`), [{ loop: w.loop([[base, false], [seam, false], [seam, true]]), outer: true }]);
  const disk = w.face(w.add(`PLANE('',${w.axis([0, 0, h])})`), [{ loop: w.loop([[base, true]]), outer: true }]);
  return w.solid([side, disk], 'cone');
}

/**
 * A bicubic B-spline patch over [0, size]² with a bump of height `bump`, as an open shell; its
 * edges are the patch's boundary curves.
 */
export function bsplinePatch(w: StepWriter, size: number, bump: number, rational = false): string {
  const n = 4;
  const z = (i: number, j: number) => (i > 0 && i < n - 1 && j > 0 && j < n - 1 ? bump : 0);
  const cp: Vec3[][] = [];
  for (let i = 0; i < n; i++) {
    const row: Vec3[] = [];
    for (let j = 0; j < n; j++) row.push([(size * i) / (n - 1), (size * j) / (n - 1), z(i, j)]);
    cp.push(row);
  }
  const ids = cp.map(row => row.map(p => w.point(p)));
  const net = `(${ids.map(row => `(${row.join(',')})`).join(',')})`;
  const weights = cp.map((row, i) => row.map((_, j) => (i === 1 && j === 1 ? 2 : 1)));
  const surface = rational
    ? w.add(`(BOUNDED_SURFACE()B_SPLINE_SURFACE(3,3,${net},.UNSPECIFIED.,.F.,.F.,.F.)B_SPLINE_SURFACE_WITH_KNOTS((4,4),(4,4),(0.,1.),(0.,1.),.UNSPECIFIED.)GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE((${weights.map(r => `(${r.map(f).join(',')})`).join(',')}))REPRESENTATION_ITEM('')SURFACE())`)
    : w.add(`B_SPLINE_SURFACE_WITH_KNOTS('',3,3,${net},.UNSPECIFIED.,.F.,.F.,.F.,(4,4),(4,4),(0.,1.),(0.,1.),.UNSPECIFIED.)`);
  // Boundary curves: the net's edge rows, with the matching weights (the edge rows have weight 1).
  const curve = (pts: string[]) => w.add(`B_SPLINE_CURVE_WITH_KNOTS('',3,(${pts.join(',')}),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,1.),.UNSPECIFIED.)`);
  const corners = [w.vertex(cp[0]![0]!), w.vertex(cp[n - 1]![0]!), w.vertex(cp[n - 1]![n - 1]!), w.vertex(cp[0]![n - 1]!)];
  const e0 = w.edge(corners[0]!, corners[1]!, curve(ids.map(row => row[0]!)));
  const e1 = w.edge(corners[1]!, corners[2]!, curve(ids[n - 1]!));
  const e2 = w.edge(corners[3]!, corners[2]!, curve(ids.map(row => row[n - 1]!)));
  const e3 = w.edge(corners[0]!, corners[3]!, curve(ids[0]!));
  const face = w.face(surface, [{ loop: w.loop([[e0, true], [e1, true], [e2, false], [e3, false]]), outer: true }]);
  const shell = w.add(`OPEN_SHELL('',(${face}))`);
  return w.add(`SHELL_BASED_SURFACE_MODEL('patch',(${shell}))`);
}

export interface FileOptions {
  schema?: string;
  /** Length unit entity, as written; #21 by convention. */
  lengthUnit?: string;
  angleUnit?: string;
  /** Extra entities, such as styles, placed after the product structure. */
  extra?: string;
  productName?: string;
}

/**
 * A file with one product whose SHAPE_REPRESENTATION holds `items`. Ids below 100 are used here:
 * #10 is the shape representation, #11 its origin placement, #20 the context, #21 the length unit.
 */
export function stepFile(w: StepWriter, items: string[], options: FileOptions = {}): string {
  const schema = options.schema ?? 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }';
  const length = options.lengthUnit ?? '#21=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));';
  const angle = options.angleUnit ?? '#22=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));';
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('test.stp','2026-01-01T00:00:00',('Tester'),('MeerCAD'),'test','test','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('automotive design');
#2=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#1);
#3=PRODUCT_CONTEXT('',#1,'mechanical');
#4=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#5=PRODUCT('P1','${options.productName ?? 'Part'}','A test part',(#3));
#6=PRODUCT_DEFINITION_FORMATION('','',#5);
#7=PRODUCT_DEFINITION('design','',#6,#4);
#8=PRODUCT_DEFINITION_SHAPE('','',#7);
#9=SHAPE_DEFINITION_REPRESENTATION(#8,#10);
#10=SHAPE_REPRESENTATION('',(#11${items.map(i => `,${i}`).join('')}),#20);
#11=AXIS2_PLACEMENT_3D('',#12,#13,#14);
#12=CARTESIAN_POINT('',(0.,0.,0.));
#13=DIRECTION('',(0.,0.,1.));
#14=DIRECTION('',(1.,0.,0.));
#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#24))GLOBAL_UNIT_ASSIGNED_CONTEXT((#21,#22,#23))REPRESENTATION_CONTEXT('',''));
${length}
${angle}
#23=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());
#24=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#21,'distance_accuracy_value','');
${w.lines.join('\n')}
${options.extra ?? ''}
ENDSEC;
END-ISO-10303-21;
`;
}

export function read(text: string, options: StepImportOptions = {}): StepImportResult {
  return readStep(text, options);
}

/** Every node, depth first, with its world matrix (without the Y-up turn). */
export function allNodes(result: StepImportResult): { node: StepNode; world: Mat4 | null }[] {
  const out: { node: StepNode; world: Mat4 | null }[] = [];
  const walk = (node: StepNode, parent: Mat4 | null) => {
    const world = node.matrix ? (parent ? multiply(parent, node.matrix) : node.matrix) : parent;
    out.push({ node, world });
    node.children.forEach(child => walk(child, world));
  };
  result.roots.forEach(root => walk(root, null));
  return out;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = s;
  }
  return out;
}

export function allMeshes(result: StepImportResult): StepMesh[] {
  return allNodes(result).flatMap(({ node }) => node.meshes);
}

/** Mesh positions after a matrix, as points. */
export function points(data: MeshData, matrix?: Mat4 | null): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < data.positions.length; i += 3) {
    const p: Vec3 = [data.positions[i]!, data.positions[i + 1]!, data.positions[i + 2]!];
    out.push(matrix ? transformPoint(matrix, p) : p);
  }
  return out;
}

export interface MeshCheck {
  /** Signed volume enclosed: positive when the triangles face outwards. */
  volume: number;
  area: number;
  /** Edges with one triangle after welding equal positions: zero for a closed mesh. */
  openEdges: number;
  nonManifoldEdges: number;
  /** Fraction of vertex normals on the same side as their triangles. */
  normalAgreement: number;
}

export function checkMesh(data: MeshData): MeshCheck {
  const p = data.positions, idx = data.indices, n = data.normals;
  let size = 0;
  for (let i = 0; i < p.length; i++) size = Math.max(size, Math.abs(p[i]!));
  const q = size * 1e-6 || 1e-12;
  const weld = new Map<string, number>();
  const id = new Int32Array(p.length / 3);
  for (let i = 0; i < id.length; i++) {
    const k = `${Math.round(p[i * 3]! / q)},${Math.round(p[i * 3 + 1]! / q)},${Math.round(p[i * 3 + 2]! / q)}`;
    if (!weld.has(k)) weld.set(k, weld.size);
    id[i] = weld.get(k)!;
  }
  const edges = new Map<string, number>();
  let volume = 0, area = 0, agree = 0, total = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    const A: Vec3 = [p[a * 3]!, p[a * 3 + 1]!, p[a * 3 + 2]!], B: Vec3 = [p[b * 3]!, p[b * 3 + 1]!, p[b * 3 + 2]!], C: Vec3 = [p[c * 3]!, p[c * 3 + 1]!, p[c * 3 + 2]!];
    volume += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const fn = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    area += Math.hypot(fn[0]!, fn[1]!, fn[2]!) / 2;
    for (const k of [a, b, c]) {
      total++;
      if (fn[0]! * n[k * 3]! + fn[1]! * n[k * 3 + 1]! + fn[2]! * n[k * 3 + 2]! > 0) agree++;
    }
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const i = id[x]!, j = id[y]!;
      if (i === j) continue;
      const key = i < j ? `${i}_${j}` : `${j}_${i}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let openEdges = 0, nonManifoldEdges = 0;
  for (const count of edges.values()) {
    if (count === 1) openEdges++;
    else if (count > 2) nonManifoldEdges++;
  }
  return { volume, area, openEdges, nonManifoldEdges, normalAgreement: total ? agree / total : 1 };
}
