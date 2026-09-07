import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface CodeBlockPatch {
    filePath: string;
    content: string;
    isNewFile: boolean;
    /** در صورت وجود، پچ به‌صورت SEARCH/REPLACE اعمال می‌شود (فرمت اصلی). */
    searchReplaceEdits?: SearchReplaceEdit[];
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

// ---------------------------------------------------------------------------
// SEARCH/REPLACE (فرمت اصلی پچ — مشابه Aider)
// ---------------------------------------------------------------------------

export interface SearchReplaceEdit {
    /** کد قدیمی که باید در فایل پیدا شود (خالی = افزودن به انتهای فایل) */
    search: string;
    /** کد جدید جایگزین */
    replace: string;
}

/**
 * پیش‌وند شماره خط (مثل «12 | ») تنها زمانی حذف می‌شود که «همه» خطوط غیرخالی
 * آن را داشته باشند — تا کد واقعی که اتفاقاً با عدد و خط شروع می‌شود خراب نشود.
 */
function stripLineNumberPrefixesIfPresent(lines: string[]): string[] {
    const nonEmpty = lines.filter(l => l.trim() !== '');
    if (nonEmpty.length > 0 && nonEmpty.every(l => /^\s*\d+\s*\|/.test(l))) {
        return lines.map(l => l.replace(/^\s*\d+\s*\|\s?/, ''));
    }
    return lines;
}

function searchReplaceRegex(): RegExp {
    return /<{5,}[ \t]*SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*={5,}[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*>{5,}[ \t]*REPLACE/g;
}

/** استخراج تمام بلاک‌های SEARCH/REPLACE از یک متن و حذف آن‌ها از متن باقی‌مانده. */
function parseSearchReplace(text: string): { edits: SearchReplaceEdit[]; rest: string } {
    const edits: SearchReplaceEdit[] = [];
    const rest = text.replace(searchReplaceRegex(), (_m, search: string, replace: string) => {
        edits.push({
            search: stripLineNumberPrefixesIfPresent(search.split(/\r?\n/)).join('\n'),
            replace: stripLineNumberPrefixesIfPresent(replace.split(/\r?\n/)).join('\n')
        });
        return '';
    });
    return { edits, rest };
}

function leadingWhitespace(line: string): string {
    const m = line.match(/^[ \t]*/);
    return m ? m[0] : '';
}

/** اختلاف تورفتگی خط اولِ تطبیق‌یافته را به تمام خطوط کد جدید اعمال می‌کند. */
function shiftIndent(lines: string[], delta: number): string[] {
    if (delta === 0) return lines;
    return lines.map(l => {
        if (l.trim() === '') return l;
        if (delta > 0) return ' '.repeat(delta) + l;
        const strip = Math.min(-delta, leadingWhitespace(l).length);
        return l.slice(strip);
    });
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
            // تمام عملیات‌ها با شماره خط «فایل اصلی» کار می‌کنند؛ اعمال معکوس
            // (از پایین به بالا) تضمین می‌کند شماره خطوط عملیات‌های قبلی معتبر بماند.
            const startIdx = Math.max(0, op.startLine - 1);
            const endIdx = Math.max(startIdx, op.endLine - 1);

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
        const { edits } = parseSearchReplace(code);
        const filePath = detectFilePathInBlock(code);
        const isNewFile = /NEW\s+FILE/i.test(code);

        if (edits.length > 0) {
            blocks.push({ filePath, content: '', isNewFile, searchReplaceEdits: edits });
        } else {
            // حذف خطوط خالی انتهایی (artifact نیولاین پایانی بلوک مارک‌داون)
            const contentLines = code.split(/\r?\n/);
            while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === '') {
                contentLines.pop();
            }
            blocks.push({ filePath, content: contentLines.join('\n'), isNewFile });
        }
    }

    // ۲. بررسی متن خام پلی‌گراند (بدون ```)
    if (blocks.length === 0) {
        const lines = text.split(/\r?\n/);
        let currentPath = '';
        let currentIsNew = false;
        let currentLines: string[] = [];
        let pendingEdits: SearchReplaceEdit[] = [];
        // حالت جمع‌آوری محتوای SEARCH/REPLACE در متن خام
        let srMode: 'none' | 'search' | 'replace' = 'none';
        let searchBuf: string[] = [];
        let replaceBuf: string[] = [];

        const flushBlock = (): void => {
            if (currentLines.length > 0 || pendingEdits.length > 0) {
                blocks.push({
                    filePath: currentPath,
                    content: currentLines.join('\n'),
                    isNewFile: currentIsNew,
                    searchReplaceEdits: pendingEdits.length > 0 ? pendingEdits : undefined
                });
            }
            currentLines = [];
            pendingEdits = [];
            currentIsNew = false;
        };

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');

            if (srMode === 'none' && /^<{5,}[ \t]*SEARCH[ \t]*$/.test(line)) {
                srMode = 'search';
                searchBuf = [];
                continue;
            }
            if (srMode === 'search' && /^={5,}[ \t]*$/.test(line)) {
                srMode = 'replace';
                replaceBuf = [];
                continue;
            }
            if (srMode === 'replace' && /^>{5,}[ \t]*REPLACE[ \t]*$/.test(line)) {
                pendingEdits.push({
                    search: stripLineNumberPrefixesIfPresent(searchBuf).join('\n'),
                    replace: stripLineNumberPrefixesIfPresent(replaceBuf).join('\n')
                });
                srMode = 'none';
                continue;
            }
            if (srMode === 'search') {
                searchBuf.push(line);
                continue;
            }
            if (srMode === 'replace') {
                replaceBuf.push(line);
                continue;
            }

            const marker = markerOf(line);
            if (marker && marker.type === 'file' && marker.payload) {
                flushBlock();
                currentPath = sanitizeFilePath(marker.payload);
                continue;
            }

            if (/NEW\s+FILE/i.test(line)) {
                currentIsNew = true;
                continue;
            }

            // خطوط قبل از اولین مارکر FILE توضیحات مدل هستند و بخشی از هیچ
            // فایلی نمی‌شوند (رفع باگ ورود متن اضافی به بلوک اول).
            if (!currentPath) continue;

            currentLines.push(line);
        }

        flushBlock();
    }

    return blocks;
}

function detectFilePathInBlock(code: string): string {
    for (const line of code.split(/\r?\n/)) {
        const marker = markerOf(line);
        if (marker && marker.payload && (marker.type === 'file' || marker.payload.includes('.'))) {
            return sanitizeFilePath(marker.payload);
        }
    }
    return '';
}

// ---------------------------------------------------------------------------
// اجرای ویرایش‌های SEARCH/REPLACE روی محتوای فایل
// ---------------------------------------------------------------------------

interface SearchReplaceResult {
    appliedCount: number;
    errors: string[];
    content: string;
}

function applySearchReplaceToContent(originalContent: string, edits: SearchReplaceEdit[]): SearchReplaceResult {
    let content = originalContent;
    let appliedCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];

        // SEARCH خالی = افزودن به انتهای فایل
        if (edit.search.trim() === '') {
            content = content.replace(/\s*$/, '') + '\n' + edit.replace.replace(/^\n+/, '');
            appliedCount++;
            continue;
        }

        const searchLines = edit.search.split(/\r?\n/);
        while (searchLines.length > 0 && searchLines[searchLines.length - 1].trim() === '') {
            searchLines.pop();
        }

        if (searchLines.length === 0) {
            content = content.replace(/\s*$/, '') + '\n' + edit.replace.replace(/^\n+/, '');
            appliedCount++;
            continue;
        }

        const replaceLines = edit.replace.split(/\r?\n/);
        const contentLines = content.split(/\r?\n/);

        // گام ۱: تطبیق دقیق (خط به خط)
        let exactStart = -1;
        let exactCount = 0;
        for (let s = 0; s <= contentLines.length - searchLines.length; s++) {
            let ok = true;
            for (let j = 0; j < searchLines.length; j++) {
                if (contentLines[s + j] !== searchLines[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                exactCount++;
                if (exactCount === 1) exactStart = s;
                if (exactCount > 1) break;
            }
        }

        if (exactCount > 1) {
            errors.push(`بلاک SEARCH شماره ${i + 1} چندین تطبیق دارد؛ لطفاً خطوط زمینه بیشتری به SEARCH اضافه کنید تا یکتا شود.`);
            continue;
        }

        let matchStart = -1;
        let fuzzy = false;
        if (exactCount === 1) {
            matchStart = exactStart;
        } else {
            // گام ۲: تطبیق فازی — بی‌توجه به فاصله‌ها و تورفتگی (whitespace-insensitive)
            let fuzzyCount = 0;
            for (let s = 0; s <= contentLines.length - searchLines.length; s++) {
                let ok = true;
                for (let j = 0; j < searchLines.length; j++) {
                    if (contentLines[s + j].trim() !== searchLines[j].trim()) {
                        ok = false;
                        break;
                    }
                }
                if (ok) {
                    fuzzyCount++;
                    if (fuzzyCount === 1) matchStart = s;
                    if (fuzzyCount > 1) break;
                }
            }
            if (fuzzyCount > 1) {
                errors.push(`بلاک SEARCH شماره ${i + 1} چندین تطبیق تقریبی دارد؛ لطفاً SEARCH را یکتا کنید.`);
                continue;
            }
            if (fuzzyCount === 1) fuzzy = true;
        }

        if (matchStart < 0) {
            errors.push(`بلاک SEARCH شماره ${i + 1} در فایل پیدا نشد (احتمالاً کد قبلاً تغییر کرده). اولین خط SEARCH: «${searchLines[0].trim().slice(0, 80)}»`);
            continue;
        }

        let newLines = replaceLines;
        if (fuzzy) {
            // حفظ تورفتگی واقعی فایل: اختلاف تورفتگی خط اول جبران می‌شود
            const delta = (searchLines[0].trim() !== '' && contentLines[matchStart].trim() !== '')
                ? leadingWhitespace(contentLines[matchStart]).length - leadingWhitespace(searchLines[0]).length
                : 0;
            newLines = shiftIndent(replaceLines, delta);
        }

        contentLines.splice(matchStart, searchLines.length, ...newLines);
        content = contentLines.join('\n');
        appliedCount++;
    }

    return { appliedCount, errors, content };
}

async function applySearchReplacePatch(
    filePath: string,
    edits: SearchReplaceEdit[],
    isNewFile: boolean
): Promise<{ applied: boolean; errors: string[] }> {
    const errors: string[] = [];
    const fileExists = fs.existsSync(filePath);

    if (isNewFile) {
        // برای فایل جدید، فقط بخش‌های REPLACE به‌عنوان محتوای کامل فایل نوشته می‌شوند
        const fullContent = edits.map(e => e.replace).join('\n');
        await writeFullFile(filePath, fullContent);
        return { applied: true, errors };
    }

    if (!fileExists) {
        errors.push('فایل در پروژه وجود ندارد. برای ایجاد فایل جدید از مارکر NEW FILE استفاده کنید.');
        return { applied: false, errors };
    }

    let content = '';
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch {
        content = '';
    }

    const result = applySearchReplaceToContent(content, edits);
    errors.push(...result.errors);

    if (result.appliedCount > 0) {
        await writeFullFile(filePath, result.content);
        return { applied: true, errors };
    }
    return { applied: false, errors };
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
                    targetPath = path.relative(workspaceRoot, vscode.window.activeTextEditor.document.fileName).replace(/\\/g, '/');
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

            if (block.searchReplaceEdits && block.searchReplaceEdits.length > 0) {
                const srResult = await applySearchReplacePatch(absolutePath, block.searchReplaceEdits, block.isNewFile);
                if (srResult.errors.length > 0) {
                    errors.push(...srResult.errors.map(e => `${targetPath}: ${e}`));
                }
                if (srResult.applied) successCount++;
            } else {
                await applyPatchToFile(absolutePath, block.content, block.isNewFile);
                successCount++;
            }
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