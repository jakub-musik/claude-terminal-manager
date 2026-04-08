import * as vscode from 'vscode'
import type { SessionRecord } from './stateMachine.js'
import { getShowNonClaudeTerminals, getShowTerminalsFromAllWindows } from './settings.js'
import type { WindowEntry, RemoteTerminalInfo } from './windowRegistry.js'

export type TerminalNode = {
  readonly kind: 'terminal'
  readonly terminal: vscode.Terminal
  readonly pid: number | undefined
}

export type SessionNode = {
  readonly kind: 'session'
  readonly record: SessionRecord
  readonly terminal: vscode.Terminal | undefined
}

export type RemoteTerminalNode = {
  readonly kind: 'remoteTerminal'
  readonly windowId: string
  readonly workspaceName: string
  readonly workspaceFolderPath?: string
  readonly terminalName: string
  readonly socketPath: string
  readonly pid?: number
  readonly session?: {
    readonly sessionId: string
    readonly status: string
    readonly subtitle: string | undefined
    readonly statusLabel: string | undefined
    readonly needsAttention?: boolean
    readonly slug?: string
    readonly customName?: string
    readonly source?: string
  }
}

export type RemoteSessionNode = {
  readonly kind: 'remoteSession'
  readonly sessionId: string
  readonly status: string
  readonly subtitle: string | undefined
  readonly statusLabel: string | undefined
  readonly needsAttention?: boolean
  readonly workspaceName: string
  readonly source?: string
}

export type SectionNode = {
  readonly kind: 'section'
  readonly sectionType: 'local' | 'remote'
  readonly windowId?: string
  readonly workspaceName?: string
  readonly workspaceFolderPath?: string
  readonly branch?: string
}

export type TreeNode = TerminalNode | SessionNode | RemoteTerminalNode | RemoteSessionNode | SectionNode

export class ClaudeTerminalProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private readonly _emitter = new vscode.EventEmitter<
    TreeNode | TreeNode[] | undefined | null | void
  >()

  readonly onDidChangeTreeData = this._emitter.event

  private readonly _disposables: vscode.Disposable[] = []

  private _sessions: ReadonlyArray<SessionRecord> = []

  private _remoteEntries: ReadonlyArray<WindowEntry> = []
  private _lastRemoteEntriesJson = '[]'

  private _currentWorkspaceName: string | undefined
  private _currentBranch: string | undefined

  /** Maps terminal process PID → Terminal object for synchronous lookup */
  private _terminalPidMap = new Map<number, vscode.Terminal>()

  /** Maps Terminal object → PID for synchronous reverse lookup */
  private _terminalToPidMap = new Map<vscode.Terminal, number>()

  /** Tracks optimistic attention clears to prevent subscription callback overwrites */
  private _pendingAttentionClears = new Map<string, number>()

  /** Maps node identity key → 0-based shortcut index across all sections */
  private _shortcutIndexMap = new Map<string, number>()

  /** Cached root section nodes from the last getChildren(undefined) call.
   *  Used to fire targeted refreshes that avoid the root-level loading indicator. */
  private _cachedRootSections: TreeNode[] = []

  constructor(
    subscribeToSessions?: (
      callback: (sessions: ReadonlyArray<SessionRecord>) => void,
    ) => void,
    private readonly _correlateSession?: (
      pid: number,
      terminals: ReadonlyArray<vscode.Terminal>,
    ) => Promise<vscode.Terminal | undefined>,
    private readonly _onCorrelationResult?: (
      sessionId: string,
      terminalId: number,
    ) => void,
    private readonly _onTerminalClosed?: (terminalPid: number) => void,
    private readonly _workspaceState?: vscode.Memento,
    private readonly _extensionUri?: vscode.Uri,
  ) {
    this._initTerminalPidMap()

    this._disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        // Fire immediately so terminal appears in tree, then again after PID resolves
        this._refreshSections()
        void this._resolveTerminalPid(terminal).then((pid) => {
          if (pid !== undefined) {
            this._terminalPidMap.set(pid, terminal)
            this._terminalToPidMap.set(terminal, pid)
            this._tryCorrelateUnmatched()
            this._refreshSections()
          }
        })
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        const closedPid = this._terminalToPidMap.get(terminal)
        this._removeTerminalFromPidMap(terminal)
        if (closedPid !== undefined) {
          this._onTerminalClosed?.(closedPid)
        }
        this._refreshSections()
      }),
    )

    if (subscribeToSessions !== undefined) {
      subscribeToSessions((sessions) => {
        let filtered = sessions.filter((s) => s.status !== 'inactive')

        // Preserve pending attention clears that haven't been confirmed yet
        if (this._pendingAttentionClears.size > 0) {
          const toRemove: string[] = []
          filtered = filtered.map((session) => {
            const clearTime = this._pendingAttentionClears.get(session.sessionId)
            if (clearTime === undefined) return session
            if (!session.needsAttention) {
              // Backend confirmed the clear
              toRemove.push(session.sessionId)
              return session
            }
            if (session.lastEventAt > clearTime) {
              // A newer event arrived after our clear — respect it
              toRemove.push(session.sessionId)
              return session
            }
            // Still pending — preserve the local clear
            return { ...session, needsAttention: false }
          })
          for (const id of toRemove) {
            this._pendingAttentionClears.delete(id)
          }
        }

        this._sessions = filtered
        this._tryCorrelateUnmatched()
        this._refreshSections()
      })
    }
  }

  /** Async-resolve processId from a terminal, guarding against undefined processId in mocks */
  private _resolveTerminalPid(
    terminal: vscode.Terminal,
  ): Promise<number | undefined> {
    // terminal.processId is Thenable<number | undefined>; may be absent in test mocks
    const processId = terminal.processId as
      | Thenable<number | undefined>
      | undefined
    if (processId === undefined || typeof processId.then !== 'function') {
      return Promise.resolve(undefined)
    }
    return new Promise<number | undefined>((resolve) => {
      processId.then(resolve, () => resolve(undefined))
    })
  }

  /** Build initial terminal→PID map from currently open terminals */
  private _initTerminalPidMap(): void {
    const terminals = [...vscode.window.terminals]
    if (terminals.length === 0) return
    void Promise.all(
      terminals.map((terminal) =>
        this._resolveTerminalPid(terminal).then((pid) => {
          if (pid !== undefined) {
            this._terminalPidMap.set(pid, terminal)
            this._terminalToPidMap.set(terminal, pid)
          }
        }),
      ),
    ).then(() => {
      this._tryCorrelateUnmatched()
      this._refreshSections()
    })
  }

  private _removeTerminalFromPidMap(terminal: vscode.Terminal): void {
    for (const [pid, t] of this._terminalPidMap) {
      if (t === terminal) {
        this._terminalPidMap.delete(pid)
        break
      }
    }
    this._terminalToPidMap.delete(terminal)
  }

  /** Check if a process is still alive (signal 0 test) */
  private _isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Run correlateSession for all currently unmatched sessions */
  private _tryCorrelateUnmatched(): void {
    if (this._correlateSession === undefined) return
    for (const session of this._sessions) {
      if (
        session.terminalId === undefined ||
        !this._terminalPidMap.has(session.terminalId)
      ) {
        const terminals = [...vscode.window.terminals]
        void this._correlateSession(session.pid, terminals).then(
          async (terminal) => {
            if (terminal !== undefined) {
              const pid = await this._resolveTerminalPid(terminal)
              if (pid !== undefined) {
                this._terminalPidMap.set(pid, terminal)
                this._onCorrelationResult?.(session.sessionId, pid)
              }
            }
          },
        )
      }
    }
  }

  /** Look up PID for a terminal object (synchronous) */
  getTerminalPid(terminal: vscode.Terminal): number | undefined {
    return this._terminalToPidMap.get(terminal)
  }

  /** Look up the session record associated with a terminal (via PID mapping) */
  getSessionForTerminal(terminal: vscode.Terminal): SessionRecord | undefined {
    const pid = this._terminalToPidMap.get(terminal)
    if (pid === undefined) return undefined
    return this._sessions.find((session) => session.terminalId === pid)
  }

  getTerminalInfoForRegistry(): RemoteTerminalInfo[] {
    return vscode.window.terminals.map((terminal) => {
      const session = this._sessions.find(
        (s) =>
          s.terminalId !== undefined &&
          this._terminalPidMap.get(s.terminalId) === terminal,
      )
      const pid = this._terminalToPidMap.get(terminal)
      return {
        name: terminal.name,
        ...(pid !== undefined ? { pid } : {}),
        ...(session !== undefined
          ? {
              session: {
                sessionId: session.sessionId,
                status: session.status,
                subtitle: session.subtitle,
                statusLabel: session.statusLabel,
                needsAttention: session.needsAttention,
                ...(session.slug !== undefined ? { slug: session.slug } : {}),
                ...(session.customName !== undefined ? { customName: session.customName } : {}),
                source: session.source,
              },
            }
          : {}),
      }
    })
  }

  /** Return local terminal and session nodes */
  private _getLocalChildren(): TreeNode[] {
    const showAll = getShowNonClaudeTerminals()
    const result: TreeNode[] = []
    const terminalsWithSessions = new Set<vscode.Terminal>()

    for (const record of this._sessions) {
      if (record.pid > 0 && !this._isProcessAlive(record.pid)) continue

      if (record.terminalId !== undefined) {
        const terminal = this._terminalPidMap.get(record.terminalId)
        if (terminal === undefined) {
          result.push({ kind: 'session', record, terminal: undefined })
        } else {
          terminalsWithSessions.add(terminal)
          result.push({ kind: 'session', record, terminal })
        }
      } else {
        result.push({ kind: 'session', record, terminal: undefined })
      }
    }

    if (showAll) {
      for (const terminal of vscode.window.terminals) {
        if (!terminalsWithSessions.has(terminal)) {
          result.push({
            kind: 'terminal',
            terminal,
            pid: this._terminalToPidMap.get(terminal),
          })
        }
      }
    }

    return result
  }

  /** Get a child node by its 0-based shortcut index (across all sections) */
  getChildByIndex(index: number): TreeNode | undefined {
    const flatChildren = this._buildFlatChildren()
    return flatChildren[index]
  }

  /** Return remote terminal nodes for a specific window */
  private _getRemoteChildren(windowId: string): TreeNode[] {
    const entry = this._remoteEntries.find((e) => e.windowId === windowId)
    if (entry === undefined) return []

    const showAll = getShowNonClaudeTerminals()
    const terminals = showAll
      ? entry.terminals
      : entry.terminals.filter((t) => t.session !== undefined)

    return terminals.map((t) => ({
      kind: 'remoteTerminal' as const,
      windowId: entry.windowId,
      workspaceName: entry.workspaceName,
      ...(entry.workspaceFolderPath !== undefined
        ? { workspaceFolderPath: entry.workspaceFolderPath }
        : {}),
      terminalName: t.name,
      socketPath: entry.socketPath,
      ...(t.pid !== undefined ? { pid: t.pid } : {}),
      ...(t.session !== undefined ? { session: t.session } : {}),
    }))
  }

  private _getSourceIcon(source: string): vscode.Uri | vscode.ThemeIcon {
    if (this._extensionUri === undefined) return new vscode.ThemeIcon('robot')
    const iconFile = source === 'codex' ? 'codex-ai.svg' : 'claude-icon.svg'
    return vscode.Uri.joinPath(this._extensionUri, 'resources', iconFile)
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'section') {
      const name = node.workspaceName ?? (node.sectionType === 'local' ? 'Local' : 'Remote')
      const label = node.branch !== undefined ? `${name} - ${node.branch}` : name
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.iconPath = new vscode.ThemeIcon(
        node.sectionType === 'local' ? 'window' : 'remote',
      )
      item.contextValue = node.sectionType === 'local' ? 'sectionLocal' : 'sectionRemote'
      item.command = {
        command: 'claudeTerminalManager.focusWindow',
        title: 'Focus Window',
        arguments: [node],
      }
      if (node.sectionType === 'local') {
        item.resourceUri = vscode.Uri.from({ scheme: 'ctm', path: '/section' })
      }
      return item
    }

    if (node.kind === 'terminal') {
      const termShortcutIdx = this.getShortcutIndex(node)
      const terminalLabel = termShortcutIdx !== undefined
        ? `${termShortcutIdx}: ${node.terminal.name}`
        : node.terminal.name
      const item = new vscode.TreeItem(
        terminalLabel,
        vscode.TreeItemCollapsibleState.None,
      )
      item.iconPath = new vscode.ThemeIcon('terminal')
      item.contextValue = 'terminal'
      item.command = {
        command: 'claudeTerminalManager.focusTerminal',
        title: 'Focus Terminal',
        arguments: [node],
      }
      if (node.pid !== undefined) {
        item.resourceUri = vscode.Uri.from({ scheme: 'ctm', path: '/terminal/' + node.pid })
      }
      return item
    }

    if (node.kind === 'session') {
      const storedName = this._workspaceState?.get<string>(
        'session:name:' + node.record.sessionId,
      )
      const fallbackName = node.record.source === 'codex' ? 'Codex' : 'Claude'
      const baseLabel =
        storedName ??
        node.record.slug ??
        fallbackName
      const isActiveTerminal = node.terminal !== undefined
        && node.terminal === vscode.window.activeTerminal
      const effectiveNeedsAttention = node.record.needsAttention && (!isActiveTerminal || node.record.activeBlockingTool !== undefined)
      const decoratedLabel = effectiveNeedsAttention
        ? `● ${baseLabel}`
        : node.record.status === 'waiting_for_input'
          ? `○ ${baseLabel}`
          : baseLabel
      const sessionShortcutIdx = this.getShortcutIndex(node)
      const label = sessionShortcutIdx !== undefined
        ? `${sessionShortcutIdx}: ${decoratedLabel}`
        : decoratedLabel
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
      )
      item.iconPath = this._getSourceIcon(node.record.source)
      item.contextValue = 'claudeSession'
      item.command = {
        command: 'claudeTerminalManager.focusTerminal',
        title: 'Focus Terminal',
        arguments: [node],
      }
      const descParts = [
        node.record.subtitle,
        node.record.statusLabel,
      ].filter((s): s is string => s !== undefined)
      if (descParts.length > 0) {
        item.description = descParts.join(' — ')
      }
      const toolName = node.record.source === 'codex' ? 'Codex' : 'Claude'
      item.tooltip = new vscode.MarkdownString(
        `**${toolName} Session:** ` +
          node.record.sessionId +
          '\n\n' +
          (node.record.subtitle ?? 'No prompt yet'),
      )
      item.accessibilityInformation = {
        label: baseLabel + ': ' + (node.record.subtitle ?? 'waiting'),
      }
      item.resourceUri = vscode.Uri.from({ scheme: 'ctm', path: '/session/' + node.record.sessionId })
      return item
    }

    if (node.kind === 'remoteTerminal') {
      const hasSession = node.session !== undefined
      const isWaiting = node.session?.status === 'waiting_for_input'
      const needsAttention = node.session?.needsAttention ?? false
      const remoteSource = node.session?.source ?? 'claude'
      const remoteFallback = remoteSource === 'codex' ? 'Codex' : 'Claude'
      const baseLabel = hasSession
        ? (node.session.slug ?? remoteFallback)
        : node.terminalName
      const remoteDecoratedLabel = needsAttention
        ? `● ${baseLabel}`
        : isWaiting
          ? `○ ${baseLabel}`
          : baseLabel
      const remoteShortcutIdx = this.getShortcutIndex(node)
      const label = remoteShortcutIdx !== undefined
        ? `${remoteShortcutIdx}: ${remoteDecoratedLabel}`
        : remoteDecoratedLabel
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
      )
      item.iconPath =
        hasSession
          ? this._getSourceIcon(remoteSource)
          : new vscode.ThemeIcon('terminal-tmux')
      item.contextValue = 'remoteTerminal'
      item.command = {
        command: 'claudeTerminalManager.focusRemoteTerminal',
        title: 'Focus Remote Terminal',
        arguments: [node],
      }
      if (hasSession) {
        const descParts = [
          node.session.subtitle,
          node.session.statusLabel,
        ].filter((s): s is string => s !== undefined)
        if (descParts.length > 0) {
          item.description = descParts.join(' — ')
        }
      }
      const remoteToolName = remoteSource === 'codex' ? 'Codex' : 'Claude'
      item.tooltip = new vscode.MarkdownString(
        hasSession
          ? `**Remote ${remoteToolName} session** in window: ` + node.workspaceName
          : '**Remote terminal** in window: ' + node.workspaceName,
      )
      return item
    }

    if (node.kind === 'remoteSession') {
      const rsToolName = (node.source ?? 'claude') === 'codex' ? 'Codex' : 'Claude'
      const baseLabel = `${rsToolName}: ${node.sessionId.slice(0, 8)}`
      const needsAttention = node.needsAttention ?? true
      const rsDecoratedLabel = needsAttention
        ? `● ${baseLabel}`
        : node.status === 'waiting_for_input'
          ? `○ ${baseLabel}`
          : baseLabel
      const rsShortcutIdx = this.getShortcutIndex(node)
      const label = rsShortcutIdx !== undefined
        ? `${rsShortcutIdx}: ${rsDecoratedLabel}`
        : rsDecoratedLabel
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
      )
      item.iconPath = this._getSourceIcon(node.source ?? 'claude')
      const descParts = [node.subtitle, node.statusLabel].filter(
        (s): s is string => s !== undefined,
      )
      if (descParts.length > 0) {
        item.description = descParts.join(' — ')
      }
      item.tooltip = new vscode.MarkdownString(
        '**Session:** ' +
          node.sessionId +
          '\n\n' +
          (node.subtitle ?? 'No prompt yet'),
      )
      return item
    }

    // Exhaustive: all TreeNode kinds handled above
    return new vscode.TreeItem('unknown')
  }

  /** Identity key for a tree node, used for shortcut index lookup */
  private _getNodeKey(node: TreeNode): string | undefined {
    switch (node.kind) {
      case 'session': return `s:${node.record.sessionId}`
      case 'terminal': return `t:${node.pid ?? node.terminal.name}`
      case 'remoteTerminal': return `rt:${node.windowId}:${node.terminalName}:${node.pid ?? ''}`
      case 'remoteSession': return `rs:${node.sessionId}`
      default: return undefined
    }
  }

  /** Build sorted root section nodes (shared between getChildren and index computation) */
  private _buildRootSections(): SectionNode[] {
    const sections: SectionNode[] = []

    sections.push({
      kind: 'section',
      sectionType: 'local',
      ...(this._currentWorkspaceName !== undefined ? { workspaceName: this._currentWorkspaceName } : {}),
      ...(this._currentBranch !== undefined ? { branch: this._currentBranch } : {}),
    })

    if (getShowTerminalsFromAllWindows()) {
      for (const entry of this._remoteEntries) {
        sections.push({
          kind: 'section',
          sectionType: 'remote',
          windowId: entry.windowId,
          workspaceName: entry.workspaceName,
          ...(entry.workspaceFolderPath !== undefined ? { workspaceFolderPath: entry.workspaceFolderPath } : {}),
          ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
        })
      }
    }

    sections.sort((sectionA, sectionB) => {
      const nameA = (sectionA.workspaceName ?? '').toLowerCase()
      const nameB = (sectionB.workspaceName ?? '').toLowerCase()
      const nameOrder = nameA.localeCompare(nameB)
      if (nameOrder !== 0) return nameOrder
      const branchA = (sectionA.branch ?? '').toLowerCase()
      const branchB = (sectionB.branch ?? '').toLowerCase()
      return branchA.localeCompare(branchB)
    })

    return sections
  }

  /** Build a flat list of all non-section children across all sections in display order */
  private _buildFlatChildren(): TreeNode[] {
    const sections = this._buildRootSections()
    const result: TreeNode[] = []
    for (const section of sections) {
      const children = section.sectionType === 'local'
        ? this._getLocalChildren()
        : section.windowId !== undefined
          ? this._getRemoteChildren(section.windowId)
          : []
      result.push(...children)
    }
    return result
  }

  /** Recompute the shortcut index map from the current tree state */
  private _recomputeShortcutIndices(): void {
    this._shortcutIndexMap.clear()
    const flatChildren = this._buildFlatChildren()
    for (let idx = 0; idx < flatChildren.length; idx++) {
      const key = this._getNodeKey(flatChildren[idx]!)
      if (key !== undefined) {
        this._shortcutIndexMap.set(key, idx)
      }
    }
  }

  /** Look up the shortcut index for a node */
  getShortcutIndex(node: TreeNode): number | undefined {
    const key = this._getNodeKey(node)
    if (key === undefined) return undefined
    return this._shortcutIndexMap.get(key)
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (node.kind === 'section') return undefined
    if (node.kind === 'session' || node.kind === 'terminal') {
      return this._buildRootSections().find((section) => section.sectionType === 'local')
    }
    if (node.kind === 'remoteTerminal') {
      return this._buildRootSections().find(
        (section) => section.sectionType === 'remote' && section.windowId === node.windowId,
      )
    }
    return undefined
  }

  getRootSections(): SectionNode[] {
    return this._buildRootSections()
  }

  getChildren(parent?: TreeNode): TreeNode[] {
    if (parent !== undefined) {
      if (parent.kind === 'section') {
        if (parent.sectionType === 'local') {
          return this._getLocalChildren()
        }
        if (parent.windowId !== undefined) {
          return this._getRemoteChildren(parent.windowId)
        }
        return []
      }

      return []
    }

    // Root level — return section nodes
    const sections = this._buildRootSections()

    console.log('[CTM] getChildren root sections:', sections.map((section) => {
      const name = section.workspaceName ?? ''
      return section.branch !== undefined ? `${name} - ${section.branch}` : name
    }))

    this._cachedRootSections = sections
    return sections
  }

  /** Refresh children of cached section nodes without triggering the root loading indicator.
   *  Falls back to a full root refresh if no sections are cached yet. */
  private _refreshSections(): void {
    this._recomputeShortcutIndices()
    if (this._cachedRootSections.length > 0) {
      this._emitter.fire(this._cachedRootSections)
    } else {
      this._emitter.fire()
    }
  }

  /** Full root refresh — rebuilds sections. Needed when sections are added/removed. */
  private _refreshRoot(): void {
    this._recomputeShortcutIndices()
    this._cachedRootSections = []
    this._emitter.fire()
  }

  /** Optimistically clear needsAttention on a session and refresh the tree immediately */
  clearAttentionLocal(sessionId: string): void {
    const index = this._sessions.findIndex((session) => session.sessionId === sessionId)
    if (index === -1) return
    const session = this._sessions[index]
    if (session === undefined) return
    if (!session.needsAttention) return
    if (session.activeBlockingTool !== undefined) return
    this._pendingAttentionClears.set(sessionId, Date.now())
    const updated = [...this._sessions]
    updated[index] = { ...session, needsAttention: false } as SessionRecord
    this._sessions = updated
    this._refreshSections()
  }

  refresh(): void {
    this._refreshSections()
  }

  refreshRemoteTerminals(entries: ReadonlyArray<WindowEntry>): void {
    const serialized = JSON.stringify(entries)
    if (serialized === this._lastRemoteEntriesJson) return
    this._lastRemoteEntriesJson = serialized

    const structureChanged =
      entries.length !== this._remoteEntries.length ||
      entries.some((entry, idx) => entry.windowId !== this._remoteEntries[idx]?.windowId)

    const sectionLabelsChanged = !structureChanged && entries.some((entry, idx) => {
      const old = this._remoteEntries[idx]
      return old !== undefined && (
        entry.branch !== old.branch ||
        entry.workspaceName !== old.workspaceName
      )
    })

    this._remoteEntries = entries

    if (structureChanged || sectionLabelsChanged) {
      this._refreshRoot()
    } else {
      this._refreshSections()
    }
  }

  setBranchInfo(workspaceName: string | undefined, branch: string | undefined): void {
    if (this._currentWorkspaceName === workspaceName && this._currentBranch === branch) return
    this._currentWorkspaceName = workspaceName
    this._currentBranch = branch
    // Section labels change — need root refresh to rebuild section nodes
    this._refreshRoot()
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose()
    }
    this._disposables.length = 0
  }
}
