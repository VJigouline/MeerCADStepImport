import { describe, expect, it } from 'vitest';
import { loadStepAsync, readStep, readStepAsync, runStepWorker, type StepWorkerLike } from '../src/index.js';
import { allMeshes, box, cone, cylinder, sphere, stepFile, StepWriter, torus } from './helpers.js';

/**
 * A worker on this thread: runStepWorker on one end of a MessageChannel. The messages, and the
 * arrays moved in them, go the same way as to a real worker.
 */
function channelWorker(): StepWorkerLike {
  const channel = new MessageChannel();
  runStepWorker({
    postMessage: (message, transfer) => channel.port2.postMessage(message, transfer ?? []),
    addEventListener: (type, listener) => channel.port2.addEventListener(type, listener as (event: MessageEvent) => void),
  });
  channel.port2.start();
  channel.port1.start();
  return {
    postMessage: (message, transfer) => channel.port1.postMessage(message, transfer ?? []),
    addEventListener: (type: 'message' | 'error', listener: (event: never) => void) => channel.port1.addEventListener(type === 'message' ? 'message' : 'messageerror', listener as () => void),
    terminate: () => {
      channel.port1.close();
      channel.port2.close();
    },
  } as StepWorkerLike;
}

function shapes(): string {
  const w = new StepWriter();
  const items = [box(w, [0, 0, 0], [10, 20, 30]), cylinder(w, 5, 10), sphere(w, 4, [20, 0, 0]), torus(w, 10, 3), cone(w, 10, Math.PI / 6)];
  return stepFile(w, items);
}

describe('tessellating in workers', () => {
  it.each([1, 2, 3])('gives the same result as readStep with %i workers', async count => {
    const text = shapes();
    const expected = readStep(text);
    const result = await readStepAsync(new TextEncoder().encode(text), { workers: { create: channelWorker, count } });
    expect(result.warnings).toEqual(expected.warnings);
    expect(result.stats).toEqual(expected.stats);
    const a = allMeshes(result), b = allMeshes(expected);
    expect(a).toHaveLength(b.length);
    a.forEach((mesh, i) => {
      expect(mesh.itemId).toBe(b[i]!.itemId);
      expect(mesh.style).toEqual(b[i]!.style);
      expect(mesh.matrix).toEqual(b[i]!.matrix);
      expect(Array.from(mesh.data.positions)).toEqual(Array.from(b[i]!.data.positions));
      expect(Array.from(mesh.data.indices)).toEqual(Array.from(b[i]!.data.indices));
      expect(Array.from(mesh.edges ?? [])).toEqual(Array.from(b[i]!.edges ?? []));
    });
  });

  it('builds a three.js group through loadStepAsync', async () => {
    const result = await loadStepAsync(shapes(), { workers: { create: channelWorker, count: 2 } });
    let meshes = 0;
    result.group.traverse(o => {
      if ((o as { isMesh?: boolean }).isMesh) meshes++;
    });
    expect(meshes).toBe(result.stats.meshes);
    expect(result.stats.triangles).toBeGreaterThan(0);
  });

  it('reads on this thread, with a warning, when workers cannot be started', async () => {
    const text = shapes();
    const result = await readStepAsync(text, {
      workers: {
        create: () => {
          throw new Error('no workers here');
        },
      },
    });
    expect(result.stats).toEqual(readStep(text).stats);
    expect(result.warnings).toContain('Read without workers: no workers here');
  });

  it('reads on this thread, with a warning, when every worker fails', async () => {
    const text = shapes();
    const broken = (): StepWorkerLike => {
      const listeners: ((event: { data: unknown }) => void)[] = [];
      return {
        postMessage: () => queueMicrotask(() => listeners.forEach(l => l({ data: { type: 'failed', message: 'out of memory' } }))),
        addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
          if (type === 'message') listeners.push(listener);
        },
        terminate: () => {},
      } as StepWorkerLike;
    };
    const result = await readStepAsync(text, { workers: { create: broken, count: 2 } });
    expect(result.stats).toEqual(readStep(text).stats);
    expect(result.warnings).toContain('Read without workers: out of memory');
  });

  it('still refuses IFC files', async () => {
    const ifc = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    await expect(readStepAsync(ifc, { workers: { create: channelWorker, count: 1 } })).rejects.toThrow(/IFC/);
  });
});
