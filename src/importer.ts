// Reads a STEP file into a tree of products and assembly instances with tessellated meshes:
// PRODUCT_DEFINITIONs with their shape representations, NEXT_ASSEMBLY_USAGE_OCCURRENCEs placed by
// CONTEXT_DEPENDENT_SHAPE_REPRESENTATION or MAPPED_ITEM, and representation units.

import { identity, invert, isIdentity, multiply, type Mat4 } from './geometry/math.js';
import { GeometryReader } from './brep/geometry.js';
import { ShapeTessellator, Warnings, type StyledMesh, type TessellationOptions, type TessellationStats } from './brep/shapes.js';
import { StyleTable, type StepStyle } from './brep/styles.js';
import { UnitReader, type Units } from './brep/units.js';
import { refId, refIds, str, StepModel } from './step/access.js';
import { detectSchema, type StepSchemaInfo } from './step/schema.js';
import { StepFile, stepText, type StepHeader } from './step/step.js';

export interface StepImportOptions extends Partial<TessellationOptions> {
  /** Draw items that the file hides with INVISIBILITY. Default false. */
  includeHidden?: boolean;
  /** Where a product has both a B-rep and an AP242 tessellated shape, use the tessellated one. Default false. */
  preferTessellated?: boolean;
}

export interface StepProduct {
  /** PRODUCT id, often a part number. */
  id: string;
  name: string;
  description: string;
}

/** A mesh placed in its node. */
export interface StepMesh extends StyledMesh {
  /** Placement in the node, in metres, including the scale from the file's length unit; null for none. */
  matrix: Float64Array | null;
}

export interface StepNode {
  name: string;
  /** product: a part or assembly; instance: a product placed in an assembly; shape: geometry without a product. */
  kind: 'product' | 'instance' | 'shape';
  product: StepProduct | null;
  /** Id of the PRODUCT_DEFINITION, if any. */
  productDefinition: number | null;
  /** Id of the NEXT_ASSEMBLY_USAGE_OCCURRENCE or MAPPED_ITEM that places an instance. */
  occurrence: number | null;
  /** Placement relative to the parent node, in metres, column-major 4 x 4; null for none. */
  matrix: Float64Array | null;
  meshes: StepMesh[];
  children: StepNode[];
}

export interface StepImportResult {
  schema: StepSchemaInfo;
  header: StepHeader;
  /** Metres per length unit of the file's main shape representation. */
  lengthUnit: number;
  /** That unit's name, such as mm or inch. */
  lengthUnitName: string;
  roots: StepNode[];
  /** Problems that didn't stop the import, such as faces left out. */
  warnings: string[];
  stats: {
    entities: number;
    products: number;
    faces: number;
    failedFaces: number;
    triangles: number;
    meshes: number;
  };
}

const DEFAULTS: TessellationOptions = {
  relativeTolerance: 0.001,
  absoluteTolerance: null,
  angularTolerance: 0.2,
  maxTrianglesPerFace: 50000,
};

const TESSELLATED_ITEMS = ['TESSELLATED_SOLID', 'TESSELLATED_SHELL', 'TRIANGULATED_FACE', 'COMPLEX_TRIANGULATED_FACE', 'TRIANGULATED_SURFACE_SET', 'COMPLEX_TRIANGULATED_SURFACE_SET'];
const BREP_ITEMS = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'FACE_BASED_SURFACE_MODEL'];

/** Item types that are recognised but not drawn, so they don't need warnings. */
const QUIET = new Set([
  'AXIS2_PLACEMENT_3D', 'AXIS2_PLACEMENT_2D', 'AXIS1_PLACEMENT', 'CARTESIAN_POINT', 'DIRECTION', 'GEOMETRIC_CURVE_SET',
  'GEOMETRIC_SET', 'STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM', 'DESCRIPTIVE_REPRESENTATION_ITEM', 'MEASURE_REPRESENTATION_ITEM',
  'VALUE_REPRESENTATION_ITEM', 'ANNOTATION_PLANE', 'DRAUGHTING_CALLOUT', 'TESSELLATED_ANNOTATION_OCCURRENCE',
  'ANNOTATION_OCCURRENCE', 'ANNOTATION_CURVE_OCCURRENCE', 'ANNOTATION_FILL_AREA_OCCURRENCE', 'ANNOTATION_TEXT_OCCURRENCE',
  'COMPLEX', 'REPRESENTATION_ITEM', 'TESSELLATED_GEOMETRIC_SET', 'TESSELLATED_CURVE_SET', 'COMPLEX_TRIANGULATED_SURFACE_SET_LIGHT',
  'VERTEX_POINT', 'EDGE_CURVE', 'TRIMMED_CURVE', 'POLYLINE', 'COMPOSITE_CURVE', 'B_SPLINE_CURVE_WITH_KNOTS', 'LINE', 'CIRCLE',
  'CAMERA_MODEL_D3', 'CAMERA_MODEL_D3_MULTI_CLIPPING', 'POINT_SET', 'CONNECTED_EDGE_SET', 'EDGE_BASED_WIREFRAME_MODEL',
  'SHELL_BASED_WIREFRAME_MODEL', 'PLACEMENT', 'TEXT_LITERAL', 'PLANE',
]);

/**
 * Reads a STEP file (AP203, AP214, AP242 or another AP with ISO 10303-42 shape) into products,
 * assembly instances and meshes. Synchronous; large files take a while.
 */
export function readStep(input: string | ArrayBuffer | Uint8Array, options: StepImportOptions = {}): StepImportResult {
  const text = stepText(input);
  const file = new StepFile(text);
  const schema = detectSchema(file.header.schemas);
  return new Importer(file, schema, options).run();
}

interface Occurrence {
  id: number;
  name: string;
  parent: number;
  child: number;
}

class Importer {
  private readonly m: StepModel;
  private readonly units: UnitReader;
  private readonly styles: StyleTable;
  private readonly warnings = new Warnings();
  private readonly stats: TessellationStats = { faces: 0, failedFaces: 0, triangles: 0 };
  private readonly options: TessellationOptions;
  private readonly readers = new Map<number, ShapeTessellator>();
  private readonly meshCache = new Map<string, StyledMesh[]>();

  private readonly products = new Map<number, StepProduct>();
  private readonly pdReps = new Map<number, number[]>();
  /** Product definition whose shape a representation is, for reps used by a SHAPE_DEFINITION_REPRESENTATION. */
  private readonly repOwner = new Map<number, number>();
  private readonly occurrences: Occurrence[] = [];
  private readonly placements = new Map<number, { rep1: number | null; rep2: number | null; transform: number | null }>();
  private readonly links = new Map<number, number[]>();
  private lengthUnit: Units | null = null;

  constructor(readonly file: StepFile, readonly schema: StepSchemaInfo, readonly importOptions: StepImportOptions) {
    this.m = new StepModel(file);
    this.units = new UnitReader(this.m);
    this.styles = new StyleTable(this.m);
    if (importOptions.includeHidden) this.styles.hidden.clear();
    this.options = {
      relativeTolerance: importOptions.relativeTolerance ?? DEFAULTS.relativeTolerance,
      absoluteTolerance: importOptions.absoluteTolerance ?? DEFAULTS.absoluteTolerance,
      angularTolerance: importOptions.angularTolerance ?? DEFAULTS.angularTolerance,
      maxTrianglesPerFace: importOptions.maxTrianglesPerFace ?? DEFAULTS.maxTrianglesPerFace,
    };
  }

  run(): StepImportResult {
    if (this.schema.protocol === 'other') {
      this.warnings.add(`${this.schema.identifier || 'No FILE_SCHEMA'}: not a known application protocol; read for its ISO 10303-42 shapes`);
    }
    this.readProductStructure();
    const childIds = new Set(this.occurrences.map(o => o.child));
    const roots: StepNode[] = [];
    for (const pd of this.products.keys()) {
      if (childIds.has(pd)) continue;
      const node = this.productNode(pd, null, new Set());
      if (node) roots.push(node);
    }
    if (!roots.some(hasMeshes)) {
      // No product structure, or one without shapes: draw the representations directly.
      roots.length = 0;
      roots.push(...this.looseShapes());
    }
    let meshes = 0;
    const count = (n: StepNode) => {
      meshes += n.meshes.length;
      n.children.forEach(count);
    };
    roots.forEach(count);
    const unit = this.lengthUnit ?? this.units.ofContext(null);
    return {
      schema: this.schema,
      header: this.file.header,
      lengthUnit: unit.length,
      lengthUnitName: unit.lengthName,
      roots,
      warnings: this.warnings.list(),
      stats: {
        entities: this.file.size,
        products: this.products.size,
        faces: this.stats.faces,
        failedFaces: this.stats.failedFaces,
        triangles: this.stats.triangles,
        meshes,
      },
    };
  }

  private readProductStructure(): void {
    const m = this.m;
    for (const id of m.idsOf('PRODUCT_DEFINITION', 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS')) {
      const pd = m.get(id);
      if (!pd) continue;
      // PRODUCT_DEFINITION(id, description, formation, frame_of_reference)
      const formation = m.deref(pd.args[2]);
      const product = formation ? m.deref(formation.args[2]) : undefined;
      this.products.set(id, {
        id: product ? str(product.args[0]) : str(pd.args[0]),
        name: product ? str(product.args[1]) : '',
        description: product ? str(product.args[2]) : str(pd.args[1]),
      });
    }
    for (const id of m.idsOf('SHAPE_DEFINITION_REPRESENTATION')) {
      const sdr = m.get(id);
      if (!sdr) continue;
      // SHAPE_DEFINITION_REPRESENTATION(definition, used_representation)
      const pds = m.deref(sdr.args[0]);
      const rep = refId(sdr.args[1]);
      if (!pds || rep === null) continue;
      const definition = refId(pds.args[2]);
      if (definition === null || !this.products.has(definition)) continue;
      const reps = this.pdReps.get(definition) ?? [];
      reps.push(rep);
      this.pdReps.set(definition, reps);
      this.repOwner.set(rep, definition);
    }
    for (const id of m.idsOf('NEXT_ASSEMBLY_USAGE_OCCURRENCE', 'ASSEMBLY_COMPONENT_USAGE', 'SPECIFIED_HIGHER_USAGE_OCCURRENCE')) {
      const e = m.get(id);
      if (!e || e.type === 'SPECIFIED_HIGHER_USAGE_OCCURRENCE') continue;
      // (id, name, description, relating_product_definition, related_product_definition, ...)
      const parent = refId(e.args[3]), child = refId(e.args[4]);
      if (parent === null || child === null) continue;
      this.occurrences.push({ id, name: str(e.args[1]) || str(e.args[0]), parent, child });
    }
    // Some writers give every occurrence the same name, such as 'Next assembly relationship':
    // a name shared by occurrences of different products says nothing, so those use the product's.
    const products = new Map<string, Set<number>>();
    for (const o of this.occurrences) {
      const set = products.get(o.name) ?? new Set();
      set.add(o.child);
      products.set(o.name, set);
    }
    for (const o of this.occurrences) if ((products.get(o.name)?.size ?? 0) > 1) o.name = '';
    for (const id of m.idsOf('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
      const e = m.get(id);
      if (!e) continue;
      // CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(representation_relation, represented_product_relation)
      const rel = m.deref(e.args[0]);
      const pds = m.deref(e.args[1]);
      const occurrence = pds ? refId(pds.args[2]) : null;
      if (!rel || occurrence === null) continue;
      const rr = m.partArgs(rel, 'REPRESENTATION_RELATIONSHIP') ?? rel.args;
      const rrwt = m.partArgs(rel, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
      const transform = rrwt ? refId(rel.parts ? rrwt[0] : rrwt[4]) : null;
      this.placements.set(occurrence, { rep1: refId(rr[2]), rep2: refId(rr[3]), transform });
    }
    for (const id of m.idsOf('SHAPE_REPRESENTATION_RELATIONSHIP', 'REPRESENTATION_RELATIONSHIP')) {
      const e = m.get(id);
      if (!e || m.is(e, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) continue;
      const rr = m.partArgs(e, 'REPRESENTATION_RELATIONSHIP') ?? e.args;
      const a = refId(rr[2]), b = refId(rr[3]);
      if (a === null || b === null) continue;
      this.link(a, b);
      this.link(b, a);
    }
  }

  private link(a: number, b: number): void {
    const list = this.links.get(a) ?? [];
    list.push(b);
    this.links.set(a, list);
  }

  private productNode(pd: number, occurrence: Occurrence | null, stack: Set<number>): StepNode | null {
    if (stack.has(pd) || stack.size > 64) return null;
    stack.add(pd);
    const product = this.products.get(pd) ?? null;
    const node: StepNode = {
      name: cleanName(occurrence?.name || product?.name || product?.id || `#${pd}`),
      kind: occurrence ? 'instance' : 'product',
      product,
      productDefinition: pd,
      occurrence: occurrence?.id ?? null,
      matrix: null,
      meshes: [],
      children: [],
    };
    const placedByMapping = new Set<number>();
    const reps = this.chooseReps(this.pdReps.get(pd) ?? []);
    const visited = new Set<number>();
    for (const rep of reps) this.collectRep(rep, null, null, node, pd, visited, stack, placedByMapping);
    for (const o of this.occurrences) {
      if (o.parent !== pd) continue;
      const placement = this.placements.get(o.id);
      // An instance already placed by a MAPPED_ITEM in this product's shape isn't placed twice.
      if (!placement && placedByMapping.has(o.child)) continue;
      const child = this.productNode(o.child, o, stack);
      if (!child) continue;
      if (placement) child.matrix = this.occurrenceMatrix(o, placement);
      node.children.push(child);
    }
    stack.delete(pd);
    return prune(node);
  }

  /**
   * Where a product's shape has both B-rep and AP242 tessellated representations, skips the
   * kind not wanted, so the shape isn't drawn twice. Representations with neither kind of item,
   * such as one holding assembly placements, are kept.
   */
  private chooseReps(reps: number[]): number[] {
    const m = this.m;
    const expanded = new Set<number>();
    const walk = (rep: number) => {
      if (expanded.has(rep)) return;
      expanded.add(rep);
      for (const other of this.links.get(rep) ?? []) {
        const owner = this.repOwner.get(other);
        if (owner === undefined || reps.includes(other)) walk(other);
      }
    };
    reps.forEach(walk);
    const kind = (rep: number): 'brep' | 'tessellated' | null => {
      const items = refIds(m.get(rep)?.args[1]).map(id => m.get(id));
      if (items.some(item => m.is(item, ...TESSELLATED_ITEMS))) return 'tessellated';
      if (items.some(item => m.is(item, ...BREP_ITEMS))) return 'brep';
      return null;
    };
    const kinds = new Map([...expanded].map(rep => [rep, kind(rep)]));
    const values = [...kinds.values()];
    if (!values.includes('brep') || !values.includes('tessellated')) return reps;
    const skip = this.importOptions.preferTessellated ? 'brep' : 'tessellated';
    for (const [rep, k] of kinds) if (k === skip) this.skipReps.add(rep);
    return reps;
  }

  private readonly skipReps = new Set<number>();

  private reader(units: Units): ShapeTessellator {
    let t = this.readers.get(units.angle);
    if (!t) {
      const geometry = new GeometryReader(this.m, units.angle);
      t = new ShapeTessellator(this.m, geometry, this.styles, this.options, this.warnings, this.stats);
      this.readers.set(units.angle, t);
    }
    return t;
  }

  private repUnits(rep: number): Units {
    const e = this.m.get(rep);
    return this.units.ofContext(e ? refId(e.args[2]) : null);
  }

  /** A placement matrix in metres. */
  private placement(id: number | null, units: Units): Mat4 {
    const matrix = this.reader(units).geometry.matrix(id);
    matrix[12] = matrix[12]! * units.length;
    matrix[13] = matrix[13]! * units.length;
    matrix[14] = matrix[14]! * units.length;
    return matrix;
  }

  /**
   * Adds a representation's items to a node: shapes as meshes, MAPPED_ITEMs of other products'
   * shapes as child instances, other MAPPED_ITEMs and related representations recursively.
   */
  private collectRep(rep: number, matrix: Mat4 | null, style: StepStyle | null, node: StepNode, pd: number | null, visited: Set<number>, stack: Set<number>, placedByMapping: Set<number>): void {
    const m = this.m;
    if (visited.has(rep)) return;
    visited.add(rep);
    if (this.skipReps.has(rep)) return;
    const e = m.get(rep);
    if (!e) return;
    const units = this.repUnits(rep);
    this.lengthUnit ??= units;
    const tessellator = this.reader(units);
    const scale = units.length;
    const unknown = new Set<string>();
    for (const itemId of refIds(e.args[1])) {
      const item = m.get(itemId);
      if (!item) continue;
      if (item.type === 'MAPPED_ITEM') {
        // MAPPED_ITEM(name, mapping_source, mapping_target); REPRESENTATION_MAP(mapping_origin, mapped_representation)
        const map = m.deref(item.args[1]);
        const mapped = map ? refId(map.args[1]) : null;
        if (mapped === null || !map) continue;
        const mappedUnits = this.repUnits(mapped);
        const transform = multiply(this.placement(refId(item.args[2]), units), invert(this.placement(refId(map.args[0]), mappedUnits)));
        const owner = this.repOwner.get(mapped);
        if (owner !== undefined && owner !== pd && this.products.has(owner)) {
          // Another product's shape: an assembly instance.
          const occurrence = this.occurrences.find(o => o.parent === pd && o.child === owner) ?? null;
          const child = this.productNode(owner, occurrence, stack);
          if (child) {
            child.kind = 'instance';
            child.occurrence = occurrence?.id ?? itemId;
            if (!occurrence && str(item.args[0])) child.name = cleanName(str(item.args[0]));
            child.matrix = matrix ? multiply(matrix, transform) : transform;
            node.children.push(child);
            placedByMapping.add(owner);
          }
          continue;
        }
        const mappedStyle = this.styles.byItem.get(itemId) ?? style;
        if (this.styles.hidden.has(itemId)) continue;
        this.collectRep(mapped, matrix ? multiply(matrix, transform) : transform, mappedStyle, node, pd, new Set(), stack, placedByMapping);
        continue;
      }
      if (tessellator.isShape(item)) {
        const cacheKey = `${itemId}|${units.angle}|${style ? style.name + style.color.join(',') : ''}`;
        let meshes = this.meshCache.get(cacheKey);
        if (!meshes) {
          meshes = tessellator.tessellate(itemId, style);
          this.meshCache.set(cacheKey, meshes);
        }
        for (const mesh of meshes) {
          const s = scaleMatrix(scale);
          const placed = matrix ? multiply(matrix, s) : s;
          node.meshes.push({ ...mesh, matrix: isIdentity(placed) ? null : placed });
        }
      } else if (!QUIET.has(item.type) && !m.is(item, 'CURVE', 'BOUNDED_CURVE', 'GEOMETRIC_REPRESENTATION_ITEM')) {
        unknown.add(m.displayType(item));
      }
    }
    for (const type of unknown) this.warnings.add(`${type} items are not drawn`);
    // Representations related without a transformation share this one's coordinates.
    for (const other of this.links.get(rep) ?? []) {
      const owner = this.repOwner.get(other);
      if (owner !== undefined && owner !== pd) continue;
      if (visited.has(other)) continue;
      this.collectRep(other, matrix, style, node, pd, visited, stack, placedByMapping);
    }
  }

  /** Child-to-parent placement of an assembly occurrence, in metres. */
  private occurrenceMatrix(o: Occurrence, placement: { rep1: number | null; rep2: number | null; transform: number | null }): Float64Array | null {
    const m = this.m;
    const t = m.get(placement.transform);
    if (!t) return null;
    const childReps = new Set(this.pdReps.get(o.child) ?? []);
    let childRep = placement.rep1, parentRep = placement.rep2;
    if (placement.rep2 !== null && childReps.has(placement.rep2) && !(placement.rep1 !== null && childReps.has(placement.rep1))) {
      childRep = placement.rep2;
      parentRep = placement.rep1;
    }
    const childUnits = childRep !== null ? this.repUnits(childRep) : this.units.ofContext(null);
    const parentUnits = parentRep !== null ? this.repUnits(parentRep) : childUnits;
    if (t.type === 'ITEM_DEFINED_TRANSFORMATION') {
      // ITEM_DEFINED_TRANSFORMATION(name, description, transform_item_1, transform_item_2)
      let childItem = refId(t.args[2]), parentItem = refId(t.args[3]);
      const childItems = new Set(childRep !== null ? refIds(m.get(childRep)?.args[1]) : []);
      if (parentItem !== null && childItems.has(parentItem) && !(childItem !== null && childItems.has(childItem))) {
        [childItem, parentItem] = [parentItem, childItem];
      } else if (childRep === placement.rep2 && !childItems.has(childItem ?? -1)) {
        [childItem, parentItem] = [parentItem, childItem];
      }
      const matrix = multiply(this.placement(parentItem, parentUnits), invert(this.placement(childItem, childUnits)));
      return isIdentity(matrix) ? null : matrix;
    }
    if (m.is(t, 'CARTESIAN_TRANSFORMATION_OPERATOR_3D', 'CARTESIAN_TRANSFORMATION_OPERATOR')) {
      const matrix = this.placement(t.id, parentUnits);
      return isIdentity(matrix) ? null : matrix;
    }
    this.warnings.add(`${t.type} assembly placements are not supported`);
    return null;
  }

  /** Shapes in representations that no product uses, for files without a product structure. */
  private looseShapes(): StepNode[] {
    const m = this.m;
    const mapped = new Set<number>();
    for (const id of m.idsOf('REPRESENTATION_MAP')) {
      const r = refId(m.get(id)?.args[1]);
      if (r !== null) mapped.add(r);
    }
    const nodes: StepNode[] = [];
    const reps = new Set<number>();
    for (const [type, ids] of this.file.typeCounts()) {
      if (!/REPRESENTATION$/.test(type) || /^(PROPERTY_DEFINITION|SHAPE_DEFINITION|DEFINITIONAL|CONTEXT_DEPENDENT|PRESENTATION|DRAUGHTING_MODEL|MECHANICAL_DESIGN)/.test(type) || ids === 0) continue;
      for (const id of m.idsOf(type)) reps.add(id);
    }
    const tessellatorFor = (rep: number) => this.reader(this.repUnits(rep));
    const used = new Set<number>();
    for (const rep of reps) {
      if (mapped.has(rep)) continue;
      const e = m.get(rep);
      const items = refIds(e?.args[1]);
      if (!items.some(i => tessellatorFor(rep).isShape(m.get(i)) || m.get(i)?.type === 'MAPPED_ITEM')) continue;
      const node: StepNode = { name: cleanName(str(e?.args[0])) || `#${rep}`, kind: 'shape', product: null, productDefinition: null, occurrence: null, matrix: null, meshes: [], children: [] };
      this.collectRep(rep, null, null, node, null, new Set(), new Set(), new Set());
      for (const i of items) used.add(i);
      if (hasMeshes(node)) nodes.push(node);
    }
    if (nodes.length) return nodes;
    // Shapes outside any representation.
    const node: StepNode = { name: this.file.header.fileName || 'STEP shapes', kind: 'shape', product: null, productDefinition: null, occurrence: null, matrix: null, meshes: [], children: [] };
    const units = this.units.ofContext(m.idsOf('GLOBAL_UNIT_ASSIGNED_CONTEXT')[0] ?? null);
    this.lengthUnit ??= units;
    const tessellator = this.reader(units);
    for (const id of m.idsOf('MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'FACE_BASED_SURFACE_MODEL', 'TESSELLATED_SOLID', 'TESSELLATED_SHELL')) {
      if (used.has(id)) continue;
      for (const mesh of tessellator.tessellate(id, null)) node.meshes.push({ ...mesh, matrix: scaleMatrix(units.length) });
    }
    return hasMeshes(node) ? [node] : [];
  }
}

/** A name on one line, as some writers put line breaks in names. */
function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

function scaleMatrix(s: number): Mat4 {
  const m = identity();
  m[0] = m[5] = m[10] = s;
  return m;
}

function hasMeshes(node: StepNode): boolean {
  return node.meshes.length > 0 || node.children.some(hasMeshes);
}

/** A node without meshes anywhere below it is dropped. */
function prune(node: StepNode): StepNode | null {
  node.children = node.children.filter(hasMeshes);
  return hasMeshes(node) ? node : null;
}

