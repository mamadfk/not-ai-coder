import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface FolderOption {
    relativePath: string;
    selected: boolean;
}

// ---------------------------------------------------------------------------
// Default ignore lists (overridable via settings.json — see package.json).
// ---------------------------------------------------------------------------
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

// Binary file extensions (double safety net beyond the glob list).
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.tiff',
    '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
    '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm',
    '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.ogg', '.flac',
    '.ttf', '.otf', '.woff', '.woff2', '.eot', '.db', '.sqlite', '.mdb'
]);

const MAX_FILE_SIZE = 500 * 1024; // 500 KB

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
interface ExportSettings {
    excludeFolders: Set<string>;
    excludeFilePatterns: string[];
}

function loadSettings(): ExportSettings {
    const cfg = vscode.workspace.getConfiguration('aiDiffAssistant');
    const userFolders = cfg.get<string[]>('excludeFolders', []);
    const userFiles = cfg.get<string[]>('excludeFiles', []);

    // User-supplied lists fully replace the defaults when non-empty,
    // otherwise the sensible built-in defaults apply.
    return {
        excludeFolders: new Set(
            userFolders.length > 0 ? userFolders : DEFAULT_EXCLUDE_FOLDERS
        ),
        excludeFilePatterns: userFiles.length > 0 ? userFiles : DEFAULT_EXCLUDE_FILE_GLOBS
    };
}

/** Minimal glob matcher supporting `*` and `?`. */
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
    // Sniff for a NUL byte in the first chunk (catches files with no
    // recognizable extension but binary content).
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

// ---------------------------------------------------------------------------
// Folder listing (for QuickPick / sidebar)
// ---------------------------------------------------------------------------
/** Returns the names of the immediate sub-directories of `rootPath`. */
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
                // ignore unreadable entries
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
    context += `   AI SYSTEM PROMPT & INSTRUCTIONS (قالب دستور العمل)\n`;
    context += `==================================================\n\n`;
    context += `شما یک دستیار برنامه نویسی هوشمند هستید. لطفا هنگام پاسخ دادن به درخواست ها و ارائه تغییرات کد، قوانین زیر را دقیقا رعایت کنید:\n\n`;
    context += `1. **کاهش مصرف توکن**: نیازی نیست کل فایل ها یا کل پروژه را در پاسخ خود تکرار کنید. فقط بخش هایی که باید تغییر کنند یا اضافه شوند را ارسال کنید.\n\n`;
    context += `2. **مشخص کردن مسیر فایل**: هر بلوک کد باید حتما دارای مسیر دقیق فایل باشد. مسیر را می توانید در عنوان بلوک کد (مثلا \`\`\`typescript:src/index.ts) یا در خط اول بلوک کد مشخص کنید. کامنت مشخص‌کننده مسیر باید با سینتکس کامنت همان زبان نوشته شود:\n`;
    context += `   - جاوااسکریپت/تی‌اس/سی‌شارپ/...:  \`// FILE: src/path/to/file.ext\`\n`;
    context += `   - پایتون/روبی/شل:                  \`# FILE: src/path/to/file.py\`\n`;
    context += `   - CSS/SCSS:                         \`/* FILE: src/style.css */\`\n`;
    context += `   - HTML/XML/Markdown/Vue:            \`<!-- FILE: index.html -->\`\n\n`;
    context += `3. **علامت گذاری تغییرات (Diff Markers)** — سینتکس کامنت باید با نوع فایل همخوانی داشته باشد:\n`;
    context += `   - **new**: کدهای جدیدی که باید اضافه شوند. قبل از آن‌ها کامنت new قرار دهید. مثال HTML: \`<!-- new -->\`، مثال CSS: \`/* new */\`، مثال JS: \`// new\`، مثال Python: \`# new\`.\n`;
    context += `   - **change**: کدهایی که جایگزین می‌شوند. قبل از بلوکِ جایگزین کامنت change بگذارید و **کل بلوک جدید (مثلاً کل تابع/متد/المنت) را بفرستید**. پلاگین به‌صورت هوشمند کل scope قدیمی (تمام بدنه‌ی تابع/کلاس/المنت) را حذف و با بلوک جدید جایگزین می‌کند — پس نیازی به remove جداگانه برای خطوط قدیمی نیست.\n`;
    context += `   - **remove**: اگر یک خط یا متد باید حذف شود، از \`// remove: [کد قبلی]\` (یا معادل همان‌زبان: \`# remove:\`، \`/* remove: */\`، \`<!-- remove: -->\`) استفاده کنید.\n`;
    context += `   - **NEW FILE**: اگر فایل کاملاً جدید است، در انتهای مسیر فایل کلمه \`(NEW FILE)\` یا در خط اول \`// NEW FILE\` (با سینتکس مناسب) قید شود.\n\n`;
    context += `4. **قالب ارسال پاسخ** — نمونه برای چند زبان:\n\n`;
    context += `\`\`\`typescript\n`;
    context += `// FILE: src/example.ts\n`;
    context += `// change\n`;
    context += `// کل تابع قدیمی جایگزین می‌شود؛ فقط بلوک کامل جدید را بفرستید:\n`;
    context += `function calc(x: number) {\n`;
    context += `    return x * 2;\n`;
    context += `}\n\n`;
    context += `// new\n`;
    context += `const NEW_CONST = 42;\n`;
    context += `\`\`\`\n\n`;
    context += `\`\`\`html\n`;
    context += `<!-- FILE: index.html -->\n`;
    context += `<!-- change -->\n`;
    context += `<div class="new-card">محتوای جدید</div>\n`;
    context += `\`\`\`\n\n`;
    context += `\`\`\`css\n`;
    context += `/* FILE: src/style.css */\n`;
    context += `/* new */\n`;
    context += `.new-card { color: red; }\n`;
    context += `\`\`\`\n\n`;

    context += `==================================================\n`;
    context += `   PROJECT STRUCTURE (ساختار پروژه)\n`;
    context += `==================================================\n\n`;
    context += treeStructure + `\n\n`;

    context += `==================================================\n`;
    context += `   PROJECT SOURCE FILES (محتوای فایل‌های پروژه)\n`;
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
    context += `   PROJECT STRUCTURE & SOURCE FILES (ساختار و سورس کد پروژه)\n`;
    context += `==================================================\n\n`;
    context += treeStructure + `\n\n`;

    context += `==================================================\n`;
    context += `   PROJECT SOURCE FILES (محتوای فایل‌های پروژه)\n`;
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
    context += `توضیح: این ساختار درختی فایل‌های پروژه است. کدهای سورس داخل فایل‌ها ارسال نشده است.\n`;

    return context;
}

// ---------------------------------------------------------------------------
// Shared file walker + helpers
// ---------------------------------------------------------------------------
/** Writes each file's content into the supplied `append` callback. */
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
            append(content + `\n\n`);
        } catch {
            // skip unreadable files
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
        // Skip excluded folders (only by top-level name) — works for any depth.
        const fullPath = path.join(dir, item);
        const relItemPath = currentRelPath ? `${currentRelPath}/${item}` : item;

        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (settings.excludeFolders.has(item)) {
                    continue;
                }

                // At root level, honour the user's folder selection.
                if (currentRelPath === '' && includedFolders !== null && !includedFolders.includes(item)) {
                    continue;
                }

                const subFiles = await getWorkspaceFiles(fullPath, includedFolders, settings, relItemPath);
                results = results.concat(subFiles);
            } else {
                // Root-level files are always considered (subject to filters)
                // when no folder selection is active.
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
            // ignore access errors
        }
    }
    return results;
}

/**
 * Builds a proper ASCII tree:
 *
 *   .
 *   ├── src
 *   │   └── index.ts
 *   └── package.json
 *
 * The previous version flattened everything under the root with a broken
 * depth calculation; this rebuilds the real hierarchy.
 */
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

    // Folders first (those that have children), then files — both alphabetical.
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
