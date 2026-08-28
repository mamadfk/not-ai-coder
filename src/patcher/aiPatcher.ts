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

function sanitizeLinePrefix(line: string): string {
    return line.replace(/^\s*\d+\s*\|\s?/, '');
}

function parseComment(line: string): string | null {
    const trimmed = line.trim();
    let m: RegExpMatchArray | null;

    m = trimmed.match(/^---\s*(?:FILE:)?\s*([\s\S]*?)\s*---$/i);
    if (m) return 'FILE: ' + m[1].trim();

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

/**
 * جستجوی هوشمند و بدون خطای لنگر (Anchor Finder)
 * تنها در صورتی جابجا می‌شود که خط جدید شامل شناسه خاص (مثل function یا class) باشد.
 */
function findSafeAnchorLine(currentLines: string[], targetLine: number, patchLines: string[]): number {
    if (patchLines.length === 0) return targetLine;

    // انتخاب خطی که بیش از ۸ کاراکتر دارد و فقط آکولاد یا کامنت نیست
    const signatureLine = patchLines.find(l => {
        const t = l.trim();
        return t.length > 8 && !/^[\{\}\(\)\<\>\/\*\#\;\,\s]+$/.test(t);
    })?.trim();

    if (!signatureLine) return targetLine;

    const baseIndex = targetLine - 1;
    if (baseIndex >= 0 && baseIndex < currentLines.length) {
        if (currentLines[baseIndex].trim() === signatureLine) {
            return targetLine;
        }
    }

    // جستجوی محدود در شعاع ۳ خط برای جلوگیری از پرش‌های اشتباه
    const searchRadius = 4;
    for (let offset = 1; offset <= searchRadius; offset++) {
        const downIdx = baseIndex + offset;
        if (downIdx < currentLines.length && currentLines[downIdx].trim() === signatureLine) {
            return downIdx + 1;
        }
        const upIdx = baseIndex - offset;
        if (upIdx >= 0 && currentLines[upIdx].trim() === signatureLine) {
            return upIdx + 1;
        }
    }

    return targetLine;
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

// FILE: src/patcher/aiPatcher.ts

function applyLineOperations(currentLines: string[], ops: LineOperation[]): string[] {
    const result = [...currentLines];

    // مرتب‌سازی معکوس: اعمال تغییرات از پایین‌ترین خط به بالاترین خط
    ops.sort((a, b) => {
        if (b.startLine !== a.startLine) {
            return b.startLine - a.startLine;
        }
        // اگر در یک خط هم Insert و هم Replace بود، اول Insert اعمال شود
        if (a.type === 'insert_after' && b.type !== 'insert_after') return -1;
        if (b.type === 'insert_after' && a.type !== 'insert_after') return 1;
        return 0;
    });

    for (const op of ops) {
        if (op.type === 'delete') {
            const startIdx = Math.max(0, op.startLine - 1);
            const endIdx = Math.max(startIdx, op.endLine - 1);
            if (startIdx < result.length) {
                const deleteCount = Math.min(result.length - startIdx, endIdx - startIdx + 1);
                result.splice(startIdx, deleteCount);
            }
        } 
        else if (op.type === 'replace') {
            const adjustedStartLine = findSafeAnchorLine(result, op.startLine, op.lines);
            const lineDiff = adjustedStartLine - op.startLine;
            const adjustedEndLine = op.endLine + lineDiff;

            const startIdx = Math.max(0, adjustedStartLine - 1);
            const endIdx = Math.max(startIdx, adjustedEndLine - 1);

            if (startIdx < result.length) {
                const deleteCount = Math.min(result.length - startIdx, endIdx - startIdx + 1);
                // حذف دقیق بازه مشخص شده و جایگزینی کد جدید
                result.splice(startIdx, deleteCount, ...op.lines);
            } else {
                result.push(...op.lines);
            }
        } 
        else if (op.type === 'insert_after') {
            // برای INSERT_AFTER: تضمین ۱۰۰٪ عدم حذف حتی یک خط (deleteCount = 0)
            // خط 0 یعنی ابتدای فایل (ایندکس 0)
            // خط 321 یعنی بعد از خط 321 (ایندکس 321)
            const insertIdx = op.startLine === 0 ? 0 : Math.min(result.length, op.startLine);
            result.splice(insertIdx, 0, ...op.lines);
        } 
        else if (op.type === 'insert_before') {
            // برای INSERT_BEFORE: درج دقیقاً قبل از خط اعلام شده
            const insertIdx = Math.max(0, Math.min(result.length, op.startLine - 1));
            result.splice(insertIdx, 0, ...op.lines);
        }
    }

    return result;
}

function extractCodeBlocks(text: string): CodeBlockPatch[] {
    const blocks: CodeBlockPatch[] = [];

    // ۱. بررسی با مارک‌داون ```
    const blockRegex = /```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(text)) !== null) {
        const code = match[1];
        let filePath = '';
        let isNewFile = false;

        for (const line of code.split(/\r?\n/)) {
            const marker = markerOf(line);
            if (marker && marker.payload && (marker.type === 'file' || marker.payload.includes('.'))) {
                filePath = sanitizeFilePath(marker.payload);
                break;
            }
        }

        if (/NEW\s+FILE/i.test(code)) {
            isNewFile = true;
        }

        blocks.push({ filePath, content: code, isNewFile });
    }

    // ۲. بررسی متن خام پلی‌گراند (بدون ```)
    if (blocks.length === 0) {
        const lines = text.split(/\r?\n/);
        let currentPath = '';
        let currentIsNew = false;
        let currentLines: string[] = [];

        for (const line of lines) {
            const marker = markerOf(line);
            if (marker && marker.type === 'file' && marker.payload) {
                if (currentLines.length > 0) {
                    blocks.push({
                        filePath: currentPath,
                        content: currentLines.join('\n'),
                        isNewFile: currentIsNew
                    });
                    currentLines = [];
                }
                currentPath = sanitizeFilePath(marker.payload);
                currentIsNew = false;
                continue;
            }

            if (/NEW\s+FILE/i.test(line)) {
                currentIsNew = true;
            }

            currentLines.push(line);
        }

        if (currentLines.length > 0) {
            blocks.push({
                filePath: currentPath,
                content: currentLines.join('\n'),
                isNewFile: currentIsNew
            });
        }
    }

    return blocks;
}

export async function parseAndApplyAiResponse(
    aiResponse: string,
    workspaceRoot: string
): Promise<{ successCount: number; errors: string[] }> {
    const blocks = extractCodeBlocks(aiResponse);
    const errors: string[] = [];
    let successCount = 0;

    if (blocks.length === 0) {
        errors.push('هیچ دستور تغییر یا فایلی در متن ورودی یافت نشد!');
        return { successCount: 0, errors };
    }

    for (const block of blocks) {
        try {
            let targetPath = sanitizeFilePath(block.filePath);

            if (!targetPath) {
                if (vscode.window.activeTextEditor) {
                    targetPath = path.relative(workspaceRoot, vscode.window.activeTextEditor.document.fileName);
                } else {
                    errors.push('مسیر فایل مشخص نیست. لطفاً فایلی را در ادیتور باز کنید یا خط // FILE: path را قرار دهید.');
                    continue;
                }
            }

            const absolutePath = path.isAbsolute(targetPath)
                ? path.resolve(targetPath)
                : path.resolve(workspaceRoot, targetPath);

            if (!isInsideWorkspace(absolutePath, workspaceRoot)) {
                errors.push(`مسیر فایل خارج از پوشه پروژه است: ${targetPath}`);
                continue;
            }

            await applyPatchToFile(absolutePath, block.content, block.isNewFile);
            successCount++;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`خطا در اعمال پچ روی ${block.filePath || 'فایل'}: ${msg}`);
        }
    }

    return { successCount, errors };
}

function isInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
    const resolvedTarget = path.resolve(targetPath).toLowerCase();
    const resolvedRoot = path.resolve(workspaceRoot).toLowerCase();
    const rel = path.relative(resolvedRoot, resolvedTarget);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
    if (doc.getText() === content) return;

    // ۱. باز کردن فایل در تب ادیتور تا کاربر تغییرات را ببیند
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });

    const fullRange = doc.lineCount === 0
        ? new vscode.Range(0, 0, 0, 0)
        : new vscode.Range(0, 0, doc.lineAt(doc.lineCount - 1).range.end.line, doc.lineAt(doc.lineCount - 1).range.end.character);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, content);
    
    // ۲. اعمال ادیت در حافظه بدون ذخیره خودکار (تا خودتان بتوانید Review کرده و با Ctrl+S سیو کنید)
    await vscode.workspace.applyEdit(edit);
}