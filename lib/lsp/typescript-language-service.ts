/**
 * In-process "LSP" for TypeScript/JavaScript using the TypeScript Compiler API.
 * Provides go-to-definition and find-references without a separate language server process.
 * Files are supplied in-memory (e.g. from workspace_files DB).
 */

import * as ts from "typescript";

const TS_JS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const MAX_FILES_FOR_PROGRAM = 200;

function isTsJs(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TS_JS_EXTENSIONS.has(ext);
}

/**
 * Convert 1-based line and 1-based character (Monaco/editor) to 0-based file offset.
 */
function lineCharacterToOffset(content: string, line1Based: number, character1Based: number): number {
  const lines = content.split("\n");
  const lineIndex = line1Based - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return 0;
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  const charIndex = Math.min(character1Based - 1, lines[lineIndex].length);
  return offset + charIndex;
}

/**
 * Convert 0-based file offset to 1-based line number (for API response).
 */
function offsetToLine1Based(content: string, offset: number): number {
  const before = content.slice(0, offset);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  return line;
}

/**
 * Convert 0-based file offset to 1-based line and column.
 */
function offsetToLineColumn1Based(
  content: string,
  offset: number
): { line: number; character: number } {
  const before = content.slice(0, offset);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  const lastNewline = before.lastIndexOf("\n");
  const character = lastNewline === -1 ? before.length + 1 : offset - lastNewline;
  return { line, character };
}

export type DefinitionResult = { filePath: string; line: number };
export type ReferenceResult = { filePath: string; line: number; context?: string };

/**
 * Create a TypeScript Language Service that reads all files from the given map.
 * rootFileNames should be a list of keys in files (e.g. all TS/JS paths).
 */
function createLanguageService(
  files: Map<string, string>,
  rootFileNames: string[]
): ts.LanguageService {
  const scriptVersions = new Map<string, number>();
  rootFileNames.forEach((name) => scriptVersions.set(name, 0));

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => rootFileNames,
    getScriptVersion: (fileName) => String(scriptVersions.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
      const content = files.get(fileName);
      if (content === undefined) return undefined;
      return ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => "",
    getCompilationSettings: (): ts.CompilerOptions => ({
      allowJs: true,
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: false,
    }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/**
 * Get the identifier/symbol name at the given position (for display).
 */
function getSymbolNameAtPosition(
  content: string,
  line1Based: number,
  character1Based: number
): string | null {
  const lines = content.split("\n");
  const lineIndex = line1Based - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  const line = lines[lineIndex];
  const colIndex = character1Based - 1;
  if (colIndex < 0 || colIndex > line.length) return null;
  const before = line.slice(0, colIndex).match(/\w+$/);
  const after = line.slice(colIndex).match(/^\w*/);
  const word = (before ? before[0] : "") + (after ? after[0] : "");
  return word.length > 0 ? word : null;
}

export interface LspDefinitionResult {
  symbol: string | null;
  definitions: DefinitionResult[];
  references: ReferenceResult[];
  currentFileOnly: boolean;
}

/**
 * Get LSP-style definition and references for a position in a TS/JS file.
 * files: path -> content for all TS/JS files in the workspace (or a subset).
 * currentPath: path of the file containing the cursor.
 * line and character: 1-based (Monaco convention).
 */
export function getDefinitionAndReferences(
  files: Map<string, string>,
  currentPath: string,
  line: number,
  character: number
): LspDefinitionResult | null {
  if (!isTsJs(currentPath)) return null;
  const content = files.get(currentPath);
  if (!content) return null;

  const rootFileNames = Array.from(files.keys()).filter(isTsJs).slice(0, MAX_FILES_FOR_PROGRAM);
  if (rootFileNames.length === 0) return null;

  const languageService = createLanguageService(files, rootFileNames);
  const position = lineCharacterToOffset(content, line, character);

  // getDefinitionAtPosition returns DefinitionInfo[] (fileName, textSpan, ...)
  const definitionInfos = languageService.getDefinitionAtPosition(currentPath, position);
  const refSpans = languageService.getReferencesAtPosition(currentPath, position);

  const symbol = getSymbolNameAtPosition(content, line, character);

  const definitions: DefinitionResult[] = [];
  const definitionKeys = new Set<string>();

  if (definitionInfos && definitionInfos.length > 0) {
    for (const def of definitionInfos) {
      const fileContent = files.get(def.fileName);
      if (fileContent === undefined) continue;
      const lineNum = offsetToLine1Based(fileContent, def.textSpan.start);
      const key = `${def.fileName}:${lineNum}`;
      if (!definitionKeys.has(key)) {
        definitionKeys.add(key);
        definitions.push({ filePath: def.fileName, line: lineNum });
      }
    }
  }

  const references: ReferenceResult[] = [];
  const refKeys = new Set<string>();

  if (refSpans && refSpans.length > 0) {
    for (const ref of refSpans) {
      const fileContent = files.get(ref.fileName);
      if (fileContent === undefined) continue;
      const lineNum = offsetToLine1Based(fileContent, ref.textSpan.start);
      const key = `${ref.fileName}:${lineNum}`;
      if (refKeys.has(key)) continue;
      refKeys.add(key);
      const lineStart = fileContent.lastIndexOf("\n", ref.textSpan.start) + 1;
      const lineEnd = fileContent.indexOf("\n", ref.textSpan.start);
      const end = lineEnd === -1 ? fileContent.length : lineEnd;
      const context = fileContent.slice(lineStart, end).trim().slice(0, 120);
      references.push({ filePath: ref.fileName, line: lineNum, context });
    }
  }

  // If we have definitions from LSP, don't mark as "current file only" (we have real results)
  const currentFileOnly = definitions.length === 0 && references.length === 0;

  return {
    symbol,
    definitions,
    references,
    currentFileOnly,
  };
}

export type RenameEdit = {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
};

/**
 * Get all edits to rename the symbol at the given position to newName.
 * Returns edits in Monaco-friendly 1-based line/column format.
 */
export function getRenameEdits(
  files: Map<string, string>,
  currentPath: string,
  line: number,
  character: number,
  newName: string
): RenameEdit[] | null {
  if (!isTsJs(currentPath)) return null;
  const content = files.get(currentPath);
  if (!content) return null;

  const rootFileNames = Array.from(files.keys()).filter(isTsJs).slice(0, MAX_FILES_FOR_PROGRAM);
  if (rootFileNames.length === 0) return null;

  const languageService = createLanguageService(files, rootFileNames);
  const position = lineCharacterToOffset(content, line, character);

  const locations = languageService.findRenameLocations(
    currentPath,
    position,
    false, // findInStrings
    false   // findInComments
  );
  if (!locations || locations.length === 0) return null;

  const edits: RenameEdit[] = [];
  for (const loc of locations) {
    const fileContent = files.get(loc.fileName);
    if (fileContent === undefined) continue;
    const start = offsetToLineColumn1Based(fileContent, loc.textSpan.start);
    const end = offsetToLineColumn1Based(fileContent, loc.textSpan.start + loc.textSpan.length);
    edits.push({
      filePath: loc.fileName,
      startLine: start.line,
      startColumn: start.character,
      endLine: end.line,
      endColumn: end.character,
      newText: newName,
    });
  }
  return edits;
}
