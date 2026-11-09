import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { loadStep, toThree } from '../src/index.js';
import { type Mat4 } from '../src/geometry/math.js';
import { allMeshes, allNodes, box, checkMesh, cone, points, read, stepFile, StepWriter } from './helpers.js';

const header = (schema = 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }') => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('assembly.stp','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
`;
const footer = '\nENDSEC;\nEND-ISO-10303-21;\n';

const context = `#1=APPLICATION_CONTEXT('automotive design');
#3=PRODUCT_CONTEXT('',#1,'mechanical');
#4=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#21,#22))REPRESENTATION_CONTEXT('',''));
#21=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#22=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#11=AXIS2_PLACEMENT_3D('',#12,#13,#14);
#12=CARTESIAN_POINT('',(0.,0.,0.));
#13=DIRECTION('',(0.,0.,1.));
#14=DIRECTION('',(1.,0.,0.));`;

/** A box part (#7) placed twice in an assembly (#42): at x = 100 mm, and at y = 200 mm turned 90° about z. */
function assembly(options: { swapped?: boolean; mapped?: boolean } = {}): string {
  const w = new StepWriter(300);
  const solid = box(w, [0, 0, 0], [10, 20, 30]);
  const place = (rel: number, idt: number, target: string) =>
    options.swapped
      ? `#${rel}=(REPRESENTATION_RELATIONSHIP('','',#45,#10)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP());\n#${idt}=ITEM_DEFINED_TRANSFORMATION('','',${target},#11);`
      : `#${rel}=(REPRESENTATION_RELATIONSHIP('','',#10,#45)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP());\n#${idt}=ITEM_DEFINED_TRANSFORMATION('','',#11,${target});`;
  const placements = options.mapped
    ? `#80=REPRESENTATION_MAP(#11,#10);
#81=MAPPED_ITEM('',#80,#46);
#82=MAPPED_ITEM('',#80,#50);`
    : `#61=PRODUCT_DEFINITION_SHAPE('','',#60);
#62=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#63,#61);
${place(63, 64, '#46')}
#71=PRODUCT_DEFINITION_SHAPE('','',#70);
#72=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#73,#71);
${place(73, 74, '#50')}`;
  return `${header()}${context}
#5=PRODUCT('BOX','box','',(#3));
#6=PRODUCT_DEFINITION_FORMATION('','',#5);
#7=PRODUCT_DEFINITION('design','',#6,#4);
#8=PRODUCT_DEFINITION_SHAPE('','',#7);
#9=SHAPE_DEFINITION_REPRESENTATION(#8,#10);
#10=SHAPE_REPRESENTATION('',(#11),#20);
#30=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11,${solid}),#20);
#31=SHAPE_REPRESENTATION_RELATIONSHIP('','',#10,#30);
#40=PRODUCT('ASM','assembly','',(#3));
#41=PRODUCT_DEFINITION_FORMATION('','',#40);
#42=PRODUCT_DEFINITION('design','',#41,#4);
#43=PRODUCT_DEFINITION_SHAPE('','',#42);
#44=SHAPE_DEFINITION_REPRESENTATION(#43,#45);
#45=SHAPE_REPRESENTATION('',(#11,#46,#50${options.mapped ? ',#81,#82' : ''}),#20);
#46=AXIS2_PLACEMENT_3D('',#47,#13,#14);
#47=CARTESIAN_POINT('',(100.,0.,0.));
#50=AXIS2_PLACEMENT_3D('',#51,#13,#52);
#51=CARTESIAN_POINT('',(0.,200.,0.));
#52=DIRECTION('',(0.,1.,0.));
#60=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','box_1','',#42,#7,$);
#70=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','box_2','',#42,#7,$);
${placements}
${w.lines.join('\n')}${footer}`;
}

/** World bounds of every mesh, in metres, without the Y-up turn. */
function worldBounds(result: ReturnType<typeof read>): [number, number, number, number, number, number][] {
  const out: [number, number, number, number, number, number][] = [];
  for (const { node, world } of allNodes(result)) {
    for (const mesh of node.meshes) {
      const m = mesh.matrix ? (world ? mul(world, mesh.matrix) : mesh.matrix) : world;
      const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const p of points(mesh.data, m)) for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k]!, p[k]!);
        b[k + 3] = Math.max(b[k + 3]!, p[k]!);
      }
      out.push(b.map(x => Math.round(x * 1e6) / 1e6) as typeof b);
    }
  }
  return out;
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = s;
  }
  return out;
}

describe('product structure', () => {
  it('reads one product with its name, units and mesh in metres', () => {
    const w = new StepWriter();
    const r = read(stepFile(w, [box(w, [0, 0, 0], [10, 20, 30])], { productName: 'Bracket' }));
    expect(r.schema.protocol).toBe('AP214');
    expect(r.lengthUnit).toBe(0.001);
    expect(r.lengthUnitName).toBe('mm');
    expect(r.roots).toHaveLength(1);
    expect(r.roots[0]!.name).toBe('Bracket');
    expect(r.roots[0]!.product).toEqual({ id: 'P1', name: 'Bracket', description: 'A test part' });
    expect(worldBounds(r)).toEqual([[0, 0, 0, 0.01, 0.02, 0.03]]);
  });

  it.each([
    ['context-dependent placements', {}],
    ['placements with the relationship written the other way round', { swapped: true }],
    ['mapped items', { mapped: true }],
  ] as [string, { swapped?: boolean; mapped?: boolean }][])('places assembly instances by %s', (_name, options) => {
    const r = read(assembly(options));
    expect(r.roots.map(n => n.name)).toEqual(['assembly']);
    const instances = r.roots[0]!.children;
    expect(instances).toHaveLength(2);
    expect(instances.every(i => i.kind === 'instance' && i.product?.name === 'box')).toBe(true);
    if (!options.mapped) expect(instances.map(i => i.name)).toEqual(['box_1', 'box_2']);
    // Both instances share one mesh.
    expect(instances[0]!.meshes[0]!.data).toBe(instances[1]!.meshes[0]!.data);
    expect(worldBounds(r).sort((a, b) => a[0] - b[0])).toEqual([
      [-0.02, 0.2, 0, 0, 0.21, 0.03],
      [0.1, 0, 0, 0.11, 0.02, 0.03],
    ]);
  });

  it('reads shapes without a product structure', () => {
    const w = new StepWriter();
    const solid = box(w, [0, 0, 0], [1, 1, 1]);
    const text = `${header()}${context}
#10=ADVANCED_BREP_SHAPE_REPRESENTATION('loose',(#11,${solid}),#20);
${w.lines.join('\n')}${footer}`;
    const r = read(text);
    expect(r.roots).toHaveLength(1);
    expect(r.roots[0]!.kind).toBe('shape');
    expect(r.roots[0]!.name).toBe('loose');
    expect(allMeshes(r)).toHaveLength(1);
  });
});

describe('units', () => {
  it('converts inches and degrees', () => {
    const w = new StepWriter();
    const deg = Math.PI / 180;
    const text = stepFile(w, [cone(w, 10, 30 * deg, deg)], {
      lengthUnit: "#21=(CONVERSION_BASED_UNIT('INCH',#25)LENGTH_UNIT()NAMED_UNIT(#29));\n#25=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#26);\n#26=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));\n#29=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);",
      angleUnit: "#22=(CONVERSION_BASED_UNIT('DEGREE',#27)NAMED_UNIT(*)PLANE_ANGLE_UNIT());\n#27=PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(0.0174532925199433),#28);\n#28=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));",
    });
    const r = read(text);
    expect(r.lengthUnit).toBeCloseTo(0.0254, 12);
    expect(r.lengthUnitName).toBe('inch');
    expect(r.stats.failedFaces).toBe(0);
    const [mesh] = allMeshes(r);
    const volume = checkMesh(mesh!.data).volume * 0.0254 ** 3;
    const expected = (Math.PI * (10 * Math.tan(30 * deg)) ** 2 * 10 * 0.0254 ** 3) / 3;
    expect(volume / expected).toBeGreaterThan(0.99);
    expect(mesh!.matrix![0]).toBeCloseTo(0.0254, 12);
  });
});

describe('presentation', () => {
  const styled = () => {
    const w = new StepWriter();
    const solid = box(w, [0, 0, 0], [10, 10, 10]);
    // The box's first face is the first ADVANCED_FACE written.
    const face = w.lines.find(l => l.includes('ADVANCED_FACE'))!.split('=')[0]!;
    const extra = `#60=STYLED_ITEM('',(#61),${solid});
#61=PRESENTATION_STYLE_ASSIGNMENT((#62));
#62=SURFACE_STYLE_USAGE(.BOTH.,#63);
#63=SURFACE_SIDE_STYLE('',(#64));
#64=SURFACE_STYLE_FILL_AREA(#65);
#65=FILL_AREA_STYLE('',(#66));
#66=FILL_AREA_STYLE_COLOUR('',#67);
#67=COLOUR_RGB('',1.,0.,0.);
#70=OVER_RIDING_STYLED_ITEM('',(#71),${face},#60);
#71=PRESENTATION_STYLE_ASSIGNMENT((#72));
#72=SURFACE_STYLE_USAGE(.BOTH.,#73);
#73=SURFACE_SIDE_STYLE('glass',(#74,#78));
#74=SURFACE_STYLE_FILL_AREA(#75);
#75=FILL_AREA_STYLE('',(#76));
#76=FILL_AREA_STYLE_COLOUR('',#77);
#77=DRAUGHTING_PRE_DEFINED_COLOUR('blue');
#78=SURFACE_STYLE_RENDERING_WITH_PROPERTIES(.NORMAL_SHADING.,#77,(#79));
#79=SURFACE_STYLE_TRANSPARENT(0.5);`;
    return { w, solid, extra };
  };

  it('colours solids and faces, overriding styles winning', () => {
    const { w, solid, extra } = styled();
    const r = read(stepFile(w, [solid], { extra }));
    const meshes = allMeshes(r).sort((a, b) => a.data.indices.length - b.data.indices.length);
    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.style).toEqual({ name: 'glass', color: [0, 0, 1], opacity: 0.5 });
    expect(meshes[0]!.data.indices.length / 3).toBe(2);
    expect(meshes[1]!.style.color).toEqual([1, 0, 0]);
    expect(meshes[1]!.data.indices.length / 3).toBe(10);
  });

  it('hides invisible items unless asked not to', () => {
    const { w, solid, extra } = styled();
    const text = stepFile(w, [solid], { extra: `${extra}\n#90=INVISIBILITY((#60));` });
    expect(allMeshes(read(text))).toHaveLength(0);
    expect(allMeshes(read(text, { includeHidden: true }))).toHaveLength(2);
  });
});

describe('AP242 tessellation', () => {
  const tetra = `#200=COORDINATES_LIST('',4,((0.,0.,0.),(10.,0.,0.),(0.,10.,0.),(0.,0.,10.)));
#201=TRIANGULATED_FACE('',#200,4,(),$,(),((1,3,2),(1,2,4),(2,3,4),(3,1,4)));
#202=TESSELLATED_SOLID('',(#201),$);
#203=TESSELLATED_SHAPE_REPRESENTATION('',(#202),#20);
#204=SHAPE_DEFINITION_REPRESENTATION(#8,#203);`;

  it('reads triangulated faces', () => {
    const r = read(stepFile(new StepWriter(), [], { extra: tetra, schema: 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }' }));
    expect(r.schema.protocol).toBe('AP242');
    const [mesh] = allMeshes(r);
    const check = checkMesh(mesh!.data);
    expect(check.volume).toBeCloseTo(1000 / 6, 9);
    expect(check.openEdges).toBe(0);
    expect(mesh!.itemType).toBe('TESSELLATED_SOLID');
  });

  it('reads strips and fans', () => {
    const extra = `#200=COORDINATES_LIST('',4,((0.,0.,0.),(10.,0.,0.),(10.,10.,0.),(0.,10.,0.)));
#201=COMPLEX_TRIANGULATED_FACE('',#200,4,(),$,(),((1,2,4,3)),());
#202=COMPLEX_TRIANGULATED_FACE('',#200,4,(),$,(),(),((1,2,3,4)));
#203=TESSELLATED_SHAPE_REPRESENTATION('',(#201,#202),#20);
#204=SHAPE_DEFINITION_REPRESENTATION(#8,#203);`;
    // One mesh per item: the strip and the fan, two triangles each.
    const meshes = allMeshes(read(stepFile(new StepWriter(), [], { extra })));
    expect(meshes.map(m => m.data.indices.length / 3)).toEqual([2, 2]);
    for (const mesh of meshes) {
      // Every triangle faces +z: strips alternate their winding.
      const n = mesh.data.normals;
      for (let i = 2; i < n.length; i += 3) expect(n[i]).toBeCloseTo(1, 9);
      expect(checkMesh(mesh.data).area).toBeCloseTo(100, 9);
    }
  });

  it('uses the B-rep where a product has both, unless tessellation is preferred', () => {
    const w = new StepWriter();
    const text = stepFile(w, [box(w, [0, 0, 0], [1, 1, 1])], { extra: tetra });
    expect(allMeshes(read(text)).map(m => m.itemType)).toEqual(['MANIFOLD_SOLID_BREP']);
    expect(allMeshes(read(text, { preferTessellated: true })).map(m => m.itemType)).toEqual(['TESSELLATED_SOLID']);
  });
});

describe('three.js', () => {
  it('builds groups in metres with Y up, sharing geometry between instances', () => {
    const { group, roots } = loadStep(assembly());
    expect(roots).toHaveLength(1);
    expect(group.rotation.x).toBeCloseTo(-Math.PI / 2, 12);
    const meshes: THREE.Mesh[] = [];
    group.traverse(o => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.geometry).toBe(meshes[1]!.geometry);
    expect(meshes[0]!.material).toBe(meshes[1]!.material);
    expect(meshes[0]!.userData.step).toMatchObject({ kind: 'instance', productName: 'box', itemType: 'MANIFOLD_SOLID_BREP' });
    const bounds = new THREE.Box3().setFromObject(group);
    // Z-up x in [-0.02, 0.11], y in [0, 0.21], z in [0, 0.03] becomes Y-up with z = -y.
    expect(bounds.min.x).toBeCloseTo(-0.02, 9);
    expect(bounds.max.x).toBeCloseTo(0.11, 9);
    expect(bounds.min.y).toBeCloseTo(0, 9);
    expect(bounds.max.y).toBeCloseTo(0.03, 9);
    expect(bounds.min.z).toBeCloseTo(-0.21, 9);
  });

  it('can keep file units and Z up', () => {
    const r = read(assembly());
    const group = toThree(r, { metres: false, yUp: false });
    const bounds = new THREE.Box3().setFromObject(group);
    expect(bounds.max.x).toBeCloseTo(110, 6);
    expect(bounds.max.y).toBeCloseTo(210, 6);
  });

  it('adds face loops as line segments under each mesh, unless asked not to', () => {
    const r = read(assembly());
    const lines: THREE.LineSegments[] = [];
    toThree(r).traverse(o => {
      if ((o as THREE.LineSegments).isLineSegments) lines.push(o as THREE.LineSegments);
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.parent).toBeInstanceOf(THREE.Mesh);
    expect(lines[0]!.userData.stepEdges).toBe(true);
    expect(lines[0]!.geometry).toBe(lines[1]!.geometry);
    expect(lines[0]!.geometry.getAttribute('position').count).toBe(24);
    let any = false;
    toThree(r, { edges: false }).traverse(o => (any ||= (o as THREE.LineSegments).isLineSegments === true));
    expect(any).toBe(false);
  });

  it('keeps world transforms usable straight away', () => {
    const { group } = loadStep(assembly());
    const p = new THREE.Vector3();
    let mesh: THREE.Mesh | undefined;
    group.traverse(o => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    mesh!.getWorldPosition(p);
    expect(Number.isFinite(p.x)).toBe(true);
  });
});
