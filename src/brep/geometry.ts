// Reads ISO 10303-42 geometry entities (points, placements, curves and surfaces) into evaluators.
// Lengths stay in the representation's units; plane angles are converted to radians.

import { cross, dot, fromAxes, normalize, perpendicular, scale, sub, type Mat4, type Vec3 } from '../geometry/math.js';
import { bool, enumValue, list, num, numbers, refId, unwrap, type StepModel } from '../step/access.js';
import { StepTyped, type StepEntity, type StepValue } from '../step/step.js';
import { BSplineCurveData, BSplineSurfaceData, expandKnots, implicitKnots } from './bspline.js';
import {
  BSplineCurve, CompositeCurve, ConicCurve, FunctionCurve, GeneralCurve, LineCurve, PolylineCurve, ReversedCurve, TrimmedCurve,
  type Curve,
} from './curves.js';
import {
  BSplineSurface, ConeSurface, CylinderSurface, ExtrusionSurface, OffsetSurface, PlaneSurface, RevolutionSurface, SphereSurface,
  TorusSurface, type Frame, type Surface,
} from './surfaces.js';

export class GeometryError extends Error {}

const B_SPLINE_CURVES = ['B_SPLINE_CURVE', 'B_SPLINE_CURVE_WITH_KNOTS', 'BEZIER_CURVE', 'UNIFORM_CURVE', 'QUASI_UNIFORM_CURVE'];
const B_SPLINE_SURFACES = ['B_SPLINE_SURFACE', 'B_SPLINE_SURFACE_WITH_KNOTS', 'BEZIER_SURFACE', 'UNIFORM_SURFACE', 'QUASI_UNIFORM_SURFACE'];

export class GeometryReader {
  private readonly curves = new Map<number, Curve>();
  private readonly surfaces = new Map<number, Surface>();
  private readonly points = new Map<number, Vec3>();

  /** `angle` is radians per plane angle unit of the representation context. */
  constructor(readonly model: StepModel, readonly angle: number) {}

  point(id: number | null): Vec3 {
    if (id === null) throw new GeometryError('missing point');
    const cached = this.points.get(id);
    if (cached) return cached;
    const e = this.model.get(id);
    if (!e) throw new GeometryError(`#${id} not found`);
    let p: Vec3;
    if (this.model.is(e, 'CARTESIAN_POINT')) {
      const c = numbers(e.parts ? this.model.partArgs(e, 'CARTESIAN_POINT')?.[0] : e.args[1]);
      p = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
    } else if (this.model.is(e, 'VERTEX_POINT')) {
      p = this.point(refId(e.args[1]));
    } else {
      throw new GeometryError(`#${id} ${e.type} is not a point`);
    }
    this.points.set(id, p);
    return p;
  }

  direction(id: number | null, fallback: Vec3): Vec3 {
    const e = this.model.get(id);
    if (!e) return fallback;
    if (this.model.is(e, 'DIRECTION')) {
      const r = numbers(e.args[1]);
      const d = normalize([r[0] ?? 0, r[1] ?? 0, r[2] ?? 0]);
      return d[0] === 0 && d[1] === 0 && d[2] === 0 ? fallback : d;
    }
    if (this.model.is(e, 'VECTOR')) return this.direction(refId(e.args[1]), fallback);
    return fallback;
  }

  /** A VECTOR with its magnitude. */
  vector(id: number | null): Vec3 {
    const e = this.model.get(id);
    if (!e) throw new GeometryError('missing vector');
    if (this.model.is(e, 'DIRECTION')) return this.direction(id, [1, 0, 0]);
    const d = this.direction(refId(e.args[1]), [1, 0, 0]);
    return scale(d, num(e.args[2], 1));
  }

  /** AXIS2_PLACEMENT_3D, AXIS2_PLACEMENT_2D or AXIS1_PLACEMENT as a frame. */
  frame(id: number | null): Frame {
    const e = this.model.get(id);
    if (!e) return { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const origin = this.point(refId(e.args[1]));
    if (this.model.is(e, 'AXIS2_PLACEMENT_2D')) {
      const x = this.direction(refId(e.args[2]), [1, 0, 0]);
      return { origin, x, y: [-x[1], x[0], 0], z: [0, 0, 1] };
    }
    const z = this.direction(refId(e.args[2]), [0, 0, 1]);
    // Without a reference direction, ISO 10303-42 first_proj_axis uses x, or z when the axis is x.
    const byDefault: Vec3 = Math.abs(z[0]) > 1 - 1e-12 ? [0, 0, 1] : [1, 0, 0];
    let x = this.model.is(e, 'AXIS1_PLACEMENT') ? byDefault : this.direction(refId(e.args[3]), byDefault);
    // Make x perpendicular to z.
    x = normalize(sub(x, scale(z, dot(x, z))));
    if (x[0] === 0 && x[1] === 0 && x[2] === 0) x = perpendicular(z);
    return { origin, x, y: cross(z, x), z };
  }

  /** A placement or CARTESIAN_TRANSFORMATION_OPERATOR as a matrix, in the representation's units. */
  matrix(id: number | null): Mat4 {
    const e = this.model.get(id);
    if (e && this.model.is(e, 'CARTESIAN_TRANSFORMATION_OPERATOR_3D', 'CARTESIAN_TRANSFORMATION_OPERATOR')) {
      // (..., axis1, axis2, local_origin, scale[, axis3]): found around the origin point, as
      // writers differ in the names and descriptions they put first.
      const args = e.args;
      const at = args.findIndex(v => this.model.is(this.model.deref(v), 'CARTESIAN_POINT'));
      if (at < 2) throw new GeometryError(`transformation operator #${e.id} has no origin`);
      const a1 = this.direction(refId(args[at - 2]), [1, 0, 0]);
      const a2 = this.direction(refId(args[at - 1]), [0, 1, 0]);
      const origin = this.point(refId(args[at]));
      const s = unwrap(args[at + 1]) === null || args[at + 1] === undefined ? 1 : num(args[at + 1], 1);
      const a3 = this.direction(refId(args[at + 2]), normalize(cross(a1, a2)));
      const z = a3;
      const x = normalize(sub(a1, scale(z, dot(a1, z))));
      const y = cross(z, x);
      return fromAxes(scale(x, s), scale(y, s), scale(z, s), origin);
    }
    const f = this.frame(id);
    return fromAxes(f.x, f.y, f.z, f.origin);
  }

  curve(id: number | null): Curve {
    if (id === null) throw new GeometryError('missing curve');
    let c = this.curves.get(id);
    if (!c) {
      c = this.readCurve(id);
      this.curves.set(id, c);
    }
    return c;
  }

  private readCurve(id: number): Curve {
    const m = this.model;
    const e = m.get(id);
    if (!e) throw new GeometryError(`#${id} not found`);
    if (m.is(e, ...B_SPLINE_CURVES)) return new BSplineCurve(this.bsplineCurve(e));
    switch (e.type) {
      case 'LINE':
        return new LineCurve(this.point(refId(e.args[1])), this.vector(refId(e.args[2])));
      case 'CIRCLE': {
        const f = this.frame(refId(e.args[1]));
        const r = num(e.args[2]);
        return new ConicCurve(f.origin, f.x, f.y, r, r);
      }
      case 'ELLIPSE': {
        const f = this.frame(refId(e.args[1]));
        return new ConicCurve(f.origin, f.x, f.y, num(e.args[2]), num(e.args[3]));
      }
      case 'PARABOLA': {
        const f = this.frame(refId(e.args[1]));
        const a = num(e.args[2]);
        return new GeneralCurve(t => add3(f.origin, scale(f.x, a * t * t), scale(f.y, 2 * a * t)));
      }
      case 'HYPERBOLA': {
        const f = this.frame(refId(e.args[1]));
        const a = num(e.args[2]), b = num(e.args[3]);
        return new GeneralCurve(t => add3(f.origin, scale(f.x, a * Math.cosh(t)), scale(f.y, b * Math.sinh(t))), -20, 20);
      }
      case 'POLYLINE':
        return new PolylineCurve(list(e.args[1]).map(v => this.point(refId(v))));
      case 'TRIMMED_CURVE':
        return this.trimmed(e);
      case 'SURFACE_CURVE':
      case 'SEAM_CURVE':
      case 'INTERSECTION_CURVE':
      case 'BOUNDED_SURFACE_CURVE': {
        const curve3d = refId(e.args[1]);
        if (curve3d !== null) return this.curve(curve3d);
        // No 3D curve: fall back to the first pcurve.
        const first = list(e.args[2]).map(refId).find((x): x is number => x !== null);
        return this.curve(first ?? null);
      }
      case 'PCURVE':
        return this.pcurve(e);
      case 'COMPOSITE_CURVE':
      case 'COMPOSITE_CURVE_ON_SURFACE':
      case 'BOUNDARY_CURVE':
      case 'OUTER_BOUNDARY_CURVE':
        return this.composite(e);
      case 'DEGENERATE_PCURVE':
        throw new GeometryError('degenerate pcurve');
      default:
        throw new GeometryError(`${m.displayType(e)} curves are not supported`);
    }
  }

  private bsplineCurve(e: StepEntity): BSplineCurveData {
    const m = this.model;
    // (degree, control_points_list, curve_form, closed_curve, self_intersect) on B_SPLINE_CURVE.
    const base = e.parts ? m.partArgs(e, 'B_SPLINE_CURVE')! : e.args.slice(1);
    const degree = num(base[0]);
    const points = list(base[1]).map(v => this.point(refId(v)));
    let knots: number[];
    const withKnots = e.parts ? m.partArgs(e, 'B_SPLINE_CURVE_WITH_KNOTS') : e.type === 'B_SPLINE_CURVE_WITH_KNOTS' ? e.args.slice(6) : undefined;
    if (withKnots) {
      knots = expandKnots(numbers(withKnots[0]), numbers(withKnots[1]));
    } else if (m.is(e, 'BEZIER_CURVE')) {
      knots = implicitKnots('bezier', degree, points.length);
    } else if (m.is(e, 'UNIFORM_CURVE')) {
      knots = implicitKnots('uniform', degree, points.length);
    } else {
      knots = implicitKnots('quasi_uniform', degree, points.length);
    }
    const rational = e.parts ? m.partArgs(e, 'RATIONAL_B_SPLINE_CURVE') : undefined;
    const weights = rational ? numbers(rational[0]) : null;
    if (knots.length !== points.length + degree + 1) throw new GeometryError(`B-spline curve #${e.id} has ${knots.length} knots for ${points.length} control points of degree ${degree}`);
    return new BSplineCurveData(degree, points, knots, weights && weights.length === points.length ? weights : null);
  }

  /** A trimming value as a parameter: PARAMETER_VALUE directly, or a point projected on the basis. */
  private trimParameter(basis: Curve, values: StepValue[], preferPoint: boolean, isConic: boolean): number | null {
    let parameter: number | null = null, point: Vec3 | null = null;
    for (const v of values) {
      if (v instanceof StepTyped && v.type === 'PARAMETER_VALUE') parameter = num(v.value) * (isConic ? this.angle : 1);
      else if (typeof v === 'number') parameter = v * (isConic ? this.angle : 1);
      else {
        const id = refId(v);
        if (id !== null) {
          try {
            point = this.point(id);
          } catch {
            // Not a point: ignore it.
          }
        }
      }
    }
    if (point && (preferPoint || parameter === null)) return basis.closest(point);
    return parameter;
  }

  private trimmed(e: StepEntity): Curve {
    const basisId = refId(e.args[1]);
    const basis = this.curve(basisId);
    const basisEntity = this.model.get(basisId);
    const isConic = !!basisEntity && ['CIRCLE', 'ELLIPSE'].includes(basisEntity.type);
    const preferPoint = enumValue(e.args[5]) === 'CARTESIAN';
    let t1 = this.trimParameter(basis, list(e.args[2]), preferPoint, isConic) ?? basis.t0;
    let t2 = this.trimParameter(basis, list(e.args[3]), preferPoint, isConic) ?? basis.t1;
    const sense = bool(e.args[4], true);
    if (sense) {
      if (basis.period !== null && t2 <= t1) t2 += basis.period * Math.ceil((t1 - t2) / basis.period + 1e-12);
      return new TrimmedCurve(basis, t1, t2);
    }
    if (basis.period !== null && t2 >= t1) t2 -= basis.period * Math.ceil((t2 - t1) / basis.period + 1e-12);
    return new TrimmedCurve(new ReversedCurve(basis), -t1, -t2);
  }

  private composite(e: StepEntity): Curve {
    const segments: { curve: Curve; a: number; b: number }[] = [];
    for (const v of list(e.args[1])) {
      const seg = this.model.deref(v);
      if (!seg) continue;
      // COMPOSITE_CURVE_SEGMENT(transition, same_sense, parent_curve).
      const sameSense = bool(seg.args[1], true);
      const parent = this.curve(refId(seg.args[2]));
      let a = parent.t0, b = parent.t1;
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new GeometryError('composite curve segment is unbounded');
      if (!sameSense) [a, b] = [b, a];
      segments.push({ curve: parent, a, b });
    }
    if (!segments.length) throw new GeometryError('empty composite curve');
    return new CompositeCurve(segments);
  }

  private pcurve(e: StepEntity): Curve {
    const surface = this.surface(refId(e.args[1]));
    const rep = this.model.deref(e.args[2]);
    const item = rep ? refId(list(rep.args[1])[0]) : null;
    const curve2d = this.curve(item);
    return new FunctionCurve(
      t => {
        const q = curve2d.point(t);
        return surface.evaluate(q[0], q[1])[0];
      },
      curve2d.t0,
      curve2d.t1,
      curve2d.period,
      (a, b) => {
        const n = 16;
        const out: number[] = [];
        for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
        return out;
      },
    );
  }

  surface(id: number | null): Surface {
    if (id === null) throw new GeometryError('missing surface');
    let s = this.surfaces.get(id);
    if (!s) {
      s = this.readSurface(id);
      this.surfaces.set(id, s);
    }
    return s;
  }

  private readSurface(id: number): Surface {
    const m = this.model;
    const e = m.get(id);
    if (!e) throw new GeometryError(`#${id} not found`);
    if (m.is(e, ...B_SPLINE_SURFACES)) return new BSplineSurface(this.bsplineSurface(e));
    switch (e.type) {
      case 'PLANE':
        return new PlaneSurface(this.frame(refId(e.args[1])));
      case 'CYLINDRICAL_SURFACE':
        return new CylinderSurface(this.frame(refId(e.args[1])), num(e.args[2]));
      case 'CONICAL_SURFACE':
        return new ConeSurface(this.frame(refId(e.args[1])), num(e.args[2]), num(e.args[3]) * this.angle);
      case 'SPHERICAL_SURFACE':
        return new SphereSurface(this.frame(refId(e.args[1])), num(e.args[2]));
      case 'TOROIDAL_SURFACE':
      case 'DEGENERATE_TOROIDAL_SURFACE':
        return new TorusSurface(this.frame(refId(e.args[1])), num(e.args[2]), num(e.args[3]));
      case 'SURFACE_OF_LINEAR_EXTRUSION': {
        const curve = this.curve(refId(e.args[1]));
        return new ExtrusionSurface(curve, this.vector(refId(e.args[2])), [curve.t0, curve.t1]);
      }
      case 'SURFACE_OF_REVOLUTION': {
        const curve = this.curve(refId(e.args[1]));
        const axis = this.model.deref(e.args[2]);
        const origin = axis ? this.point(refId(axis.args[1])) : [0, 0, 0] as Vec3;
        const direction = axis ? this.direction(refId(axis.args[2]), [0, 0, 1]) : [0, 0, 1] as Vec3;
        return new RevolutionSurface(curve, origin, direction, [curve.t0, curve.t1]);
      }
      case 'OFFSET_SURFACE':
        return new OffsetSurface(this.surface(refId(e.args[1])), num(e.args[2]));
      case 'RECTANGULAR_TRIMMED_SURFACE':
      case 'CURVE_BOUNDED_SURFACE':
        return this.surface(refId(e.args[1]));
      default:
        throw new GeometryError(`${m.displayType(e)} surfaces are not supported`);
    }
  }

  private bsplineSurface(e: StepEntity): BSplineSurfaceData {
    const m = this.model;
    // (u_degree, v_degree, control_points_list, surface_form, u_closed, v_closed, self_intersect).
    const base = e.parts ? m.partArgs(e, 'B_SPLINE_SURFACE')! : e.args.slice(1);
    const uDegree = num(base[0]), vDegree = num(base[1]);
    const points = list(base[2]).map(row => list(row).map(v => this.point(refId(v))));
    const nu = points.length, nv = points[0]?.length ?? 0;
    if (nu < 2 || nv < 2 || points.some(row => row.length !== nv)) throw new GeometryError(`B-spline surface #${e.id} has a ragged control net`);
    let uKnots: number[], vKnots: number[];
    const withKnots = e.parts ? m.partArgs(e, 'B_SPLINE_SURFACE_WITH_KNOTS') : e.type === 'B_SPLINE_SURFACE_WITH_KNOTS' ? e.args.slice(8) : undefined;
    if (withKnots) {
      uKnots = expandKnots(numbers(withKnots[0]), numbers(withKnots[2]));
      vKnots = expandKnots(numbers(withKnots[1]), numbers(withKnots[3]));
    } else {
      const kind = m.is(e, 'BEZIER_SURFACE') ? 'bezier' : m.is(e, 'UNIFORM_SURFACE') ? 'uniform' : 'quasi_uniform';
      uKnots = implicitKnots(kind, uDegree, nu);
      vKnots = implicitKnots(kind, vDegree, nv);
    }
    if (uKnots.length !== nu + uDegree + 1 || vKnots.length !== nv + vDegree + 1) throw new GeometryError(`B-spline surface #${e.id} has knots that don't match its control net`);
    const rational = e.parts ? m.partArgs(e, 'RATIONAL_B_SPLINE_SURFACE') : undefined;
    let weights: number[][] | null = null;
    if (rational) {
      weights = list(rational[0]).map(row => numbers(row));
      if (weights.length !== nu || weights.some(row => row.length !== nv)) weights = null;
    }
    return new BSplineSurfaceData(uDegree, vDegree, points, uKnots, vKnots, weights);
  }
}

function add3(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
}
