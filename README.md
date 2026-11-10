# MeerCADStepImport

A STEP (ISO 10303-21) importer for [three.js](https://threejs.org/), written in TypeScript with no WebAssembly. It reads the CAD application protocols **AP203**, **AP214** and **AP242**, and other APs built on the same ISO 10303-42 geometry. It detects which protocol a file uses from its `FILE_SCHEMA`.

It tessellates B-rep solids and surface models with planar, analytic (cylinder, cone, sphere, torus) and NURBS faces into watertight meshes. It also builds the product and assembly structure, applies the file's colours, and converts the file's units.

```ts
import { loadStep } from 'meercad-step-import';

const result = loadStep(await file.arrayBuffer());
scene.add(result.group);            // THREE.Group, in metres, Y up
console.log(result.schema.name);    // "AP214 (automotive design)"
console.log(result.warnings);       // anything that couldn't be read
```

## What it reads

- **Protocols:** AP203 (both editions), AP214 and AP242, detected from `FILE_SCHEMA`. Other protocols with ISO 10303-42 shapes, such as AP209, AP210 and AP238, are read for their shapes. IFC files are refused, with a pointer to [MeerCADIFCImport](https://github.com/VJigouline/MeerCADIFCImport).
- **Shapes:**
  - B-rep solids, with and without voids, and faceted B-reps.
  - Shell- and face-based surface models.
  - AP242 tessellated solids, shells and triangulated faces.
- **Surfaces:**
  - Planes, cylinders, cones, spheres and tori.
  - B-spline surfaces in every form: with knots, Bézier, uniform and quasi-uniform, rational or not.
  - Surfaces of linear extrusion and of revolution, offset surfaces and trimmed surfaces.
- **Curves:**
  - Lines, circles, ellipses, parabolas and hyperbolas.
  - B-spline curves in every form.
  - Polylines, trimmed curves, composite curves, and curves on surfaces (pcurves).
- **Tessellation:** to a chord and an angle tolerance:
  - Faces are triangulated in each surface's own (u, v) parameters.
  - Faces sharing an edge share its points, so closed solids give closed meshes.
  - Seams, poles and multi-turn threads are handled.
  - Large files can be tessellated in web workers, several times faster, with `loadStepAsync(input, { workers })`. See the [API](Documentation/API.md#readstepasyncinput-options).
- **Structure:**
  - Products and assemblies, with instances placed by context-dependent shape representations or by mapped items.
  - Instances of the same part share geometry.
- **Presentation:** colours and transparency from styled items, with face styles overriding solid styles. Items hidden by `INVISIBILITY` are left out.
- **Units:** SI units with prefixes, and conversion-based units such as inches, feet and degrees, read for each representation.

See [Geometry and protocol support](Documentation/Support.md) for the details and the limits.

## Install

The package is not on the npm registry. Install it from GitHub:

```sh
npm install github:VJigouline/MeerCADStepImport
```

`three` (r160 or later) is a peer dependency. The package builds itself on install.

## Documentation

- [Getting started](Documentation/GettingStarted.md)
- [API](Documentation/API.md)
- [Application protocols and how they are read](Documentation/Protocols.md)
- [Geometry and protocol support](Documentation/Support.md)
- [Using it in SceneEditor](Documentation/SceneEditor.md)

## Development

```sh
npm install
npm test           # vitest: unit tests, and sample models in samples/ when present
npm run typecheck
npm run build      # emits dist/
```

The tests build their own STEP files. Third-party sample models, such as the CAx-IF test files, can be put in `samples/` for extra checks. That folder is not part of the repository.

Requirements: Node.js 22 or later.

## Licence

MIT.
