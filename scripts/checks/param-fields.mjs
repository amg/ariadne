/**
 * param-fields — a function that destructures its parameter binds every member the
 * parameter's type declares. A member left unbound is an input the function never
 * reads, so the type, and every caller that passes it, carries a phantom field.
 *
 * Applies to a destructured parameter annotated with a type literal, which only that
 * function uses. A parameter typed by a named alias is left alone, since the alias is
 * shared and one function may take only part of it. A destructuring with a rest
 * element takes the remaining members, so it is skipped.
 */
import ts from 'typescript';
import { rel } from './programs.mjs';

const isFunctionLike = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node);

const nameOf = (member) => member.name && ts.isIdentifier(member.name) && member.name.text;

/** The names a destructuring binds, or undefined when a rest element takes the rest. */
function boundNamesOf(pattern) {
  if (pattern.elements.some((element) => element.dotDotDotToken)) return undefined;
  return new Set(pattern.elements.map((element) => (element.propertyName ?? element.name).text));
}

/** The members of a destructured parameter's type that its destructuring leaves unbound. */
function unboundMembersOf(parameter) {
  if (!ts.isObjectBindingPattern(parameter.name) || !parameter.type) return [];
  if (!ts.isTypeLiteralNode(parameter.type)) return [];
  const bound = boundNamesOf(parameter.name);
  if (!bound) return [];
  return parameter.type.members.map(nameOf).filter((name) => name && !bound.has(name));
}

function findingsIn(file) {
  const found = [];
  const visit = (node) => {
    if (isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        const unbound = unboundMembersOf(parameter);
        if (unbound.length === 0) continue;
        const { line } = file.getLineAndCharacterOfPosition(parameter.getStart(file));
        found.push({ path: rel(file.fileName), line: line + 1, unbound });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function run({ files }) {
  const findings = files.flatMap(findingsIn);
  if (findings.length === 0) {
    return {
      passed: true,
      report: '✅ param-fields: every destructured parameter binds all its declared members',
    };
  }
  const lines = findings.map(
    ({ path, line, unbound }) => `  ${path}:${line}  never bound: ${unbound.join(', ')}`,
  );
  const summary = `\n❌ param-fields: ${findings.length} parameter(s) declare members the function never reads. Remove the member from the type and from every caller, or bind it.`;
  return { passed: false, report: [...lines, summary].join('\n') };
}

export const paramFields = { name: 'param-fields', run };
