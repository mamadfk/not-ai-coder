import * as vscode from 'vscode';
import { SidebarWebviewProvider, errorMessage } from './ui/sidebarProvider';
import { generateProjectContext, generateProjectStructureOnly, getRootFolderList } from './exporter/contextExporter';
import { parseAndApplyAiResponse } from './patcher/aiPatcher';

export function activate(context: vscode.ExtensionContext) {
    // Register Sidebar Provider
    const sidebarProvider = new SidebarWebviewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarWebviewProvider.viewType, sidebarProvider)
    );

    // Command 1: Copy Full Context with QuickPick Folder Selection
    const copyContextDisposable = vscode.commands.registerCommand('aiDiffAssistant.copyContext', async () => {
        const rootPath = await resolveWorkspaceRoot();
        if (!rootPath) return;

        try {
            const includedFolders = await pickFolders(rootPath);
            if (includedFolders === undefined) return; // user cancelled

            const contextText = await generateProjectContext(rootPath, includedFolders);
            await vscode.env.clipboard.writeText(contextText);
            vscode.window.showInformationMessage('ساختار و کانتکست پروژه با موفقیت در کلیپ‌بورد کپی شد!');
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`خطا در کپی کانتکست: ${errorMessage(err)}`);
        }
    });

    // Command 2: Copy Structure Only
    const copyStructureDisposable = vscode.commands.registerCommand('aiDiffAssistant.copyStructure', async () => {
        const rootPath = await resolveWorkspaceRoot();
        if (!rootPath) return;

        try {
            const includedFolders = await pickFolders(rootPath);
            if (includedFolders === undefined) return; // user cancelled

            const structureText = await generateProjectStructureOnly(rootPath, includedFolders);
            await vscode.env.clipboard.writeText(structureText);
            vscode.window.showInformationMessage('فقط ساختار درختی پروژه در کلیپ‌بورد کپی شد!');
        } catch (err: unknown) {
            vscode.window.showErrorMessage(`خطا در کپی ساختار: ${errorMessage(err)}`);
        }
    });

    // Command 3: Apply Patch from Clipboard
    const applyPatchDisposable = vscode.commands.registerCommand('aiDiffAssistant.applyPatch', async () => {
        const rootPath = await resolveWorkspaceRoot();
        if (!rootPath) return;

        const clipboardText = await vscode.env.clipboard.readText();
        if (!clipboardText || !clipboardText.trim()) {
            vscode.window.showWarningMessage('کلیپ‌بورد شما خالی است! لطفاً ابتدا متن پاسخ هوش مصنوعی را کپی کنید.');
            return;
        }

        const { successCount, errors } = await parseAndApplyAiResponse(clipboardText, rootPath);

        if (successCount > 0) {
            vscode.window.showInformationMessage(`تغییرات کدهای کپی شده با موفقیت روی ${successCount} بلوک/فایل اعمال شد.`);
        }

        if (errors.length > 0) {
            vscode.window.showErrorMessage(`برخی خطاها هنگام اعمال پچ رخ داد:\n${errors.join('\n')}`);
        }
    });

    context.subscriptions.push(copyContextDisposable, copyStructureDisposable, applyPatchDisposable);
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the workspace root path to operate on. When more than one workspace
 * folder is open (multi-root), prompts the user to pick one. Returns undefined
 * (after notifying) when there's nothing open or the user cancels.
 */
async function resolveWorkspaceRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('هیچ پروژه‌ای در VS Code باز نیست!');
        return undefined;
    }

    if (folders.length === 1) {
        return folders[0].uri.fsPath;
    }

    // Multi-root: let the user choose which folder to target.
    const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: 'پروژه‌ای که می‌خواهید عملیات روی آن انجام شود را انتخاب کنید:'
    });
    return picked?.uri.fsPath;
}

/**
 * Shows a multi-select QuickPick of the root-level folders.
 * - Returns the list of selected folder names (possibly empty).
 * - Returns `undefined` when the user dismisses the QuickPick.
 */
async function pickFolders(rootPath: string): Promise<string[] | undefined> {
    const rootFolders = await getRootFolderList(rootPath);
    if (rootFolders.length === 0) {
        return [];
    }

    const selected = await vscode.window.showQuickPick(
        // Use the standard `description` field to carry the folder name — no
        // custom (non-typed) properties on the QuickPickItem.
        rootFolders.map(f => ({ label: `📁 ${f}`, description: f })),
        {
            canPickMany: true,
            placeHolder: 'پوشه‌هایی که می‌خواهید شامل شوند را انتخاب کنید:'
        }
    );

    if (selected === undefined) {
        return undefined;
    }

    return selected.map(s => s.description!);
}
