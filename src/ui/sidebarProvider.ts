import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { generateProjectContext, generateProjectStructureOnly, generateProjectStructureAndSource, getRootFolderList } from '../exporter/contextExporter';
import { parseAndApplyAiResponse } from '../patcher/aiPatcher';

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiDiffAssistant.sidebarView';

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'getFolders':
                    await this._handleGetFolders(webviewView);
                    break;
                case 'copyContext':
                    await this._handleCopyContext(message.includedFolders || []);
                    break;
                case 'copyStructure':
                    await this._handleCopyStructure(message.includedFolders || []);
                    break;
                case 'copyStructureAndSource':
                    await this._handleCopyStructureAndSource(message.includedFolders || []);
                    break;
                case 'applyAiResponse':
                    await this._handleApplyAiResponse(message.value);
                    break;
            }
        });
    }

    private async _handleGetFolders(webviewView: vscode.WebviewView) {
        const rootPath = this._requireRootPath();
        if (!rootPath) {
            webviewView.webview.postMessage({ type: 'folderList', folders: [] });
            return;
        }
        const folders = await getRootFolderList(rootPath);
        webviewView.webview.postMessage({ type: 'folderList', folders });
    }

    private async _handleCopyContext(includedFolders: string[]) {
        const rootPath = this._requireRootPath();
        if (!rootPath) return;

        try {
            const contextText = await generateProjectContext(rootPath, includedFolders);
            await vscode.env.clipboard.writeText(contextText);

            const msg = includedFolders.length > 0
                ? `کانتکست پروژه کپی شد! (${includedFolders.length} پوشه انتخاب شد)`
                : `کانتکست پروژه (تمامی فایل‌های ریشه) کپی شد!`;

            vscode.window.showInformationMessage(msg);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`خطا در ایجاد کانتکست پروژه: ${errorMessage(err)}`);
        }
    }

    private async _handleCopyStructure(includedFolders: string[]) {
        const rootPath = this._requireRootPath();
        if (!rootPath) return;

        try {
            const structureText = await generateProjectStructureOnly(rootPath, includedFolders);
            await vscode.env.clipboard.writeText(structureText);
            vscode.window.showInformationMessage(`فقط ساختار درختی پروژه در کلیپ‌بورد کپی شد!`);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`خطا در ایجاد ساختار پروژه: ${errorMessage(err)}`);
        }
    }

    private async _handleCopyStructureAndSource(includedFolders: string[]) {
        const rootPath = this._requireRootPath();
        if (!rootPath) return;

        try {
            const contentText = await generateProjectStructureAndSource(rootPath, includedFolders);
            await vscode.env.clipboard.writeText(contentText);
            vscode.window.showInformationMessage(`ساختار و سورس کد پروژه (بدون پرامپت) در کلیپ‌بورد کپی شد!`);
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`خطا در ایجاد کانتکست پروژه: ${errorMessage(err)}`);
        }
    }

    private async _handleApplyAiResponse(aiResponse: string) {
        const rootPath = this._requireRootPath();
        if (!rootPath) return;

        if (!aiResponse || !aiResponse.trim()) {
            vscode.window.showWarningMessage('لطفاً ابتدا خروجی هوش مصنوعی را در کادر پیست کنید!');
            return;
        }

        try {
            const { successCount, errors } = await parseAndApplyAiResponse(aiResponse, rootPath);

            if (successCount > 0) {
                vscode.window.showInformationMessage(`تغییرات با موفقیت در ${successCount} فایل / بلوک کد اعمال شد.`);
            }

            if (errors.length > 0) {
                vscode.window.showErrorMessage(`برخی خطاها هنگام اعمال کد رخ داد:\n${errors.join('\n')}`);
            }
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`خطا در اجرای پچ: ${errorMessage(err)}`);
        }
    }

    /**
     * Returns the first workspace folder's fsPath, or undefined (after showing
     * an error) when no project is open. Centralises the repeated guard.
     */
    private _requireRootPath(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage('هیچ پوشه یا پروژه‌ای در VS Code باز نیست!');
            return undefined;
        }
        return folders[0].uri.fsPath;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // CSP nonce: only this script may run inside the webview.
        const nonce = getNonce();

        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} https:`,
            `style-src 'unsafe-inline' ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>AI Diff Assistant</title>
    <style>
        body {
            font-family: var(--vscode-font-family, system-ui, sans-serif);
            padding: 12px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            direction: rtl;
        }
        .card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border, #3c3c3c);
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 14px;
        }
        h3 {
            margin-top: 0;
            margin-bottom: 8px;
            font-size: 1.05em;
            color: var(--vscode-symbolIcon-keywordForeground, #007acc);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        p {
            font-size: 0.85em;
            line-height: 1.4;
            opacity: 0.85;
            margin-top: 0;
            margin-bottom: 10px;
        }
        .folder-menu {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, #444);
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 10px;
            max-height: 160px;
            overflow-y: auto;
            direction: ltr;
            text-align: left;
        }
        .folder-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.85em;
            margin-bottom: 4px;
        }
        .folder-item input {
            cursor: pointer;
        }
        .toolbar {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        }
        .toolbar a {
            font-size: 0.78em;
            cursor: pointer;
            text-decoration: underline;
            opacity: 0.8;
        }
        .toolbar a:hover {
            opacity: 1;
        }
        button {
            width: 100%;
            padding: 9px 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            font-weight: bold;
            font-size: 0.88em;
            cursor: pointer;
            transition: background-color 0.2s;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 6px;
            margin-bottom: 8px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ffffff);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
        }
        .btn-apply {
            background-color: var(--vscode-statusBarItem-remoteBackground, #0e639c);
            margin-bottom: 0;
        }
        textarea {
            width: 100%;
            height: 150px;
            box-sizing: border-box;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #555);
            border-radius: 4px;
            padding: 8px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            direction: ltr;
            text-align: left;
        }
        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .footer {
            font-size: 0.78em;
            text-align: center;
            opacity: 0.6;
            margin-top: 15px;
        }
    </style>
</head>
<body>
    <div class="card">
        <h3>📂 انتخاب پوشه‌های پروژه</h3>
        <p>پوشه‌هایی که می‌خواهید در کانتکست قرار گیرند را تیک بزنید:</p>
        <div class="toolbar">
            <a id="selectAll">انتخاب همه</a>
            <a id="deselectAll">لغو همه</a>
        </div>
        <div id="folderContainer" class="folder-menu">
            <span style="font-size:0.8em; opacity:0.6;">در حال دریافت پوشه‌های پروژه...</span>
        </div>
        <button id="btnCopy">📋 کپی پرامپت + ساختار + سورس کد</button>
        <button id="btnCopyStructureAndSource" class="btn-secondary">🗂️ کپی ساختار + سورس کد (بدون پرامپت)</button>
        <button id="btnCopyStructure" class="btn-secondary">🌳 کپی "فقط" ساختار درختی پروژه</button>
    </div>

    <div class="card">
        <h3>⚡ ۲. اعمال پاسخ هوش مصنوعی</h3>
        <p>پاسخ یا کد دریافتی از AI Playground را در کادر زیر پیست کنید:</p>
        <textarea id="aiText" placeholder="// Paste AI response code blocks here..."></textarea>
        <button id="btnApply" class="btn-apply" style="margin-top: 10px;">🚀 اعمال هوشمند تغییرات (Apply Patch)</button>
    </div>

    <div class="footer">
        پلاگین مدیریت هوشمند پرامپت و دیف کد
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        vscode.postMessage({ type: 'getFolders' });

        // SECURITY: build folder DOM with the DOM API (never innerHTML) so a
        // maliciously-named folder can't inject markup/script.
        function renderFolders(folders) {
            const container = document.getElementById('folderContainer');
            container.innerHTML = '';
            if (!folders || folders.length === 0) {
                const span = document.createElement('span');
                span.style.fontSize = '0.8em';
                span.style.opacity = '0.6';
                span.textContent = 'پوشه‌ای در ریشه پروژه یافت نشد.';
                container.appendChild(span);
                return;
            }
            folders.forEach(folder => {
                const div = document.createElement('div');
                div.className = 'folder-item';

                const input = document.createElement('input');
                input.type = 'checkbox';
                input.id = 'f_' + folder;
                input.value = folder;

                const label = document.createElement('label');
                label.htmlFor = 'f_' + folder;
                label.textContent = '📁 ' + folder;

                div.appendChild(input);
                div.appendChild(label);
                container.appendChild(div);
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'folderList') {
                renderFolders(message.folders);
            }
        });

        function getIncludedFolders() {
            const includedFolders = [];
            document.querySelectorAll('#folderContainer input[type="checkbox"]').forEach(cb => {
                if (cb.checked) {
                    includedFolders.push(cb.value);
                }
            });
            return includedFolders;
        }

        document.getElementById('selectAll').addEventListener('click', () => {
            document.querySelectorAll('#folderContainer input[type="checkbox"]').forEach(cb => { cb.checked = true; });
        });

        document.getElementById('deselectAll').addEventListener('click', () => {
            document.querySelectorAll('#folderContainer input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        });

        document.getElementById('btnCopy').addEventListener('click', () => {
            vscode.postMessage({ type: 'copyContext', includedFolders: getIncludedFolders() });
        });

        document.getElementById('btnCopyStructure').addEventListener('click', () => {
            vscode.postMessage({ type: 'copyStructure', includedFolders: getIncludedFolders() });
        });

        document.getElementById('btnCopyStructureAndSource').addEventListener('click', () => {
            vscode.postMessage({ type: 'copyStructureAndSource', includedFolders: getIncludedFolders() });
        });

        document.getElementById('btnApply').addEventListener('click', () => {
            const val = document.getElementById('aiText').value;
            vscode.postMessage({ type: 'applyAiResponse', value: val });
        });
    </script>
</body>
</html>`;
    }
}

// ---------------------------------------------------------------------------
// Small helpers (shared with extension.ts via re-export of `errorMessage`).
// ---------------------------------------------------------------------------
function getNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
