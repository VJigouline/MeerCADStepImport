// Indexed triangle meshes with normals, ready for a three.js BufferGeometry.

import type { Vec3 } from './math.js';

/** Indexed mesh with normals. */
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** RGBA per vertex, when the source had per-vertex colours; null otherwise. */
  colors: Float32Array | null;
}

/** Grows a mesh from parts, each with its own vertices. */
export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Appends vertices and triangles; indices are local to the part. */
  append(positions: readonly number[], normals: readonly number[], indices: readonly number[], flip = false): void {
    const base = this.vertexCount;
    for (const x of positions) this.positions.push(x);
    const sign = flip ? -1 : 1;
    for (const n of normals) this.normals.push(n * sign);
    for (let i = 0; i + 2 < indices.length; i += 3) {
      if (flip) this.indices.push(base + indices[i]!, base + indices[i + 2]!, base + indices[i + 1]!);
      else this.indices.push(base + indices[i]!, base + indices[i + 1]!, base + indices[i + 2]!);
    }
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      indices: new Uint32Array(this.indices),
      colors: null,
    };
  }
}

/** Area-weighted vertex normals of an indexed mesh. */
export function vertexNormals(positions: readonly number[], indices: readonly number[]): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const u: Vec3 = [positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!, positions[b + 2]! - positions[a + 2]!];
    const v: Vec3 = [positions[c]! - positions[a]!, positions[c + 1]! - positions[a + 1]!, positions[c + 2]! - positions[a + 2]!];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const k of [a, b, c]) {
      normals[k] += n[0];
      normals[k + 1] += n[1];
      normals[k + 2] += n[2];
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i] /= l;
    normals[i + 1] /= l;
    normals[i + 2] /= l;
  }
  return normals;
}
