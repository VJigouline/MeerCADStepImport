import type * as THREE from 'three';
import { readStep, readStepAsync, type StepImportOptions, type StepImportResult } from './importer.js';
import type { StepWorkerOptions } from './parallel.js';
import { toThree, type StepThreeOptions } from './three.js';

export { readStep, readStepAsync } from './importer.js';
export { runStepWorker, defaultWorkerCount } from './parallel.js';
export type { StepWorkerLike, StepWorkerOptions, StepWorkerScope } from './parallel.js';
export type { StepImportOptions, StepImportResult, StepNode, StepMesh, StepProduct } from './importer.js';
export { toThree } from './three.js';
export type { StepThreeOptions, StepUserData, StepMeshUserData } from './three.js';
export { detectSchema, UnsupportedSchemaError } from './step/schema.js';
export type { StepProtocol, StepSchemaInfo } from './step/schema.js';
export { StepFile, StepRef, StepEnum, StepTyped, StepSyntaxError, DERIVED, decodeStepString, stepText } from './step/step.js';
export type { StepEntity, StepHeader, StepPart, StepValue } from './step/step.js';
export type { StepStyle } from './brep/styles.js';
export type { TessellationOptions } from './brep/shapes.js';
export type { MeshData } from './geometry/mesh.js';

export interface StepLoadResult extends StepImportResult {
  /** The model for three.js. */
  group: THREE.Group;
}

/**
 * Reads a STEP file (AP203, AP214, AP242 and other APs with ISO 10303-42 shape) and returns the
 * model as a three.js group together with the plain import result.
 */
export function loadStep(input: string | ArrayBuffer | Uint8Array, options: StepImportOptions & StepThreeOptions = {}): StepLoadResult {
  const result = readStep(input, options);
  return { ...result, group: toThree(result, options) };
}

/** True if the bytes start like a gzip stream, as .stpz files do. */
export function isGzip(input: ArrayBuffer | Uint8Array): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Inflates gzip-compressed STEP (.stpz) with the platform's DecompressionStream. */
export async function decompressStep(input: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Like loadStep, and also reads gzip-compressed files (.stpz). With `workers`, the tessellation
 * is spread over web workers whose script calls `runStepWorker()`, which is several times faster
 * for large files and leaves the page responsive meanwhile.
 */
export async function loadStepAsync(
  input: string | ArrayBuffer | Uint8Array,
  options: StepImportOptions & StepThreeOptions & { workers?: StepWorkerOptions } = {},
): Promise<StepLoadResult> {
  const data = typeof input !== 'string' && isGzip(input) ? await decompressStep(input) : input;
  const result = await readStepAsync(data, options);
  return { ...result, group: toThree(result, options) };
}
