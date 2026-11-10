# API

## loadStep(input, options?)

```ts
loadStep(input: string | ArrayBuffer | Uint8Array, options?: StepImportOptions & StepThreeOptions): StepLoadResult
```

Reads a STEP file and builds a three.js group. Returns everything `readStep` returns, plus `group`.

It throws in two cases:

- **`UnsupportedSchemaError`** for IFC files.
- **`StepSyntaxError`** for text that isn't an ISO 10303-21 file.

## loadStepAsync(input, options?)

```ts
loadStepAsync(input: string | ArrayBuffer | Uint8Array, options?: StepImportOptions & StepThreeOptions & { workers?: StepWorkerOptions }): Promise<StepLoadResult>
```

Like `loadStep`, and it also reads gzip-compressed files (`.stpz`). It recognises them by their first bytes and inflates them with the platform's `DecompressionStream`.

With `workers`, the tessellation is spread over workers, as described under `readStepAsync`.

## readStepAsync(input, options?)

```ts
readStepAsync(input: string | ArrayBuffer | Uint8Array, options?: StepImportOptions & { workers?: StepWorkerOptions }): Promise<StepImportResult>
```

Like `readStep`. With `workers`, the shape items are tessellated in workers, and the result is the same as `readStep`'s.

1. The workers each read the file while this thread reads the product structure.
2. This thread hands them the shape items one at a time, those with the most faces first.
3. The meshes come back as transferred arrays, not copies, and the tree is built from them.

Without `workers`, it reads on this thread, like `readStep`.

On an 8-core machine, a 95 MB file with 6 000 faces takes 15 s on one thread and 5.6 s with six workers. Small files are quicker without workers, which take a few hundred milliseconds to start.

If the workers can't be started, or every one of them fails, the file is read on this thread instead. A warning then says why: `Read without workers: …`.

### StepWorkerOptions

| Option | Default | Meaning |
|---|---|---|
| `create` | (required) | `() => StepWorkerLike`: starts a worker whose script calls `runStepWorker()`. A web `Worker` is a `StepWorkerLike`. |
| `count` | one less than the processors, at most 6 | How many workers to start. Each holds its own copy of the file's text, about the file's size. |

### runStepWorker(scope?)

The worker's side. Call it from the worker's script. `scope` defaults to the worker's global scope.

In a browser, with a bundler that understands `new URL(…, import.meta.url)`:

```ts
// step.worker.ts
import { runStepWorker } from 'meercad-step-import';
runStepWorker();

// The page
const result = await loadStepAsync(bytes, {
  workers: { create: () => new Worker(new URL('./step.worker', import.meta.url), { type: 'module' }) },
});
```

In Node, wrap `worker_threads`, whose workers are event emitters rather than event targets:

```ts
// step-worker.mjs
import { parentPort } from 'node:worker_threads';
import { runStepWorker } from 'meercad-step-import';
runStepWorker({
  postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
  addEventListener: (type, listener) => parentPort.on(type, data => listener({ data })),
});

// The caller
const create = () => {
  const worker = new Worker(new URL('./step-worker.mjs', import.meta.url));
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    addEventListener: (type, listener) => worker.on(type, data => listener(type === 'message' ? { data } : data)),
    terminate: () => worker.terminate(),
  };
};
const result = await readStepAsync(bytes, { workers: { create } });
```

## readStep(input, options?)

```ts
readStep(input: string | ArrayBuffer | Uint8Array, options?: StepImportOptions): StepImportResult
```

Reads a STEP file into plain data, without three.js.

### StepImportOptions

| Option | Default | Meaning |
|---|---|---|
| `relativeTolerance` | 0.001 | Chord tolerance as a fraction of each solid's size: how far the mesh may be from the surface. |
| `absoluteTolerance` | none | Chord tolerance in the file's length unit, for every solid. Overrides `relativeTolerance`. |
| `angularTolerance` | 0.2 | Radians. Largest angle between neighbouring normals, and per segment along curved edges. |
| `maxTrianglesPerFace` | 50 000 | Refinement stops at this many triangles in a face. |
| `includeHidden` | `false` | Draw items that the file hides with `INVISIBILITY`. |
| `preferTessellated` | `false` | Where a product has both a B-rep and an AP242 tessellated shape, draw the tessellated one. By default the B-rep is drawn. |

### StepImportResult

| Field | Meaning |
|---|---|
| `schema` | `{ protocol, name, identifier, schemaName, edition }`: the detected application protocol. See [Protocols](Protocols.md). |
| `header` | The STEP header: file name, time stamp, author, organisation, originating system, schemas. |
| `lengthUnit` | Metres per length unit of the main shape representation, such as 0.001 for millimetres or 0.0254 for inches. |
| `lengthUnitName` | That unit's name: `mm`, `m`, `inch` and so on. |
| `roots` | Top-level `StepNode`s: the products that are not part of an assembly. |
| `warnings` | Messages about anything left out, each once, with a count. |
| `stats` | `{ entities, products, faces, failedFaces, triangles, meshes }`. |

### StepNode

| Field | Meaning |
|---|---|
| `name` | The instance's occurrence name, or the product's name. |
| `kind` | `product`: a part or assembly at the top. `instance`: a product placed in an assembly. `shape`: geometry from a file without a product structure. |
| `product` | `{ id, name, description }` from `PRODUCT`, or `null`. |
| `productDefinition` | Id of the `PRODUCT_DEFINITION`. |
| `occurrence` | Id of the `NEXT_ASSEMBLY_USAGE_OCCURRENCE` or `MAPPED_ITEM` placing the instance. |
| `matrix` | Placement in the parent, in metres, as a column-major 4 × 4 `Float64Array`; `null` for none. |
| `meshes` | `StepMesh[]`: the product's own shapes, one mesh per shape item and colour. |
| `children` | Instances placed in this product. |

### StepMesh

| Field | Meaning |
|---|---|
| `name` | The shape item's name. |
| `itemId`, `itemType` | Id and type of the shape item, such as `MANIFOLD_SOLID_BREP`. |
| `style` | `{ name, color: [r, g, b], opacity }`: sRGB colour, 0 to 1. |
| `data` | `MeshData`: `positions`, `normals` (`Float32Array`), `indices` (`Uint32Array`), and `colors` (always `null` here). Shared between instances. |
| `edges` | The faces' boundary loops as line segments: a `Float32Array` of point pairs in the same coordinates as `data`. An edge shared by two faces is in once, and seams are left out. `null` where there are none, as for AP242 tessellated shapes. |
| `matrix` | Placement in the node, in metres. It includes the scale from the file's length unit, as the data is in file units. `null` for none. |

## toThree(result, options?)

```ts
toThree(result: StepImportResult, options?: StepThreeOptions): THREE.Group
```

Builds the three.js group from a `readStep` result. World matrices are updated, so the group can be measured, for example with `Box3.setFromObject`, before it is first rendered.

### StepThreeOptions

| Option | Default | Meaning |
|---|---|---|
| `metres` | `true` | Keep the model in metres. With `false`, it is scaled back to the file's length unit. |
| `yUp` | `true` | Turn STEP's Z up into three.js's Y up, by rotating the root group −90° about x. |
| `doubleSided` | `true` | Render both sides of faces, for open shells and surface models. |
| `edges` | `true` | Add the faces' boundary loops as a `THREE.LineSegments` named "Edges" under each mesh that has them, with `userData.stepEdges` set. Faces are drawn with a small polygon offset so the lines show on them. Hide or remove them to show faces alone. |
| `edgeColor` | `0x202020` | Colour of those lines. |

Groups carry `userData.step`, a `StepUserData`:

- `kind`
- `productId`, `productName`, `description`
- `productDefinition`, `occurrence`

Meshes carry a `StepMeshUserData` there instead: the same fields, plus `itemId`, `itemType` and `style`. Materials are `MeshStandardMaterial`s, with roughness 0.5 and metalness 0.1.

## Lower-level exports

| Export | Use |
|---|---|
| `StepFile` | The ISO 10303-21 reader. It indexes instances in one pass and parses each when first asked for. `get(id)` returns `{ id, type, args, parts? }`, with `parts` listing a complex instance's parts. `idsOfType(type)` also finds complex instances by part type. |
| `StepRef`, `StepEnum`, `StepTyped`, `DERIVED` | Attribute values: `#12`, `.T.`, `LENGTH_MEASURE(2.5)`, `*`. |
| `detectSchema(schemas)` | The protocol for a list of `FILE_SCHEMA` identifiers. |
| `decodeStepString`, `stepText` | String escapes, and text from bytes. |
| `isGzip`, `decompressStep` | Recognise and inflate `.stpz` data. |
