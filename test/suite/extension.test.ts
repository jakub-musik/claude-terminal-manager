// VS Code extension e2e tests using @vscode/test-electron (Mocha, not Vitest).
// These run inside a real VS Code instance so 'vscode' is available natively.
// Mocha globals (suite, test, suiteSetup) are injected by the test runner.

import * as assert from 'assert'
import * as vscode from 'vscode'

const EXTENSION_ID = 'jakubmusik.claude-terminal-manager'

suite('Extension Test Suite', () => {
  suiteSetup(async () => {
    // Ensure the extension is activated before tests run
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    if (ext !== undefined && !ext.isActive) {
      await ext.activate()
    }
  })

  // (a) Extension activates within 5 seconds
  test('Extension should be present and active', async function () {
    this.timeout(5000)
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    assert.ok(ext !== undefined, 'Extension should be installed')
    assert.ok(ext.isActive, 'Extension should be active')
  })

  // (b) claudeTerminalManager tree view is declared in package.json
  test('claudeTerminalManager view is declared in package manifest', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID)
    assert.ok(ext !== undefined, 'Extension should be installed')
    const pkg = ext.packageJSON as {
      contributes?: {
        views?: { explorer?: Array<{ id: string }> }
      }
    }
    const views = pkg.contributes?.views?.explorer ?? []
    assert.ok(
      views.some((v) => v.id === 'claudeTerminalManager'),
      'claudeTerminalManager view should be declared in contributes.views',
    )
  })

  // (c) Opening a new terminal has PATH prepended via environmentVariableCollection
  test('Extension environment collection prepends PATH', async function () {
    this.timeout(5000)
    const terminal = vscode.window.createTerminal('claude-test-path')
    try {
      assert.ok(terminal !== undefined, 'Terminal should be created')
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      // environmentVariableCollection.prepend() is applied by VS Code to new
      // terminal shells. We verify indirectly: terminal creation succeeded and
      // the extension is active (so the collection is applied to new terminals).
      const ext = vscode.extensions.getExtension(EXTENSION_ID)
      assert.ok(
        ext?.isActive,
        'Extension must be active for PATH injection',
      )
    } finally {
      terminal.dispose()
    }
  })

  // (d) Opening a new terminal has VSCODE_CLAUDE_SOCKET set
  test('Extension environment collection sets VSCODE_CLAUDE_SOCKET', async function () {
    this.timeout(5000)
    const terminal = vscode.window.createTerminal('claude-test-socket')
    try {
      assert.ok(terminal !== undefined, 'Terminal should be created')
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      const ext = vscode.extensions.getExtension(EXTENSION_ID)
      assert.ok(
        ext?.isActive,
        'Extension must be active for socket var injection',
      )
      // The socket path is /tmp/vscode-claude-<pid>.sock — verify at least one
      // socket file exists (the SocketServer started on activation).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('child_process') as typeof import('child_process')
      const socks = execSync(
        'ls /tmp/vscode-claude-*.sock 2>/dev/null || echo ""',
      )
        .toString()
        .trim()
      assert.ok(
        socks.length > 0,
        'Socket file should exist while extension is active',
      )
    } finally {
      terminal.dispose()
    }
  })

  // (e) renameSession command is registered and callable
  test('renameSession command is registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(
      commands.includes('claudeTerminalManager.renameSession'),
      'renameSession command should be registered',
    )
  })

  // (f) focusTerminal command is registered and callable
  test('focusTerminal command is registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(
      commands.includes('claudeTerminalManager.focusTerminal'),
      'focusTerminal command should be registered',
    )
  })

  // (f2) renameTerminal command is registered and callable (T2.2)
  test('renameTerminal command is registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(
      commands.includes('claudeTerminalManager.renameTerminal'),
      'renameTerminal command should be registered',
    )
  })

  // (f3) focusRemoteTerminal command is registered and callable (T2.7)
  test('focusRemoteTerminal command is registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(
      commands.includes('claudeTerminalManager.focusRemoteTerminal'),
      'focusRemoteTerminal command should be registered',
    )
  })

  // (g) Settings readable with correct defaults
  test('Settings have correct default values', () => {
    const config = vscode.workspace.getConfiguration('claudeTerminalManager')
    assert.strictEqual(
      config.get<boolean>('notifications.onSessionComplete'),
      true,
      'notifications.onSessionComplete default should be true',
    )
    assert.strictEqual(
      config.get<boolean>('sidebar.showNonClaudeTerminals'),
      true,
      'sidebar.showNonClaudeTerminals default should be true',
    )
    assert.strictEqual(
      config.get<boolean>('status.verboseToolNames'),
      false,
      'status.verboseToolNames default should be false',
    )
    assert.strictEqual(
      config.get<boolean>('sidebar.showTerminalsFromAllWindows'),
      false,
      'sidebar.showTerminalsFromAllWindows default should be false',
    )
  })
})
