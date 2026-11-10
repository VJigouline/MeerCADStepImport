# Geometry and protocol support

## Shapes

| Kind | Entities | Notes |
|---|---|---|
| Solids | `MANIFOLD_SOLID_BREP`, `BREP_WITH_VOIDS`, `FACETED_BREP` | Voids are drawn facing inwards. |
| Surface models | `SHELL_BASED_SURFACE_MODEL`, `FACE_BASED_SURFACE_MODEL` | Open and closed shells. |
| Shells and faces | `CLOSED_SHELL`, `OPEN_SHELL`, `CONNECTED_FACE_SET`, `ORIENTED_CLOSED_SHELL`, `ORIENTED_OPEN_SHELL`, `ADVANCED_FACE`, `FACE_SURFACE`, `ORIENTED_FACE`, `FACE` | Also when used directly as representation items. A `FACE` without a surface is drawn as a planar polygon. |
| Loops | `EDGE_LOOP`, `POLY_LOOP`, `VERTEX_LOOP` | Vertex loops, at cone apexes and poles, need no triangles. |
| Edges | `ORIENTED_EDGE`, `EDGE_CURVE` | Sampled once and shared by the faces on either side. |
| Tessellated (AP242) | `TESSELLATED_SOLID`, `TESSELLATED_SHELL`, `TRIANGULATED_FACE`, `COMPLEX_TRIANGULATED_FACE`, `TRIANGULATED_SURFACE_SET`, `COMPLEX_TRIANGULATED_SURFACE_SET` | With `COORDINATES_LIST`, point index lists, strips and fans. Normals are used where given, and computed otherwise. |
| Instancing | `MAPPED_ITEM` | Of a shape, or of another product's shape, which becomes an assembly instance. |

## Surfaces

| Surface | Notes |
|---|---|
| `PLANE` | |
| `CYLINDRICAL_SURFACE`, `CONICAL_SURFACE`, `SPHERICAL_SURFACE`, `TOROIDAL_SURFACE`, `DEGENERATE_TOROIDAL_SURFACE` | Closed in u, and for tori in v as well. Cone semi-angles are read in the file's angle unit. |
| `B_SPLINE_SURFACE_WITH_KNOTS`, `BEZIER_SURFACE`, `UNIFORM_SURFACE`, `QUASI_UNIFORM_SURFACE` | Rational ones too, written as complex instances. A surface that closes on itself is treated as periodic, whatever its flags say. |
| `SURFACE_OF_LINEAR_EXTRUSION`, `SURFACE_OF_REVOLUTION` | Over any supported curve. |
| `OFFSET_SURFACE` | Of any supported surface. |
| `RECTANGULAR_TRIMMED_SURFACE`, `CURVE_BOUNDED_SURFACE` | Their basis surface, as the face's own bounds trim it. |

## Curves

| Curve | Notes |
|---|---|
| `LINE`, `CIRCLE`, `ELLIPSE`, `PARABOLA`, `HYPERBOLA` | |
| `B_SPLINE_CURVE_WITH_KNOTS`, `BEZIER_CURVE`, `UNIFORM_CURVE`, `QUASI_UNIFORM_CURVE` | Rational ones too. |
| `POLYLINE`, `TRIMMED_CURVE`, `COMPOSITE_CURVE`, `COMPOSITE_CURVE_ON_SURFACE`, `BOUNDARY_CURVE` | Trims by parameter (in the angle unit for conics) or by point. |
| `SURFACE_CURVE`, `SEAM_CURVE`, `INTERSECTION_CURVE` | Their 3D curve, or their first pcurve if there is none. |
| `PCURVE` | A 2D curve on a surface, evaluated on it. |

`OFFSET_CURVE_3D` and `CURVE_REPLICA` are not supported. Faces bounded by them are left out, with a warning.

## How faces are tessellated

1. **Edges:** each edge is sampled once between its vertices, to the chord and angle tolerances. Faces sharing an edge share its points, so closed solids give closed meshes.
   - B-spline edges start from points at their knots, and some files have a knot every few degrees.
   - Those points are thinned out to a quarter of the chord tolerance and half the angle. That keeps the edges of sliver faces from crossing each other.
   - An edge always keeps at least as many segments as its degree.
2. **Projection:** each face's boundary is projected into the surface's (u, v) parameters, analytically for elementary surfaces and by Newton's method for the others.
3. **Closed surfaces:** the boundary is cut at the seam and moved into one period. The pieces are joined along the seam, round poles and cone apexes, and along the domain's edges. This covers bands round cylinders, caps at poles, faces that are a whole sphere or torus, and threads that wind round many times.
4. **Seam edges:** an edge that a face uses twice on a closed surface is a seam with the face on both sides. It is left out, and the face is closed across it.
5. **Interior:** a grid of points is added inside the face. The grid's spacing comes from the surface's curvature in each direction.
6. **Triangulation:** the points are triangulated in (u, v), and edge flips make the result Delaunay.
   - The flips run until none is left, so long thin faces aren't left half-flipped.
   - Edges and triangles too far from the surface, or with normals too far apart, are then split until the tolerances are met.
7. **Normals:** come from the surface itself, flipped where the face is against the surface's direction.

The chord tolerance is 0.1% of each solid's size by default, and the angle tolerance 0.2 rad. Inside faces, the mesh may be up to twice the chord tolerance from the surface.

Faces that can't be tessellated are left out and counted in `stats.failedFaces`, with a warning giving the reason. Examples are faces with an unsupported curve, or with a boundary that can't be closed.

## Colours

- **Styled items:** `STYLED_ITEM` sets the colour of a solid, shell, face or mapped item.
- **Overrides:** `OVER_RIDING_STYLED_ITEM` and `CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM` replace a style, usually on a face. The context of a context-dependent override is ignored.
- **Style chain:** `PRESENTATION_STYLE_ASSIGNMENT` → `SURFACE_STYLE_USAGE` → `SURFACE_SIDE_STYLE`. The colour comes from `SURFACE_STYLE_FILL_AREA` or `SURFACE_STYLE_RENDERING`, and transparency from `SURFACE_STYLE_RENDERING_WITH_PROPERTIES` with `SURFACE_STYLE_TRANSPARENT`.
- **Colour entities:** `COLOUR_RGB`, and `DRAUGHTING_PRE_DEFINED_COLOUR` by name.
- **Precedence:** a face's own style, then its shell's, its solid's, and the mapped item's.
- **Default:** light grey, for anything without a style.
- **Colour space:** colours are taken as sRGB.
- **Hidden items:** items made invisible by `INVISIBILITY`, directly, through their styled item or through a layer, are left out. Set `includeHidden` to draw them.

## Units

- **Lengths:** `SI_UNIT` with any prefix, and `CONVERSION_BASED_UNIT`s such as inches and feet, through their `MEASURE_WITH_UNIT`.
- **Plane angles:** radians and degrees.
- **Per representation:** units are read from each representation's `GLOBAL_UNIT_ASSIGNED_CONTEXT`. Assemblies of parts in different units come out right.
- **Default:** a file without units is taken to be in millimetres.

## Not supported

- **CSG and swept solids:** `BOOLEAN_RESULT`, `CSG_SOLID`, `EXTRUDED_AREA_SOLID` and others, which are rare in STEP CAD exports. Such items are reported as "not drawn".
- **Wireframes and points:** `GEOMETRIC_CURVE_SET`, `EDGE_BASED_WIREFRAME_MODEL` and similar.
- **PMI and annotations:** semantic and graphical PMI, draughting callouts and text.
- **External references:** assemblies split over several files.
- **Textures** and other material properties beyond colour and transparency.
- **Validation properties:** geometric validation properties (volumes, centroids) are not checked.
