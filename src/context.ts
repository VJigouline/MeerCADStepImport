// What tessellating a file's shape items needs, shared by the importer and the workers it can
// spread the tessellation over: the model, its styles, the tolerances, and a tessellator for each
// angle unit, with the warnings and statistics they gather.

import { GeometryReader } from './brep/geometry.js';
import { ShapeTessellator, Warnings, type TessellationOptions, type TessellationStats } from './brep/shapes.js';
import { StyleTable } from './brep/styles.js';
import { StepModel } from './step/access.js';
import type { StepFile } from './step/step.js';

export interface StepImportOptions extends Partial<TessellationOptions> {
  /** Draw items that the file hides with INVISIBILITY. Default false. */
  includeHidden?: boolean;
  /** Where a product has both a B-rep and an AP242 tessellated shape, use the tessellated one. Default false. */
  preferTessellated?: boolean;
}

export const DEFAULT_TESSELLATION: TessellationOptions = {
  relativeTolerance: 0.001,
  absoluteTolerance: null,
  angularTolerance: 0.2,
  maxTrianglesPerFace: 50000,
};

export class TessellationContext {
  readonly model: StepModel;
  readonly styles: StyleTable;
  readonly options: TessellationOptions;
  readonly warnings = new Warnings();
  readonly stats: TessellationStats = { faces: 0, failedFaces: 0, triangles: 0 };
  private readonly tessellators = new Map<number, ShapeTessellator>();

  constructor(readonly file: StepFile, importOptions: StepImportOptions) {
    this.model = new StepModel(file);
    this.styles = new StyleTable(this.model);
    if (importOptions.includeHidden) this.styles.hidden.clear();
    this.options = {
      relativeTolerance: importOptions.relativeTolerance ?? DEFAULT_TESSELLATION.relativeTolerance,
      absoluteTolerance: importOptions.absoluteTolerance ?? DEFAULT_TESSELLATION.absoluteTolerance,
      angularTolerance: importOptions.angularTolerance ?? DEFAULT_TESSELLATION.angularTolerance,
      maxTrianglesPerFace: importOptions.maxTrianglesPerFace ?? DEFAULT_TESSELLATION.maxTrianglesPerFace,
    };
  }

  /** The tessellator for representations whose plane angles are in `angle` radians. */
  tessellator(angle: number): ShapeTessellator {
    let t = this.tessellators.get(angle);
    if (!t) {
      t = new ShapeTessellator(this.model, new GeometryReader(this.model, angle), this.styles, this.options, this.warnings, this.stats);
      this.tessellators.set(angle, t);
    }
    return t;
  }
}
