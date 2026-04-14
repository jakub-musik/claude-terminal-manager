import * as childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { Effect, Layer, ManagedRuntime, Schedule, Stream } from 'effect'
import { SessionManager, makeSessionManagerLive } from './sessionManager.js'
import type { SessionRecord } from './stateMachine.js'
import { SocketServerLive, SocketConfig } from './socketServer.js'
import { correlateSession } from './terminalCorrelator.js'
import { ClaudeTerminalProvider } from './treeProvider.js'
import type { SessionNode, TerminalNode, RemoteTerminalNode, SectionNode } from './treeProvider.js'
import { getVerboseToolNames } from './settings.js'
import { resolveSessionSlug, readLatestSlug } from './slugResolver.js'
import {
  writeWindowEntry,
  getWindowEntryPath,
  pruneStaleWindowFiles,
  pruneDuplicateWindowFiles,
  readAllWindowEntries,
  type WindowEntry,
} from './windowRegistry.js'
import {
  writeFocusRequest,
  getFocusRequestPath,
  type FocusRequest,
} from './focusIpc.js'

const HOOK_MARKER = '--vscode-ctm'
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CODEX_HOOKS_PATH = path.join(os.homedir(), '.codex', 'hooks.json')

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
function writeClaudeHooks(reporterPath: string): void {
  let settings: any = {}
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'))
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  const hooks: any = settings['hooks'] ?? {}
  const events = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'Stop',
  ]

  // Single-quoted path handles spaces in the reporter path
  const quoted = `'${reporterPath}'`

  for (const event of events) {
    const existing: any[] = Array.isArray(hooks[event]) ? hooks[event] : []
    const hasOurHook = existing.some(
      (group: any) =>
        Array.isArray(group['hooks']) &&
        group['hooks'].some(
          (h: any) =>
            typeof h['command'] === 'string' &&
            h['command'].includes(HOOK_MARKER),
        ),
    )
    if (!hasOurHook) {
      const command =
        event === 'SessionStart'
          ? `${quoted} ${HOOK_MARKER} --pid $PPID`
          : `${quoted} ${HOOK_MARKER}`
      existing.push({ hooks: [{ type: 'command', command }] })
    }
    hooks[event] = existing
  }

  settings['hooks'] = hooks
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
function removeClaudeHooks(): void {
  let settings: any
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'))
  } catch {
    return
  }

  const hooks: any = settings['hooks'] ?? {}
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue
    hooks[event] = hooks[event].filter(
      (group: any) =>
        !Array.isArray(group['hooks']) ||
        !group['hooks'].some(
          (h: any) =>
            typeof h['command'] === 'string' &&
            h['command'].includes(HOOK_MARKER),
        ),
    )
  }

  settings.hooks = hooks
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
function checkClaudeHooks(): { installed: boolean; events: string[] } {
  let settings: any
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'))
  } catch {
    return { installed: false, events: [] }
  }

  const hooks: any = settings['hooks'] ?? {}
  const foundEvents: string[] = []
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue
    const hasOurHook = hooks[event].some(
      (group: any) =>
        Array.isArray(group['hooks']) &&
        group['hooks'].some(
          (h: any) =>
            typeof h['command'] === 'string' &&
            h['command'].includes(HOOK_MARKER),
        ),
    )
    if (hasOurHook) {
      foundEvents.push(event)
    }
  }
  return { installed: foundEvents.length > 0, events: foundEvents }
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
export function writeCodexHooks(reporterPath: string): void {
  // If ~/.codex/ doesn't exist, skip silently
  const codexDir = path.join(os.homedir(), '.codex')
  if (!fs.existsSync(codexDir)) return

  let settings: any = {}
  try {
    settings = JSON.parse(fs.readFileSync(CODEX_HOOKS_PATH, 'utf8'))
  } catch {
    // File doesn't exist or invalid — start fresh
  }

  const hooks: any = settings['hooks'] ?? {}
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']
  const quoted = `'${reporterPath}'`

  for (const event of events) {
    const existing: any[] = Array.isArray(hooks[event]) ? hooks[event] : []
    const hasOurHook = existing.some(
      (group: any) =>
        Array.isArray(group['hooks']) &&
        group['hooks'].some(
          (h: any) =>
            typeof h['command'] === 'string' &&
            h['command'].includes(HOOK_MARKER),
        ),
    )
    if (!hasOurHook) {
      const command =
        event === 'SessionStart'
          ? `${quoted} ${HOOK_MARKER} --source codex --pid $PPID`
          : `${quoted} ${HOOK_MARKER} --source codex`
      existing.push({ hooks: [{ type: 'command', command }] })
    }
    hooks[event] = existing
  }

  settings['hooks'] = hooks
  fs.writeFileSync(CODEX_HOOKS_PATH, JSON.stringify(settings, null, 2) + '\n')
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
export function removeCodexHooks(): void {
  let settings: any
  try {
    settings = JSON.parse(fs.readFileSync(CODEX_HOOKS_PATH, 'utf8'))
  } catch {
    return
  }

  const hooks: any = settings['hooks'] ?? {}
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue
    hooks[event] = hooks[event].filter(
      (group: any) =>
        !Array.isArray(group['hooks']) ||
        !group['hooks'].some(
          (h: any) =>
            typeof h['command'] === 'string' &&
            h['command'].includes(HOOK_MARKER),
        ),
    )
  }

  settings['hooks'] = hooks
  fs.writeFileSync(CODEX_HOOKS_PATH, JSON.stringify(settings, null, 2) + '\n')
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
export function checkCodexHooks(): { installed: boolean; events: string[] } {
  let settings: any
  try {
    settings = JSON.parse(fs.readFileSync(CODEX_HOOKS_PATH, 'utf8'))
  } catch {
    return { installed: false, events: [] }
  }

  const hooks: any = settings['hooks'] ?? {}
  const foundEvents: string[] = []
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue
    const hasOurHook = hooks[event].some(
      (group: any) =>
        Array.isArray(group['hooks']) &&
        group['hooks'].some(
          (h: any) =>
            typeof h['command'] === 'string' &&
            h['command'].includes(HOOK_MARKER),
        ),
    )
    if (hasOurHook) foundEvents.push(event)
  }
  return { installed: foundEvents.length > 0, events: foundEvents }
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

function detectGitBranch(folderPath: string | undefined): string | undefined {
  if (folderPath === undefined) return undefined
  try {
    const result = childProcess.execFileSync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: folderPath, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return result !== '' && result !== 'HEAD' ? result : undefined
  } catch {
    return undefined
  }
}

let _runtime: { dispose(): Promise<void> } | undefined

export function activate(context: vscode.ExtensionContext): void {
  const codeCli = vscode.env.appName.includes('Insiders') ? 'code-insiders' : 'code'

  const activateWindow = (folderPath: string | undefined): void => {
    if (folderPath === undefined) {
      outputChannel.appendLine('[CTM] activateWindow: no folderPath — skipping')
      return
    }
    outputChannel.appendLine(`[CTM] activateWindow: ${codeCli} -r ${folderPath}`)
    childProcess.execFile(codeCli, ['-r', folderPath], (err) => {
      if (err !== null) {
        outputChannel.appendLine(`[CTM] activateWindow failed: ${err.message}`)
      }
    })
  }

  const outputChannel = vscode.window.createOutputChannel(
    'Agent Terminal Manager',
  )
  context.subscriptions.push(outputChannel)

  const storageBinDir = path.join(context.globalStorageUri.fsPath, 'bin')
  const extensionBinDir = path.join(context.extensionUri.fsPath, 'bin')

  const SOCKET_ID_KEY = 'ctm:socketId'
  let socketId = context.workspaceState.get<string>(SOCKET_ID_KEY)
  if (socketId === undefined) {
    socketId = randomUUID()
    void context.workspaceState.update(SOCKET_ID_KEY, socketId)
  }
  const socketPath = `/tmp/vscode-claude-${socketId}.sock`

  outputChannel.appendLine(
    `[CTM] Extension activated. Socket: ${socketPath}`,
  )

  fs.mkdirSync(storageBinDir, { recursive: true })
  const reporterSrc = path.join(extensionBinDir, 'reporter')
  const reporterDst = path.join(storageBinDir, 'reporter')
  fs.copyFileSync(reporterSrc, reporterDst)
  fs.chmodSync(reporterDst, 0o755)

  // Register hooks in ~/.claude/settings.json
  try {
    writeClaudeHooks(path.join(storageBinDir, 'reporter'))
    outputChannel.appendLine('[CTM] Claude hooks registered in ~/.claude/settings.json')
  } catch (err) {
    outputChannel.appendLine(`[CTM] Warning: could not register Claude hooks: ${String(err)}`)
  }

  // Register hooks in ~/.codex/hooks.json
  try {
    writeCodexHooks(path.join(storageBinDir, 'reporter'))
    outputChannel.appendLine('[CTM] Codex hooks registered in ~/.codex/hooks.json')
  } catch (err) {
    outputChannel.appendLine(`[CTM] Warning: could not register Codex hooks: ${String(err)}`)
  }

  const SESSIONS_KEY = 'ctm:sessions'
  const rawPersisted =
    (context.workspaceState.get<SessionRecord[]>(SESSIONS_KEY) ?? [])
      .map((s) => {
        const raw = s as unknown as Record<string, unknown>
        const source = typeof raw['source'] === 'string' ? raw['source'] : 'claude'
        return { ...s, needsAttention: s.needsAttention ?? false, activeBlockingTool: s.activeBlockingTool ?? undefined, source }
      })
  const persistedSessions = rawPersisted.filter((s) => {
    if (s.pid <= 0) return false
    try {
      process.kill(s.pid, 0)
      return true
    } catch {
      return false
    }
  })
  if (rawPersisted.length > 0) {
    outputChannel.appendLine(
      `[CTM] Restored ${persistedSessions.length}/${rawPersisted.length} session(s) (filtered by alive process)`,
    )
  }

  const verboseLive = makeSessionManagerLive(getVerboseToolNames, persistedSessions)
  const socketConfigLive = Layer.succeed(SocketConfig, { socketPath })
  const serverLayer = SocketServerLive.pipe(
    Layer.provide(verboseLive),
    Layer.provide(socketConfigLive),
  )
  const AppLayer = Layer.merge(verboseLive, serverLayer)

  const runtime = ManagedRuntime.make(AppLayer)
  _runtime = runtime

  // Eagerly initialize the runtime so the socket server starts immediately
  runtime.runFork(Effect.never)

  context.subscriptions.push({
    dispose: () => {
      void _runtime?.dispose()
    },
  })

  context.environmentVariableCollection.replace('VSCODE_CLAUDE_SOCKET', socketPath)
  context.environmentVariableCollection.description =
    'Agent Terminal Manager: provides socket path for agent hook events'

  const correlateSessionFn = (
    pid: number,
    terminals: ReadonlyArray<vscode.Terminal>,
  ): Promise<vscode.Terminal | undefined> =>
    runtime.runPromise(correlateSession(pid, terminals)).catch(() => undefined)

  const onCorrelationResultFn = (
    sessionId: string,
    terminalId: number,
  ): void => {
    runtime.runFork(
      Effect.gen(function* () {
        const sm = yield* SessionManager
        yield* sm.setTerminalId(sessionId, terminalId)
      }),
    )
  }

  // Window registry: publish this window's terminals so other windows can see them
  const windowId = socketId
  const globalStoragePath = context.globalStorageUri.fsPath

  // providerRef is captured by getCurrentEntry closure; set after provider creation
  // eslint-disable-next-line prefer-const
  let providerRef: ClaudeTerminalProvider | undefined
  let currentBranch = detectGitBranch(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)

  const getCurrentEntry = (): WindowEntry => {
    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    return {
      windowId,
      workspaceName: vscode.workspace.name ?? 'Untitled',
      ...(folderPath !== undefined ? { workspaceFolderPath: folderPath } : {}),
      ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
      socketPath,
      terminals:
        providerRef?.getTerminalInfoForRegistry() ??
        vscode.window.terminals.map((t) => ({ name: t.name })),
      lastHeartbeat: Date.now(),
    }
  }

  const provider = new ClaudeTerminalProvider(
    (callback) => {
      runtime.runFork(
        Effect.gen(function* () {
          const sm = yield* SessionManager
          yield* sm.changes.pipe(
            Stream.runForEach((sessions) =>
              Effect.gen(function* () {
                const active = sessions.filter((s) => s.status !== 'inactive')
                outputChannel.appendLine(
                  `[CTM] Sessions: ${active.length} active — ` +
                    (active.length === 0
                      ? 'none'
                      : active
                          .map(
                            (s) =>
                              `${s.sessionId.slice(0, 8)} status=${s.status} terminalId=${s.terminalId ?? 'unset'}`,
                          )
                          .join(', ')),
                )
                callback(sessions)

                // Auto-clear attention when the session's terminal is already focused
                const activeTerminal = vscode.window.activeTerminal
                if (activeTerminal !== undefined && providerRef !== undefined) {
                  const activeSession = providerRef.getSessionForTerminal(activeTerminal)
                  if (activeSession !== undefined && activeSession.needsAttention) {
                    providerRef.clearAttentionLocal(activeSession.sessionId)
                    yield* Effect.fork(sm.clearAttention(activeSession.sessionId))
                  } else if (activeSession === undefined) {
                    // Terminal not correlated — attempt on-demand correlation
                    const activePid = providerRef.getTerminalPid(activeTerminal)
                    if (activePid !== undefined) {
                      yield* Effect.fork(
                        Effect.gen(function* () {
                          const allSessions = yield* sm.getAll()
                          for (const currentSession of allSessions) {
                            if (currentSession.needsAttention && currentSession.terminalId === undefined) {
                              const match = yield* correlateSession(currentSession.pid, [activeTerminal])
                              if (match !== undefined) {
                                yield* sm.setTerminalId(currentSession.sessionId, activePid)
                                yield* sm.clearAttention(currentSession.sessionId)
                                break
                              }
                            }
                          }
                        }),
                      )
                    }
                  }
                }

                const toSave = sessions.filter((s) => s.status !== 'inactive')
                void context.workspaceState.update(SESSIONS_KEY, toSave)
                yield* writeWindowEntry(globalStoragePath, getCurrentEntry())

                // Resolve slugs for sessions that have cwd but no slug yet
                // Skip non-Claude sessions — slug resolution reads Claude-specific JSONL files
                for (const session of active) {
                  if (session.source !== 'claude') continue
                  if (session.cwd !== undefined && session.slug === undefined) {
                    yield* resolveSessionSlug(session.cwd, session.sessionId).pipe(
                      Effect.flatMap((slug) =>
                        slug !== undefined
                          ? sm.setSlug(session.sessionId, slug)
                          : Effect.void,
                      ),
                      Effect.fork,
                    )
                  }
                }
              }),
            ),
          )
        }),
      )
    },
    correlateSessionFn,
    onCorrelationResultFn,
    (terminalPid: number) => {
      runtime.runFork(
        Effect.gen(function* () {
          const sm = yield* SessionManager
          yield* sm.clearTerminalId(terminalPid)
        }),
      )
    },
    context.workspaceState,
    context.extensionUri,
  )
  providerRef = provider
  context.subscriptions.push(provider)

  const treeView = vscode.window.createTreeView('claudeTerminalManagerPanel', {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  context.subscriptions.push(treeView)

  let selectionClearScheduled = false
  context.subscriptions.push(
    treeView.onDidChangeSelection((event: vscode.TreeViewSelectionChangeEvent<unknown>) => {
      if (event.selection.length > 0 && !selectionClearScheduled) {
        selectionClearScheduled = true
        setTimeout(() => {
          selectionClearScheduled = false
          provider.refresh()
        }, 100)
      }
    }),
  )

  const localDecorationProvider: vscode.FileDecorationProvider = {
    provideFileDecoration(uri: vscode.Uri) {
      if (uri.scheme === 'ctm') {
        return { color: new vscode.ThemeColor('terminal.ansiGreen') }
      }
      return undefined
    },
  }
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(localDecorationProvider),
  )

  // Write initial entry and prune stale/duplicate entries from crashed or reloaded windows
  const ownFolderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  runtime.runFork(writeWindowEntry(globalStoragePath, getCurrentEntry()))
  runtime.runFork(pruneStaleWindowFiles(globalStoragePath))
  runtime.runFork(pruneDuplicateWindowFiles(globalStoragePath, windowId, ownFolderPath))

  // Heartbeat: re-write entry every 30 seconds so other windows know we're alive
  runtime.runFork(
    Effect.repeat(
      Effect.flatMap(Effect.sync(getCurrentEntry), (e) =>
        writeWindowEntry(globalStoragePath, e),
      ),
      Schedule.spaced('30 seconds'),
    ),
  )

  // Session reaper: detect dead processes and synthesize session_end events
  runtime.runFork(
    Effect.repeat(
      Effect.gen(function* () {
        const sm = yield* SessionManager
        const sessions = yield* sm.getAll()
        for (const session of sessions) {
          if (session.pid > 0 && session.status !== 'inactive') {
            let alive = false
            try {
              process.kill(session.pid, 0)
              alive = true
            } catch {
              // Process is dead
            }
            if (!alive) {
              outputChannel.appendLine(
                `[CTM] Reaper: pid ${session.pid} dead, ending session ${session.sessionId.slice(0, 8)}`,
              )
              yield* sm.processEvent({
                event: 'session_end',
                session_id: session.sessionId,
                pid: session.pid,
                source: session.source,
              })
            }
          }
        }
      }),
      Schedule.spaced('5 seconds'),
    ),
  )

  // Set initial branch info on provider
  provider.setBranchInfo(vscode.workspace.name, currentBranch)

  // Periodic branch detection: update provider and window entry when branch changes
  runtime.runFork(
    Effect.repeat(
      Effect.gen(function* () {
        const branch = detectGitBranch(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
        if (branch !== currentBranch) {
          currentBranch = branch
          provider.setBranchInfo(vscode.workspace.name, branch)
          // Write registry immediately so other windows see the change without waiting for heartbeat
          yield* writeWindowEntry(globalStoragePath, getCurrentEntry())
        }
      }),
      Schedule.spaced('5 seconds'),
    ),
  )

  // Periodic slug re-resolution: pick up slug changes from Claude
  // Skip non-Claude sessions — slug resolution reads Claude-specific JSONL files
  runtime.runFork(
    Effect.repeat(
      Effect.gen(function* () {
        const sm = yield* SessionManager
        const sessions = yield* sm.getAll()
        for (const session of sessions) {
          if (session.source !== 'claude') continue
          if (session.cwd !== undefined && session.slug !== undefined && session.status !== 'inactive') {
            const latestSlug = yield* readLatestSlug(session.cwd, session.sessionId)
            if (latestSlug !== undefined && latestSlug !== session.slug) {
              yield* sm.setSlug(session.sessionId, latestSlug)
            }
          }
        }
      }),
      Schedule.spaced('5 seconds'),
    ),
  )

  // Update registry when terminals open or close
  const terminalOpenSub = vscode.window.onDidOpenTerminal(() => {
    runtime.runFork(writeWindowEntry(globalStoragePath, getCurrentEntry()))
  })
  const terminalCloseSub = vscode.window.onDidCloseTerminal(() => {
    runtime.runFork(writeWindowEntry(globalStoragePath, getCurrentEntry()))
  })
  const activeTerminalSub = vscode.window.onDidChangeActiveTerminal((terminal) => {
    // Always refresh so getTreeItem can suppress dots for the active terminal
    provider.refresh()
    if (terminal === undefined) return

    const session = provider.getSessionForTerminal(terminal)
    if (session !== undefined && session.needsAttention) {
      if (session.activeBlockingTool !== undefined) {
        // Blocking tool is active — don't clear attention on terminal focus
        return
      }
      provider.clearAttentionLocal(session.sessionId)
      runtime.runFork(
        Effect.gen(function* () {
          const sm = yield* SessionManager
          yield* sm.clearAttention(session.sessionId)
        }),
      )
      return
    }

    // Fallback: terminal not correlated yet — attempt on-demand correlation
    if (session === undefined) {
      const activePid = provider.getTerminalPid(terminal)
      if (activePid !== undefined) {
        runtime.runFork(
          Effect.gen(function* () {
            const sm = yield* SessionManager
            const sessions = yield* sm.getAll()
            for (const currentSession of sessions) {
              if (currentSession.needsAttention && currentSession.terminalId === undefined) {
                const match = yield* correlateSession(currentSession.pid, [terminal])
                if (match !== undefined) {
                  yield* sm.setTerminalId(currentSession.sessionId, activePid)
                  yield* sm.clearAttention(currentSession.sessionId)
                  break
                }
              }
            }
          }),
        )
      }
    }
  })
  context.subscriptions.push(terminalOpenSub, terminalCloseSub, activeTerminalSub)

  // Cleanup: delete our registry entry when this window closes
  context.subscriptions.push({
    dispose: () => {
      try {
        fs.unlinkSync(getWindowEntryPath(globalStoragePath, windowId))
      } catch {
        // Best-effort deletion
      }
    },
  })

  // Load remote entries once on activation
  const refreshRemoteEntries = (): void => {
    runtime.runFork(
      readAllWindowEntries(globalStoragePath, windowId, undefined, ownFolderPath).pipe(
        Effect.tap((entries) =>
          Effect.sync(() => provider.refreshRemoteTerminals(entries)),
        ),
      ),
    )
  }
  refreshRemoteEntries()

  // Watch for registry changes from other windows
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.globalStorageUri, 'window-*.json'),
  )
  const ownWindowFile = `window-${windowId}.json`
  const onRegistryChange = (uri: vscode.Uri): void => {
    // Skip changes to our own window entry to avoid self-triggered refresh loops
    if (uri.fsPath.endsWith(ownWindowFile)) return
    refreshRemoteEntries()
  }
  watcher.onDidChange(onRegistryChange)
  watcher.onDidCreate(onRegistryChange)
  watcher.onDidDelete(onRegistryChange)
  context.subscriptions.push(watcher)

  const expandAllDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.expandAll',
    async () => {
      const sections = provider.getRootSections()
      for (const section of sections) {
        await treeView.reveal(section, { expand: true, select: false })
      }
    },
  )
  context.subscriptions.push(expandAllDisposable)

  const focusDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.focusTerminal',
    (node: SessionNode | TerminalNode) => {
      if (node.kind === 'terminal') {
        node.terminal.show(false)
        return
      }
      if (node.terminal !== undefined) {
        node.terminal.show(false)
      } else {
        void vscode.window.showInformationMessage(
          'Terminal not yet correlated — open a terminal manually',
        )
      }
      if (node.kind === 'session' && node.record.needsAttention) {
        provider.clearAttentionLocal(node.record.sessionId)
        runtime.runFork(
          Effect.gen(function* () {
            const sm = yield* SessionManager
            yield* sm.clearAttention(node.record.sessionId)
          }),
        )
      }
    },
  )
  context.subscriptions.push(focusDisposable)

  const focusByIndex = (index: number): void => {
    outputChannel.appendLine(`[CTM] focusByIndex: index=${index}`)
    const node = provider.getChildByIndex(index)
    outputChannel.appendLine(
      `[CTM] focusByIndex: node kind=${node?.kind ?? 'undefined'}`,
    )
    if (node === undefined) return

    if (node.kind === 'terminal') {
      node.terminal.show(false)
      return
    }
    if (node.kind === 'session') {
      if (node.terminal !== undefined) {
        node.terminal.show(false)
      } else {
        void vscode.window.showInformationMessage(
          'Terminal not yet correlated — open a terminal manually',
        )
      }
      if (node.record.needsAttention) {
        provider.clearAttentionLocal(node.record.sessionId)
        runtime.runFork(
          Effect.gen(function* () {
            const sm = yield* SessionManager
            yield* sm.clearAttention(node.record.sessionId)
          }),
        )
      }
      return
    }
    if (node.kind === 'remoteTerminal') {
      void vscode.commands.executeCommand(
        'claudeTerminalManager.focusRemoteTerminal',
        node,
      )
    }
  }

  for (let idx = 0; idx <= 9; idx++) {
    const capturedIndex = idx
    const disposable = vscode.commands.registerCommand(
      `claudeTerminalManager.focusTerminal${idx}`,
      () => focusByIndex(capturedIndex),
    )
    context.subscriptions.push(disposable)
  }

  const focusByIndexDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.focusTerminalByIndex',
    (args: { index: number } | undefined) => {
      if (args === undefined) return
      focusByIndex(args.index)
    },
  )
  context.subscriptions.push(focusByIndexDisposable)

  const customizeShortcutsDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.customizeShortcuts',
    () => {
      void vscode.commands.executeCommand(
        'workbench.action.openGlobalKeybindings',
        'claudeTerminalManager.focusTerminal',
      )
    },
  )
  context.subscriptions.push(customizeShortcutsDisposable)

  const renameDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.renameSession',
    async (node: SessionNode) => {
      const { sessionId } = node.record
      const currentName =
        context.workspaceState.get<string>('session:name:' + sessionId) ??
        node.record.customName ??
        'Claude'
      const newName = await vscode.window.showInputBox({
        prompt: 'Enter session name',
        value: currentName,
      })
      if (newName !== undefined) {
        await context.workspaceState.update('session:name:' + sessionId, newName)
        provider.refresh()
      }
    },
  )
  context.subscriptions.push(renameDisposable)

  const resetDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.resetState',
    async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Reset all terminal state? This will forget all tracked sessions.',
        { modal: true },
        'Reset',
      )
      if (confirm !== 'Reset') return

      // Clear in-memory sessions
      runtime.runFork(
        Effect.gen(function* () {
          const sm = yield* SessionManager
          yield* sm.clearAll()
        }),
      )

      // Clear persisted sessions and session names from workspace state
      await context.workspaceState.update(SESSIONS_KEY, undefined)
      const keys = context.workspaceState.keys()
      for (const key of keys) {
        if (key.startsWith('session:name:')) {
          await context.workspaceState.update(key, undefined)
        }
      }

      provider.refresh()
      outputChannel.appendLine('[CTM] State reset by user')
    },
  )
  context.subscriptions.push(resetDisposable)

  const closeTerminalDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.closeTerminal',
    (node: SessionNode | TerminalNode) => {
      try {
        if (node.kind === 'terminal') {
          node.terminal.dispose()
          return
        }
        if (node.terminal !== undefined) {
          node.terminal.dispose()
        } else {
          runtime.runFork(
            Effect.gen(function* () {
              const sm = yield* SessionManager
              yield* sm.processEvent({
                event: 'session_end',
                session_id: node.record.sessionId,
                pid: node.record.pid,
                source: node.record.source,
              })
            }),
          )
        }
      } catch {
        runtime.runFork(
          Effect.gen(function* () {
            const sm = yield* SessionManager
            yield* sm.processEvent({
              event: 'session_end',
              session_id: (node as SessionNode).record.sessionId,
              pid: (node as SessionNode).record.pid,
              source: (node as SessionNode).record.source,
            })
          }),
        )
      }
    },
  )
  context.subscriptions.push(closeTerminalDisposable)

  const focusRemoteDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.focusRemoteTerminal',
    (node: RemoteTerminalNode) => {
      if (node === undefined || node.kind !== 'remoteTerminal') {
        outputChannel.appendLine(
          `[CTM] focusRemoteTerminal: unexpected node: ${JSON.stringify(node)}`,
        )
        return
      }
      outputChannel.appendLine(
        `[CTM] Sending focus request: windowId=${node.windowId} terminal="${node.terminalName}" pid=${node.pid ?? 'undefined'} folderPath=${node.workspaceFolderPath ?? 'undefined'}`,
      )
      runtime.runFork(
        writeFocusRequest(globalStoragePath, node.windowId, node.terminalName, node.pid, node.session?.sessionId),
      )
      // Activate the target window via `code -r <folder>` (handles Space switching)
      activateWindow(node.workspaceFolderPath)
    },
  )
  context.subscriptions.push(focusRemoteDisposable)

  const focusWindowDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.focusWindow',
    (node: SectionNode) => {
      if (node === undefined || node.kind !== 'section') {
        outputChannel.appendLine(
          `[CTM] focusWindow: unexpected node: ${JSON.stringify(node)}`,
        )
        return
      }
      if (node.sectionType === 'local') {
        // Local section — window is already focused, nothing to do
        return
      }
      outputChannel.appendLine(
        `[CTM] focusWindow: folderPath=${node.workspaceFolderPath ?? 'undefined'}`,
      )
      activateWindow(node.workspaceFolderPath)
    },
  )
  context.subscriptions.push(focusWindowDisposable)

  const installHooksDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.installHooks',
    () => {
      const results: string[] = []
      try {
        writeClaudeHooks(path.join(storageBinDir, 'reporter'))
        results.push('Claude: installed')
      } catch (err) {
        results.push(`Claude: failed (${String(err)})`)
      }
      try {
        writeCodexHooks(path.join(storageBinDir, 'reporter'))
        results.push('Codex: installed')
      } catch (err) {
        results.push(`Codex: failed (${String(err)})`)
      }
      const message = results.join(' | ')
      outputChannel.appendLine(`[CTM] Install hooks: ${message}`)
      void vscode.window.showInformationMessage(`Hooks: ${message}`)
    },
  )
  context.subscriptions.push(installHooksDisposable)

  const removeHooksDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.removeHooks',
    () => {
      const results: string[] = []
      try {
        removeClaudeHooks()
        results.push('Claude: removed')
      } catch (err) {
        results.push(`Claude: failed (${String(err)})`)
      }
      try {
        removeCodexHooks()
        results.push('Codex: removed')
      } catch (err) {
        results.push(`Codex: failed (${String(err)})`)
      }
      const message = results.join(' | ')
      outputChannel.appendLine(`[CTM] Remove hooks: ${message}`)
      void vscode.window.showInformationMessage(`Hooks: ${message}`)
    },
  )
  context.subscriptions.push(removeHooksDisposable)

  const checkHooksDisposable = vscode.commands.registerCommand(
    'claudeTerminalManager.checkHooks',
    () => {
      const claude = checkClaudeHooks()
      const codex = checkCodexHooks()
      const claudeStatus = claude.installed
        ? `Claude: ${claude.events.join(', ')}`
        : 'Claude: not installed'
      const codexStatus = codex.installed
        ? `Codex: ${codex.events.join(', ')}`
        : 'Codex: not installed'
      const message = `${claudeStatus} | ${codexStatus}`
      outputChannel.appendLine(`[CTM] ${message}`)
      void vscode.window.showInformationMessage(message)
    },
  )
  context.subscriptions.push(checkHooksDisposable)

  // Watch for incoming focus requests targeting THIS window.
  // Use Node.js fs.watch instead of VS Code's FileSystemWatcher because
  // the latter is unreliable for detecting changes made by other VS Code
  // window processes in the globalStorage directory.
  const focusFileName = 'focus-' + windowId + '.json'
  const handleFocusRequest = (): void => {
    const focusPath = getFocusRequestPath(globalStoragePath, windowId)
    try {
      const req = JSON.parse(
        fs.readFileSync(focusPath, 'utf8'),
      ) as FocusRequest
      outputChannel.appendLine(
        `[CTM] Focus request received: terminal="${req.terminalName}" pid=${req.pid ?? 'undefined'}`,
      )
      let terminal: vscode.Terminal | undefined
      if (req.pid !== undefined) {
        // Match by PID for exact terminal identification
        terminal = vscode.window.terminals.find(
          (t) => provider.getTerminalPid(t) === req.pid,
        )
      }
      // Fall back to name match if PID match fails
      if (terminal === undefined) {
        terminal = vscode.window.terminals.find(
          (t) => t.name === req.terminalName,
        )
      }
      if (terminal !== undefined) {
        terminal.show(false)
        outputChannel.appendLine('[CTM] Terminal found and shown')
      } else {
        outputChannel.appendLine(
          `[CTM] Terminal "${req.terminalName}" not found among ${vscode.window.terminals.length} terminals: [${vscode.window.terminals.map((t) => t.name).join(', ')}]`,
        )
      }
      if (req.sessionId !== undefined) {
        provider.clearAttentionLocal(req.sessionId)
        runtime.runFork(
          Effect.gen(function* () {
            const sm = yield* SessionManager
            yield* sm.clearAttention(req.sessionId!)
          }),
        )
      }
      fs.unlinkSync(focusPath)
    } catch {
      // file may not exist yet or JSON may be invalid
    }
  }

  let focusDirWatcher: fs.FSWatcher | undefined
  try {
    focusDirWatcher = fs.watch(globalStoragePath, (_event, filename) => {
      if (filename === focusFileName) {
        handleFocusRequest()
      }
    })
    outputChannel.appendLine(
      `[CTM] Watching for focus requests: ${path.join(globalStoragePath, focusFileName)}`,
    )
  } catch (err) {
    outputChannel.appendLine(
      `[CTM] Warning: could not watch for focus requests: ${String(err)}`,
    )
  }
  context.subscriptions.push({
    dispose: () => {
      focusDirWatcher?.close()
    },
  })

  const configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeTerminalManager')) {
      provider.refresh()
    }
  })
  context.subscriptions.push(configDisposable)

}

export async function deactivate(): Promise<void> {
  try {
    removeClaudeHooks()
  } catch {
    // best-effort cleanup
  }
  try {
    removeCodexHooks()
  } catch {
    // best-effort cleanup
  }
  await _runtime?.dispose()
}
