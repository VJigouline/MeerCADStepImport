// Tessellation spread over workers: each worker reads the file for itself, then tessellates the
// shape items it is handed, one at a time, largest first, and sends the meshes back.

import type { StyledMesh, TessellationStats } from './brep/shapes.js';
import type { StepStyle } from './brep/styles.js';
import { TessellationContext, type StepImportOptions } from './context.js';
import type { TessellationRequest } from './importer.js';
import { StepFile, stepText } from './step/step.js';

/**
 * What the importer needs of a worker: a web Worker is one. In Node, wrap a worker_threads
 * Worker (see the API documentation).
 */
export interface StepWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  terminate(): void;
}

export interface StepWorkerOptions {
  /** Starts a worker whose script calls `runStepWorker()`. */
  create: () => StepWorkerLike;
  /**
   * How many workers to start: by default one less than the processors, at most 6. Each holds
   * its own copy of the file's text.
   */
  count?: number;
}

/** What the worker's side, `runStepWorker`, can listen and answer on. */
export interface StepWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

type ToWorker =
  | { type: 'init'; input: string | ArrayBuffer | Uint8Array; options: StepImportOptions }
  | { type: 'tessellate'; task: number; itemId: number; angle: number; style: StepStyle | null };

type FromWorker =
  | { type: 'ready' }
  | { type: 'done'; task: number; meshes: StyledMesh[]; warnings: [string, number][]; stats: TessellationStats }
  | { type: 'failed'; message: string };

/** The default number of workers: one less than the processors, at most 6. */
export function defaultWorkerCount(): number {
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(6, cores - 1));
}

/**
 * Runs in a worker: reads the file it is sent, then tessellates the items it is asked for. Call
 * it from the worker's script; `scope` is the worker's global scope unless given.
 */
export function runStepWorker(scope: StepWorkerScope = globalThis as unknown as StepWorkerScope): void {
  let context: TessellationContext | null = null;
  scope.addEventListener('message', event => {
    const message = event.data as ToWorker;
    try {
      if (message.type === 'init') {
        context = new TessellationContext(new StepFile(stepText(message.input)), message.options);
        scope.postMessage({ type: 'ready' } satisfies FromWorker);
      } else if (message.type === 'tessellate') {
        if (!context) throw new Error('tessellate before init');
        const before = { ...context.stats };
        context.warnings.clear();
        const meshes = context.tessellator(message.angle).tessellate(message.itemId, message.style);
        const stats: TessellationStats = {
          faces: context.stats.faces - before.faces,
          failedFaces: context.stats.failedFaces - before.failedFaces,
          triangles: context.stats.triangles - before.triangles,
        };
        // The meshes' arrays move to the importer rather than being copied.
        const transfer = new Set<ArrayBuffer>();
        for (const mesh of meshes) {
          for (const array of [mesh.data.positions, mesh.data.normals, mesh.data.indices, mesh.data.colors, mesh.edges]) {
            if (array && array.buffer instanceof ArrayBuffer) transfer.add(array.buffer);
          }
        }
        const reply: FromWorker = { type: 'done', task: message.task, meshes, warnings: context.warnings.entries(), stats };
        scope.postMessage(reply, [...transfer]);
      }
    } catch (error) {
      scope.postMessage({ type: 'failed', message: error instanceof Error ? error.message : String(error) } satisfies FromWorker);
    }
  });
}

/**
 * Workers reading one file. They start reading as soon as the pool is made, while the importer
 * reads the product structure.
 */
export class StepWorkerPool {
  private readonly workers: StepWorkerLike[] = [];
  private readonly ready: Promise<void>[] = [];
  private closed = false;

  constructor(input: string | ArrayBuffer | Uint8Array, options: StepImportOptions, workerOptions: StepWorkerOptions) {
    const count = Math.max(1, Math.floor(workerOptions.count ?? defaultWorkerCount()));
    for (let i = 0; i < count; i++) {
      const worker = workerOptions.create();
      this.workers.push(worker);
      this.ready.push(
        new Promise((resolve, reject) => {
          const listener = (event: { data: unknown }) => {
            const message = event.data as FromWorker;
            if (message.type === 'ready') resolve();
            else if (message.type === 'failed') reject(new Error(message.message));
          };
          worker.addEventListener('message', listener);
          worker.addEventListener('error', error => reject(asError(error)));
        }),
      );
      // Each worker gets its own copy of the file.
      worker.postMessage({ type: 'init', input, options: plainOptions(options) } satisfies ToWorker);
    }
  }

  /**
   * Tessellates the requested items, largest first by `cost`, and calls `done` with each one's
   * meshes, the warnings it gave and its statistics. Rejects if a worker fails.
   */
  async run(
    requests: readonly TessellationRequest[],
    cost: (request: TessellationRequest) => number,
    done: (request: TessellationRequest, meshes: StyledMesh[], warnings: [string, number][], stats: TessellationStats) => void,
  ): Promise<void> {
    const queue = requests.map(r => ({ r, c: cost(r) })).sort((a, b) => b.c - a.c).map(x => x.r);
    let next = 0;
    // Workers that are still loading take items once they are ready; a worker that fails to load
    // is left out as long as others work.
    const lanes = this.workers.map((worker, i) =>
      this.ready[i]!.then(
        () =>
          new Promise<void>((resolve, reject) => {
            const give = () => {
              if (this.closed || next >= queue.length) {
                resolve();
                return;
              }
              const task = next++;
              const r = queue[task]!;
              worker.postMessage({ type: 'tessellate', task, itemId: r.itemId, angle: r.angle, style: r.style } satisfies ToWorker);
            };
            worker.addEventListener('message', event => {
              const message = event.data as FromWorker;
              if (message.type === 'done') {
                done(queue[message.task]!, message.meshes, message.warnings, message.stats);
                give();
              } else if (message.type === 'failed') {
                reject(new Error(message.message));
              }
            });
            worker.addEventListener('error', error => reject(asError(error)));
            give();
          }),
        (error: unknown) => ({ failed: asError(error) }),
      ),
    );
    const results = await Promise.all(lanes);
    const failures = results.filter((x): x is { failed: Error } => !!x && typeof x === 'object' && 'failed' in x);
    if (failures.length === this.workers.length) throw failures[0]!.failed;
    if (next < queue.length) throw new Error('workers stopped before tessellating every item');
  }

  close(): void {
    this.closed = true;
    for (const worker of this.workers) worker.terminate();
  }
}

/** The options without anything that can't be sent to a worker. */
function plainOptions(options: StepImportOptions): StepImportOptions {
  return {
    relativeTolerance: options.relativeTolerance,
    absoluteTolerance: options.absoluteTolerance,
    angularTolerance: options.angularTolerance,
    maxTrianglesPerFace: options.maxTrianglesPerFace,
    includeHidden: options.includeHidden,
    preferTessellated: options.preferTessellated,
  };
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  const message = (error as { message?: unknown })?.message;
  return new Error(typeof message === 'string' ? message : 'a worker failed');
}
