// Checks against third-party sample models (CAx-IF test files and others) kept in samples/, which
// is not in the repository: these tests are skipped when the folder is absent.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readStep } from '../src/index.js';
import { allMeshes, checkMesh } from './helpers.js';

const dir = new URL('../samples/', import.meta.url);
const files = existsSync(dir) ? readdirSync(dir).filter(f => /\.(stp|step)$/i.test(f)) : [];

describe.skipIf(files.length === 0)('sample models', () => {
  it.each(files)('%s imports with every face', file => {
    const r = readStep(readFileSync(new URL(file, dir)));
    expect(r.stats.failedFaces).toBe(0);
    expect(r.stats.triangles).toBeGreaterThan(0);
    for (const mesh of allMeshes(r)) {
      const check = checkMesh(mesh.data);
      // Thin fillets give a few sliver triangles tilted past their vertex normals.
      expect(check.normalAgreement).toBeGreaterThan(0.99);
      expect(check.nonManifoldEdges).toBe(0);
    }
  });
});
