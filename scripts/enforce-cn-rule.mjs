import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// If files are passed as args, use them. Otherwise, scan frontend/src.
const args = process.argv.slice(2);
let filesToCheck = [];

if (args.length > 0) {
  // Resolve relative to where the script is executed
  filesToCheck = args
    .map((f) => path.resolve(process.cwd(), f))
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
} else {
  const srcDir = path.resolve(process.cwd(), 'frontend/src');
  function findTsxFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        findTsxFiles(fullPath, fileList);
      } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
        fileList.push(fullPath);
      }
    }
    return fileList;
  }
  filesToCheck = findTsxFiles(srcDir);
}

let hasErrors = false;

for (const file of filesToCheck) {
  if (!fs.existsSync(file)) continue; // skip deleted files in pre-commit

  const code = fs.readFileSync(file, 'utf-8');
  if (!code.includes('cn(')) continue;

  const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);

  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === 'cn') {
      const callArgs = node.arguments;

      const classNameIndex = callArgs.findIndex((arg) => {
        const text = arg.getText();
        return text === 'className' || text.endsWith('.className');
      });

      if (classNameIndex !== -1) {
        for (let i = 0; i < classNameIndex; i++) {
          const arg = callArgs[i];
          const isPropLogic =
            ts.isBinaryExpression(arg) ||
            ts.isConditionalExpression(arg) ||
            ts.isCallExpression(arg) ||
            ts.isObjectLiteralExpression(arg);

          if (isPropLogic) {
            hasErrors = true;
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const relativePath = path.relative(process.cwd(), file);
            console.error(
              `❌ [Prop Superiority Violation] ${relativePath}:${line + 1}:${character + 1}`,
            );
            console.error(
              `   In cn(), 'className' must appear BEFORE conditional or prop-driven logic.`,
            );
            console.error(
              `   Found a logical/conditional/call/object expression before 'className'.`,
            );
            console.error(`   Fix: Move 'className' earlier in the cn() arguments.\n`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

if (hasErrors) {
  process.exit(1);
} else {
  // Only print if we are scanning everything manually, to avoid noise in pre-commit
  if (args.length === 0) {
    console.log('✅ Prop Superiority check passed!');
  }
}
