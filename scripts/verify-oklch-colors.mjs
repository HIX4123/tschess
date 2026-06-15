import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const CHECK_TARGETS = [
  'dist',
  'src',
  'scripts',
  'index.html',
  'package.json',
  'README.md',
  'vite.config.ts',
  'eslint.config.js',
];
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'artifacts', 'assets']);
const IGNORED_EXTENSIONS = new Set(['.pdf', '.ttf', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const FORBIDDEN_PATTERNS = [
  { label: 'hex color', pattern: /#[0-9a-fA-F]{3,8}\b/gu },
  { label: 'rgb color', pattern: /\brgba?\(/gu },
  { label: 'hsl color', pattern: /\bhsla?\(/gu },
  { label: 'clear color keyword', pattern: new RegExp(String.raw`\btrans` + 'parent' + String.raw`\b`, 'gu') },
];

async function pathExists(targetPath) {
  try {
    await readdir(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOTDIR') {
      return true;
    }
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function collectFiles(targetPath) {
  const basename = path.basename(targetPath);
  if (IGNORED_DIRECTORIES.has(basename)) {
    return [];
  }

  const extension = path.extname(targetPath).toLowerCase();
  if (IGNORED_EXTENSIONS.has(extension)) {
    return [];
  }

  let entries;
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOTDIR') {
      throw error;
    }
    return [targetPath];
  }

  const nestedFiles = await Promise.all(
    entries.map((entry) => collectFiles(path.join(targetPath, entry.name))),
  );

  return nestedFiles.flat();
}

function lineAndColumnForIndex(content, index) {
  const lines = content.slice(0, index).split(/\r?\n/u);
  return {
    line: lines.length,
    column: lines.at(-1).length + 1,
  };
}

function findForbiddenColors(relativePath, content) {
  const findings = [];

  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const { line, column } = lineAndColumnForIndex(content, match.index ?? 0);
      findings.push({
        column,
        label,
        line,
        match: match[0],
        relativePath,
      });
    }
  }

  return findings;
}

async function main() {
  const existingTargets = [];
  for (const target of CHECK_TARGETS) {
    const targetPath = path.resolve(PROJECT_ROOT, target);
    if (await pathExists(targetPath)) {
      existingTargets.push(targetPath);
    }
  }

  const files = (await Promise.all(existingTargets.map(collectFiles))).flat();
  const findings = [];

  for (const filePath of files) {
    const content = await readFile(filePath, 'utf8');
    const relativePath = path.relative(PROJECT_ROOT, filePath);
    findings.push(...findForbiddenColors(relativePath, content));
  }

  if (findings.length > 0) {
    console.error('Forbidden non-OKLCH color expressions found:');
    for (const finding of findings) {
      console.error(
        `${finding.relativePath}:${finding.line}:${finding.column} ${finding.label} ${finding.match}`,
      );
    }
    process.exit(1);
  }

  console.log(`OKLCH color verification passed (${files.length} files checked).`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to verify OKLCH colors: ${message}`);
  process.exit(1);
});
