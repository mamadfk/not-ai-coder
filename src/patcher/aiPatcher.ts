import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CodeBlockPatch {
    filePath: string;
    content: string;
    isNewFile: boolean;
}

export type LineOpType = 'replace' | 'insert_after' | 'insert_before' | 'delete';

export interface LineOperation {
    type: LineOpType;
    startLine: number;
    endLine: number;
    lines: string[];
}

interface Marker {
    type: 'file' | 'newfile' | 'replace' | 'insert_after' | 'insert_before' | 'delete';
    startLine?: number;
    endLine?: number;
    payload?: string;
}

function sanitizeFilePath(rawPath: string): string {
    if (!rawPath) return '';
    return rawPath
        .replace(/^(?:NEW\s+FILE|NEW|FILE:)\s*/i, '')
        .replace(/[\/\*->#\s]+(?:INSERT_AFTER|INSERT|ADD_AFTER|INSERT_BEFORE|ADD_BEFORE|REPLACE|CHANGE|DELETE|REMOVE).*/i, '')
        .replace(/[\/\*->#\s]+$/, '')
        .replace(/^[\/\*->#\s]+/, '')
        .replace(/^['"`]|['"`]$/g, '')
        .trim();
}

function splitInlineMarkers(rawText: string): string {
    const rawLines = rawText.split(/\r?\n/);
    const result: string[] = [];

    const markerRegex = /(?:(?:\/\*|\/\/|<!--|#)?\s*(?:FILE|File|file)\s*:\s*[^\/\*\s]+\.[a-zA-Z0-9]+(?:\s*\*\/|\s*-->|\s*\/)?)|(?:(?:\/\*|\/\/|<!--|#)?\s*(?:REPLACE|CHANGE|INSERT_AFTER|INSERT|ADD_AFTER|INSERT_BEFORE|ADD_BEFORE|DELETE|REMOVE)\s*:\s*\d+(?:\s*-\s*\d+)?(?:\s*\*\/|\s*-->|\s*\/)?)/gi;

    for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line) {
            result.push('');
            continue;
        }

        let lastIndex = 0;
        let match: RegExpExecArray | null;
        let foundAnyMarker = false;

        markerRegex.lastIndex = 0;

        while ((match = markerRegex.exec(line)) !== null) {
            foundAnyMarker = true;
            const before = line.substring(lastIndex, match.index).trim();
            if (before) {
                result.push(before);
            }
            result.push(match[0].trim());
            lastIndex = markerRegex.lastIndex;
        }

        if (foundAnyMarker) {
            const after = line.substring(lastIndex).trim();
            if (after) {
                result.push(after);
            }
        } else {
            result.push(rawLine);
        }
    }

    return result.join('\n');
}

function parseComment(line: string): string | null {
    const trimmed = line.trim();
    let m: RegExpMatchArray | null;

    m = trimmed.match(/^<!--\s*([\s\S]*?)(?:-->)?\s*$/);
    if (m) return m[1].trim();

    m = trimmed.match(/^\/\*\s*([\s\S]*?)(?:\*\/|\/)?\s*$/);
    if (m) return m[1].trim();

    m = trimmed.match(/^(?:\/\/|\/|#)\s*(.*?)\s*$/);
    if (m) return m[1].trim();

    return null;
}

function detectMarker(inner: string): Marker | null {
    if (!inner) return null;
    let m: RegExpMatchArray | null;

    const extractFileInSameLine = (str: string): string | undefined => {
        const fileMatch = str.match(/(?:FILE|File|file)\s*:\s*([^\/\*\s]+\.[a-zA-Z0-9]+)/i);
        return fileMatch ? sanitizeFilePath(fileMatch[1]) : undefined;
    };

    if (/^NEW\s+FILE$/i.test(inner)) {
        return { type: 'newfile' };
    }

    m = inner.match(/(?:REPLACE|CHANGE)\s*:\s*(\d+)(?:\s*-\s*(\d+))?/i);
    if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : start;
        return { type: 'replace', startLine: start, endLine: end, payload: extractFileInSameLine(inner) };
    }

    m = inner.match(/(?:INSERT_AFTER|INSERT|ADD_AFTER)\s*:\s*(\d+)/i);
    if (m) {
        const lineNum = parseInt(m[1], 10);
        return { type: 'insert_after', startLine: lineNum, endLine: lineNum, payload: extractFileInSameLine(inner) };
    }

    m = inner.match(/(?:INSERT_BEFORE|ADD_BEFORE)\s*:\s*(\d+)/i);
    if (m) {
        const lineNum = parseInt(m[1], 10);
        return { type: 'insert_before', startLine: lineNum, endLine: lineNum, payload: extractFileInSameLine(inner) };
    }

    m = inner.match(/(?:DELETE|REMOVE)\s*:\s*(\d+)(?:\s*-\s*(\d+))?/i);
    if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : start;
        return { type: 'delete', startLine: start, endLine: end, payload: extractFileInSameLine(inner) };
    }

    m = inner.match(/(?:FILE|File|file)\s*:\s*(.+)/i);
    if (m) return { type: 'file', payload: sanitizeFilePath(m[1]) };

    return null;
}

function markerOf(line: string): Marker | null {
    const inner = parseComment(line);
    if (inner === null) return null;
    return detectMarker(inner);
}

function isMetadataMarker(line: string): boolean {
    const m = markerOf(line);
    return m !== null && m.type === 'file' && !m.startLine;
}

export async function parseAndApplyAiResponse(
    aiResponse: string,
    workspaceRoot: string
): Promise<{ successCount: number; errors: string[] }> {
    const normalizedResponse = splitInlineMarkers(aiResponse);
    const blocks = extractCodeBlocks(normalizedResponse);
    const errors: string[] = [];
    let successCount = 0;

    for (const block of blocks) {
        try {
            let targetPath = sanitizeFilePath(block.filePath);

            if (!targetPath) {
                if (vscode.window.activeTextEditor) {
                    targetPath = path.relative(workspaceRoot, vscode.window.activeTextEditor.document.fileName);
                } else {
                    errors.push('مسیر فایل مشخص نشده است. لطفاً مطمئن شوید مدل // FILE: path را ارائه داده است.');
                    continue;
                }
            }

            const absolutePath = path.isAbsolute(targetPath)
                ? path.resolve(targetPath)
                : path.resolve(workspaceRoot, targetPath);

            if (!isInsideWorkspace(absolutePath, workspaceRoot)) {
                errors.push(`مسیر فایل خارج از پروژه است و رد شد: ${targetPath}`);
                continue;
            }

            await applyPatchToFile(absolutePath, block.content, block.isNewFile);
            successCount++;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`خطا در اعمال پچ روی ${block.filePath || '(نامشخص)'}: ${msg}`);
        }
    }

    return { successCount, errors };
}

function isInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(workspaceRoot);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function extractCodeBlocks(text: string): CodeBlockPatch[] {
    const blocks: CodeBlockPatch[] = [];
    const blockRegex = /```([^\n]*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(text)) !== null) {
        const header = match[1].trim();
        const code = match[2];

        let filePath = '';
        let isNewFile = false;

        if (header.includes(':')) {
            const parts = header.split(':');
            if (parts.length >= 2 && (parts[1].includes('/') || parts[1].includes('.') || parts[1].includes('\\'))) {
                filePath = sanitizeFilePath(parts.slice(1).join(':'));
            }
        } else if (header.includes('/') || header.includes('.') || header.includes('\\')) {
            filePath = sanitizeFilePath(header);
        }

        if (!filePath) {
            for (const line of code.split(/\r?\n/)) {
                const marker = markerOf(line);
                if (marker && marker.payload) {
                    filePath = sanitizeFilePath(marker.payload);
                    break;
                }
            }
        }

        if (/NEW\s+FILE/i.test(code) || /NEW\s+FILE/i.test(header)) {
            isNewFile = true;
        }

        blocks.push({ filePath, content: code, isNewFile });
    }

    // Fallback if no ``` code fences used
    if (blocks.length === 0) {
        const lines = text.split(/\r?\n/);
        let currentPath = '';
        let currentIsNew = false;
        let currentLines: string[] = [];

        for (const line of lines) {
            const marker = markerOf(line);
            const foundPath = marker?.payload;

            if (foundPath) {
                const cleanPath = sanitizeFilePath(foundPath);
                if (cleanPath && cleanPath !== currentPath) {
                    if (currentPath && currentLines.length > 0) {
                        blocks.push({
                            filePath: currentPath,
                            content: currentLines.join('\n'),
                            isNewFile: currentIsNew
                        });
                    }
                    currentPath = cleanPath;
                    currentIsNew = /NEW\s+FILE/i.test(line);
                    currentLines = [];
                }
            }

            if (currentPath) {
                currentLines.push(line);
            }
        }

        if (currentPath && currentLines.length > 0) {
            blocks.push({
                filePath: currentPath,
                content: currentLines.join('\n'),
                isNewFile: currentIsNew
            });
        }
    }

    return blocks;
}

async function applyPatchToFile(filePath: string, patchContent: string, isNewFile: boolean): Promise<void> {
    const fileExists = fs.existsSync(filePath);
    const rawLines = patchContent.split(/\r?\n/);

    const lines = rawLines.filter(l => !isMetadataMarker(l));

    if (!fileExists || isNewFile) {
        const cleanContent = lines
            .filter(l => markerOf(l) === null)
            .map(sanitizeLinePrefix)
            .join('\n');
        await writeFullFile(filePath, cleanContent);
        return;
    }

    let currentContent = '';
    try {
        currentContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
        currentContent = '';
    }
    const currentLines = currentContent.split(/\r?\n/);

    const operations = parseLineOperations(lines);

    if (operations.length === 0) {
        // If no line operations, write full file content safely
        const cleanContent = lines
            .filter(l => markerOf(l) === null)
            .map(sanitizeLinePrefix)
            .join('\n');
        await writeFullFile(filePath, cleanContent);
        return;
    }

    const updatedLines = applyLineOperations(currentLines, operations);
    await writeFullFile(filePath, updatedLines.join('\n'));
}

function parseLineOperations(lines: string[]): LineOperation[] {
    const ops: LineOperation[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const marker = markerOf(line);

        if (marker && (marker.type === 'replace' || marker.type === 'insert_after' || marker.type === 'insert_before' || marker.type === 'delete')) {
            const startLine = marker.startLine ?? 1;
            const endLine = marker.endLine ?? startLine;
            const type: LineOpType = marker.type;

            i++;
            const codeLines: string[] = [];
            while (i < lines.length && markerOf(lines[i]) === null) {
                codeLines.push(sanitizeLinePrefix(lines[i]));
                i++;
            }

            ops.push({
                type,
                startLine,
                endLine,
                lines: codeLines
            });
            continue;
        }

        i++;
    }

    return ops;
}

function sanitizeLinePrefix(line: string): string {
    return line.replace(/^\s*\d+\s*\|\s?/, '');
}

function applyLineOperations(currentLines: string[], ops: LineOperation[]): string[] {
    const result = [...currentLines];

    ops.sort((a, b) => {
        if (b.startLine !== a.startLine) {
            return b.startLine - a.startLine;
        }
        if (a.type === 'insert_after' && b.type !== 'insert_after') return -1;
        if (b.type === 'insert_after' && a.type !== 'insert_after') return 1;
        return 0;
    });

    for (const op of ops) {
        const startIdx = Math.max(0, op.startLine - 1);
        const endIdx = Math.max(startIdx, op.endLine - 1);

        if (op.type === 'delete') {
            if (startIdx < result.length) {
                const deleteCount = Math.min(result.length - startIdx, endIdx - startIdx + 1);
                result.splice(startIdx, deleteCount);
            }
        } else if (op.type === 'replace') {
            if (startIdx < result.length) {
                const deleteCount = Math.min(result.length - startIdx, endIdx - startIdx + 1);
                result.splice(startIdx, deleteCount, ...op.lines);
            } else {
                result.push(...op.lines);
            }
        } else if (op.type === 'insert_after') {
            const insertIdx = Math.min(result.length, op.startLine);
            result.splice(insertIdx, 0, ...op.lines);
        } else if (op.type === 'insert_before') {
            const insertIdx = Math.min(result.length, startIdx);
            result.splice(insertIdx, 0, ...op.lines);
        }
    }

    return result;
}

async function writeFullFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const uri = vscode.Uri.file(filePath);
    const fileExists = fs.existsSync(filePath);

    if (!fileExists) {
        const createEdit = new vscode.WorkspaceEdit();
        createEdit.createFile(uri, { ignoreIfExists: true });
        await vscode.workspace.applyEdit(createEdit);
    }

    const doc = await vscode.workspace.openTextDocument(uri);

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