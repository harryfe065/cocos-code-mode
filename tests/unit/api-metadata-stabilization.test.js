'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { createProgram } = require('../../scripts/cocos-api/compiler-inputs');
const { collectExports } = require('../../scripts/cocos-api/engine-records');
const { signatures } = require('../../scripts/cocos-api/type-metadata');

function fixture(t, source, extension = '.ts') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, `exports${extension}`);
  fs.writeFileSync(file, source);
  const input = { ...createProgram(root, [file], { types: [], strict: true, module: ts.ModuleKind.CommonJS }), root, config: {} };
  const result = collectExports(input, 'fixture', [{ file, module: 'cc', namespace: 'engine-runtime', domain: 'fixture', features: [] }]);
  return { ...result, ...input };
}
function member(f, owner, name, isStatic = false) {
  const row = f.records.find(row => row.className === owner && row.member === name && row.static === isStatic);
  assert.ok(row, `${owner}.${name} (${isStatic ? 'static' : 'instance'}) is collected`);
  return row;
}
function accessors(row) {
  return { get: row.signatures.find(signature => signature.kind === 'get'), set: row.signatures.find(signature => signature.kind === 'set') };
}

test('inherited generic accessor setters use instantiated write types, including distinct reads and union aliases', t => {
  const f = fixture(t, `
    type Input<T> = T | boolean;
    export class Base<T> {
      get value(): T { throw 0; }
      set value(input: T) {}
      get converted(): number { return 1; }
      set converted(input: T | number) {}
      get aliased(): number { return 1; }
      set aliased(input: Input<T>) {}
    }
    export class Middle<U> extends Base<U> {}
    export class Derived extends Middle<string> {}
  `);
  const value = accessors(member(f, 'Derived', 'value'));
  assert.equal(value.get.returnType, 'string');
  assert.equal(value.set.parameters[0].type, 'string');
  assert.equal(value.set.parameters[0].declaredType, 'T');
  assert.deepEqual(value.set.unresolved, []);
  const converted = accessors(member(f, 'Derived', 'converted'));
  assert.equal(converted.get.returnType, 'number');
  assert.equal(converted.set.parameters[0].type, 'string | number');
  assert.deepEqual(converted.set.unresolved, []);
  assert.match(converted.set.text, /string \| number/);
  const aliased = accessors(member(f, 'Derived', 'aliased'));
  assert.equal(aliased.get.returnType, 'number');
  assert.equal(aliased.set.parameters[0].type, 'Input<string>');
  assert.equal(aliased.set.parameters[0].declaredType, 'Input < T >');
  assert.deepEqual(aliased.set.unresolved, []);
  const generic = accessors(member(f, 'Base', 'value'));
  assert.ok(generic.set.unresolved.some(item => item.kind === 'type-parameter' && item.reference === 'T'));
});

test('declaration classes retain distinct accessor, static and constructor contracts', t => {
  const f = fixture(t, `
    export declare class Base<T> {
      get value(): T;
      set value(input: T);
      get converted(): number;
      set converted(input: T | number);
    }
    export declare class Derived extends Base<string> {
      constructor(seed: string);
      run(input: number): boolean;
      static make(seed: string): Derived;
    }
  `, '.d.ts');
  const value = accessors(member(f, 'Derived', 'value'));
  assert.equal(value.get.returnType, 'string');
  assert.equal(value.set.parameters[0].type, 'string');
  assert.equal(value.set.returnType, 'void');
  const converted = accessors(member(f, 'Derived', 'converted'));
  assert.equal(converted.get.returnType, 'number');
  assert.equal(converted.set.parameters[0].type, 'string | number');
  assert.equal(converted.set.returnType, 'void');
  assert.deepEqual(converted.set.unresolved, []);
  assert.equal(member(f, 'Derived', 'run').signatures[0].returnType, 'boolean');
  assert.equal(member(f, 'Derived', 'make', true).signatures[0].returnType, 'Derived');
  const owner = f.records.find(row => row.className === 'Derived' && !row.member);
  assert.equal(owner.kind, 'class');
  assert.equal(owner.signatures[0].kind, 'construct');
  assert.equal(owner.signatures[0].parameters[0].type, 'string');
});

test('exported class-expression variables enumerate members under each export identity without executing source', t => {
  const f = fixture(t, `
    class Base<T> {
      get inherited(): T { throw 0; }
      set inherited(input: T) {}
      static baseMethod(): number { return 1; }
    }
    export const Factory = class ActualFactory extends Base<string> {
      static { throw new Error('Catalog extraction must never execute this'); }
      constructor(public seed: string) { super(); }
      run(input: number): boolean { return true; }
      static make(seed: string): number { return 1; }
      private hidden(): void {}
      protected guarded(): void {}
      /** @internal */ internalMethod(): void {}
    };
    export { Factory as PublicFactory };
    /** @internal */ export const InternalFactory = class { run(): void {} };
    export const __privateFactory = class { run(): void {} };
    /** @internal */ export { Factory as InternalAlias };
    export const Wrapped = (class { run(): string { return ''; } });
  `);
  for (const name of ['Factory', 'PublicFactory']) {
    const run = member(f, name, 'run');
    assert.equal(run.kind, 'method');
    assert.equal(run.signatures[0].parameters[0].type, 'number');
    assert.equal(run.signatures[0].returnType, 'boolean');
    assert.equal(run.publicExport, true);
    assert.equal(run.declaredClassName, 'ActualFactory');
    assert.equal(run.inheritedFrom, null);
    assert.equal(run.source.path, 'exports.ts');
    assert.deepEqual(run.exportedFrom, ['exports.ts']);
    assert.equal(member(f, name, 'make', true).signatures[0].returnType, 'number');
    assert.equal(member(f, name, 'baseMethod', true).inheritedFrom, 'Base');
    assert.equal(member(f, name, 'seed').signatures[0].type, 'string');
    assert.equal(member(f, name, 'hidden').visibility, 'private');
    assert.equal(member(f, name, 'hidden').publicExport, false);
    assert.equal(member(f, name, 'guarded').visibility, 'protected');
    assert.equal(member(f, name, 'guarded').publicExport, false);
    assert.equal(member(f, name, 'internalMethod').internal, true);
    assert.equal(member(f, name, 'internalMethod').publicExport, false);
    const inherited = accessors(member(f, name, 'inherited'));
    assert.equal(inherited.get.returnType, 'string');
    assert.equal(inherited.set.parameters[0].type, 'string');
    const owner = f.records.find(row => row.className === name && !row.member);
    assert.equal(owner.kind, 'property');
    assert.equal(owner.readonly, true);
    assert.equal(owner.declaredClassName, 'ActualFactory');
    assert.equal(owner.signatures[0].kind, 'construct');
    assert.equal(owner.signatures[0].parameters[0].type, 'string');
  }
  const alias = f.records.find(row => row.className === 'PublicFactory' && !row.member);
  assert.deepEqual(alias.aliases, ['Factory', 'PublicFactory']);
  for (const name of ['InternalFactory', '__privateFactory', 'InternalAlias']) {
    assert.equal(member(f, name, 'run').publicExport, false);
  }
  assert.equal(member(f, 'Wrapped', 'run').signatures[0].returnType, 'string');
  assert.ok(f.records.every(row => row.permitted === false));
});

test('unavailable compiler write-type resolution stays explicitly unresolved', t => {
  const f = fixture(t, 'export class Sample { get value(): number { return 1; } set value(input: string | number) {} }');
  const declaration = f.program.getSourceFiles().find(file => file.fileName.endsWith('exports.ts')).statements[0];
  const type = f.checker.getDeclaredTypeOfSymbol(f.checker.getSymbolAtLocation(declaration.name));
  const symbol = f.checker.getPropertyOfType(type, 'value');
  const checker = new Proxy(f.checker, {
    get(target, key) {
      if (key === 'getTypeOfSymbolAtLocation') return (item, location) => {
        if (ts.isStringLiteral(location) && location.parent && ts.isElementAccessExpression(location.parent)) throw new Error('Write type unavailable');
        return target.getTypeOfSymbolAtLocation(item, location);
      };
      return target[key];
    },
  });
  const rows = signatures(checker, symbol, symbol.valueDeclaration);
  const setter = rows.find(row => row.kind === 'set');
  assert.equal(setter.parameters[0].type, 'string | number');
  assert.ok(setter.unresolved.some(item => item.kind === 'setter-write-type'));
});
