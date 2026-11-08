# Using it in SceneEditor

[SceneEditor](https://github.com/VJigouline/SceneEditor) opens STEP files with MeerCADStepImport. Drop a `.stp`, `.step`, `.p21` or `.stpz` file on the view, or choose one with **Open files** on the Scene tab.

`ThreeSceneService.addStepFile` reads the file as bytes and calls `loadStepAsync`, which also inflates `.stpz` files. It adds the resulting group to the scene, then refits the view.

- **Errors:** an IFC file, or one that isn't a STEP file, shows a **Failure** message with the reason, and the scene is unaffected.
- **Warnings:** these go to the browser console. They include faces that couldn't be tessellated.
- **Model in the editor:** the model comes in metres with Y up, like the other formats. Its assembly structure appears as nested groups, and its MeshStandardMaterials can be edited and reassigned on the Materials tab like any other.
- **Ray tracing:** the model can be ray traced on the Photorealistic tab.

The import runs in the page:

- **Typical parts and assemblies** of a few megabytes take a second or less.
- **Large assemblies with modelled threads** take longer, for example about 25 seconds for a 15 MB assembly of 5 700 faces. The page is held for that time.
