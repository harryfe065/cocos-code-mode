'use strict';
const { ts, fs, path, compare, json, source, slash, finalize } = require('./catalog-utils');
const { resolveAlias, moduleRoots, createProgram, declarationRoots, ambientModules, diagnosticRow } = require('./compiler-inputs');
const { signatures, metadata, constraints, compact, typeInfo } = require('./type-metadata');
function kind(node) {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isModuleDeclaration(node) || ts.isSourceFile(node)) return 'namespace';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isFunctionDeclaration(node)) return 'method';
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return 'accessor';
  return 'property';
}
function classExpression(node) {
  let initializer = ts.isVariableDeclaration(node) ? node.initializer : undefined;
  while (initializer && (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer) || ts.isNonNullExpression(initializer) || ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
  return initializer && ts.isClassExpression(initializer) ? initializer : null;
}
function collectExports(input, version, roots, label = 'engine') {
  const records = new Map();
  const unknowns = [];
  const { checker, root } = input;
  function record(symbol, declaration, context, className, member, inheritedFrom = null) {
    const memberOwner = member && ts.isParameter(declaration) && ts.isConstructorDeclaration(declaration.parent) ? declaration.parent.parent : declaration.parent;
    const info = metadata(declaration);
    const documentation = new Set(info.jsdoc ? [info.jsdoc] : []);
    for (const part of symbol.declarations || []) {
      if (part === declaration) continue;
      const merged = metadata(part);
      info.internal = info.internal || merged.internal;
      info.deprecated = info.deprecated || merged.deprecated;
      info.async = info.async || merged.async;
      info.generator = info.generator || merged.generator;
      if (merged.jsdoc) documentation.add(merged.jsdoc);
    }
    info.jsdoc = [...documentation].join('\n') || null;
    const ownerMetadata = member ? metadata(memberOwner) : info;
    if (member && memberOwner.name) {
      const ownerSymbol = checker.getSymbolAtLocation(memberOwner.name);
      for (const part of ownerSymbol?.declarations || []) {
        const merged = metadata(part);
        ownerMetadata.internal = ownerMetadata.internal || merged.internal;
        ownerMetadata.deprecated = ownerMetadata.deprecated || merged.deprecated;
      }
    }
    info.internal = info.internal || ownerMetadata.internal || !context.publicExport;
    info.deprecated = info.deprecated || ownerMetadata.deprecated || !!context.deprecated;
    let sigs;
    if (['interface', 'type', 'enum'].includes(kind(declaration)) && !member) {
      const value = typeInfo(checker, checker.getDeclaredTypeOfSymbol(symbol), ts.isInterfaceDeclaration(declaration) ? declaration : declaration.type);
      sigs = [{ overload: 0, visibility: info.visibility, jsdoc: info.jsdoc, kind: 'value', type: value.type, declaredType: value.declaredType, references: value.references, unresolved: value.unresolved }];
    } else sigs = signatures(checker, symbol, declaration);
    const diagnostics = sigs.flatMap(signature => signature.unresolved);
    const inheritedName = inheritedFrom?.name?.getText() || null;
    const owner = member ? memberOwner : classExpression(declaration) || declaration;
    const ownerSymbol = owner.name && checker.getSymbolAtLocation(owner.name);
    const mergedOwners = ownerSymbol?.declarations?.filter(part => ts.isInterfaceDeclaration(part) || ts.isClassDeclaration(part) || ts.isClassExpression(part));
    const owners = mergedOwners?.length ? mergedOwners : [owner];
    const clauses = owners.flatMap(part => part.heritageClauses || []);
    const heritage = [...new Map(clauses.flatMap(clause => clause.types.map(type => ({ relation: ts.tokenToString(clause.token), type: compact(type) }))).map(item => [json(item), item])).values()];
    for (const clause of clauses) for (const type of clause.types) {
      const resolved = typeInfo(checker, checker.getTypeAtLocation(type), type);
      diagnostics.push(...resolved.unresolved);
    }
    const unresolved = [...new Map(diagnostics.map(item => [json(item), item])).values()].sort((a, b) => compare(json(a), json(b)));
    const row = finalize({ version, namespace: context.namespace, module: context.module, className, member: member || null,
      name: member || className, kind: kind(declaration), signatures: sigs, ...info, inheritance: heritage, inheritedFrom: inheritedName,
      aliases: symbol.name !== className && !member ? [symbol.name, className] : [], declaredClassName: owner.name?.getText() || null,
      enumValues: ts.isEnumDeclaration(declaration) ? sigs[0].references.find(reference => reference.name === symbol.name && reference.kind === 'enum')?.enumValues ?? null : null,
      backingFields: ['accessor', 'property'].includes(kind(declaration)) ? [...new Set((compact(declaration) || '').match(/this\s*\.\s*_[A-Za-z0-9_$]+/g) || [])].map(value => value.replace(/\s/g, '').slice(5)) : [],
      source: source(declaration, root, label), exportedFrom: [context.exportPath], domain: context.domain,
      evidenceStatus: unresolved.length ? 'declared' : 'signatureResolved', contextConstraints: constraints(declaration, { ...context, config: input.config, path: slash(path.relative(root, declaration.getSourceFile().fileName)) }, checker),
      unresolved, discovered: true, permitted: false, publicExport: context.publicExport && info.visibility === 'public' && !info.internal,
      evidence: [{ kind: label === 'engine' ? 'source-export' : 'declaration', path: context.exportPath, alias: className }] });
    const key = row.semanticKey;
    const existing = records.get(key);
    if (!existing) records.set(key, row);
    else {
      existing.deprecated = existing.deprecated || row.deprecated;
      existing.internal = existing.internal || row.internal;
      existing.publicExport = existing.publicExport && row.publicExport && !existing.internal;
      existing.exportedFrom = [...new Set([...existing.exportedFrom, ...row.exportedFrom])].sort(compare);
      existing.contextConstraints.features = [...new Set([...existing.contextConstraints.features, ...row.contextConstraints.features])].sort(compare);
      existing.evidence = [...new Map([...existing.evidence, ...row.evidence].map(item => [json(item), item])).values()];
      finalize(existing);
    }
  }
  function visit(exported, context, prefix = '', ancestors = new Set()) {
    const symbol = resolveAlias(checker, exported);
    const name = prefix ? `${prefix}.${exported.name}` : exported.name;
    if (!symbol?.declarations?.length) { unknowns.push({ namespace: context.namespace, module: context.module, name, kind: 'export', reference: exported.name, path: context.exportPath, reason: 'Unresolved export alias or declaration' }); return; }
    if (ancestors.has(symbol)) return;
    const declaration = symbol.valueDeclaration || symbol.declarations[0];
    const expression = classExpression(declaration);
    const classSymbol = expression ? checker.getTypeAtLocation(expression).symbol : symbol;
    const classDeclarations = expression ? [expression] : symbol.declarations;
    const declaredKind = kind(declaration);
    const exportMetadata = [];
    if (exported !== symbol) for (const part of exported.declarations || []) {
      exportMetadata.push(metadata(part));
      if (ts.isExportSpecifier(part) && ts.isExportDeclaration(part.parent?.parent)) exportMetadata.push(metadata(part.parent.parent));
      if (ts.isNamespaceExport(part) && ts.isExportDeclaration(part.parent)) exportMetadata.push(metadata(part.parent));
    }
    const classMetadata = expression ? metadata(expression) : null;
    const internal = symbol.declarations.some(part => metadata(part).internal) || !!classMetadata?.internal || exportMetadata.some(item => item.internal);
    const deprecated = !!context.deprecated || symbol.declarations.some(part => metadata(part).deprecated) || !!classMetadata?.deprecated || exportMetadata.some(item => item.deprecated);
    const local = { ...context, deprecated, publicExport: context.publicExport && !internal && !/^__private(?:\.|$)/.test(name) };
    record(symbol, declaration, local, name, null);
    if (declaredKind === 'namespace' || symbol.flags & ts.SymbolFlags.Module) {
      const next = new Set([...ancestors, symbol]);
      for (const child of checker.getExportsOfModule(symbol).sort((a, b) => compare(a.name, b.name))) visit(child, local, name, next);
    }
    if (declaredKind === 'class' || declaredKind === 'interface' || expression) {
      const instance = checker.getDeclaredTypeOfSymbol(classSymbol);
      const members = new Map(checker.getPropertiesOfType(instance).map(item => [item.name, item]));
      for (const declared of classDeclarations) for (const member of declared.members || []) {
        const memberSymbol = member.name && checker.getSymbolAtLocation(member.name);
        if (memberSymbol && !(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static)) members.set(memberSymbol.name, memberSymbol);
      }
      for (const child of [...members.values()].sort((a, b) => compare(a.name, b.name))) {
        const decl = child.valueDeclaration || child.declarations?.[0];
        if (decl) {
          const owner = ts.isParameter(decl) && ts.isConstructorDeclaration(decl.parent) ? decl.parent.parent : decl.parent;
          record(child, decl, local, name, child.name, !classDeclarations.includes(owner) ? owner : null);
        }
      }
      if (symbol.valueDeclaration) {
        const constructor = checker.getTypeOfSymbolAtLocation(symbol, declaration);
        for (const child of checker.getPropertiesOfType(constructor).sort((a, b) => compare(a.name, b.name))) {
          const decl = child.valueDeclaration || child.declarations?.[0];
          if (decl && ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Static) record(child, decl, local, name, child.name, !classDeclarations.includes(decl.parent) ? decl.parent : null);
        }
      }
      const baseTypes = checker.getBaseTypes(instance) || [];
      for (const base of baseTypes) {
        if (base.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) unknowns.push({ namespace: local.namespace, module: local.module, name, kind: 'inheritance', reference: checker.typeToString(base), reason: 'Base type resolution is unknown' });
      }
    }
  }
  for (const context of roots) {
    let symbol = context.symbol;
    if (!symbol) {
      const sf = input.program.getSourceFile(context.file);
      symbol = sf && checker.getSymbolAtLocation(sf);
    }
    if (!symbol) { unknowns.push({ kind: 'module', reference: context.file, reason: 'Export module symbol unavailable' }); continue; }
    const env = { ...context, exportPath: context.file ? slash(path.relative(root, context.file)) : context.module, publicExport: true };
    for (const exported of checker.getExportsOfModule(symbol).sort((a, b) => compare(a.name, b.name))) visit(exported, env);
  }
  return { records: [...records.values()].sort((a, b) => compare(a.id, b.id)), unknowns };
}
function extractEngine(input, version) { return collectExports(input, version, moduleRoots(input)); }
function extractDeclarations(root, version) {
  const roots = declarationRoots(root);
  const input = { ...createProgram(root, roots, { types: [], module: ts.ModuleKind.CommonJS }), root, config: {} };
  const modules = ambientModules(input.program, input.checker).map(symbol => {
    const module = symbol.name.slice(1, -1);
    return { symbol, module, namespace: module === 'cc' ? 'engine-runtime' : 'engine-authoring', domain: 'declarations', features: [] };
  });
  const result = collectExports(input, version, modules, 'declarations');
  result.diagnostics = [...input.diagnostics, ...input.program.getSyntacticDiagnostics()].map(item => diagnosticRow(item, root, 'declarations'));
  return result;
}
function attachDeclarations(records, declarations) {
  const matches = new Map(declarations.map(record => [record.semanticKey, record]));
  const used = new Set();
  for (const record of records) {
    const declared = matches.get(record.semanticKey);
    if (!declared) continue;
    used.add(record.semanticKey);
    record.declarationEvidence = { source: declared.source, signatures: declared.signatures, evidenceStatus: declared.evidenceStatus,
      agreement: record.signatureHash === declared.signatureHash ? 'matching' : 'different', provenance: 'explicit-input-not-stock-qualification' };
  }
  for (const declared of declarations) if (!used.has(declared.semanticKey)) {
    declared.contextConstraints.sourceAvailability = 'declaration-only';
    declared.domain = 'declarations';
    records.push(finalize(declared));
  }
  return records;
}
module.exports = { extractEngine, extractDeclarations, attachDeclarations, collectExports };
