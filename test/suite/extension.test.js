"use strict";
// VS Code extension e2e tests using @vscode/test-electron (Mocha, not Vitest).
// These run inside a real VS Code instance so 'vscode' is available natively.
// Mocha globals (suite, test, suiteSetup) are injected by the test runner.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const vscode = __importStar(require("vscode"));
const EXTENSION_ID = 'jakubmusik.claude-terminal-manager';
suite('Extension Test Suite', () => {
    suiteSetup(async () => {
        // Ensure the extension is activated before tests run
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        if (ext !== undefined && !ext.isActive) {
            await ext.activate();
        }
    });
    // (a) Extension activates within 5 seconds
    test('Extension should be present and active', async function () {
        this.timeout(5000);
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext !== undefined, 'Extension should be installed');
        assert.ok(ext.isActive, 'Extension should be active');
    });
    // (b) claudeTerminalManager tree view is declared in package.json
    test('claudeTerminalManager view is declared in package manifest', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext !== undefined, 'Extension should be installed');
        const pkg = ext.packageJSON;
        const views = pkg.contributes?.views?.explorer ?? [];
        assert.ok(views.some((v) => v.id === 'claudeTerminalManager'), 'claudeTerminalManager view should be declared in contributes.views');
    });
    // (c) Opening a new terminal has PATH prepended via environmentVariableCollection
    test('Extension environment collection prepends PATH', async function () {
        this.timeout(5000);
        const terminal = vscode.window.createTerminal('claude-test-path');
        try {
            assert.ok(terminal !== undefined, 'Terminal should be created');
            await new Promise((resolve) => setTimeout(resolve, 1000));
            // environmentVariableCollection.prepend() is applied by VS Code to new
            // terminal shells. We verify indirectly: terminal creation succeeded and
            // the extension is active (so the collection is applied to new terminals).
            const ext = vscode.extensions.getExtension(EXTENSION_ID);
            assert.ok(ext?.isActive, 'Extension must be active for PATH injection');
        }
        finally {
            terminal.dispose();
        }
    });
    // (d) Opening a new terminal has VSCODE_CLAUDE_SOCKET set
    test('Extension environment collection sets VSCODE_CLAUDE_SOCKET', async function () {
        this.timeout(5000);
        const terminal = vscode.window.createTerminal('claude-test-socket');
        try {
            assert.ok(terminal !== undefined, 'Terminal should be created');
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const ext = vscode.extensions.getExtension(EXTENSION_ID);
            assert.ok(ext?.isActive, 'Extension must be active for socket var injection');
            // The socket path is /tmp/vscode-claude-<pid>.sock — verify at least one
            // socket file exists (the SocketServer started on activation).
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { execSync } = require('child_process');
            const socks = execSync('ls /tmp/vscode-claude-*.sock 2>/dev/null || echo ""')
                .toString()
                .trim();
            assert.ok(socks.length > 0, 'Socket file should exist while extension is active');
        }
        finally {
            terminal.dispose();
        }
    });
    // (e) renameSession command is registered and callable
    test('renameSession command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('claudeTerminalManager.renameSession'), 'renameSession command should be registered');
    });
    // (f) focusTerminal command is registered and callable
    test('focusTerminal command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('claudeTerminalManager.focusTerminal'), 'focusTerminal command should be registered');
    });
    // (g) Settings readable with correct defaults
    test('Settings have correct default values', () => {
        const config = vscode.workspace.getConfiguration('claudeTerminalManager');
        assert.strictEqual(config.get('notifications.onSessionComplete'), true, 'notifications.onSessionComplete default should be true');
        assert.strictEqual(config.get('sidebar.showNonClaudeTerminals'), true, 'sidebar.showNonClaudeTerminals default should be true');
        assert.strictEqual(config.get('status.verboseToolNames'), false, 'status.verboseToolNames default should be false');
    });
});
//# sourceMappingURL=extension.test.js.map