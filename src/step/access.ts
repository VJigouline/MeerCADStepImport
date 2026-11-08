// Typed access to STEP attributes. Attributes are read by position, and for complex instances by
// the part that declares them, so the same code reads both #1=B_SPLINE_CURVE_WITH_KNOTS(...) and
// #1=(B_SPLINE_CURVE(...)B_SPLINE_CURVE_WITH_KNOTS(...)RATIONAL_B_SPLINE_CURVE(...)...).

import { StepEnum, StepRef, StepTyped, type StepEntity, type StepFile, type StepValue } from './step.js';

/** Unwraps defined types, such as LENGTH_MEASURE(2.5) or PARAMETER_VALUE(0.1). */
export function unwrap(value: StepValue | undefined): StepValue | undefined {
  while (value instanceof StepTyped) value = value.value;
  return value;
}

export function num(value: StepValue | undefined, fallback = 0): number {
  const v = unwrap(value);
  return typeof v === 'number' ? v : fallback;
}

export function optNum(value: StepValue | undefined): number | null {
  const v = unwrap(value);
  return typeof v === 'number' ? v : null;
}

export function str(value: StepValue | undefined): string {
  const v = unwrap(value);
  return typeof v === 'string' ? v : '';
}

/** .T. and .F.; anything else, including .U., gives the fallback. */
export function bool(value: StepValue | undefined, fallback = true): boolean {
  const v = unwrap(value);
  if (v instanceof StepEnum) {
    if (v.value === 'T') return true;
    if (v.value === 'F') return false;
  }
  return fallback;
}

export function enumValue(value: StepValue | undefined): string {
  const v = unwrap(value);
  return v instanceof StepEnum ? v.value : '';
}

export function list(value: StepValue | undefined): StepValue[] {
  const v = unwrap(value);
  return Array.isArray(v) ? v : [];
}

export function refId(value: StepValue | undefined): number | null {
  const v = unwrap(value);
  return v instanceof StepRef ? v.id : null;
}

export function refIds(value: StepValue | undefined): number[] {
  const out: number[] = [];
  for (const item of list(value)) {
    const id = refId(item);
    if (id !== null) out.push(id);
  }
  return out;
}

export function numbers(value: StepValue | undefined): number[] {
  return list(value).map(v => num(v));
}

/** Entity instances with type checks that see through complex instances. */
export class StepModel {
  constructor(readonly file: StepFile) {}

  get(id: number | null | undefined): StepEntity | undefined {
    return id === null || id === undefined ? undefined : this.file.get(id);
  }

  /** The entity referenced by an attribute value. */
  deref(value: StepValue | undefined): StepEntity | undefined {
    return this.get(refId(value));
  }

  /** True if the entity is, or for a complex instance has a part, of one of the given types. */
  is(entity: StepEntity | undefined, ...types: string[]): boolean {
    if (!entity) return false;
    if (entity.parts) return entity.parts.some(part => types.includes(part.type));
    return types.includes(entity.type);
  }

  /**
   * The attributes a type declares itself. For a simple instance these are all its attributes
   * (inherited ones first, as written); for a complex instance, those of the named part.
   */
  partArgs(entity: StepEntity, type: string): StepValue[] | undefined {
    if (entity.parts) return entity.parts.find(part => part.type === type)?.args;
    return entity.type === type ? entity.args : undefined;
  }

  /** Ids of every instance of the given types, including complex instances with such a part. */
  idsOf(...types: string[]): number[] {
    const out = new Set<number>();
    for (const type of types) for (const id of this.file.idsOfType(type)) out.add(id);
    return [...out];
  }

  /** The type name to show for an entity: its own, or a complex instance's most specific part. */
  displayType(entity: StepEntity): string {
    if (!entity.parts) return entity.type;
    const generic = new Set(['REPRESENTATION_ITEM', 'GEOMETRIC_REPRESENTATION_ITEM', 'BOUNDED_CURVE', 'BOUNDED_SURFACE', 'CURVE', 'SURFACE']);
    return entity.parts.map(part => part.type).filter(type => !generic.has(type)).join('+') || 'COMPLEX';
  }
}
