import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface FolderOption {
    relativePath: string;
    selected: boolean;
}

const DEFAULT_EXCLUDE_FOLDERS = [
    'node_modules', '.git', '.vscode', '.idea', '.vscode-test',
    'dist', 'build', 'out', '.next', '.nuxt', '.cache',
    'coverage', '__pycache__', '.pytest_cache', '.venv', 'venv',
    'env', '.env', '.terraform', 'target', 'bin', 'obj'
];

const DEFAULT_EXCLUDE_FILE_GLOBS = [
    '*.log', '*.min.js', '*.min.css', '*.map',
    '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yarn',
    '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.bmp', '*.webp',
    '*.pdf', '*.zip', '*.tar', '*.gz', '*.rar', '*.7z',
    '*.exe', '*.dll', '*.so', '*.dylib', '*.class', '*.jar', '*.wasm',
    '*.mp3', '*.mp4', '*.mov', '*.avi', '*.mkv'
];

const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.tiff',
    '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
    '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm',
    '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.ogg', '.flac',
    '.ttf', '.otf', '.woff', '.woff2', '.eot', '.db', '.sqlite', '.mdb'
]);

const MAX_FILE_SIZE = 500 * 1024; // 500 KB

interface ExportSettings {
    excludeFolders: Set<string>;
    excludeFilePatterns: string[];
}

function loadSettings(): ExportSettings {
    const cfg = vscode.workspace.getConfiguration('aiDiffAssistant');
    const userFolders = cfg.get<string[]>('excludeFolders', []);
    const userFiles = cfg.get<string[]>('excludeFiles', []);

    return {
        excludeFolders: new Set(
            userFolders.length > 0 ? userFolders : DEFAULT_EXCLUDE_FOLDERS
        ),
        excludeFilePatterns: userFiles.length > 0 ? userFiles : DEFAULT_EXCLUDE_FILE_GLOBS
    };
}

function globMatch(pattern: string, name: string): boolean {
    const regex = new RegExp(
        '^' +
        pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
        '$'
    );
    return regex.test(name);
}

function isFileExcluded(fileName: string, settings: ExportSettings): boolean {
    return settings.excludeFilePatterns.some(p => globMatch(p, fileName));
}

function isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
        return true;
    }
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(2048);
        const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
        fs.closeSync(fd);
        return buf.slice(0, bytesRead).includes(0);
    } catch {
        return false;
    }
}

export async function getRootFolderList(rootPath: string): Promise<string[]> {
    try {
        const items = fs.readdirSync(rootPath);
        const folders: string[] = [];
        for (const item of items) {
            const fullPath = path.join(rootPath, item);
            try {
                if (fs.statSync(fullPath).isDirectory()) {
                    folders.push(item);
                }
            } catch {
                // ignore
            }
        }
        return folders.sort();
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Context generators
// ---------------------------------------------------------------------------
export async function generateProjectContext(
    rootPath: string,
    includedFolders: string[] | null = null
): Promise<string> {
    const settings = loadSettings();
    const files = await getWorkspaceFiles(rootPath, includedFolders, settings);
    const treeStructure = buildTreeString(rootPath, files);
    
 // FILE: src/exporter/contextExporter.ts

    let context = `==================================================\n`;
    context += `   AI SYSTEM PROMPT & INSTRUCTIONS (دستورالعمل جامع و دقیق هوش مصنوعی)\n`;
    context += `==================================================\n\n`;
    context += `شما یک مهندس ارشد نرم‌افزار هستید. سورس‌کد کامل پروژه با شماره خط در ادامه آمده است.\n`;
    context += `تغییرات شما توسط یک سیستم پچ خودکار اعمال می‌شود، بنابراین رعایت دقیق شماره خطوط و فرمت ۱۰۰٪ الزامی است.\n\n`;

    context += `🚨 **قوانین حیاتی برای دستورات تغییر (بسیار مهم)**:\n\n`;

    context += `۱. **دستور // REPLACE: X-Y (جایگزینی یا ویرایش)**:\n`;
    context += `   - اگر می‌خواهید حتی یک خط موجود در فایل را تغییر دهید، حتماً از REPLACE استفاده کنید.\n`;
    context += `   - مثال: برای ویرایش خطوط 15 تا 20 بنویسید: \`// REPLACE: 15-20\`\n`;
    context += `   - مثال برای یک تک خط: \`// REPLACE: 321\` (خود خط 321 حذف و کد جدید جایگزین آن می‌شود).\n\n`;

    context += `۲. **دستور // INSERT_AFTER: X (درج بعد از یک خط - بدون حذف)**:\n`;
    context += `   - این دستور خط X را **دست‌نخورده نگه می‌دارد** و کدهای جدید را از خط X+1 اضافه می‌کند.\n`;
    context += `   - ⚠️ **هشدار حیاتی سینتکس**: اگر می‌خواهید کدی را **داخل** یک تابع، کلاس یا بلاک (قبل از بسته شدن \`}\` یا \`</div>\`) اضافه کنید، هرگز روی خط آکولاد پایانی INSERT_AFTER نزنید! چون کد به بیرون از تابع می‌افتد. در این حالت باید روی خط ماقبل‌آخر INSERT_AFTER بزنید یا کل بدنه را REPLACE کنید.\n`;
    context += `   - مثال: برای درج کد در ابتدای فایل بنویسید: \`// INSERT_AFTER: 0\`\n\n`;

    context += `۳. **دستور // DELETE: X-Y (حذف خطوط)**:\n`;
    context += `   - برای حذف خطوط بدون نوشتن کد جایگزین: \`// DELETE: 50-55\`\n\n`;

    context += `۴. **عدم تکرار شماره خط در کدها**:\n`;
    context += `   - در کدهای ارسالی خود اصلاً پیشوند شماره خط مثل \`321 | \` نگذارید و فقط کد خام را بنویسید.\n\n`;

    context += `📌 **فرمت استاندارد خروجی**:\n`;
    context += `هر فایل را در یک بلوک مجزا با مسیر دقیق ارسال کنید:\n`;
    context += `\`\`\`زبان\n`;
    context += `// FILE: مسیر_دقیق_فایل\n`;
    context += `// REPLACE: خط_شروع-خط_پایان\n`;
    context += `کد اصلاح شده...\n`;
    context += `\`\`\`\n\n`;

    context += `==================================================\n`;
    context += `   PROJECT STRUCTURE (ساختار پروژه)\n`;
    context += `==================================================\n\n`;
    context += treeStructure + `\n\n`;

    context += `==================================================\n`;
    context += `   PROJECT SOURCE FILES (محتوای فایل‌های پروژه با شماره خط)\n`;
    context += `==================================================\n\n`;

    appendFileContents(rootPath, files, ctx => { context += ctx; });

    return context;
}

export async function generateProjectStructureAndSource(
    rootPath: string,
    includedFolders: string[] | null = null
): Promise<string> {
    const settings = loadSettings();
    const files = await getWorkspaceFiles(rootPath, includedFolders, settings);
    const treeStructure = buildTreeString(rootPath, files);

    let context = `==================================================\n`;
    context += `   PROJECT STRUCTURE & SOURCE FILES (ساختار و سورس کد)\n`;
    context += `==================================================\n\n`;
    context += treeStructure + `\n\n`;

    context += `==================================================\n`;
    context += `   PROJECT SOURCE FILES (محتوای فایل‌ها همراه با شماره خط)\n`;
    context += `==================================================\n\n`;

    appendFileContents(rootPath, files, ctx => { context += ctx; });

    return context;
}

export async function generateProjectStructureOnly(
    rootPath: string,
    includedFolders: string[] | null = null
): Promise<string> {
    const settings = loadSettings();
    const files = await getWorkspaceFiles(rootPath, includedFolders, settings);
    const treeStructure = buildTreeString(rootPath, files);

    let context = `==================================================\n`;
    context += `   PROJECT STRUCTURE ONLY (فقط ساختار پروژه)\n`;
    context += `==================================================\n\n`;
    context += treeStructure + `\n\n`;

    return context;
}

function appendFileContents(
    rootPath: string,
    files: string[],
    append: (chunk: string) => void
): void {
    for (const file of files) {
        const relPath = path.relative(rootPath, file).replace(/\\/g, '/');
        try {
            const content = fs.readFileSync(file, 'utf-8');
            append(`--- FILE: ${relPath} ---\n`);
            const lines = content.split(/\r?\n/);
            lines.forEach((line, index) => {
                append(`${index + 1} | ${line}\n`);
            });
            append(`\n`);
        } catch {
            // skip
        }
    }
}

async function getWorkspaceFiles(
    dir: string,
    includedFolders: string[] | null,
    settings: ExportSettings,
    currentRelPath = ''
): Promise<string[]> {
    let results: string[] = [];
    let list: string[];
    try {
        list = fs.readdirSync(dir);
    } catch {
        return [];
    }

    for (const item of list) {
        const fullPath = path.join(dir, item);
        const relItemPath = currentRelPath ? `${currentRelPath}/${item}` : item;

        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (settings.excludeFolders.has(item)) {
                    continue;
                }
                if (currentRelPath === '' && includedFolders !== null && !includedFolders.includes(item)) {
                    continue;
                }
                const subFiles = await getWorkspaceFiles(fullPath, includedFolders, settings, relItemPath);
                results = results.concat(subFiles);
            } else {
                if (isFileExcluded(item, settings)) {
                    continue;
                }
                if (isBinaryFile(fullPath)) {
                    continue;
                }
                if (stat.size > MAX_FILE_SIZE) {
                    continue;
                }
                results.push(fullPath);
            }
        } catch {
            // ignore
        }
    }
    return results;
}

type TreeNode = { name: string; children: Map<string, TreeNode> };

function buildTreeString(rootPath: string, files: string[]): string {
    const root: TreeNode = { name: '.', children: new Map() };

    for (const file of files) {
        const rel = path.relative(rootPath, file).replace(/\\/g, '/');
        const segments = rel.split('/');
        let node = root;
        for (const seg of segments) {
            let child = node.children.get(seg);
            if (!child) {
                child = { name: seg, children: new Map() };
                node.children.set(seg, child);
            }
            node = child;
        }
    }

    const lines: string[] = ['.'];
    renderNode(root, '', lines);
    return lines.join('\n');
}

function renderNode(node: TreeNode, prefix: string, lines: string[]): void {
    const entries = [...node.children.values()].sort((a, b) =>
        a.name.localeCompare(b.name, 'en', { numeric: true })
    );

    entries.sort((a, b) => {
        const aIsDir = a.children.size > 0;
        const bIsDir = b.children.size > 0;
        if (aIsDir !== bIsDir) {
            return aIsDir ? -1 : 1;
        }
        return 0;
    });

    entries.forEach((child, index) => {
        const isLast = index === entries.length - 1;
        const branch = isLast ? '└── ' : '├── ';
        lines.push(`${prefix}${branch}${child.name}`);

        if (child.children.size > 0) {
            const nextPrefix = prefix + (isLast ? '    ' : '│   ');
            renderNode(child, nextPrefix, lines);
        }
    });
}