// Reader for ISO 10303-21 ("STEP physical file") exchange structures. Entities are indexed in
// one pass and parsed only when asked for, so large files don't have to be held as objects all
// at once. Complex instances, #1=(A(...)B(...)), keep their parts, so attributes can be read by
// the part they belong to.

/** Reference to another entity instance, #id. */
export class StepRef {
  constructor(readonly id: number) {}
}

/** Enumeration or boolean value, such as .T., .F., .U. or .MILLI. */
export class StepEnum {
  constructor(readonly value: string) {}
}

/** Value wrapped in a defined type, such as PARAMETER_VALUE(0.5) or LENGTH_MEASURE(25.4). */
export class StepTyped {
  constructor(readonly type: string, readonly value: StepValue) {}
}

/** The derived value marker, *. */
export const DERIVED: unique symbol = Symbol('derived');

/** An attribute value: $ is null. */
export type StepValue =
  | number
  | string
  | null
  | typeof DERIVED
  | StepRef
  | StepEnum
  | StepTyped
  | StepValue[];

/** One part of a complex instance: its entity type and its own attributes. */
export interface StepPart {
  type: string;
  args: StepValue[];
}

export interface StepEntity {
  id: number;
  /** Entity type in upper case, as written: ADVANCED_FACE. COMPLEX for a complex instance. */
  type: string;
  /** All attributes; for a complex instance, its parts' attributes in order. */
  args: StepValue[];
  /** A complex instance's parts, in file order. */
  parts?: StepPart[];
}

export interface StepHeader {
  description: string[];
  implementationLevel: string;
  fileName: string;
  timeStamp: string;
  author: string[];
  organization: string[];
  preprocessorVersion: string;
  originatingSystem: string;
  authorization: string;
  /** FILE_SCHEMA identifiers, such as AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }. */
  schemas: string[];
}

export class StepSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
    this.name = 'StepSyntaxError';
  }
}

const enum Ch {
  Hash = 35, Dollar = 36, Quote = 39, LParen = 40, RParen = 41, Star = 42, Comma = 44,
  Minus = 45, Dot = 46, Slash = 47, Semicolon = 59, Equals = 61, Plus = 43,
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isIdentChar(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 95 || c === Ch.Minus;
}

/** Decodes a STEP string literal's body: '' quotes and the \X\, \X2\, \X4\ and \S\ escapes. */
export function decodeStepString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "'" && raw[i + 1] === "'") {
      out += "'";
      i++;
    } else if (c === '\\' && raw[i + 1] === '\\') {
      out += '\\';
      i++;
    } else if (c === '\\' && raw.startsWith('X2\\', i + 1)) {
      // \X2\ hhhh... \X0\: UTF-16 code units, four hex digits each.
      const end = raw.indexOf('\\X0\\', i + 4);
      const hex = raw.slice(i + 4, end < 0 ? raw.length : end);
      for (let k = 0; k + 4 <= hex.length; k += 4) out += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
      i = end < 0 ? raw.length : end + 3;
    } else if (c === '\\' && raw.startsWith('X4\\', i + 1)) {
      // \X4\ hhhhhhhh... \X0\: Unicode code points, eight hex digits each.
      const end = raw.indexOf('\\X0\\', i + 4);
      const hex = raw.slice(i + 4, end < 0 ? raw.length : end);
      for (let k = 0; k + 8 <= hex.length; k += 8) out += String.fromCodePoint(parseInt(hex.slice(k, k + 8), 16));
      i = end < 0 ? raw.length : end + 3;
    } else if (c === '\\' && raw[i + 1] === 'X' && raw[i + 2] === '\\') {
      // \X\hh: one ISO 8859-1 character.
      out += String.fromCharCode(parseInt(raw.slice(i + 3, i + 5), 16));
      i += 4;
    } else if (c === '\\' && raw[i + 1] === 'S' && raw[i + 2] === '\\') {
      // \S\c: the character c with its top bit set, in ISO 8859-1.
      out += String.fromCharCode((raw.charCodeAt(i + 3) & 0x7f) + 0x80);
      i += 3;
    } else if (c === '\\' && raw[i + 1] === 'P' && raw[i + 3] === '\\') {
      // \PA\ code page switches: ignored, as the code pages beyond ISO 8859-1 are rare.
      i += 3;
    } else {
      out += c;
    }
  }
  return out;
}

/** Parses STEP values from text, starting at a given offset. */
class ValueParser {
  pos: number;
  constructor(readonly text: string, start: number) {
    this.pos = start;
  }

  private skip(): void {
    const t = this.text;
    for (;;) {
      const c = t.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        this.pos++;
      } else if (c === Ch.Slash && t.charCodeAt(this.pos + 1) === Ch.Star) {
        const end = t.indexOf('*/', this.pos + 2);
        this.pos = end < 0 ? t.length : end + 2;
      } else {
        return;
      }
    }
  }

  private fail(message: string): never {
    throw new StepSyntaxError(`${message} at offset ${this.pos}`, this.pos);
  }

  /** Parses a parenthesised, comma-separated list of values. */
  list(): StepValue[] {
    this.skip();
    if (this.text.charCodeAt(this.pos) !== Ch.LParen) this.fail('expected (');
    this.pos++;
    const values: StepValue[] = [];
    this.skip();
    if (this.text.charCodeAt(this.pos) === Ch.RParen) {
      this.pos++;
      return values;
    }
    for (;;) {
      values.push(this.value());
      this.skip();
      const c = this.text.charCodeAt(this.pos);
      if (c === Ch.Comma) {
        this.pos++;
      } else if (c === Ch.RParen) {
        this.pos++;
        return values;
      } else {
        this.fail('expected , or )');
      }
    }
  }

  value(): StepValue {
    this.skip();
    const t = this.text;
    const c = t.charCodeAt(this.pos);
    if (c === Ch.Dollar) {
      this.pos++;
      return null;
    }
    if (c === Ch.Star) {
      this.pos++;
      return DERIVED;
    }
    if (c === Ch.Hash) {
      let p = this.pos + 1, id = 0;
      while (isDigit(t.charCodeAt(p))) id = id * 10 + (t.charCodeAt(p++) - 48);
      if (p === this.pos + 1) this.fail('expected an entity number');
      this.pos = p;
      return new StepRef(id);
    }
    if (c === Ch.Quote) {
      let p = this.pos + 1;
      for (;;) {
        const q = t.indexOf("'", p);
        if (q < 0) this.fail('unterminated string');
        if (t.charCodeAt(q + 1) === Ch.Quote) {
          p = q + 2;
          continue;
        }
        const raw = t.slice(this.pos + 1, q);
        this.pos = q + 1;
        return raw.includes('\\') || raw.includes("''") ? decodeStepString(raw) : raw;
      }
    }
    if (c === Ch.Dot) {
      const end = t.indexOf('.', this.pos + 1);
      if (end < 0) this.fail('unterminated enumeration');
      const value = t.slice(this.pos + 1, end);
      this.pos = end + 1;
      return new StepEnum(value);
    }
    if (c === Ch.LParen) return this.list();
    if (isDigit(c) || c === Ch.Minus || c === Ch.Plus) {
      let p = this.pos + 1;
      for (;;) {
        const d = t.charCodeAt(p);
        if (isDigit(d) || d === Ch.Dot || d === 69 || d === 101 || ((d === Ch.Minus || d === Ch.Plus) && (t.charCodeAt(p - 1) === 69 || t.charCodeAt(p - 1) === 101))) p++;
        else break;
      }
      const number = Number(t.slice(this.pos, p));
      if (Number.isNaN(number)) this.fail('malformed number');
      this.pos = p;
      return number;
    }
    if (c === 34) {
      // "binary" literal: kept as its hex text.
      const end = t.indexOf('"', this.pos + 1);
      if (end < 0) this.fail('unterminated binary');
      const value = t.slice(this.pos + 1, end);
      this.pos = end + 1;
      return value;
    }
    if (isIdentChar(c)) {
      let p = this.pos;
      while (isIdentChar(t.charCodeAt(p))) p++;
      const type = t.slice(this.pos, p).toUpperCase();
      this.pos = p;
      const inner = this.list();
      return new StepTyped(type, inner.length === 1 ? inner[0]! : inner);
    }
    this.fail(`unexpected character '${t[this.pos] ?? 'end of file'}'`);
  }
}

/**
 * A parsed STEP file. The DATA section is scanned once to find where each entity instance is;
 * instances are parsed when first asked for and then cached.
 */
export class StepFile {
  readonly header: StepHeader;
  /** Text offset of each instance's type name, by instance number. */
  private readonly offsets = new Map<number, number>();
  /** Instance numbers by upper-case type name. */
  private readonly typeIndex = new Map<string, number[]>();
  private readonly cache = new Map<number, StepEntity>();

  constructor(readonly text: string) {
    this.header = this.readHeader();
    this.indexData();
  }

  /** Every instance number in the file. */
  get ids(): IterableIterator<number> {
    return this.offsets.keys();
  }

  get size(): number {
    return this.offsets.size;
  }

  /**
   * Instance numbers of one entity type, in any case. Complex instances are listed under each of
   * their parts' types as well as under COMPLEX.
   */
  idsOfType(type: string): readonly number[] {
    return this.typeIndex.get(type.toUpperCase()) ?? [];
  }

  /** Every entity type in the file with its instance count. */
  typeCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [type, ids] of this.typeIndex) counts.set(type, ids.length);
    return counts;
  }

  /** The type of an instance without parsing its attributes. */
  typeOf(id: number): string | undefined {
    const offset = this.offsets.get(id);
    if (offset === undefined) return undefined;
    let end = offset;
    while (isIdentChar(this.text.charCodeAt(end))) end++;
    return end > offset ? this.text.slice(offset, end).toUpperCase() : 'COMPLEX';
  }

  has(id: number): boolean {
    return this.offsets.has(id);
  }

  /** Parses, or returns the cached, instance. Undefined if the file has no such instance. */
  get(id: number): StepEntity | undefined {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const offset = this.offsets.get(id);
    if (offset === undefined) return undefined;
    let p = offset;
    while (isIdentChar(this.text.charCodeAt(p))) p++;
    const type = this.text.slice(offset, p).toUpperCase();
    let entity: StepEntity;
    if (type === '') {
      // A complex instance, #1=(A(...)B(...)): its parts, and their attributes in order.
      const parts = this.complexParts(offset);
      entity = { id, type: 'COMPLEX', args: parts.flatMap(part => part.args), parts };
    } else {
      entity = { id, type, args: new ValueParser(this.text, p).list() };
    }
    this.cache.set(id, entity);
    return entity;
  }

  private complexParts(offset: number): StepPart[] {
    const t = this.text;
    let p = offset + 1;
    const parts: StepPart[] = [];
    const skip = () => {
      for (;;) {
        const c = t.charCodeAt(p);
        if (c === 32 || c === 9 || c === 10 || c === 13) p++;
        else if (c === Ch.Slash && t.charCodeAt(p + 1) === Ch.Star) {
          const end = t.indexOf('*/', p + 2);
          p = end < 0 ? t.length : end + 2;
        } else return;
      }
    };
    for (;;) {
      skip();
      if (p >= t.length || t.charCodeAt(p) === Ch.RParen) break;
      const start = p;
      while (isIdentChar(t.charCodeAt(p))) p++;
      if (p === start) throw new StepSyntaxError(`expected an entity type in a complex instance at offset ${p}`, p);
      const type = t.slice(start, p).toUpperCase();
      const parser = new ValueParser(t, p);
      const args = parser.list();
      p = parser.pos;
      parts.push({ type, args });
    }
    return parts;
  }

  /** Types of a complex instance's parts, read without parsing their attributes. */
  private complexPartTypes(offset: number): string[] {
    const t = this.text;
    const types: string[] = [];
    let depth = 0;
    for (let p = offset + 1; p < t.length; p++) {
      const c = t.charCodeAt(p);
      if (c === Ch.Quote) {
        for (;;) {
          const q = t.indexOf("'", p + 1);
          if (q < 0) return types;
          if (t.charCodeAt(q + 1) === Ch.Quote) p = q + 1;
          else {
            p = q;
            break;
          }
        }
      } else if (c === Ch.LParen) depth++;
      else if (c === Ch.RParen) {
        if (depth === 0) return types;
        depth--;
      } else if (depth === 0 && isIdentChar(c) && !isDigit(c)) {
        let e = p;
        while (isIdentChar(t.charCodeAt(e))) e++;
        types.push(t.slice(p, e).toUpperCase());
        p = e - 1;
      } else if (c === Ch.Semicolon) return types;
    }
    return types;
  }

  private readHeader(): StepHeader {
    const text = this.text;
    const headerStart = text.search(/HEADER\s*;/i);
    const dataStart = text.search(/DATA\s*(\([^)]*\))?\s*;/i);
    if (!/^\s*(\/\*[\s\S]*?\*\/\s*)*ISO-10303-21\s*;/i.test(text.slice(0, 4096)) || headerStart < 0 || dataStart < 0) {
      throw new StepSyntaxError('not an ISO 10303-21 file: missing ISO-10303-21, HEADER or DATA', 0);
    }
    const section = text.slice(headerStart, dataStart);
    const read = (name: string): StepValue[] => {
      const match = new RegExp(`${name}\\s*\\(`, 'i').exec(section);
      if (!match) return [];
      try {
        return new ValueParser(section, match.index + match[0].length - 1).list();
      } catch {
        return [];
      }
    };
    const strings = (value: StepValue | undefined): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' ? [value] : [];
    const str = (value: StepValue | undefined): string => (typeof value === 'string' ? value : '');
    const description = read('FILE_DESCRIPTION');
    const name = read('FILE_NAME');
    const schema = read('FILE_SCHEMA');
    return {
      description: strings(description[0]),
      implementationLevel: str(description[1]),
      fileName: str(name[0]),
      timeStamp: str(name[1]),
      author: strings(name[2]),
      organization: strings(name[3]),
      preprocessorVersion: str(name[4]),
      originatingSystem: str(name[5]),
      authorization: str(name[6]),
      schemas: strings(schema[0]),
    };
  }

  /** Finds every #id = TYPE( in the DATA sections, skipping strings and comments. */
  private indexData(): void {
    const t = this.text;
    const dataMatch = /\bDATA\s*(\([^)]*\))?\s*;/i.exec(t);
    let p = dataMatch ? dataMatch.index + dataMatch[0].length : t.length;
    const length = t.length;
    let atStatement = true;
    while (p < length) {
      const c = t.charCodeAt(p);
      if (c === Ch.Quote) {
        // Skip a string, including '' escapes.
        p++;
        for (;;) {
          const q = t.indexOf("'", p);
          if (q < 0) {
            p = length;
            break;
          }
          if (t.charCodeAt(q + 1) === Ch.Quote) p = q + 2;
          else {
            p = q + 1;
            break;
          }
        }
        continue;
      }
      if (c === Ch.Slash && t.charCodeAt(p + 1) === Ch.Star) {
        const end = t.indexOf('*/', p + 2);
        p = end < 0 ? length : end + 2;
        continue;
      }
      if (c === Ch.Semicolon) {
        atStatement = true;
        p++;
        continue;
      }
      if (atStatement && c === Ch.Hash) {
        let q = p + 1, id = 0;
        while (isDigit(t.charCodeAt(q))) id = id * 10 + (t.charCodeAt(q++) - 48);
        while (t.charCodeAt(q) === 32 || t.charCodeAt(q) === 9 || t.charCodeAt(q) === 10 || t.charCodeAt(q) === 13) q++;
        if (t.charCodeAt(q) === Ch.Equals) {
          q++;
          while (t.charCodeAt(q) === 32 || t.charCodeAt(q) === 9 || t.charCodeAt(q) === 10 || t.charCodeAt(q) === 13) q++;
          this.offsets.set(id, q);
          let e = q;
          while (isIdentChar(t.charCodeAt(e))) e++;
          const type = e > q ? t.slice(q, e).toUpperCase() : 'COMPLEX';
          const types = type === 'COMPLEX' ? ['COMPLEX', ...this.complexPartTypes(q)] : [type];
          for (const name of types) {
            let list = this.typeIndex.get(name);
            if (!list) {
              list = [];
              this.typeIndex.set(name, list);
            }
            list.push(id);
          }
          atStatement = false;
          p = e;
          continue;
        }
      }
      if (c === 69 && t.startsWith('ENDSEC', p) && atStatement) {
        // Another DATA section may follow; keep scanning.
        p += 6;
        continue;
      }
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) atStatement = false;
      p++;
    }
  }
}

/** Reads a file's text, from a string, an ArrayBuffer or bytes. STEP files are 7-bit ASCII or UTF-8. */
export function stepText(input: string | ArrayBuffer | Uint8Array): string {
  if (typeof input === 'string') return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return new TextDecoder('utf-8').decode(bytes);
}
