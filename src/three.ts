// Builds a three.js scene graph from an imported STEP model.

import * as THREE from 'three';
import type { StepImportResult, StepMesh, StepNode } from './importer.js';
import type { StepStyle } from './brep/styles.js';

export interface StepThreeOptions {
  /** Keep the model in metres. Default true; false scales it back to the file's length unit. */
  metres?: boolean;
  /** Turn STEP's Z-up coordinates into three.js's Y-up. Default true. */
  yUp?: boolean;
  /** Render both sides of faces, for open shells and surface models. Default true. */
  doubleSided?: boolean;
  /**
   * Add the faces' boundary loops (their edges) as a THREE.LineSegments child of each mesh that
   * has them, marked with userData.stepEdges. Default true.
   */
  edges?: boolean;
  /** Colour of those lines. Default 0x202020. */
  edgeColor?: THREE.ColorRepresentation;
}

/** What each three.js object made from a STEP node carries in userData.step. */
export interface StepUserData {
  kind: StepNode['kind'];
  productId: string | null;
  productName: string | null;
  description: string | null;
  /** Id of the PRODUCT_DEFINITION. */
  productDefinition: number | null;
  /** Id of the NEXT_ASSEMBLY_USAGE_OCCURRENCE or MAPPED_ITEM placing an instance. */
  occurrence: number | null;
}

/** userData.step of meshes: their node's data plus the shape item they came from. */
export interface StepMeshUserData extends StepUserData {
  itemId: number;
  itemType: string;
  style: string;
}

/**
 * The STEP model as a THREE.Group: a group per product and assembly instance, placed in its
 * parent, and a mesh per shape item and colour. Instances of the same part share
 * BufferGeometries, and equal colours share a material.
 */
export function toThree(result: StepImportResult, options: StepThreeOptions = {}): THREE.Group {
  const metres = options.metres ?? true;
  const yUp = options.yUp ?? true;
  const side = options.doubleSided ?? true ? THREE.DoubleSide : THREE.FrontSide;
  const withEdges = options.edges ?? true;
  const root = new THREE.Group();
  root.name = result.header.fileName || 'STEP model';
  root.userData.stepSchema = result.schema;
  if (!metres && result.lengthUnit !== 1) root.scale.setScalar(1 / result.lengthUnit);
  if (yUp) root.rotation.x = -Math.PI / 2;

  const geometries = new Map<object, THREE.BufferGeometry>();
  const materials = new Map<string, THREE.Material>();
  const edgeGeometries = new Map<Float32Array, THREE.BufferGeometry>();
  let edgeMaterial: THREE.LineBasicMaterial | null = null;
  const edgesOf = (edges: Float32Array): THREE.LineSegments => {
    let geometry = edgeGeometries.get(edges);
    if (!geometry) {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(edges, 3));
      geometry.computeBoundingSphere();
      edgeGeometries.set(edges, geometry);
    }
    edgeMaterial ??= new THREE.LineBasicMaterial({ name: 'STEP edges', color: new THREE.Color(options.edgeColor ?? 0x202020) });
    const lines = new THREE.LineSegments(geometry, edgeMaterial);
    lines.name = 'Edges';
    lines.userData.stepEdges = true;
    return lines;
  };
  const geometryOf = (mesh: StepMesh): THREE.BufferGeometry => {
    let geometry = geometries.get(mesh.data);
    if (!geometry) {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.data.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.data.normals, 3));
      if (mesh.data.colors) geometry.setAttribute('color', new THREE.BufferAttribute(mesh.data.colors, 4));
      geometry.setIndex(new THREE.BufferAttribute(mesh.data.indices, 1));
      geometry.computeBoundingSphere();
      geometries.set(mesh.data, geometry);
    }
    return geometry;
  };
  const materialOf = (style: StepStyle): THREE.Material => {
    const key = `${style.name}|${style.color.join(',')}|${style.opacity}`;
    let material = materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        name: style.name,
        color: new THREE.Color().setRGB(style.color[0], style.color[1], style.color[2], THREE.SRGBColorSpace),
        roughness: 0.5,
        metalness: 0.1,
        side,
        transparent: style.opacity < 1,
        opacity: style.opacity,
        depthWrite: style.opacity >= 1,
        // Pushed back a little so that edges drawn on the faces aren't hidden by them.
        polygonOffset: withEdges,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      materials.set(key, material);
    }
    return material;
  };

  const place = (object: THREE.Object3D, matrix: Float64Array | null) => {
    if (!matrix) return;
    const m = new THREE.Matrix4().fromArray(matrix);
    m.decompose(object.position, object.quaternion, object.scale);
    const check = new THREE.Matrix4().compose(object.position, object.quaternion, object.scale);
    if (!nearlyEqual(check, m)) {
      // Shear or a mirror that doesn't decompose: keep the matrix itself.
      object.matrixAutoUpdate = false;
      object.matrix.copy(m);
    }
  };

  const build = (node: StepNode): THREE.Group => {
    const group = new THREE.Group();
    group.name = node.name;
    const data: StepUserData = {
      kind: node.kind,
      productId: node.product?.id ?? null,
      productName: node.product?.name ?? null,
      description: node.product?.description ?? null,
      productDefinition: node.productDefinition,
      occurrence: node.occurrence,
    };
    group.userData.step = data;
    place(group, node.matrix);
    for (const mesh of node.meshes) {
      const three = new THREE.Mesh(geometryOf(mesh), materialOf(mesh.style));
      three.name = node.meshes.length > 1 ? `${node.name} (${mesh.name && !/^#\d+$/.test(mesh.name) ? mesh.name : mesh.style.name})` : node.name;
      const meshData: StepMeshUserData = { ...data, itemId: mesh.itemId, itemType: mesh.itemType, style: mesh.style.name };
      three.userData.step = meshData;
      three.castShadow = true;
      three.receiveShadow = true;
      place(three, mesh.matrix);
      if (withEdges && mesh.edges) three.add(edgesOf(mesh.edges));
      group.add(three);
    }
    for (const child of node.children) group.add(build(child));
    return group;
  };
  for (const node of result.roots) root.add(build(node));
  // World matrices ready for measuring, such as with Box3.setFromObject, before the first render.
  root.updateMatrixWorld(true);
  return root;
}

function nearlyEqual(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  let scale = 0;
  for (let i = 0; i < 16; i++) scale = Math.max(scale, Math.abs(b.elements[i]!));
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i]! - b.elements[i]!) > 1e-9 * Math.max(1, scale)) return false;
  return true;
}
