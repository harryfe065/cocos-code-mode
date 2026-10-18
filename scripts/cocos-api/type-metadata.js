'use strict';
const { ts, text, tokens, json, compare } = require('./catalog-utils');
function compact(node) {
  if (!node) return null;
  return JSON.parse(tokens(text(node))).map(([, value]) => value).join(' ');
}
function canonicalType(value) {
  return value.replace(/import\("([^\"]+)"\)/g, (_, module) => {
    const normalized = module.replace(/\\/g, '/');
    const segment = normalized.match(/(?:^|\/)((?:cocos|editor|exports|pal|@types)\/.*)$/);
    return `import("${segment ? segment[1] : normalized.split('/').pop()}")`;
  });
}
function typeInfo(checker, type, node) {
  const unresolved = [];
  const seen = new Set();
  const active = new Set();
  const seenSymbols = new Set();
  const references = new Map();
  const referenceSymbols = new Map();
  let count = 0;
  let budgetExceeded = false;
  const visit = current => {
    if (!current) return;
    if (active.has(current)) { unresolved.push({ kind: 'cycle', reference: current.aliasSymbol?.name || current.symbol?.name || 'recursive-type' }); return; }
    if (seen.has(current)) return;
    if (count >= 256) {
      if (!budgetExceeded) unresolved.push({ kind: 'type-budget', reference: 'Type expansion exceeds 256 nodes' });
      budgetExceeded = true;
      return;
    }
    count++;
    seen.add(current);
    active.add(current);
    try {
    if (current.flags & ts.TypeFlags.Any) unresolved.push({ kind: 'any', reference: current.aliasSymbol?.name || current.intrinsicName || 'any' });
    if (current.flags & ts.TypeFlags.Unknown) unresolved.push({ kind: 'unknown', reference: 'unknown' });
    if (current.flags & ts.TypeFlags.NonPrimitive) unresolved.push({ kind: 'opaque-object', reference: 'object' });
    if (current.flags & ts.TypeFlags.BigIntLike) unresolved.push({ kind: 'semantic-adapter-required', reference: 'bigint-type' });
    if (current.flags & ts.TypeFlags.ESSymbolLike) unresolved.push({ kind: 'semantic-adapter-required', reference: 'symbol-type' });
    if (current.flags & ts.TypeFlags.TypeParameter) {
      unresolved.push({ kind: 'type-parameter', reference: current.symbol?.name || checker.typeToString(current) });
      visit(checker.getBaseConstraintOfType(current));
    }
    if (current.flags & ts.TypeFlags.IndexedAccess) {
      unresolved.push({ kind: 'indexed-access', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      visit(current.objectType);
      visit(current.indexType);
    }
    if (current.flags & ts.TypeFlags.Index) {
      unresolved.push({ kind: 'keyof', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      visit(current.type);
    }
    if (current.flags & ts.TypeFlags.TemplateLiteral) {
      unresolved.push({ kind: 'template-literal', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      current.types.forEach(visit);
    }
    if (current.flags & ts.TypeFlags.StringMapping) {
      unresolved.push({ kind: 'string-mapping', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      visit(current.type);
    }
    if (current.flags & ts.TypeFlags.Conditional) {
      unresolved.push({ kind: 'conditional', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      visit(current.checkType);
      visit(current.extendsType);
      // Branches describe declaration dependencies, not a selected or instantiated result.
      const conditional = current.root?.node;
      if (conditional && ts.isConditionalTypeNode(conditional)) {
        visit(checker.getTypeFromTypeNode(conditional.trueType));
        visit(checker.getTypeFromTypeNode(conditional.falseType));
      }
    }
    if (current.flags & ts.TypeFlags.Object && current.objectFlags & ts.ObjectFlags.Mapped) {
      unresolved.push({ kind: 'mapped-type', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      // Declaration operands are provenance, not proof of instantiated mapped properties.
      const mapped = current.declaration;
      if (mapped && ts.isMappedTypeNode(mapped)) {
        for (const operand of [mapped.typeParameter.constraint, mapped.nameType, mapped.type]) {
          if (operand) visit(checker.getTypeFromTypeNode(operand));
        }
      }
    }
    if (current.isUnionOrIntersection?.()) current.types.forEach(visit);
    const collection = checker.isArrayType(current) || checker.isTupleType(current);
    if (current.flags & ts.TypeFlags.Object && current.objectFlags & ts.ObjectFlags.Reference) checker.getTypeArguments(current).forEach(visit);
    if (current.aliasTypeArguments) current.aliasTypeArguments.forEach(visit);
    let symbol = collection ? current.aliasSymbol : current.aliasSymbol || current.symbol;
    const enumMember = current.symbol?.declarations?.find(ts.isEnumMember);
    if (enumMember) symbol = checker.getSymbolAtLocation(enumMember.parent.name) || symbol;
    if (current.flags & ts.TypeFlags.Object && (current.objectFlags & ts.ObjectFlags.Class || current.objectFlags & ts.ObjectFlags.Reference && current.target?.objectFlags & ts.ObjectFlags.Class)) {
      unresolved.push({ kind: 'semantic-adapter-required', reference: 'class-instance-type' });
    }
    const callSignatures = checker.getSignaturesOfType(current, ts.SignatureKind.Call);
    const constructSignatures = checker.getSignaturesOfType(current, ts.SignatureKind.Construct);
    if (callSignatures.length) unresolved.push({ kind: 'semantic-adapter-required', reference: 'callable-type' });
    if (constructSignatures.length) unresolved.push({ kind: 'semantic-adapter-required', reference: 'constructable-type' });
    const declaration = symbol?.declarations?.find(item => ts.isInterfaceDeclaration(item) || ts.isTypeAliasDeclaration(item));
    if (declaration && ts.isInterfaceDeclaration(declaration)) {
      for (const base of checker.getBaseTypes(current) || []) visit(base);
    }
    if (symbol && !symbol.name.startsWith('__')) {
      const previous = referenceSymbols.get(symbol.name);
      if (previous && previous !== symbol) {
        unresolved.push({ kind: 'ambiguous-reference', reference: symbol.name });
        const reference = references.get(symbol.name);
        if (reference) { reference.resolution = 'unknown'; reference.enumValues = null; }
      }
      else referenceSymbols.set(symbol.name, symbol);
    }
    if (symbol && !symbol.name.startsWith('__') && !references.has(symbol.name)) {
      const enumDeclarations = symbol.declarations?.filter(ts.isEnumDeclaration) || [];
      const enumValues = enumDeclarations.length ? [] : null;
      const enumNames = new Set();
      enumMembers: for (const item of enumDeclarations) {
        for (const member of item.members) {
          if (enumValues.length >= 256) {
            unresolved.push({ kind: 'enum-budget', reference: symbol.name });
            break enumMembers;
          }
          const value = checker.getConstantValue(member);
          const name = checker.getSymbolAtLocation(member.name)?.name || member.name.getText();
          if (enumNames.has(name)) unresolved.push({ kind: 'enum-member-ambiguity', reference: `${symbol.name}.${name}` });
          enumNames.add(name);
          const resolved = value !== undefined && (typeof value !== 'number' || Number.isFinite(value));
          if (!resolved) unresolved.push({ kind: 'enum-value', reference: `${symbol.name}.${name}` });
          enumValues.push({ name, value: resolved ? value : compact(member.initializer), constant: resolved });
        }
      }
      references.set(symbol.name, { name: symbol.name, resolution: symbol.declarations?.length ? 'resolved' : 'unknown',
        kind: enumDeclarations.length ? 'enum' : declaration ? ts.isInterfaceDeclaration(declaration) ? 'interface' : 'type-alias' : 'type-reference',
        enumValues });
    }
    if (collection) return;
    if (symbol && declaration && !seenSymbols.has(symbol)) {
      seenSymbols.add(symbol);
      if (ts.isTypeAliasDeclaration(declaration) && !declaration.typeParameters?.length) { const underlying = checker.getTypeFromTypeNode(declaration.type); if (underlying !== current) visit(underlying); }
    }
    if (current.flags & ts.TypeFlags.Object && (current.objectFlags & ts.ObjectFlags.Anonymous || declaration)) {
      for (const index of checker.getIndexInfosOfType(current)) {
        visit(index.keyType);
        visit(index.type);
      }
      for (const property of checker.getPropertiesOfType(current)) {
        const propertyDeclaration = property.valueDeclaration || property.declarations?.[0];
        if (property.declarations?.some(item => ts.isGetAccessorDeclaration(item) || ts.isSetAccessorDeclaration(item))) {
          unresolved.push({ kind: 'semantic-adapter-required', reference: 'accessor-property' });
          for (const accessor of property.declarations) {
            if (!ts.isSetAccessorDeclaration(accessor)) continue;
            const writeType = setterWriteType(checker, property);
            if (writeType) visit(writeType);
            else unresolved.push({ kind: 'setter-write-type', reference: 'Compiler write-type resolution unavailable' });
          }
        }
        const key = propertyDeclaration?.name;
        if (key && ts.isComputedPropertyName(key) && checker.getTypeAtLocation(key.expression).flags & ts.TypeFlags.ESSymbolLike) {
          unresolved.push({ kind: 'semantic-adapter-required', reference: 'symbol-keyed-property' });
        }
        if (propertyDeclaration) visit(checker.getTypeOfSymbolAtLocation(property, propertyDeclaration));
      }
      for (const signature of [...callSignatures, ...constructSignatures]) {
        for (const parameter of signature.typeParameters || []) {
          visit(checker.getBaseConstraintOfType(parameter));
          const declared = parameter.symbol?.declarations?.[0];
          if (declared?.default) visit(checker.getTypeFromTypeNode(declared.default));
        }
        const receiver = signature.thisParameter;
        const receiverDeclaration = receiver?.valueDeclaration || receiver?.declarations?.[0];
        if (receiverDeclaration) visit(checker.getTypeOfSymbolAtLocation(receiver, receiverDeclaration));
        signature.parameters.forEach(parameter => { const parameterDeclaration = parameter.valueDeclaration || parameter.declarations?.[0]; if (parameterDeclaration) visit(checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration)); });
        visit(checker.getReturnTypeOfSignature(signature));
        visit(checker.getTypePredicateOfSignature(signature)?.type);
      }
    }
    } finally { active.delete(current); }
  };
  visit(type);
  if (node) {
    const declarations = ts.isInterfaceDeclaration(node) ? (type.symbol?.declarations || [node]).filter(ts.isInterfaceDeclaration) : [node];
    const pending = declarations.slice(0, 256).reverse();
    let scanned = 0;
    let syntaxExceeded = declarations.length > 256;
    while (pending.length) {
      const current = pending.pop();
      scanned++;
      if (ts.isTypeReferenceNode(current)) {
        let symbol = checker.getSymbolAtLocation(current.typeName);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (!symbol || symbol.name === 'unknown' || !symbol.declarations?.length) unresolved.push({ kind: 'reference', reference: compact(current.typeName) });
      }
      if (ts.isExpressionWithTypeArguments(current)) {
        let symbol = checker.getSymbolAtLocation(current.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (!symbol || symbol.name === 'unknown' || !symbol.declarations?.length) unresolved.push({ kind: 'reference', reference: compact(current.expression) });
      }
      if (ts.isImportTypeNode(current)) {
        let symbol = checker.getSymbolAtLocation(current.qualifier || current.argument.literal);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (!symbol || symbol.name === 'unknown' || !symbol.declarations?.length) unresolved.push({ kind: 'import-reference', reference: compact(current) });
      }
      if (ts.isTypeQueryNode(current)) {
        let symbol = checker.getSymbolAtLocation(current.exprName);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (!symbol || symbol.name === 'unknown' || !symbol.declarations?.length) unresolved.push({ kind: 'value-reference', reference: compact(current.exprName) });
      }
      if (ts.isComputedPropertyName(current)) {
        const keyType = checker.getTypeAtLocation(current.expression);
        if (keyType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) unresolved.push({ kind: 'value-reference', reference: compact(current.expression) });
        else if (!(keyType.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.UniqueESSymbol))) unresolved.push({ kind: 'computed-key', reference: compact(current.expression) });
      }
      if (ts.isTypeNode(current) || current === node || ts.isInterfaceDeclaration(current) || ts.isHeritageClause(current) || ts.isExpressionWithTypeArguments(current) || ts.isPropertySignature(current) || ts.isParameter(current) || ts.isMethodSignature(current) || ts.isCallSignatureDeclaration(current) || ts.isConstructSignatureDeclaration(current) || ts.isIndexSignatureDeclaration(current) || ts.isTypeParameterDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
        const children = [];
        ts.forEachChild(current, child => {
          if (scanned + pending.length + children.length >= 256) { syntaxExceeded = true; return true; }
          children.push(child);
          return undefined;
        });
        for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
      }
    }
    if (syntaxExceeded) unresolved.push({ kind: 'syntax-budget', reference: 'Type annotation scan exceeds 256 nodes' });
  }
  const rendered = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
  return { type: canonicalType(rendered), declaredType: node ? compact(node) : null, references: [...references.values()].sort((a, b) => compare(a.name, b.name)),
    unresolved: [...new Map(unresolved.map(item => [json(item), item])).values()].sort((a, b) => compare(json(a), json(b))) };
}
// A parsed element-assignment key asks the public checker API for the symbol's
// write type, including inherited generic substitutions. A declaration parameter
// is uninstantiated, and a property read would incorrectly reuse the getter type.
const setterWriteSource = ts.createSourceFile('catalog-setter-write.ts', 'receiver["value"] = input;', ts.ScriptTarget.Latest, true);
const setterWriteLocation = setterWriteSource.statements[0].expression.left.argumentExpression;
function setterWriteType(checker, symbol) {
  try {
    return checker.getTypeOfSymbolAtLocation(symbol, setterWriteLocation) || null;
  } catch {
    return null;
  }
}
function signatureInfo(checker, signature, declaration, index, returnType, writeType) {
  const unresolved = [];
  const declarationMetadata = metadata(declaration);
  const visibility = declarationMetadata.visibility;
  const genericReferences = new Map();
  const receiverSymbol = signature.thisParameter;
  const receiverDeclaration = receiverSymbol?.valueDeclaration || receiverSymbol?.declarations?.[0];
  const receiver = receiverSymbol ? typeInfo(checker, checker.getTypeOfSymbolAtLocation(receiverSymbol, receiverDeclaration || declaration), receiverDeclaration?.type) : null;
  if (receiver) {
    unresolved.push(...receiver.unresolved);
    for (const reference of receiver.references) genericReferences.set(json(reference), reference);
  }
  let minArgumentCount = signature.minArgumentCount;
  const parameters = signature.parameters.map((symbol, position) => {
    const parameter = symbol.valueDeclaration || symbol.declarations?.[0] || declaration.parameters?.[position];
    if (parameter?.dotDotDotToken) {
      const rawRestType = checker.getTypeOfSymbolAtLocation(symbol, parameter);
      const alternatives = [rawRestType];
      const visited = new Set();
      let requiredLength = Infinity;
      for (let index = 0; index < alternatives.length; index++) {
        const alternative = alternatives[index];
        if (visited.has(alternative)) continue;
        if (visited.size >= 256) { requiredLength = 0; unresolved.push({ kind: 'arity-budget', reference: 'Rest arity expansion exceeds 256 types' }); break; }
        visited.add(alternative);
        if (alternative.flags & ts.TypeFlags.TypeParameter) {
          const constraint = checker.getBaseConstraintOfType(alternative);
          if (constraint && constraint !== alternative) { alternatives.push(constraint); continue; }
        }
        if (alternative.isUnion?.()) {
          if (alternatives.length + alternative.types.length > 256) { requiredLength = 0; unresolved.push({ kind: 'arity-budget', reference: 'Rest arity expansion exceeds 256 types' }); break; }
          for (const type of alternative.types) alternatives.push(type);
          continue;
        }
        requiredLength = Math.min(requiredLength, checker.isTupleType(alternative) ? alternative.target.minLength : 0);
        if (requiredLength === 0) break;
      }
      if (!Number.isFinite(requiredLength)) requiredLength = 0;
      if (requiredLength > 0) minArgumentCount = Math.max(minArgumentCount, position + requiredLength);
    }
    const info = typeInfo(checker, position === 0 && writeType || checker.getTypeOfSymbolAtLocation(symbol, parameter || declaration), parameter?.type);
    unresolved.push(...info.unresolved);
    return { name: symbol.name, type: info.type, declaredType: info.declaredType, references: info.references, optional: !!(symbol.flags & ts.SymbolFlags.Optional) || !!parameter?.questionToken || !!parameter?.initializer && position >= signature.minArgumentCount,
      jsdoc: parameter?.jsDoc?.map(doc => doc.getText()).join('\n') || null,
      bindingPattern: parameter?.name && (ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)) ? compact(parameter.name) : null,
      rest: !!parameter?.dotDotDotToken, defaultExpression: compact(parameter?.initializer), unresolved: info.unresolved };
  });
  for (let position = 0; position < parameters.length; position++) {
    if (position < minArgumentCount && parameters[position].defaultExpression !== null) parameters[position].optional = false;
  }
  // Setter declarations cannot annotate a return type or return a value. The
  // compiler reports `any` for bodyless setter signatures, not their write type.
  const result = typeInfo(checker, ts.isSetAccessorDeclaration(declaration) ? checker.getVoidType() : returnType || checker.getReturnTypeOfSignature(signature), declaration.type);
  unresolved.push(...result.unresolved);
  const nativePredicate = checker.getTypePredicateOfSignature(signature);
  const predicateInfo = nativePredicate?.type ? typeInfo(checker, nativePredicate.type, declaration.type?.type) : null;
  const predicate = nativePredicate ? {
    kind: ts.TypePredicateKind[nativePredicate.kind],
    parameterName: nativePredicate.parameterName ?? null,
    parameterIndex: nativePredicate.parameterIndex ?? null,
    type: predicateInfo,
  } : null;
  if (predicateInfo) {
    unresolved.push(...predicateInfo.unresolved);
    for (const reference of predicateInfo.references) genericReferences.set(json(reference), reference);
  }
  const typeParameters = (signature.typeParameters || []).map(parameter => {
    const constraint = checker.getBaseConstraintOfType(parameter);
    const info = constraint ? typeInfo(checker, constraint) : null;
    const declared = parameter.symbol?.declarations?.[0];
    const defaultInfo = declared?.default ? typeInfo(checker, checker.getTypeFromTypeNode(declared.default), declared.default) : null;
    for (const value of [info, defaultInfo]) {
      if (!value) continue;
      unresolved.push(...value.unresolved);
      for (const reference of value.references) genericReferences.set(json(reference), reference);
    }
    const modifiers = declared?.modifiers || [];
    const variance = [modifiers.some(modifier => modifier.kind === ts.SyntaxKind.InKeyword) ? 'in' : '', modifiers.some(modifier => modifier.kind === ts.SyntaxKind.OutKeyword) ? 'out' : ''].filter(Boolean).join(' ') || null;
    return { name: parameter.symbol?.name || checker.typeToString(parameter), const: modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ConstKeyword), variance, constraint: info?.type || null, default: compact(declared?.default) };
  });
  return { overload: index, visibility, jsdoc: declarationMetadata.jsdoc, minArgumentCount, kind: ts.isSetAccessorDeclaration(declaration) ? 'set' : ts.isGetAccessorDeclaration(declaration) ? 'get' : 'call',
    text: writeType ? `(${parameters.map(parameter => `${parameter.name}: ${parameter.type}`).join(', ')}): ${result.type}` : returnType && ts.isGetAccessorDeclaration(declaration) ? `(): ${result.type}` : checker.signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation), typeParameters, parameters, receiver, predicate,
    returnType: result.type, declaredReturnType: result.declaredType, returnReferences: result.references,
    references: [...genericReferences.values()].sort((a, b) => compare(json(a), json(b))),
    unresolved: [...new Map(unresolved.map(item => [json(item), item])).values()].sort((a, b) => compare(json(a), json(b))) };
}
function signatures(checker, symbol, declaration) {
  const accessors = (symbol.declarations || []).filter(d => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d));
  if (accessors.length) return accessors.map((decl, i) => {
    const setter = ts.isSetAccessorDeclaration(decl);
    const writeType = setter ? setterWriteType(checker, symbol) : undefined;
    const row = signatureInfo(checker, checker.getSignatureFromDeclaration(decl), decl, i,
      ts.isGetAccessorDeclaration(decl) ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : undefined, writeType);
    if (setter && !writeType) row.unresolved.push({ kind: 'setter-write-type', reference: 'Compiler write-type resolution unavailable' });
    return row;
  });
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const constructs = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  const declarationMetadata = metadata(declaration);
  if (calls.length || constructs.length) return [...calls, ...constructs].map((sig, i) => {
    const row = signatureInfo(checker, sig, sig.getDeclaration() || declaration, i);
    if (i >= calls.length) row.kind = 'construct';
    row.abstract = declarationMetadata.abstract || !!(sig.flags & ts.SignatureFlags.Abstract);
    if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) row.jsdoc = row.jsdoc || declarationMetadata.jsdoc;
    if (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration) || ts.isParameter(declaration) && ts.isConstructorDeclaration(declaration.parent) && !!(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.ParameterPropertyModifier)) {
      row.visibility = declarationMetadata.visibility;
      row.jsdoc = row.jsdoc || declarationMetadata.jsdoc;
      row.unresolved.push({ kind: 'semantic-adapter-required', reference: i < calls.length ? 'callable-property' : 'constructable-property' });
    }
    return row;
  });
  const info = typeInfo(checker, type, declaration.type);
  return [{ overload: 0, visibility: declarationMetadata.visibility, jsdoc: declarationMetadata.jsdoc, kind: 'value', type: info.type, declaredType: info.declaredType, references: info.references,
    defaultExpression: compact(declaration.initializer), unresolved: info.unresolved }];
}
function metadata(node) {
  const tags = ts.getJSDocTags(node).map(tag => tag.tagName.text);
  const decorators = (ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : []).map(decorator => compact(decorator.expression));
  const modifiers = (ts.canHaveModifiers(node) ? ts.getModifiers(node) || [] : []).map(modifier => ts.tokenToString(modifier.kind)).filter(Boolean);
  const visibility = node.name && ts.isPrivateIdentifier(node.name) || modifiers.includes('private') ? 'private' : modifiers.includes('protected') ? 'protected' : 'public';
  const nameNode = node.name && ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
  const declaredName = nameNode && (ts.isIdentifier(nameNode) && nameNode === node.name || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) ? nameNode.text : node.name?.getText();
  let binding = node;
  while (ts.isBindingElement(binding) && (ts.isObjectBindingPattern(binding.parent) || ts.isArrayBindingPattern(binding.parent))) binding = binding.parent.parent;
  if (binding !== node) tags.push(...ts.getJSDocTags(binding).map(tag => tag.tagName.text));
  const documentation = node.jsDoc?.length ? node.jsDoc : binding.jsDoc?.length ? binding.jsDoc : ts.isVariableDeclaration(binding) && ts.isVariableStatement(binding.parent?.parent) ? binding.parent.parent.jsDoc || [] : [];
  const constantBinding = ts.isVariableDeclaration(binding) && ts.isVariableDeclarationList(binding.parent) && !!(binding.parent.flags & ts.NodeFlags.Const);
  let initializer = (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) ? node.initializer : undefined;
  while (initializer && (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer) || ts.isNonNullExpression(initializer) || ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
  const callable = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? initializer : node;
  const callableModifiers = ts.canHaveModifiers(callable) ? ts.getModifiers(callable) || [] : [];
  return { decorators, visibility, optional: !!node.questionToken, static: modifiers.includes('static'), readonly: constantBinding || modifiers.includes('readonly') || ts.isGetAccessorDeclaration(node) && !node.symbol?.declarations?.some(ts.isSetAccessorDeclaration),
    internal: tags.includes('internal') || tags.includes('engineInternal') || tags.includes('private') || !!declaredName?.startsWith('__'), deprecated: tags.includes('deprecated'),
    generator: !!callable.asteriskToken, async: callableModifiers.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword), abstract: modifiers.includes('abstract'), jsdoc: documentation.map(doc => doc.getText()).join('\n') || null };
}
function constraints(node, context, checker) {
  const sf = node.getSourceFile();
  const constants = [];
  const constantSymbols = new Set();
  const namespaceNames = new Set();
  const namespaceSymbols = new Set();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'internal:constants' && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      const bindings = statement.importClause.namedBindings.elements.filter(item => !item.isTypeOnly);
      constants.push(...bindings.map(item => item.name.text));
      if (checker) for (const item of bindings) {
        const symbol = checker.getSymbolAtLocation(item.name);
        const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        if (symbol && !checker.getTypeOnlyAliasDeclaration(symbol) && target?.declarations?.length && target.flags & ts.SymbolFlags.Value) constantSymbols.add(symbol);
      }
    } else if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'internal:constants' && statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)) {
      const name = statement.importClause.namedBindings.name;
      namespaceNames.add(name.text);
      const symbol = checker?.getSymbolAtLocation(name);
      if (symbol) namespaceSymbols.add(symbol);
    }
  }
  const guards = [];
  const pending = [node];
  while (pending.length) {
    const current = pending.pop();
    const shortCircuit = ts.isBinaryExpression(current) && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || current.operatorToken.kind === ts.SyntaxKind.BarBarToken || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken);
    const expressionGuard = ts.isIfStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current) || ts.isSwitchStatement(current);
    if (expressionGuard || ts.isConditionalExpression(current) || ts.isForStatement(current) || shortCircuit) {
      const expression = shortCircuit ? current.left : expressionGuard ? current.expression : current.condition;
      const usesConstant = part => {
        while (ts.isParenthesizedExpression(part) || ts.isAsExpression(part) || ts.isTypeAssertionExpression(part) || ts.isNonNullExpression(part) || ts.isSatisfiesExpression(part) || ts.isPrefixUnaryExpression(part) || ts.isPostfixUnaryExpression(part) || ts.isTypeOfExpression(part) || ts.isVoidExpression(part) || ts.isAwaitExpression(part)) part = part.expression || part.operand;
        if ((ts.isMethodDeclaration(part) || ts.isGetAccessorDeclaration(part) || ts.isSetAccessorDeclaration(part)) && ts.isObjectLiteralExpression(part.parent)) return ts.isComputedPropertyName(part.name) && usesConstant(part.name.expression);
        if (ts.isTypeNode(part) || ts.isFunctionLike(part) || ts.isClassExpression(part)) return false;
        if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          let target = part.left;
          while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isTypeAssertionExpression(target) || ts.isNonNullExpression(target) || ts.isSatisfiesExpression(target)) target = target.expression;
          if (ts.isIdentifier(target)) return usesConstant(part.right);
          if (ts.isPropertyAccessExpression(target)) return usesConstant(target.expression) || usesConstant(part.right);
          if (ts.isElementAccessExpression(target)) return usesConstant(target.expression) || usesConstant(target.argumentExpression) || usesConstant(part.right);
        }
        if (ts.isDeleteExpression(part)) {
          let target = part.expression;
          while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isTypeAssertionExpression(target) || ts.isNonNullExpression(target) || ts.isSatisfiesExpression(target)) target = target.expression;
          if (ts.isIdentifier(target)) return false;
          if (ts.isPropertyAccessExpression(target)) return usesConstant(target.expression);
          if (ts.isElementAccessExpression(target)) return usesConstant(target.expression) || usesConstant(target.argumentExpression);
        }
        if (ts.isPropertyAssignment(part)) return (ts.isComputedPropertyName(part.name) && usesConstant(part.name.expression)) || usesConstant(part.initializer);
        if (checker && ts.isShorthandPropertyAssignment(part) && constantSymbols.has(checker.getShorthandAssignmentValueSymbol(part))) return true;
        if (ts.isIdentifier(part) && (checker ? constantSymbols.has(checker.getSymbolAtLocation(part)) : constants.includes(part.text))) return true;
        if (ts.isPropertyAccessExpression(part) || ts.isElementAccessExpression(part)) {
          let target = part.expression;
          while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isTypeAssertionExpression(target) || ts.isNonNullExpression(target) || ts.isSatisfiesExpression(target)) target = target.expression;
          let key = ts.isElementAccessExpression(part) ? part.argumentExpression : undefined;
          while (key && ts.isParenthesizedExpression(key)) key = key.expression;
          const explicitMember = ts.isPropertyAccessExpression(part) || key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key));
          if (explicitMember && ts.isIdentifier(target) && (checker ? namespaceSymbols.has(checker.getSymbolAtLocation(target)) : namespaceNames.has(target.text))) {
            const name = ts.isPropertyAccessExpression(part) ? part.name.text : key.text;
            const member = checker?.getPropertyOfType(checker.getTypeAtLocation(target), name);
            const value = member && member.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(member) : member;
            if (!checker || value?.declarations?.length && value.flags & ts.SymbolFlags.Value) return true;
          }
          if (ts.isPropertyAccessExpression(part)) return usesConstant(target);
        }
        return ts.forEachChild(part, usesConstant);
      };
      if (expression && usesConstant(expression)) guards.push(compact(expression));
    }
    const children = [];
    ts.forEachChild(current, child => { children.push(child); });
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  const overrides = (context.config?.moduleOverrides || []).filter(item => Object.keys(item.overrides || {}).some(file => file === context.path)).map(item => ({ test: item.test, replacement: item.overrides[context.path] }));
  const editModeDeclared = (ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : []).some(decorator => {
    let expression = decorator.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isCallExpression(expression)) {
      if (expression.arguments.length !== 1) return false;
      let argument = expression.arguments[0];
      while (ts.isParenthesizedExpression(argument)) argument = argument.expression;
      if (argument.kind !== ts.SyntaxKind.TrueKeyword) return false;
      expression = expression.expression;
    }
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (checker && ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        const target = checker.getAliasedSymbol(symbol);
        return !checker.getTypeOnlyAliasDeclaration(symbol) && !!target?.declarations?.length && target.name === 'executeInEditMode';
      }
    }
    if (checker && (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))) {
      let base = expression.expression;
      while (ts.isParenthesizedExpression(base) || ts.isAsExpression(base) || ts.isTypeAssertionExpression(base) || ts.isNonNullExpression(base) || ts.isSatisfiesExpression(base)) base = base.expression;
      const symbol = ts.isIdentifier(base) ? checker.getSymbolAtLocation(base) : undefined;
      if (symbol && symbol.flags & ts.SymbolFlags.Alias && checker.getTypeOnlyAliasDeclaration(symbol)) return false;
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        let key = ts.isPropertyAccessExpression(expression) ? expression.name : expression.argumentExpression;
        while (key && ts.isParenthesizedExpression(key)) key = key.expression;
        const name = key && (ts.isIdentifier(key) && ts.isPropertyAccessExpression(expression) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) ? key.text : null;
        if (!name) return false;
        const member = checker.getPropertyOfType(checker.getTypeAtLocation(base), name);
        const target = member && member.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(member) : member;
        return !!target?.declarations?.length && !!(target.flags & ts.SymbolFlags.Value) && target.name === 'executeInEditMode';
      }
    }
    if (ts.isElementAccessExpression(expression)) {
      let key = expression.argumentExpression;
      while (key && ts.isParenthesizedExpression(key)) key = key.expression;
      return key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && key.text === 'executeInEditMode';
    }
    return ts.isIdentifier(expression) ? expression.text === 'executeInEditMode' : ts.isPropertyAccessExpression(expression) && expression.name.text === 'executeInEditMode';
  });
  return { execution: context.namespace === 'engine-runtime' ? ['game-runtime'] : ['edit-scene'], targetAvailable: 'unknown',
    features: context.features || [], importedConstants: constants.sort(compare), guards: [...new Set(guards)].sort(compare), moduleOverrides: overrides,
    editModeDeclared, jsonTransfer: 'named-reference-or-value-dto-required' };
}
module.exports = { compact, typeInfo, signatureInfo, signatures, metadata, constraints };
