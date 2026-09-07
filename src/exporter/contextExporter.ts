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
    'env', '.env', '.terraform', 'target', 'bin', 'obj', '.dart_tool'
];

const DEFAULT_EXCLUDE_FILE_GLOBS = [
    '*.log', '*.min.js', '*.min.css', '*.map',
    '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yarn', 'pubspec.lock',
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
    
    let context = `==================================================\n`;
    context += `   AI SYSTEM PROMPT & INSTRUCTIONS (دستورالعمل جامع و دقیق هوش مصنوعی)\n`;
    context += `==================================================\n\n`;
    context += `شما یک مهندس ارشد نرم‌افزار هستید. سورس‌کد کامل پروژه با شماره خط در ادامه آمده است.\n`;
    context += `تغییرات شما توسط یک سیستم پچ خودکار اعمال می‌شود، بنابراین رعایت دقیق فرمت ۱۰۰٪ الزامی است.\n\n`;

    context += `🚨 **فرمت اصلی تغییرات — SEARCH/REPLACE (بسیار مهم)**:\n\n`;
    context += `هر تغییر را به این شکل ارسال کنید (کد قدیمی عیناً از فایل، کد جدید جایگزین):\n\n`;
    context += `\`\`\`زبان\n`;
    context += `// FILE: مسیر_دقیق_فایل\n`;
    context += `<<<<<<< SEARCH\n`;
    context += `کد قدیمی — دقیقاً همان‌طور که در فایل است (بدون پیشوند شماره خط)\n`;
    context += `=======\n`;
    context += `کد جدید\n`;
    context += `>>>>>>> REPLACE\n`;
    context += `\`\`\`\n\n`;
    context += `**قوانین حیاتی**:\n\n`;
    context += `۱. بخش SEARCH باید **کپی دقیق و حرف‌به‌حرف** کد موجود در فایل باشد — هرگز پیشوند شماره خط (مثل \`12 | \`) در آن ننویسید.\n`;
    context += `۲. برای چند تغییر در یک فایل، چند بلاک SEARCH/REPLACE پشت سر هم بعد از یک خط \`// FILE:\` بنویسید.\n`;
    context += `۳. حداقل ۱ تا ۳ خط زمینه به SEARCH اضافه کنید تا متن جستجو در کل فایل **یکتا** باشد (از انتخاب خطوط عمومی و تکراری مثل \`}\` یا \`)\` به‌تنهایی خودداری کنید).\n`;
    context += `۴. برای ایجاد فایل جدید: خط \`// FILE: مسیر\` و سپس خط \`// NEW FILE\` و بعد کل محتوای فایل بدون SEARCH/REPLACE.\n\n`;

    context += `⚙️ **فرمت جایگزین مبتنی بر شماره خط (فقط در صورت درخواست صریح کاربر)**:\n\n`;
    context += `- \`// REPLACE: X-Y\` جایگزینی خطوط (تک‌خط: \`// REPLACE: 321\`)، \`// INSERT_AFTER: X\` درج بعد از خط X، \`// INSERT_BEFORE: X\` درج قبل از خط X، \`// DELETE: X-Y\` حذف خطوط.\n`;
    context += `- ⚠️ تمام شماره خطوط باید بر اساس **فایل اصلی** (خروجی همین پرامپت) باشند؛ سیستم خودش ترتیب اعمال را مدیریت می‌کند.\n\n`;

    context += `📌 **قوانین عمومی کد**:\n`;
    context += `- هیچ پیشوند شماره خط در کد خروجی نگذارید؛ فقط کد خام.\n`;
    context += `- کد خروجی باید کامل و بدون placeholder یا \`...\` باشد.\n\n`;

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