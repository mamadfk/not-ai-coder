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

    let context = `==================================================\n`;
    context += `   AI SYSTEM PROMPT & INSTRUCTIONS (دستورالعمل جامع هوش مصنوعی)\n`;
    context += `==================================================\n\n`;
    context += `شما یک مهندس ارشد برنامه‌نویسی و متخصص توسعه نرم‌افزار هستید. سورس‌کد پروژه در ادامه آورده شده و تمامی خطوط با شماره خط مشخص شده‌اند.\n\n`;
    context += `🎯 **هدف اصلی**: ارائه کدهای کاملاً تمیز، دقیق، ساختاریافته و قابل پچ روی پروژه.\n`;
    context += `⚠️ **نکته بسیار مهم**: هدف ما صرفه‌جویی بی‌مورد در توکن نیست! هرگز به خاطر کاهش توکن، ساختار پاسخ، بلوک‌های کد یا مشخصات فایل‌ها را خراب نکنید یا در یک خط فشرده نسازید.\n\n`;
    context += `📌 **قوانین اجباری فرمت خروجی (۱۰۰٪ الزام‌آور)**:\n\n`;
    context += `۱. **بلوک کد مجزا برای هر فایل**: تغییرات هر فایل را حتماً در یک بلوک کد مارک‌داون مجزا (با \`\`\`زبان) قرار دهید.\n\n`;
    context += `۲. **خط اول (مسیر کامل فایل)**: اولین خط داخل بلوک کد حتماً باید مسیر دقیق فایل باشد:\n`;
    context += `   - دارت/فلاتر/جاوااسکریپت:  \`// FILE: lib/screens/home_screen.dart\`\n`;
    context += `   - یامل/پایتون/شل:          \`# FILE: pubspec.yaml\`\n`;
    context += `   - اکس‌ام‌ال/ایچ‌تی‌ام‌ال:     \`<!-- FILE: android/app/src/main/AndroidManifest.xml -->\`\n`;
    context += `   - سی‌اس‌اس:                \`/* FILE: assets/styles.css */\`\n\n`;
    context += `۳. **خط دوم (دستور تغییر و شماره خط)**: دومین خط حتماً باید دستور تغییر باشد:\n`;
    context += `   - برای جایگزینی خطوط:       \`// REPLACE: 15-20\` (یا \`// REPLACE: 12\` برای یک خط)\n`;
    context += `   - برای درج کد جدید:         \`// INSERT_AFTER: 45\` (یا \`// INSERT_AFTER: 0\` برای ابتدای فایل)\n`;
    context += `   - برای حذف خطوط:            \`// DELETE: 8-10\`\n`;
    context += `   - برای فایل جدید:           \`// NEW FILE\`\n\n`;
    context += `۴. **شروع کد از خط سوم**: کدها باید حتماً از خط بعدی شروع شوند. **هرگز مسیر فایل، مارکر تغییر و کد اصلی را در یک خط ننویسید!**\n\n`;
    context += `۵. **عدم تکرار شماره خط**: در کدهای جدیدی که می‌نویسید شماره خط قرار ندهید.\n\n`;
    context += `--------------------------------------------------\n`;
    context += `📌 **نمونه‌های استاندارد پاسخ (دقیقاً طبق این الگوها عمل کنید)**:\n\n`;
    context += `مثال ۱ (فایل Dart در فلاتر):\n`;
    context += `\`\`\`dart\n`;
    context += `// FILE: lib/screens/home_screen.dart\n`;
    context += `// REPLACE: 15-18\n`;
    context += `class HomeScreen extends StatefulWidget {\n`;
    context += `  const HomeScreen({super.key});\n`;
    context += `\`\`\`\n\n`;
    context += `مثال ۲ (فایل YAML کانفیگ فلاتر):\n`;
    context += `\`\`\`yaml\n`;
    context += `# FILE: pubspec.yaml\n`;
    context += `# INSERT_AFTER: 20\n`;
    context += `  flutter_bloc: ^8.1.3\n`;
    context += `\`\`\`\n\n`;
    context += `مثال ۳ (فایل Android XML در فلاتر):\n`;
    context += `\`\`\`xml\n`;
    context += `<!-- FILE: android/app/src/main/AndroidManifest.xml -->\n`;
    context += `<!-- REPLACE: 10-12 -->\n`;
    context += `<application android:label="MyFlutterApp">\n`;
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