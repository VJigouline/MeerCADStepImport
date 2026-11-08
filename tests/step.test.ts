import { describe, expect, it } from 'vitest';
import { StepFile, StepRef, StepEnum, StepTyped, decodeStepString, detectSchema, UnsupportedSchemaError, readStep, StepSyntaxError } from '../src/index.js';
import { StepModel, num } from '../src/step/access.js';

const file = (data: string, schema = 'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }') => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('a test'),'2;1');
FILE_NAME('part.stp','2026-01-01T00:00:00',('Author'),('Org'),'pre','sys','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
${data}
ENDSEC;
END-ISO-10303-21;
`;

describe('Part 21 reader', () => {
  it('reads the header', () => {
    const f = new StepFile(file('#1=CARTESIAN_POINT(\'\',(0.,0.,0.));'));
    expect(f.header.fileName).toBe('part.stp');
    expect(f.header.originatingSystem).toBe('sys');
    expect(f.header.schemas).toEqual(['AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }']);
  });

  it('parses values of every kind', () => {
    const f = new StepFile(file("#1=TEST('it''s',$,*,#2,.T.,(1,2.5E1,-3.),LENGTH_MEASURE(2.5),\"0F\");"));
    const e = f.get(1)!;
    expect(e.type).toBe('TEST');
    expect(e.args[0]).toBe("it's");
    expect(e.args[1]).toBeNull();
    expect(e.args[3]).toBeInstanceOf(StepRef);
    expect((e.args[4] as StepEnum).value).toBe('T');
    expect(e.args[5]).toEqual([1, 25, -3]);
    expect(e.args[6]).toBeInstanceOf(StepTyped);
    expect(num(e.args[6])).toBe(2.5);
    expect(e.args[7]).toBe('0F');
  });

  it('keeps the parts of complex instances and indexes them by part type', () => {
    const f = new StepFile(file(`#1=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
#2=(BOUNDED_CURVE()B_SPLINE_CURVE(1,(#3,#4),.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((2,2),(0.,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((1.,1.))REPRESENTATION_ITEM('c'));`));
    const unit = f.get(1)!;
    expect(unit.type).toBe('COMPLEX');
    expect(unit.parts!.map(p => p.type)).toEqual(['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
    expect(f.idsOfType('si_unit')).toEqual([1]);
    expect(f.idsOfType('RATIONAL_B_SPLINE_CURVE')).toEqual([2]);
    expect(f.typeOf(2)).toBe('COMPLEX');
    const m = new StepModel(f);
    expect(m.is(f.get(2), 'B_SPLINE_CURVE')).toBe(true);
    expect(m.partArgs(f.get(2)!, 'RATIONAL_B_SPLINE_CURVE')).toEqual([[1, 1]]);
    expect(m.displayType(f.get(2)!)).toBe('B_SPLINE_CURVE+B_SPLINE_CURVE_WITH_KNOTS+RATIONAL_B_SPLINE_CURVE');
  });

  it('skips strings and comments when indexing', () => {
    const f = new StepFile(file("/* #9=FAKE(); */\n#1=NAME('a;#2=FAKE()');\n#3=OTHER();"));
    expect([...f.ids]).toEqual([1, 3]);
  });

  it('decodes string escapes', () => {
    expect(decodeStepString('\\X2\\00E9\\X0\\t\\S\\a')).toBe('étá');
    expect(decodeStepString("a''b")).toBe("a'b");
  });

  it('rejects text that is not a STEP file', () => {
    expect(() => new StepFile('solid cube\nendsolid')).toThrow(StepSyntaxError);
  });
});

describe('schema detection', () => {
  it.each([
    ['CONFIG_CONTROL_DESIGN', 'AP203', null],
    ['CONFIGURATION_CONTROL_3D_DESIGN_ED2_MIM_LF { 1 0 10303 403 1 1 4 }', 'AP203e2', 1],
    ['AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 1 }', 'AP214', 3],
    ['AUTOMOTIVE_DESIGN_CC2 { 1 2 10303 214 -1 1 5 4 }', 'AP214', null],
    ['AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }', 'AP242', 3],
    ['AP209_MULTIDISCIPLINARY_ANALYSIS_AND_DESIGN_MIM_LF', 'AP209', null],
    ['SOMETHING_ELSE', 'other', null],
  ])('%s is %s', (schema, protocol, edition) => {
    const info = detectSchema([schema]);
    expect(info.protocol).toBe(protocol);
    expect(info.edition).toBe(edition);
  });

  it('refuses IFC files', () => {
    expect(() => readStep(file('#1=IFCPROJECT();', 'IFC4'))).toThrow(UnsupportedSchemaError);
  });
});
