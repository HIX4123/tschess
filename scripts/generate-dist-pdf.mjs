import { createHash } from 'node:crypto';
import { accessSync, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import PDFDocument from 'pdfkit';
import prettier from 'prettier';
import { createHighlighter } from 'shiki';

const DIST_DIR = path.resolve(process.cwd(), 'dist');
const OUTPUT_FILE = path.resolve(process.cwd(), 'artifacts', 'build-report.pdf');
const FONT_REGULAR_PATH = path.resolve(
  process.cwd(),
  'assets',
  'fonts',
  'D2CodingLigature-Regular.ttf',
);
const FONT_BOLD_PATH = path.resolve(
  process.cwd(),
  'assets',
  'fonts',
  'D2CodingLigature-Bold.ttf',
);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const CODE_FONT_SIZE = 8;
const CODE_LINE_HEIGHT = 10.8;
const SHIKI_THEME = 'github-light';
const SHIKI_LANGS = ['javascript', 'typescript', 'css', 'scss', 'html', 'json', 'xml'];
const EXTENSION_TO_LANGUAGE = new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.ts', 'typescript'],
  ['.css', 'css'],
  ['.scss', 'scss'],
  ['.html', 'html'],
  ['.json', 'json'],
  ['.svg', 'xml'],
  ['.map', 'json'],
  ['.txt', null],
]);

const BRACKET_GRAY_BUCKETS = ['#000000', '#2f2f2f', '#595959', '#808080'];
const OPEN_BRACKET_TO_CLOSE = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);
const CLOSE_BRACKET_TO_OPEN = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
]);
const NUMBER_TOKEN_PATTERN = /^[-+]?((\d[\d_]*)(\.\d[\d_]*)?|0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+)$/u;

function createSymbols(unicodeCapable) {
  if (!unicodeCapable) {
    return {
      treeBranch: '|-- ',
      treeLast: '\\-- ',
      treePipe: '|   ',
      treeSpace: '    ',
      visibleSpace: '.',
      visibleTab: '->',
      indentBoundary: '|',
      continuation: '-> ',
    };
  }

  return {
    treeBranch: '├── ',
    treeLast: '└── ',
    treePipe: '│   ',
    treeSpace: '    ',
    visibleSpace: '·',
    visibleTab: '→',
    indentBoundary: '┆',
    continuation: '↪ ',
  };
}

function createStyles(fonts) {
  return {
    treeTitle: { color: '#000000', font: fonts.bold },
    tree: { color: '#111111', font: fonts.regular },
    sectionHeader: { color: '#111111', font: fonts.bold },
    separator: { color: '#4a4a4a', font: fonts.regular },
    lineNumber: { color: '#666666', font: fonts.regular },
    continuation: { color: '#4d4d4d', font: fonts.regular },
    whitespaceMarker: { color: '#b8b8b8', font: fonts.regular },
    indentBoundary: { color: '#8f8f8f', font: fonts.regular },
    codeDefault: { color: '#111111', font: fonts.regular },
    comment: { color: '#8a8a8a', font: fonts.italic },
    keyword: { color: '#0d0d0d', font: fonts.bold },
    string: { color: '#4a4a4a', font: fonts.regular },
    number: { color: '#2b2b2b', font: fonts.bold },
    functionName: { color: '#1d1d1d', font: fonts.bold },
    typeName: { color: '#323232', font: fonts.bold },
    tagName: { color: '#252525', font: fonts.bold },
    attribute: { color: '#575757', font: fonts.regular },
  };
}

function toChars(text, style) {
  const chars = [];
  for (const char of text) {
    chars.push({ char, style });
  }
  return chars;
}

function sameStyle(left, right) {
  return left.color === right.color && left.font === right.font;
}

class PdfLineRenderer {
  constructor(doc, baseFont) {
    this.doc = doc;
    this.currentY = doc.page.margins.top;
    this.leftX = doc.page.margins.left;
    this.rightX = doc.page.width - doc.page.margins.right;
    this.bottomY = doc.page.height - doc.page.margins.bottom;

    doc.font(baseFont).fontSize(CODE_FONT_SIZE);
    this.charWidth = doc.widthOfString('M');
    this.maxColumns = Math.max(24, Math.floor((this.rightX - this.leftX) / this.charWidth));
  }

  ensureLineSpace() {
    if (this.currentY + CODE_LINE_HEIGHT <= this.bottomY) {
      return;
    }

    this.doc.addPage();
    this.currentY = this.doc.page.margins.top;
    this.leftX = this.doc.page.margins.left;
    this.rightX = this.doc.page.width - this.doc.page.margins.right;
    this.bottomY = this.doc.page.height - this.doc.page.margins.bottom;
  }

  writeLine(chars) {
    this.ensureLineSpace();
    if (chars.length === 0) {
      this.currentY += CODE_LINE_HEIGHT;
      return;
    }

    let x = this.leftX;
    let index = 0;

    while (index < chars.length) {
      const startStyle = chars[index].style;
      let text = '';

      while (index < chars.length && sameStyle(chars[index].style, startStyle)) {
        text += chars[index].char;
        index += 1;
      }

      this.doc
        .font(startStyle.font)
        .fontSize(CODE_FONT_SIZE)
        .fillColor(startStyle.color)
        .text(text, x, this.currentY, { lineBreak: false });

      x += this.doc.widthOfString(text);
    }

    this.currentY += CODE_LINE_HEIGHT;
  }
}

async function listFilesRecursively(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursively(entryPath);
      }

      if (entry.isFile()) {
        return [entryPath];
      }

      return [];
    }),
  );

  return files.flat();
}

function readUtf8Strict(buffer) {
  return UTF8_DECODER.decode(buffer);
}

function detectSpaceIndentUnit(content) {
  const lines = content.split(/\r?\n/u);
  const indentCounts = [];

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    const match = line.match(/^( +)/u);
    if (!match) {
      continue;
    }

    indentCounts.push(match[1].length);
  }

  if (indentCounts.length === 0) {
    return 2;
  }

  const hasNonMultipleOfFour = indentCounts.some((count) => count % 4 !== 0);
  return hasNonMultipleOfFour ? 2 : 4;
}

function normalizeLeadingForHash(leading, spaceIndentUnit) {
  let indentLevel = 0;
  let spaces = 0;

  for (const char of leading) {
    if (char === '\t') {
      indentLevel += 1;
      continue;
    }
    if (char === ' ') {
      spaces += 1;
    }
  }

  indentLevel += Math.floor(spaces / spaceIndentUnit);
  const residualSpaces = spaces % spaceIndentUnit;

  return `${' '.repeat(indentLevel * 4)}${' '.repeat(residualSpaces)}`;
}

function normalizeIndentForHash(content) {
  const spaceIndentUnit = detectSpaceIndentUnit(content);
  return content.replace(/^[ \t]+/gmu, (leading) =>
    normalizeLeadingForHash(leading, spaceIndentUnit),
  );
}

function computeSha12(content) {
  const normalized = normalizeIndentForHash(content);
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return digest.slice(0, 12);
}

function resolveLanguage(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE.get(extension) ?? null;
}

function extractScopes(token) {
  const scopes = [];
  if (!Array.isArray(token.explanation)) {
    return scopes;
  }

  for (const fragment of token.explanation) {
    if (!Array.isArray(fragment.scopes)) {
      continue;
    }

    for (const scope of fragment.scopes) {
      if (typeof scope.scopeName === 'string') {
        scopes.push(scope.scopeName);
      }
    }
  }

  return scopes;
}

function hasScope(scopes, needle) {
  return scopes.some((scope) => scope.includes(needle));
}

function styleFromToken(token, styles) {
  const scopes = extractScopes(token);

  if (hasScope(scopes, 'comment')) {
    return styles.comment;
  }
  if (hasScope(scopes, 'keyword') || hasScope(scopes, 'storage') || hasScope(scopes, 'control')) {
    return styles.keyword;
  }
  if (hasScope(scopes, 'string')) {
    return styles.string;
  }
  if (
    hasScope(scopes, 'constant.numeric') ||
    hasScope(scopes, 'constant.language') ||
    NUMBER_TOKEN_PATTERN.test(token.content.trim())
  ) {
    return styles.number;
  }
  if (
    hasScope(scopes, 'entity.name.function') ||
    hasScope(scopes, 'support.function') ||
    hasScope(scopes, 'meta.function-call')
  ) {
    return styles.functionName;
  }
  if (
    hasScope(scopes, 'entity.name.type') ||
    hasScope(scopes, 'storage.type') ||
    hasScope(scopes, 'support.type')
  ) {
    return styles.typeName;
  }
  if (hasScope(scopes, 'entity.name.tag') || hasScope(scopes, 'punctuation.definition.tag')) {
    return styles.tagName;
  }
  if (hasScope(scopes, 'attribute-name')) {
    return styles.attribute;
  }

  return styles.codeDefault;
}

function buildLineCharsFromTokens(rawLine, tokens, styles) {
  const chars = [];
  for (const token of tokens) {
    const tokenStyle = styleFromToken(token, styles);
    for (const char of token.content) {
      chars.push({ char, style: tokenStyle });
    }
  }

  const joined = chars.map((item) => item.char).join('');
  if (joined !== rawLine) {
    return toChars(rawLine, styles.codeDefault);
  }

  return chars;
}

function visualizeWhitespace(chars, symbols, styles, spaceIndentUnit) {
  const visualizedChars = [];
  let inLeadingIndent = true;
  let leadingSpaceCount = 0;

  for (const item of chars) {
    if (item.char === ' ') {
      if (inLeadingIndent) {
        const isIndentBoundary = leadingSpaceCount % spaceIndentUnit === 0;
        visualizedChars.push({
          char: isIndentBoundary ? symbols.indentBoundary : symbols.visibleSpace,
          style: isIndentBoundary ? styles.indentBoundary : styles.whitespaceMarker,
        });
        leadingSpaceCount += 1;
        continue;
      }

      visualizedChars.push({ char: symbols.visibleSpace, style: styles.whitespaceMarker });
      continue;
    }

    if (item.char === '\t') {
      visualizedChars.push(...toChars(symbols.visibleTab, styles.whitespaceMarker));
      if (inLeadingIndent) {
        leadingSpaceCount = 0;
      }
      continue;
    }

    inLeadingIndent = false;
    visualizedChars.push(item);
  }

  return visualizedChars;
}

function applyBracketDepthEmphasis(chars, stack) {
  for (let index = 0; index < chars.length; index += 1) {
    const value = chars[index].char;
    if (OPEN_BRACKET_TO_CLOSE.has(value)) {
      const color = BRACKET_GRAY_BUCKETS[stack.length % BRACKET_GRAY_BUCKETS.length];
      chars[index] = {
        ...chars[index],
        style: { ...chars[index].style, color },
      };
      stack.push(value);
      continue;
    }

    if (!CLOSE_BRACKET_TO_OPEN.has(value)) {
      continue;
    }

    const expectedOpen = CLOSE_BRACKET_TO_OPEN.get(value);
    const lastOpen = stack[stack.length - 1];
    if (lastOpen !== expectedOpen) {
      continue;
    }

    const color =
      BRACKET_GRAY_BUCKETS[(stack.length - 1 + BRACKET_GRAY_BUCKETS.length) % BRACKET_GRAY_BUCKETS.length];
    chars[index] = {
      ...chars[index],
      style: { ...chars[index].style, color },
    };
    stack.pop();
  }
}

function buildWrappedLines(contentChars, maxColumns, firstPrefixChars, continuationPrefixChars) {
  const lines = [];
  const safeMaxColumns = Math.max(16, maxColumns);
  let offset = 0;
  let firstLine = true;

  if (contentChars.length === 0) {
    lines.push([...firstPrefixChars]);
    return lines;
  }

  while (offset < contentChars.length) {
    const prefixChars = firstLine ? firstPrefixChars : continuationPrefixChars;
    const capacity = Math.max(1, safeMaxColumns - prefixChars.length);
    const chunk = contentChars.slice(offset, offset + capacity);
    lines.push([...prefixChars, ...chunk]);
    offset += chunk.length;
    firstLine = false;
  }

  return lines;
}

async function tokenizeByLine(highlighter, file) {
  const language = resolveLanguage(file.relativePath);
  if (!language) {
    return null;
  }

  try {
    const result = highlighter.codeToTokens(file.content, {
      lang: language,
      theme: SHIKI_THEME,
      includeExplanation: true,
    });
    return result.tokens;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[highlight-fallback] ${file.relativePath}: ${message}`);
    return null;
  }
}

function createTreeRoot() {
  return {
    directories: new Map(),
    files: [],
  };
}

function insertTreePath(root, relativePath, size, sha12) {
  const segments = relativePath.split(path.sep);
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isFile = index === segments.length - 1;
    if (isFile) {
      current.files.push({ name: segment, size, sha12 });
      continue;
    }

    if (!current.directories.has(segment)) {
      current.directories.set(segment, createTreeRoot());
    }
    current = current.directories.get(segment);
  }
}

function renderTreeLinesFromNode(node, symbols, prefix = '') {
  const directoryEntries = [...node.directories.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const fileEntries = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  const entries = [
    ...directoryEntries.map(([name, value]) => ({ type: 'directory', name, value })),
    ...fileEntries.map((value) => ({ type: 'file', ...value })),
  ];

  const lines = [];
  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const connector = isLast ? symbols.treeLast : symbols.treeBranch;
    const childPrefix = prefix + (isLast ? symbols.treeSpace : symbols.treePipe);

    if (entry.type === 'directory') {
      lines.push(`${prefix}${connector}${entry.name}/`);
      lines.push(...renderTreeLinesFromNode(entry.value, symbols, childPrefix));
      continue;
    }

    lines.push(`${prefix}${connector}${entry.name} (${entry.size} B / ${entry.sha12})`);
  }

  return lines;
}

function buildTreeLines(textFiles, symbols) {
  const root = createTreeRoot();
  for (const file of textFiles) {
    insertTreePath(root, file.relativePath, file.size, file.sha12);
  }

  return [
    'File Tree',
    '해시 확인: certutil -hashfile <dist> SHA256',
    'dist/',
    ...renderTreeLinesFromNode(root, symbols),
  ];
}

function writePlainWrappedLine(renderer, text, lineStyle, styles, symbols) {
  const contentChars = toChars(text, lineStyle);
  const continuationPrefix = toChars(symbols.continuation, styles.continuation);
  const wrapped = buildWrappedLines(contentChars, renderer.maxColumns, [], continuationPrefix);
  for (const line of wrapped) {
    renderer.writeLine(line);
  }
}

function writeCodeLines(renderer, rawLines, tokenLines, styles, symbols) {
  const bracketStack = [];
  const gutterWidth = String(Math.max(1, rawLines.length)).length;
  const spaceIndentUnit = detectSpaceIndentUnit(rawLines.join('\n'));

  for (const [lineIndex, rawLine] of rawLines.entries()) {
    const lineNumber = String(lineIndex + 1).padStart(gutterWidth, ' ');
    const firstPrefix = toChars(`${lineNumber} | `, styles.lineNumber);
    const continuationPrefix = [
      ...toChars(`${' '.repeat(gutterWidth)} | `, styles.lineNumber),
      ...toChars(symbols.continuation, styles.continuation),
    ];
    const tokens = tokenLines?.[lineIndex] ?? [{ content: rawLine, explanation: [] }];
    const lineChars = visualizeWhitespace(
      buildLineCharsFromTokens(rawLine, tokens, styles),
      symbols,
      styles,
      spaceIndentUnit,
    );

    applyBracketDepthEmphasis(lineChars, bracketStack);

    const wrappedLines = buildWrappedLines(
      lineChars,
      renderer.maxColumns,
      firstPrefix,
      continuationPrefix,
    );
    for (const physicalLine of wrappedLines) {
      renderer.writeLine(physicalLine);
    }
  }
}

function setupFonts(doc) {
  const fonts = {
    regular: 'Courier',
    bold: 'Courier-Bold',
    italic: 'Courier-Oblique',
  };

  if (process.env.PDF_FORCE_ASCII === '1') {
    console.warn('[font] PDF_FORCE_ASCII=1 detected. Using ASCII fallback symbols.');
    return { fonts, unicodeCapable: false };
  }

  try {
    accessSync(FONT_REGULAR_PATH);
    accessSync(FONT_BOLD_PATH);
    doc.registerFont('D2Regular', FONT_REGULAR_PATH);
    doc.registerFont('D2Bold', FONT_BOLD_PATH);
    fonts.regular = 'D2Regular';
    fonts.bold = 'D2Bold';
    fonts.italic = 'D2Regular';
    return { fonts, unicodeCapable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[font-fallback] ${message}`);
    return { fonts, unicodeCapable: false };
  }
}

async function generatePdf(textFiles, highlighter) {
  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'portrait',
    margin: 36,
    autoFirstPage: true,
  });
  const outputStream = createWriteStream(OUTPUT_FILE);
  doc.pipe(outputStream);

  const { fonts, unicodeCapable } = setupFonts(doc);
  const styles = createStyles(fonts);
  const symbols = createSymbols(unicodeCapable);
  const renderer = new PdfLineRenderer(doc, fonts.regular);
  const treeLines = buildTreeLines(textFiles, symbols);

  for (const line of treeLines) {
    const style = line === 'File Tree' ? styles.treeTitle : styles.tree;
    writePlainWrappedLine(renderer, line, style, styles, symbols);
  }
  renderer.writeLine([]);
  writePlainWrappedLine(renderer, '-'.repeat(renderer.maxColumns), styles.separator, styles, symbols);

  for (const file of textFiles) {
    renderer.writeLine([]);
    writePlainWrappedLine(
      renderer,
      `==== ${file.relativePath} (${file.size} B / ${file.sha12}) ====`,
      styles.sectionHeader,
      styles,
      symbols,
    );

    const rawLines = file.content.split(/\r?\n/u);
    const tokenLines = await tokenizeByLine(highlighter, file);
    writeCodeLines(renderer, rawLines, tokenLines, styles, symbols);
  }

  await new Promise((resolve, reject) => {
    outputStream.on('finish', resolve);
    outputStream.on('error', reject);
    doc.on('error', reject);
    doc.end();
  });
}

async function main() {
  const filePaths = await listFilesRecursively(DIST_DIR);
  const sortedFilePaths = filePaths.sort((a, b) => a.localeCompare(b));
  const textFiles = [];

  for (const filePath of sortedFilePaths) {
    const relativePath = path.relative(DIST_DIR, filePath);
    const buffer = await readFile(filePath);

    try {
      const content = readUtf8Strict(buffer);
      let finalContent = content;

      try {
        const prettierConfig = (await prettier.resolveConfig(filePath)) ?? {};
        const formatted = await prettier.format(content, {
          ...prettierConfig,
          filepath: filePath,
        });
        if (formatted !== content) {
          await writeFile(filePath, formatted, 'utf8');
        }
        finalContent = formatted;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[format-skip] ${relativePath}: ${message}`);
      }

      textFiles.push({
        relativePath,
        size: Buffer.byteLength(finalContent, 'utf8'),
        content: finalContent,
        sha12: computeSha12(finalContent),
      });
    } catch {
      console.warn(`[skip] ${relativePath}: not valid UTF-8 text`);
    }
  }

  if (textFiles.length === 0) {
    throw new Error('No UTF-8 text files found under dist.');
  }

  const highlighter = await createHighlighter({
    themes: [SHIKI_THEME],
    langs: SHIKI_LANGS,
  });

  await generatePdf(textFiles, highlighter);
  console.log(
    `PDF report generated: ${path.relative(process.cwd(), OUTPUT_FILE)} (${textFiles.length} files)`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to generate PDF report: ${message}`);
  process.exit(1);
});
