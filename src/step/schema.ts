// Application protocol detection from FILE_SCHEMA. The APs that carry 3D shape (AP203, AP214,
// AP242 and others built on ISO 10303-42 geometry) share their geometric and topological
// entities, so one reader serves them all; the schema decides what the file is called and
// which parts of it are expected.

export type StepProtocol = 'AP203' | 'AP203e2' | 'AP214' | 'AP242' | 'AP209' | 'AP210' | 'AP238' | 'other';

export interface StepSchemaInfo {
  protocol: StepProtocol;
  /** Readable name, such as 'AP214 (automotive design)'. */
  name: string;
  /** The FILE_SCHEMA identifier as written, such as AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }. */
  identifier: string;
  /** The schema's name without its object identifier, upper case. */
  schemaName: string;
  /** Edition from the object identifier, such as 3 for { 1 0 10303 242 3 ... }; null if not given. */
  edition: number | null;
}

export class UnsupportedSchemaError extends Error {
  constructor(message: string, readonly schema: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

const PROTOCOLS: { test: RegExp; protocol: StepProtocol; name: string }[] = [
  { test: /^CONFIG_CONTROL_DESIGN$/, protocol: 'AP203', name: 'AP203 (configuration controlled 3D design)' },
  { test: /^(CONFIGURATION_CONTROL_3D_DESIGN_ED2_MIM_LF|AP203_CONFIGURATION_CONTROLLED_3D_DESIGN_OF_MECHANICAL_PARTS_AND_ASSEMBLIES_MIM_LF)$/, protocol: 'AP203e2', name: 'AP203 edition 2 (configuration controlled 3D design)' },
  { test: /^AUTOMOTIVE_DESIGN(_CC\d)?$/, protocol: 'AP214', name: 'AP214 (automotive design)' },
  { test: /^AP242_/, protocol: 'AP242', name: 'AP242 (managed model based 3D engineering)' },
  { test: /^(AP209_|STRUCTURAL_ANALYSIS_DESIGN)/, protocol: 'AP209', name: 'AP209 (multidisciplinary analysis and design)' },
  { test: /^AP210_/, protocol: 'AP210', name: 'AP210 (electronic assembly, interconnect and packaging design)' },
  { test: /^(INTEGRATED_CNC_SCHEMA|AP238_)/, protocol: 'AP238', name: 'AP238 (STEP-NC)' },
];

/** The application protocol of a file from its FILE_SCHEMA identifiers. */
export function detectSchema(schemas: readonly string[]): StepSchemaInfo {
  const identifier = schemas[0] ?? '';
  const schemaName = identifier.replace(/\{.*$/, '').trim().toUpperCase();
  if (/^IFC/.test(schemaName)) {
    throw new UnsupportedSchemaError(`${identifier} is an IFC schema: read IFC files with meercad-ifc-import`, identifier);
  }
  const oid = /\{([^}]*)\}/.exec(identifier)?.[1]?.trim().split(/\s+/).map(Number) ?? [];
  // { 1 0 10303 <part> <edition> ... }
  const edition = oid.length >= 5 && oid[2] === 10303 && Number.isInteger(oid[4]) && oid[4]! > 0 ? oid[4]! : null;
  for (const p of PROTOCOLS) {
    if (p.test.test(schemaName)) return { protocol: p.protocol, name: p.name, identifier, schemaName, edition };
  }
  return { protocol: 'other', name: schemaName || 'unknown schema', identifier, schemaName, edition };
}
