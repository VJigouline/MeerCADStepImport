# Getting started

## Install

```sh
npm install three github:VJigouline/MeerCADStepImport
```

## Load a file into a three.js scene

```ts
import * as THREE from 'three';
import { loadStepAsync, UnsupportedSchemaError, StepSyntaxError } from 'meercad-step-import';

async function open(file: File, scene: THREE.Scene) {
  try {
    const result = await loadStepAsync(await file.arrayBuffer());
    scene.add(result.group);
    console.log(`${result.schema.name}, ${result.lengthUnitName}: ${result.stats.products} products, ${result.stats.triangles} triangles`);
    for (const warning of result.warnings) console.warn(warning);
  } catch (error) {
    if (error instanceof UnsupportedSchemaError || error instanceof StepSyntaxError) alert(error.message);
    else throw error;
  }
}
```

There are two ways to load a file:

- **`loadStepAsync`** also reads gzip-compressed STEP (`.stpz`).
- **`loadStep`** is the synchronous version, for uncompressed files.

Both accept the file as an `ArrayBuffer`, a `Uint8Array` or a string, and both work in browsers and in Node.js.

The group is in metres with Y up, so it sits in a three.js scene like any other model. Pass `{ metres: false }` to keep the file's length unit, or `{ yUp: false }` to keep the Z up that CAD models use.

## Products, assemblies and their data

Each product and each placed instance becomes a `THREE.Group`, nested as in the file's assembly structure:

```
Group "as1"                    product (the top assembly)
├─ Group "rod-assembly_1"      instance of the rod assembly
│  ├─ Group "nut_1"            instance of the nut: one mesh per colour
│  └─ Group "rod_1"
└─ Group "plate_1"
```

Instances are named after their assembly occurrence. If a file gives every occurrence the same generic name, such as "Next assembly relationship", the product's name is used instead.

Groups and meshes carry their data in `userData.step`:

```ts
scene.traverse(object => {
  const step = object.userData.step;
  if (object instanceof THREE.Mesh && step) {
    console.log(step.productName, step.productId, step.itemType, step.style);
  }
});
```

Instances of the same part share one `BufferGeometry` per colour, and equal colours share a `MeshStandardMaterial`.

## Tessellation quality

Each face is tessellated to two tolerances:

- **Chord tolerance:** the largest distance between the mesh and the surface. By default it is 0.1% of each solid's size.
- **Angle tolerance:** the largest angle between neighbouring normals, and the largest angle per segment along curved edges. By default it is 0.2 rad, about 11°.

```ts
loadStep(data, {
  relativeTolerance: 0.0005,  // finer: 0.05% of each solid's size
  angularTolerance: 0.1,      // radians
});

loadStep(data, { absoluteTolerance: 0.01 });  // in the file's length unit, for every solid
```

Finer tolerances give smoother curves and more triangles. Each face is limited to `maxTrianglesPerFace` (default 50 000).

## Plain data without three.js

`readStep` returns the same tree as plain data: nodes with placement matrices, and meshes as typed arrays. Use it in a worker, or to convert to another format:

```ts
import { readStep } from 'meercad-step-import';

const result = readStep(text);
for (const root of result.roots) console.log(root.name, root.children.length, root.meshes.length);
```

The group can then be built with `toThree(result)`.
