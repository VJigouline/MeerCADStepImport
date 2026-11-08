// Presentation: colours and transparency from STYLED_ITEM and OVER_RIDING_STYLED_ITEM, and
// items hidden by INVISIBILITY.

import { enumValue, num, refId, refIds, str, type StepModel } from '../step/access.js';

export interface StepStyle {
  name: string;
  /** sRGB, 0 to 1. */
  color: [number, number, number];
  /** 1 is opaque. */
  opacity: number;
}

export const DEFAULT_STYLE: StepStyle = { name: 'Default', color: [0.75, 0.75, 0.78], opacity: 1 };

const PREDEFINED: Record<string, [number, number, number]> = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], yellow: [1, 1, 0], magenta: [1, 0, 1],
  cyan: [0, 1, 1], black: [0, 0, 0], white: [1, 1, 1],
};

export class StyleTable {
  /** Style by the id of the item it applies to. */
  readonly byItem = new Map<number, StepStyle>();
  /** Items not to draw. */
  readonly hidden = new Set<number>();

  constructor(private readonly model: StepModel) {
    const m = model;
    const plain = m.idsOf('STYLED_ITEM');
    const overriding = new Set(m.idsOf('OVER_RIDING_STYLED_ITEM', 'CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM'));
    // Plain styles first, so overriding ones replace them.
    const order = [...plain.filter(id => !overriding.has(id)), ...overriding];
    for (const id of order) {
      const e = m.get(id);
      if (!e) continue;
      // STYLED_ITEM(name, styles, item), possibly in a complex instance.
      const args = m.partArgs(e, 'STYLED_ITEM') ?? e.args;
      const styles = e.parts ? args[0] : args[1];
      const item = refId(e.parts ? args[1] : args[2]);
      if (item === null) continue;
      const style = this.read(refIds(styles));
      if (style) this.byItem.set(item, style);
    }
    for (const id of m.idsOf('INVISIBILITY')) {
      const e = m.get(id);
      for (const target of refIds(e?.args[0])) {
        const t = m.get(target);
        if (!t) continue;
        if (m.is(t, 'STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM')) {
          const item = refId(t.args[2]);
          if (item !== null) this.hidden.add(item);
        } else if (m.is(t, 'PRESENTATION_LAYER_ASSIGNMENT')) {
          for (const item of refIds(t.args[2])) this.hidden.add(item);
        } else {
          this.hidden.add(target);
        }
      }
    }
  }

  private read(assignments: number[]): StepStyle | null {
    const m = this.model;
    let color: [number, number, number] | null = null, opacity = 1, name = '';
    const visit = (id: number, depth: number) => {
      if (depth > 8) return;
      const e = m.get(id);
      if (!e) return;
      switch (e.type) {
        case 'PRESENTATION_STYLE_ASSIGNMENT':
        case 'PRESENTATION_STYLE_BY_CONTEXT':
          for (const s of refIds(e.args[0])) visit(s, depth + 1);
          break;
        case 'SURFACE_STYLE_USAGE': {
          // Prefer the front or both-sides style over a back-side one.
          const side = enumValue(e.args[0]);
          if (side === 'NEGATIVE' && color) break;
          const s = refId(e.args[1]);
          if (s !== null) visit(s, depth + 1);
          break;
        }
        case 'SURFACE_SIDE_STYLE':
          if (!name) name = str(e.args[0]);
          for (const s of refIds(e.args[1])) visit(s, depth + 1);
          break;
        case 'SURFACE_STYLE_FILL_AREA': {
          const s = refId(e.args[0]);
          if (s !== null) visit(s, depth + 1);
          break;
        }
        case 'FILL_AREA_STYLE':
          if (!name) name = str(e.args[0]);
          for (const s of refIds(e.args[1])) visit(s, depth + 1);
          break;
        case 'FILL_AREA_STYLE_COLOUR': {
          const c = this.colour(refId(e.args[1]));
          if (c) color = c;
          break;
        }
        case 'SURFACE_STYLE_RENDERING':
        case 'SURFACE_STYLE_RENDERING_WITH_PROPERTIES': {
          const c = this.colour(refId(e.args[1]));
          if (c && !color) color = c;
          for (const p of refIds(e.args[2])) {
            const prop = m.get(p);
            if (prop?.type === 'SURFACE_STYLE_TRANSPARENT') opacity = 1 - Math.min(1, Math.max(0, num(prop.args[0])));
          }
          break;
        }
        default:
          break;
      }
    };
    for (const id of assignments) visit(id, 0);
    if (!color) return null;
    return { name: name || colourName(color), color, opacity };
  }

  private colour(id: number | null): [number, number, number] | null {
    const e = this.model.get(id);
    if (!e) return null;
    if (this.model.is(e, 'COLOUR_RGB')) {
      // COLOUR_RGB(name, red, green, blue): the last three attributes.
      const args = this.model.partArgs(e, 'COLOUR_RGB') ?? e.args;
      const n = args.length;
      return [clamp(num(args[n - 3])), clamp(num(args[n - 2])), clamp(num(args[n - 1]))];
    }
    if (this.model.is(e, 'DRAUGHTING_PRE_DEFINED_COLOUR', 'PRE_DEFINED_COLOUR')) {
      return PREDEFINED[str(e.args[0]).toLowerCase()] ?? null;
    }
    return null;
  }
}

function clamp(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function colourName(c: [number, number, number]): string {
  const hex = c.map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

/** A key that is equal for equal styles. */
export function styleKey(style: StepStyle): string {
  return `${style.name}|${style.color.map(x => x.toFixed(4)).join(',')}|${style.opacity.toFixed(4)}`;
}
