# Application protocols

STEP files name their schema in the header's `FILE_SCHEMA`. That name is followed by an object identifier, `{ 1 0 10303 <part> <edition> ... }`. `detectSchema` maps the name to a protocol and takes the edition from the identifier.

| `protocol` | Schema names | What it is |
|---|---|---|
| `AP203` | `CONFIG_CONTROL_DESIGN` | AP203 edition 1, configuration controlled 3D design. |
| `AP203e2` | `CONFIGURATION_CONTROL_3D_DESIGN_ED2_MIM_LF`, `AP203_CONFIGURATION_CONTROLLED_3D_DESIGN_OF_MECHANICAL_PARTS_AND_ASSEMBLIES_MIM_LF` | AP203 edition 2. |
| `AP214` | `AUTOMOTIVE_DESIGN`, `AUTOMOTIVE_DESIGN_CC1`, `AUTOMOTIVE_DESIGN_CC2` | AP214, core data for automotive mechanical design. Adds colours, layers and more to AP203. |
| `AP242` | `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF` and other `AP242_` names | AP242, managed model-based 3D engineering. Succeeds AP203 and AP214 and adds tessellated geometry and PMI. |
| `AP209` | `AP209_MULTIDISCIPLINARY_ANALYSIS_AND_DESIGN_MIM_LF`, `STRUCTURAL_ANALYSIS_DESIGN` | AP209, analysis and design. |
| `AP210` | `AP210_` names | AP210, electronic assembly, interconnect and packaging. |
| `AP238` | `INTEGRATED_CNC_SCHEMA`, `AP238_` names | AP238, STEP-NC. |
| `other` | anything else | Read for its shapes, with a warning. |

IFC schemas (`IFC2X3`, `IFC4` and so on) use the same file format, but they describe buildings with a different data model. Reading one throws `UnsupportedSchemaError`; use [MeerCADIFCImport](https://github.com/VJigouline/MeerCADIFCImport) for those.

## How they are read

All these protocols take their geometry and topology from ISO 10303-42 and their product structure from ISO 10303-41 and -44, so one reader serves them all:

- **Products:** `PRODUCT`, `PRODUCT_DEFINITION_FORMATION` and `PRODUCT_DEFINITION` name each part and assembly.
- **Shapes:**
  - `PRODUCT_DEFINITION_SHAPE` and `SHAPE_DEFINITION_REPRESENTATION` link a product definition to its shape representations.
  - `SHAPE_REPRESENTATION_RELATIONSHIP`s without a transformation link those to the representations holding the solids, such as an `ADVANCED_BREP_SHAPE_REPRESENTATION`.
- **Assemblies:** `NEXT_ASSEMBLY_USAGE_OCCURRENCE` places a child product in a parent. The placement comes from one of two places:
  - **A `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`:** its representation relationship carries an `ITEM_DEFINED_TRANSFORMATION`, between a placement in the child's representation and one in the parent's, or a `CARTESIAN_TRANSFORMATION_OPERATOR_3D`. Writers differ in which representation they put first; the importer works out which is the child's.
  - **A `MAPPED_ITEM`** in the parent's representation, mapping the child's representation to a placement.
- **Units:** each representation's context gives its length and plane angle units, so parts in different units can share an assembly.

The protocols differ mostly in what they add on top:

- **AP214 and AP242** add presentation (colours, layers, invisibility), which is read.
- **AP242** adds tessellated shapes, which are read too. Where a product has both, the B-rep is drawn unless `preferTessellated` is set.
- **AP242 and AP214 PMI and annotations** (dimensions, tolerances, notes) are recognised and left out.
