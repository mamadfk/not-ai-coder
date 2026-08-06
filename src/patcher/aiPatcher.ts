import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CodeBlockPatch {
    filePath: string;
    content: string;
    isNewFile: boolean;
}

// ---------------------------------------------------------------------------
// Comment-syntax-agnostic marker detection
//
// We support FOUR comment styles so the same markers work across languages:
//   • // ...              (JS, TS, Java, C#, …)
//   • # ...               (Python, Ruby, shell, …)
//   • /* ... */           (CSS, C-like block comments)
//   • <!-- ... -->        (HTML, XML, Markdown, Vue templates)
//
// Rather than copy each regex variant into every pattern, we first extract the
// inner text of a comment line and then classify it. This keeps things DRY and
// trivial to extend.
// ---------------------------------------------------------------------------
type MarkerType = 'file' | 'newfile' | 'change' | 'new' | 'remove';
interface Marker {
    type: MarkerType;
    /** Payload (e.g. file path for `file`, code for `remove`). */
    payload?: string;
}

/** Extract the inner text of a comment line, regardless of syntax. Returns null for non-comments. */
function parseComment(line: string): string | null {
    const trimmed = line.trim();
    let m: RegExpMatchArray | null;
    // HTML / XML / Markdown comment: <!-- ... --> (closing optional)
    m = trimmed.match(/^<!--\s*([\s\S]*?)(?:-->)?\s*$/);
    if (m) {
        return m[1].trim();
    }
    // Block comment: /* ... */ (closing optional)
    m = trimmed.match(/^\/\*\s*([\s\S]*?)(?:\*\/)?\s*$/);
    if (m) {
        return m[1].trim();
    }
    // Line comment: // ... or # ...
    m = trimmed.match(/^(?:\/\/|#)\s*(.*?)\s*$/);
    if (m) {
        return m[1].trim();
    }
    return null;
}

/** Classify the inner comment text into one of our markers (or null). */
function detectMarker(inner: string): Marker | null {
    if (!inner) {
        return null;
    }
    let m: RegExpMatchArray | null;
    // FILE: <path>
    m = inner.match(/^(?:FILE|File|file)\s*:\s*(.+)$/);
    if (m) {
        return { type: 'file', payload: m[1].trim() };
    }
    // NEW FILE
    if (/^NEW\s+FILE$/i.test(inner)) {
        return { type: 'newfile' };
    }
    // ADD_NEW (alias of `new`)
    if (/^ADD_NEW$/i.test(inner)) {
        return { type: 'new' };
    }
    // remove: <code>
    m = inner.match(/^remove\s*:\s*([\s\S]+)$/i);
    if (m) {
        return { type: 'remove', payload: m[1].trim() };
    }
    // change
    if (/^change\b/i.test(inner)) {
        return { type: 'change' };
    }
    // new
    if (/^new\b/i.test(inner)) {
        return { type: 'new' };
    }
    return null;
}

/** End-to-end: line -> marker (or null when the line isn't a managed marker). */
function markerOf(line: string): Marker | null {
    const inner = parseComment(line);
    if (inner === null) {
        return null;
    }
    return detectMarker(inner);
}

/** True if the line is any kind of metadata / diff marker we manage. */
function isAnyMarker(line: string): boolean {
    return markerOf(line) !== null;
}

/** True if the line is a FILE-header or NEW FILE marker (pure metadata to strip). */
function isMetadataMarker(line: string): boolean {
    const m = markerOf(line);
    return m !== null && (m.type === 'file' || m.type === 'newfile');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function parseAndApplyAiResponse(
    aiResponse: string,
    workspaceRoot: string
): Promise<{ successCount: number; errors: string[] }> {
    const blocks = extractCodeBlocks(aiResponse);
    const errors: string[] = [];
    let successCount = 0;

    if (blocks.length === 0) {
        // Fallback: raw response (no fences) with a `// FILE:` header inside it.
        // Scan line-by-line so any comment syntax (//, #, /*, <!--) is honoured.
        for (const line of aiResponse.split(/\r?\n/)) {
            const marker = markerOf(line);
            if (marker && marker.type === 'file' && marker.payload) {
                blocks.push({
                    filePath: marker.payload,
                    content: aiResponse,
                    isNewFile: /NEW\s+FILE/i.test(aiResponse)
                });
                break; // first FILE header wins
            }
        }
    }

    for (const block of blocks) {
        try {
            let targetPath = block.filePath;

            // No path in block header/code -> fall back to the active editor.
            if (!targetPath) {
                if (vscode.window.activeTextEditor) {
                    targetPath = path.relative(workspaceRoot, vscode.window.activeTextEditor.document.fileName);
                } else {
                    errors.push('نمیتوان مسیر فایل را از بلوک کد تشخیص داد و هیچ فایلی هم در ادیتور فعال نیست.');
                    continue;
                }
            }

            // Strip leading "NEW FILE" / "FILE:" noise from the path itself.
            targetPath = targetPath.replace(/^(?:NEW\s+FILE|NEW|FILE:)\s*/i, '').trim();

            // Resolve to an absolute path.
            const absolutePath = path.isAbsolute(targetPath)
                ? path.resolve(targetPath)
                : path.resolve(workspaceRoot, targetPath);

            // SECURITY: refuse to write outside of the workspace root.
            if (!isInsideWorkspace(absolutePath, workspaceRoot)) {
                errors.push(`مسیر فایل خارج از workspace است و به دلایل امنیتی رد شد: ${targetPath}`);
                continue;
            }

            await applyPatchToFile(absolutePath, block.content, block.isNewFile);
            successCount++;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`خطا در اعمال تغییرات روی فایل ${block.filePath || '(نامشخص)'}: ${msg}`);
        }
    }

    return { successCount, errors };
}

// ---------------------------------------------------------------------------
// Security helper
// ---------------------------------------------------------------------------
/**
 * Returns true only when `targetPath` resolves to `workspaceRoot` or somewhere
 * beneath it. Prevents path-traversal attacks (`../../etc/passwd`) and absolute
 * paths pointing outside the project.
 */
function isInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(workspaceRoot);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    // Empty string = the root itself. Anything starting with ".." or an
    // absolute path (e.g. "C:\..." on another drive) is outside.
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Block extraction
// ---------------------------------------------------------------------------
function extractCodeBlocks(text: string): CodeBlockPatch[] {
    const blocks: CodeBlockPatch[] = [];
    // ```lang:path/to/file or ```lang  ->  matches non-greedy to the next fence.
    const blockRegex = /```([^\n]*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(text)) !== null) {
        const header = match[1].trim();
        const code = match[2];

        let filePath = '';
        let isNewFile = false;

        // Header like: typescript:src/index.ts  OR  src/index.ts
        if (header.includes(':')) {
            const parts = header.split(':');
            if (parts.length >= 2 && (parts[1].includes('/') || parts[1].includes('.') || parts[1].includes('\\'))) {
                filePath = parts.slice(1).join(':').trim();
            }
        } else if (header.includes('/') || header.includes('.') || header.includes('\\')) {
            filePath = header.trim();
        }

        // Fallback: an inline `// FILE:` / `# FILE:` / `/* FILE: */` / `<!-- FILE: -->`
        // comment inside the code block (any supported comment syntax).
        if (!filePath) {
            for (const line of code.split(/\r?\n/)) {
                const marker = markerOf(line);
                if (marker && marker.type === 'file' && marker.payload) {
                    filePath = marker.payload;
                    break;
                }
            }
        }

        if (/NEW\s+FILE/i.test(code) || /NEW\s+FILE/i.test(header)) {
            isNewFile = true;
        }

        blocks.push({ filePath, content: code, isNewFile });
    }

    return blocks;
}

// ---------------------------------------------------------------------------
// Core patch application
// ---------------------------------------------------------------------------
async function applyPatchToFile(filePath: string, patchContent: string, isNewFile: boolean): Promise<void> {
    const fileExists = fs.existsSync(filePath);
    const rawLines = patchContent.split(/\r?\n/);

    // Phase 1 — always strip pure-metadata lines (FILE: headers, NEW FILE marks).
    const lines = rawLines.filter(l => !isMetadataMarker(l));

    // Case A — brand new file: just strip every marker and write the full content.
    if (!fileExists || isNewFile) {
        const content = lines.filter(l => !isAnyMarker(l)).join('\n');
        await writeFullFile(filePath, content);
        return;
    }

    // Existing file — read current content for diffing decisions.
    let currentContent = '';
    try {
        currentContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
        currentContent = '';
    }
    const currentLines = currentContent.split(/\r?\n/);

    // Any incremental edit marker (`change`, `new`, `remove`) explicitly implies partial mode.
    const hasIncrementalMarkers = lines.some(l => {
        const m = markerOf(l);
        return m !== null && (m.type === 'change' || m.type === 'new' || m.type === 'remove');
    });

    // Lines that are real code (markers stripped) — used for the complete/snippet test.
    const patchCodeLines = lines.filter(l => !isAnyMarker(l));

    if (!hasIncrementalMarkers && looksLikeCompleteFile(patchCodeLines, currentLines)) {
        // Case B — complete file replacement (default behaviour per the prompt when NO markers are present).
        await writeFullFile(filePath, patchCodeLines.join('\n'));
        return;
    }

    // Case C — partial / incremental patch. Build the new content in memory,
    // then persist via the same (undo-aware) writer.
    const merged = applyIncrementalEdits(currentLines, lines);
    await writeFullFile(filePath, merged.join('\n'));
}

/**
 * Heuristic to tell a full-file payload from a small snippet the AI sent in
 * isolation. We never want to overwrite a 400-line file with a 5-line method.
 */
function looksLikeCompleteFile(patchLines: string[], currentLines: string[]): boolean {
    const patchNonEmpty = patchLines.filter(l => l.trim() !== '');
    const currentNonEmpty = currentLines.filter(l => l.trim() !== '');

    if (patchNonEmpty.length === 0 || currentNonEmpty.length === 0) {
        return true; // nothing meaningful to compare — assume complete (safe overwrite of empty).
    }

    const ratio = patchNonEmpty.length / currentNonEmpty.length;
    const firstPatch = patchNonEmpty[0].trim();
    const firstCurrent = currentNonEmpty[0].trim();
    const lastPatch = patchNonEmpty[patchNonEmpty.length - 1].trim();
    const lastCurrent = currentNonEmpty[currentNonEmpty.length - 1].trim();

    // High coverage ratio -> likely the full file.
    if (ratio >= 0.7) {
        return true;
    }

    // Both first and last non-empty lines match AND decent ratio -> complete file replacement.
    if (firstPatch === firstCurrent && lastPatch === lastCurrent && ratio >= 0.4) {
        return true;
    }

    // Small ratio or partial snippet -> treat as a snippet.
    return false;
}

/**
 * Apply `// change` / `// new` / `// remove` blocks onto the existing file
 * content (in memory) and return the merged result.
 *
 * Strategy (deliberately simple & predictable, syntax-agnostic):
 *   • `remove: <code>`  → delete every existing line whose trimmed text
 *                          exactly matches the code given.
 *   • `change`          → the following block replaces the ENTIRE old scope
 *                          (whole function/class/element body) whose opening
 *                          line matches it — first by exact text, then by a
 *                          lightweight "signature" so value-only changes still
 *                          match. This avoids leaving stale lines behind. If
 *                          nothing matches, the block is appended.
 *                          Scope detection supports brace blocks, indent-based
 *                          blocks (Python) and HTML/XML tags.
 *   • `new` / ADD_NEW   → the following block is appended to the file.
 *
 * Markers work with any comment style (line `//`, hash `#`, block-star,
 * or HTML angle-bracket comments) thanks to the shared `markerOf` helper.
 */
function applyIncrementalEdits(currentLines: string[], patchLines: string[]): string[] {
    let result = [...currentLines];

    // 1) Removes first so later inserts/replacements see a clean slate.
    for (const line of patchLines) {
        const marker = markerOf(line);
        if (marker && marker.type === 'remove' && marker.payload) {
            const codeToRemove = marker.payload.replace(/^\[|\]$/g, '').trim();
            if (codeToRemove) {
                result = result.filter(l => l.trim() !== codeToRemove);
            }
        }
    }

    // 2) change / new blocks.
    let i = 0;
    while (i < patchLines.length) {
        const line = patchLines[i];
        const marker = markerOf(line);

        if (marker && marker.type === 'change') {
            const block = collectBlock(patchLines, ++i);
            i += block.length;
            if (block.length > 0) {
                const firstLine = block[0].trim();
                const normFirstLine = normalizeLine(firstLine);

                // 1) Prefer an exact match...
                let idx = result.findIndex(l => l.trim() === firstLine);
                // 2) Fall back to normalized whitespace match...
                if (idx < 0) {
                    idx = result.findIndex(l => normalizeLine(l) === normFirstLine);
                }
                // 3) Fall back to a signature match...
                if (idx < 0) {
                    const sig = lineSignature(firstLine);
                    if (sig) {
                        idx = result.findIndex(l => lineSignature(l.trim()) === sig);
                    }
                }
                if (idx >= 0) {
                    // Replace the WHOLE old scope (e.g. an entire function body or CSS rule),
                    // not just the single matched line — otherwise leftover lines
                    // from the old block would corrupt the file.
                    const openerIndent = getIndent(result[idx]);
                    const scopeEnd = findScopeEnd(result, idx, openerIndent);
                    result.splice(idx, scopeEnd - idx, ...block);
                } else {
                    result.push(...block); // fallback: append.
                }
            }
            continue;
        }

        if (marker && marker.type === 'new') {
            const block = collectBlock(patchLines, ++i);
            i += block.length;
            if (block.length > 0) {
                result.push(...block);
            }
            continue;
        }

        // A `// remove` line or any ordinary code line outside a block — skip.
        i++;
    }

    return result;
}

/**
 * Extracts a coarse "signature" from a code line so that two lines differing
 * only in their assigned value still compare equal. Handles the common cases:
 *   - `const/let/var NAME = ...`        → `const name`
 *   - `function NAME(...) {`            → `function name`
 *   - `def NAME(...):`  / `class NAME:` → `def name` / `class name`
 * Returns the original (lower-cased) text when no pattern matches, so callers
 * can still detect mismatches.
 */
function lineSignature(line: string): string {
    const trimmed = line.trim();
    // const/let/var foo = ...
    let m = trimmed.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m) {
        return `var ${m[1].toLowerCase()}`;
    }
    // function foo(...) {
    m = trimmed.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (m) {
        return `func ${m[1].toLowerCase()}`;
    }
    // def foo(...) / class Foo
    m = trimmed.match(/^(?:def|class)\s+([A-Za-z_][\w]*)\b/);
    if (m) {
        return `def ${m[1].toLowerCase()}`;
    }
    // export const foo = ... / export function foo(...)
    m = trimmed.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m) {
        return `var ${m[1].toLowerCase()}`;
    }
    m = trimmed.match(/^export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/);
    return trimmed.toLowerCase();
}

/** Normalizes whitespace and symbols in a line to compare code signatures reliably. */
function normalizeLine(line: string): string {
    return line.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*([{}():;,])\s*/g, '$1');
}

/** Leading-whitespace length of a line (0 for empty/blank lines). */
function getIndent(line: string): number {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
}

/**
 * Find the END index (exclusive) of the scope that opens at `startIdx`, so a
 * `change` marker can delete the whole old block — not just its first line —
 * before inserting the replacement. Supports three families of syntax:
 *
 *   1. Brace-balanced blocks `{ ... }` (JS/TS/C#/Java/Rust/Go/CSS rules…).
 *   2. Indent-based blocks where the opener ends with `:` (Python `def`/`class`,
 *      YAML, Makefiles). The scope is every subsequent more-indented non-blank
 *      line; trailing blank lines are left untouched.
 *   3. HTML/XML/JSX tags `<tag …>` … `</tag>` via balanced tag counting.
 *
 * Falls back to a single line when nothing else matches.
 */
function findScopeEnd(lines: string[], startIdx: number, openerIndent: number): number {
    const opener = lines[startIdx].trim();

    // 1) Brace-balanced block.
    if (opener.includes('{')) {
        let depth = 0;
        let sawOpen = false;
        for (let i = startIdx; i < lines.length; i++) {
            for (const ch of lines[i]) {
                if (ch === '{') {
                    depth++;
                    sawOpen = true;
                } else if (ch === '}') {
                    depth--;
                }
            }
            if (sawOpen && depth <= 0) {
                return i + 1;
            }
        }
        return lines.length;
    }

    // 2) Indent-based block (opener ends with ':').
    if (opener.endsWith(':')) {
        let lastInside = startIdx;
        for (let i = startIdx + 1; i < lines.length; i++) {
            if (lines[i].trim() === '') {
                continue; // blanks don't end the scope, but aren't "inside" it.
            }
            if (getIndent(lines[i]) <= openerIndent) {
                break; // dedented back to/under the opener → scope is over.
            }
            lastInside = i;
        }
        return lastInside + 1;
    }

    // 3) HTML/XML/JSX tag block.
    const tagMatch = opener.match(/^<([a-zA-Z][\w-]*)\b/);
    if (tagMatch) {
        const tagName = tagMatch[1];
        if (opener.endsWith('/>')) {
            return startIdx + 1; // self-closing tag.
        }
        const openRe = new RegExp('<' + tagName + '\\b', 'g');
        const closeRe = new RegExp('</' + tagName + '\\s*>', 'g');
        const selfRe = new RegExp('<' + tagName + '[^>]*/>', 'g');
        let depth = 0;
        for (let i = startIdx; i < lines.length; i++) {
            const o = (lines[i].match(openRe) || []).length;
            const c = (lines[i].match(closeRe) || []).length;
            const s = (lines[i].match(selfRe) || []).length;
            depth += o - s - c;
            if (depth <= 0) {
                return i + 1;
            }
        }
        return lines.length;
    }

    // 4) Fallback: a single line.
    return startIdx + 1;
}

/** Collect consecutive non-marker lines starting at `start`. */
function collectBlock(lines: string[], start: number): string[] {
    const block: string[] = [];
    let i = start;
    while (i < lines.length && !isAnyMarker(lines[i])) {
        block.push(lines[i]);
        i++;
    }
    return block;
}

// ---------------------------------------------------------------------------
// Undo-aware writer (uses WorkspaceEdit so changes survive Ctrl+Z & refresh
// open editors). mkdir is still required because WorkspaceEdit won't create
// parent directories.
// ---------------------------------------------------------------------------
async function writeFullFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const uri = vscode.Uri.file(filePath);
    const fileExists = fs.existsSync(filePath);

    // Brand-new file: create it (undo-able) before we can edit its range.
    if (!fileExists) {
        const createEdit = new vscode.WorkspaceEdit();
        createEdit.createFile(uri, { ignoreIfExists: true });
        await vscode.workspace.applyEdit(createEdit);
    }

    const doc = await vscode.workspace.openTextDocument(uri);

    // No-op when the content already matches.
    if (doc.getText() === content) {
        return;
    }

    const fullRange =
        doc.lineCount === 0
            ? new vscode.Range(0, 0, 0, 0)
            : new vscode.Range(
                  0,
                  0,
                  doc.lineAt(doc.lineCount - 1).range.end.line,
                  doc.lineAt(doc.lineCount - 1).range.end.character
              );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, content);
    await vscode.workspace.applyEdit(edit);
}
