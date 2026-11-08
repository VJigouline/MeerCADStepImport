// Length and plane angle units of a representation context: GLOBAL_UNIT_ASSIGNED_CONTEXT with
// SI_UNIT or CONVERSION_BASED_UNIT parts, possibly chained through MEASURE_WITH_UNIT.

import { enumValue, num, refIds, unwrap, type StepModel } from '../step/access.js';
import type { StepEntity } from '../step/step.js';

export interface Units {
  /** Metres per length unit. */
  length: number;
  /** Radians per plane angle unit. */
  angle: number;
  /** Uncertainty, in length units, from GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT; null if none. */
  uncertainty: number | null;
  /** Name for messages: 'mm', 'inch' and so on. */
  lengthName: string;
}

export const DEFAULT_UNITS: Units = { length: 0.001, angle: 1, uncertainty: null, lengthName: 'mm (assumed)' };

const SI_PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

const PREFIX_NAME: Record<string, string> = { MILLI: 'mm', CENTI: 'cm', DECI: 'dm', KILO: 'km', MICRO: 'µm', NANO: 'nm' };

export class UnitReader {
  private readonly cache = new Map<number, Units>();
  constructor(private readonly model: StepModel) {}

  /** Units of a representation context, by id. */
  ofContext(contextId: number | null): Units {
    if (contextId === null) return DEFAULT_UNITS;
    const cached = this.cache.get(contextId);
    if (cached) return cached;
    const m = this.model;
    const context = m.get(contextId);
    const units: Units = { ...DEFAULT_UNITS };
    let foundLength = false;
    if (context) {
      const assigned = m.partArgs(context, 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
      // Simple GLOBAL_UNIT_ASSIGNED_CONTEXT instances carry the inherited identifier and type first.
      const unitList = assigned ? (context.parts ? assigned[0] : assigned[2]) : undefined;
      for (const id of refIds(unitList)) {
        const unit = m.get(id);
        if (!unit) continue;
        if (m.is(unit, 'LENGTH_UNIT')) {
          const r = this.factor(unit, 0);
          if (r) {
            units.length = r.factor;
            units.lengthName = r.name;
            foundLength = true;
          }
        } else if (m.is(unit, 'PLANE_ANGLE_UNIT')) {
          const r = this.factor(unit, 0);
          if (r) units.angle = r.factor;
        }
      }
      const uncertainty = m.partArgs(context, 'GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT');
      const uncertaintyList = uncertainty ? (context.parts ? uncertainty[0] : uncertainty[2]) : undefined;
      for (const id of refIds(uncertaintyList)) {
        const measure = m.get(id);
        if (measure && m.is(measure, 'UNCERTAINTY_MEASURE_WITH_UNIT')) {
          const value = num(measure.args[0]);
          if (value > 0) units.uncertainty = units.uncertainty === null ? value : Math.min(units.uncertainty, value);
        }
      }
    }
    if (!foundLength) units.lengthName = DEFAULT_UNITS.lengthName;
    this.cache.set(contextId, units);
    return units;
  }

  /** SI units per unit, for SI_UNIT and CONVERSION_BASED_UNIT (recursively). */
  private factor(unit: StepEntity, depth: number): { factor: number; name: string } | null {
    if (depth > 8) return null;
    const m = this.model;
    const si = m.partArgs(unit, 'SI_UNIT');
    if (si) {
      // SI_UNIT(prefix, name) in a complex instance; simple ones start with dimensions (derived *).
      const args = unit.parts ? si : si.slice(-2);
      const prefix = enumValue(args[0]);
      const name = enumValue(args[1]);
      const scale = SI_PREFIX[prefix] ?? 1;
      if (name === 'RADIAN' || name === 'STERADIAN') return { factor: scale, name: name.toLowerCase() };
      return { factor: scale, name: PREFIX_NAME[prefix] ?? (prefix ? `${prefix.toLowerCase()}${name.toLowerCase()}` : 'm') };
    }
    const conversion = m.partArgs(unit, 'CONVERSION_BASED_UNIT');
    if (conversion) {
      const args = unit.parts ? conversion : conversion.slice(-2);
      const name = typeof unwrap(args[0]) === 'string' ? (unwrap(args[0]) as string) : 'unit';
      const measure = m.deref(args[1]);
      if (!measure) return null;
      // MEASURE_WITH_UNIT(value_component, unit_component).
      const value = num(measure.args[0], 1);
      const base = m.deref(measure.args[1]);
      const inner = base ? this.factor(base, depth + 1) : null;
      if (!inner) {
        // A degree conversion without a usable base unit: assume radians.
        if (/DEG/i.test(name)) return { factor: Math.PI / 180, name: 'degree' };
        return null;
      }
      return { factor: value * inner.factor, name: name.toLowerCase() };
    }
    return null;
  }
}
