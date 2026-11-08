import { describe, expect, it } from 'vitest';
import { BSplineCurveData, BSplineSurfaceData, expandKnots } from '../src/brep/bspline.js';
import { ConicCurve } from '../src/brep/curves.js';
import { tessellateFace } from '../src/brep/face.js';
import { BSplineSurface, PlaneSurface, SphereSurface } from '../src/brep/surfaces.js';
import { sampleEdge } from '../src/brep/shapes.js';
import { allMeshes, box, bsplinePatch, checkMesh, cone, cylinder, read, sphere, stepFile, StepWriter, torus } from './helpers.js';

function boundsOf(data: { positions: Float32Array }): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k]!, data.positions[i + k]!);
    b[k + 3] = Math.max(b[k + 3]!, data.positions[i + k]!);
  }
  return b;
}

const solidOf = (build: (w: StepWriter) => string, options = {}) => {
  const w = new StepWriter();
  const id = build(w);
  return read(stepFile(w, [id]), options);
};

describe('B-splines', () => {
  it('evaluates a rational quadratic quarter circle exactly', () => {
    const s = Math.SQRT1_2;
    const c = new BSplineCurveData(2, [[1, 0, 0], [1, 1, 0], [0, 1, 0]], expandKnots([3, 3], [0, 1]), [1, s, 1]);
    for (let i = 0; i <= 10; i++) {
      const [p, d] = c.evaluate(i / 10);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 12);
      // The derivative is tangent: perpendicular to the radius.
      expect(p[0] * d[0] + p[1] * d[1]).toBeCloseTo(0, 10);
    }
  });

  it('gives surface derivatives that match finite differences', () => {
    const pts = [0, 1, 2, 3].map(i => [0, 1, 2, 3].map(j => [i, j, Math.sin(i + 2 * j)] as [number, number, number]));
    const weights = pts.map((row, i) => row.map((_, j) => 1 + 0.2 * i + 0.1 * j));
    const s = new BSplineSurfaceData(2, 2, pts, expandKnots([3, 1, 3], [0, 0.4, 1]), expandKnots([3, 1, 3], [0, 0.6, 1]), weights);
    const h = 1e-6;
    for (const [u, v] of [[0.2, 0.3], [0.5, 0.7], [0.9, 0.1]] as const) {
      const [, du, dv] = s.evaluate(u, v);
      const a = s.evaluate(u + h, v)[0], b = s.evaluate(u - h, v)[0];
      const c = s.evaluate(u, v + h)[0], d = s.evaluate(u, v - h)[0];
      for (let k = 0; k < 3; k++) {
        expect(du[k]!).toBeCloseTo((a[k]! - b[k]!) / (2 * h), 5);
        expect(dv[k]!).toBeCloseTo((c[k]! - d[k]!) / (2 * h), 5);
      }
    }
  });

  it('projects points onto a B-spline surface', () => {
    const pts = [0, 1, 2, 3].map(i => [0, 1, 2, 3].map(j => [i, j, (i - 1.5) ** 2 - (j - 1.5) ** 2] as [number, number, number]));
    const surface = new BSplineSurface(new BSplineSurfaceData(3, 3, pts, expandKnots([4, 4], [0, 1]), expandKnots([4, 4], [0, 1]), null));
    for (const [u, v] of [[0.1, 0.9], [0.5, 0.5], [0.77, 0.23]] as const) {
      const p = surface.evaluate(u, v)[0];
      const [pu, pv] = surface.project(p);
      expect(pu).toBeCloseTo(u, 7);
      expect(pv).toBeCloseTo(v, 7);
    }
  });
});

describe('edges', () => {
  it('samples circular arcs within the tolerances, either way round', () => {
    const circle = new ConicCurve([0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 10);
    const options = { tolerance: 0.01, angle: 0.2, maxTriangles: 1e4 };
    const forward = sampleEdge(circle, [10, 0, 0], [0, 10, 0], false, true, options);
    const backward = sampleEdge(circle, [10, 0, 0], [0, 10, 0], false, false, options);
    // A quarter circle one way, three quarters the other.
    expect(forward.length).toBeGreaterThan(8);
    expect(backward.length).toBeGreaterThan(forward.length * 2.5);
    for (const p of [...forward, ...backward]) expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 9);
    for (let i = 1; i < forward.length; i++) {
      const a = forward[i - 1]!, b = forward[i]!;
      const mid = Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      expect(10 - mid).toBeLessThanOrEqual(0.01 + 1e-12);
    }
    expect(forward[forward.length - 1]).toEqual([0, 10, 0]);
    const closed = sampleEdge(circle, [10, 0, 0], [10, 0, 0], true, true, options);
    expect(closed.length).toBeGreaterThan(30);
  });
});

describe('faces', () => {
  it('triangulates a planar face with a hole, facing the face normal', () => {
    const plane = new PlaneSurface({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
    const outer: [number, number, number][] = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]];
    const hole: [number, number, number][] = [[1, 1, 0], [1, 3, 0], [3, 3, 0], [3, 1, 0]];
    for (const sense of [true, false]) {
      // With the face against the plane's normal, the loops run the other way round.
      const loops = sense ? [outer, hole] : [outer.slice().reverse(), hole.slice().reverse()];
      const mesh = tessellateFace(plane, sense, loops, { tolerance: 0.01, angle: 0.2, maxTriangles: 1e4 });
      let area = 0;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!].map(i => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!]);
        area += ((b![0]! - a![0]!) * (c![1]! - a![1]!) - (b![1]! - a![1]!) * (c![0]! - a![0]!)) / 2;
      }
      expect(area).toBeCloseTo(sense ? 12 : -12, 9);
      expect(mesh.normals[2]).toBe(sense ? 1 : -1);
    }
  });

  it('tessellates a whole sphere from no boundary at all', () => {
    const s = new SphereSurface({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, 2);
    const mesh = tessellateFace(s, true, [], { tolerance: 0.002, angle: 0.2, maxTriangles: 1e5 });
    for (let i = 0; i < mesh.positions.length; i += 3) expect(Math.hypot(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!)).toBeCloseTo(2, 9);
    expect(mesh.indices.length / 3).toBeGreaterThan(200);
  });
});

describe('solids', () => {
  it('reads a box as a closed mesh with its volume', () => {
    const r = solidOf(w => box(w, [0, 0, 0], [10, 20, 30]));
    const [mesh] = allMeshes(r);
    const check = checkMesh(mesh!.data);
    expect(r.stats.failedFaces).toBe(0);
    expect(mesh!.data.indices.length / 3).toBe(12);
    expect(check.openEdges).toBe(0);
    expect(check.volume).toBeCloseTo(6000, 6);
    expect(check.normalAgreement).toBe(1);
  });

  it.each([
    ['cylinder', (w: StepWriter) => cylinder(w, 5, 10), Math.PI * 25 * 10],
    ['sphere', (w: StepWriter) => sphere(w, 5), (4 / 3) * Math.PI * 125],
    ['torus', (w: StepWriter) => torus(w, 10, 3), 2 * Math.PI ** 2 * 10 * 9],
    ['cone', (w: StepWriter) => cone(w, 10, Math.PI / 6), (Math.PI * (10 * Math.tan(Math.PI / 6)) ** 2 * 10) / 3],
  ])('reads a %s as a closed, outward-facing mesh', (_name, build, volume) => {
    const r = solidOf(build);
    expect(r.warnings).toEqual([]);
    expect(r.stats.failedFaces).toBe(0);
    const meshes = allMeshes(r);
    expect(meshes).toHaveLength(1);
    const check = checkMesh(meshes[0]!.data);
    expect(check.openEdges).toBe(0);
    expect(check.nonManifoldEdges).toBe(0);
    expect(check.normalAgreement).toBe(1);
    // Inscribed triangles lose a little volume: no more than the area times the distance the
    // mesh may be from the surface, twice the chord tolerance inside faces.
    const b = boundsOf(meshes[0]!.data);
    const tolerance = 0.001 * Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    expect(volume - check.volume).toBeGreaterThanOrEqual(-1e-9);
    expect(volume - check.volume).toBeLessThan(check.area * 2 * tolerance);
  });

  it('refines more for a finer tolerance', () => {
    const coarse = allMeshes(solidOf(w => sphere(w, 5), { relativeTolerance: 0.01, angularTolerance: 0.5 }))[0]!;
    const fine = allMeshes(solidOf(w => sphere(w, 5), { relativeTolerance: 0.0002, angularTolerance: 0.1 }))[0]!;
    expect(fine.data.indices.length).toBeGreaterThan(coarse.data.indices.length * 4);
    const v = (4 / 3) * Math.PI * 125;
    expect(Math.abs(checkMesh(fine.data).volume - v)).toBeLessThan(Math.abs(checkMesh(coarse.data).volume - v));
  });

  it.each([false, true])('reads a B-spline surface model (rational: %s) close to its surface', rational => {
    const r = solidOf(w => bsplinePatch(w, 30, 6, rational));
    expect(r.stats.failedFaces).toBe(0);
    const [mesh] = allMeshes(r);
    const check = checkMesh(mesh!.data);
    // An open patch: its four sides are open.
    expect(check.openEdges).toBeGreaterThan(4);
    expect(check.normalAgreement).toBe(1);
    expect(mesh!.itemType).toBe('SHELL_BASED_SURFACE_MODEL');
    // Bumped up, so its area is more than the flat square's.
    expect(check.area).toBeGreaterThan(900);
    expect(check.area).toBeLessThan(1100);
  });
});
