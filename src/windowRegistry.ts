import * as fs from 'node:fs'
import * as path from 'node:path'
import { Effect } from 'effect'

export interface RemoteSessionInfo {
  readonly sessionId: string
  readonly status: string
  readonly subtitle: string | undefined
  readonly statusLabel: string | undefined
  readonly needsAttention?: boolean
  readonly slug?: string
  readonly customName?: string
  readonly source?: string
}

export interface RemoteTerminalInfo {
  readonly name: string
  readonly pid?: number
  readonly customName?: string
  readonly session?: RemoteSessionInfo
}

export interface WindowEntry {
  readonly windowId: string
  readonly workspaceName: string
  readonly workspaceFolderPath?: string
  readonly branch?: string
  readonly socketPath: string
  readonly terminals: ReadonlyArray<RemoteTerminalInfo>
  readonly lastHeartbeat: number
}

export const getWindowEntryPath = (
  globalStoragePath: string,
  windowId: string,
): string => path.join(globalStoragePath, 'window-' + windowId + '.json')

export const writeWindowEntry = (
  globalStoragePath: string,
  entry: WindowEntry,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    fs.writeFileSync(
      getWindowEntryPath(globalStoragePath, entry.windowId),
      JSON.stringify(entry),
    )
  }).pipe(
    Effect.catchAll((e) =>
      Effect.logWarning('writeWindowEntry failed: ' + String(e)),
    ),
  )

export const readAllWindowEntries = (
  globalStoragePath: string,
  ownWindowId: string,
  maxAgeMs?: number,
  ownWorkspaceFolderPath?: string,
): Effect.Effect<ReadonlyArray<WindowEntry>, never> =>
  Effect.sync((): ReadonlyArray<WindowEntry> => {
    try {
      const now = Date.now()
      const maxAge = maxAgeMs ?? 90_000
      const files = fs.readdirSync(globalStoragePath)
      const result: WindowEntry[] = []
      for (const file of files) {
        if (!file.startsWith('window-') || !file.endsWith('.json')) continue
        if (file === 'window-' + ownWindowId + '.json') continue
        try {
          const content = fs.readFileSync(
            path.join(globalStoragePath, file),
            'utf8',
          )
          const entry = JSON.parse(content) as WindowEntry
          if (now - entry.lastHeartbeat > maxAge) continue
          if (
            ownWorkspaceFolderPath !== undefined &&
            entry.workspaceFolderPath === ownWorkspaceFolderPath
          )
            continue
          result.push(entry)
        } catch {
          // Skip files that fail to parse or read
        }
      }
      // Deduplicate remote entries by workspaceFolderPath, keeping the freshest
      const deduped = new Map<string, WindowEntry>()
      for (const entry of result) {
        const key = entry.workspaceFolderPath ?? entry.windowId
        const existing = deduped.get(key)
        if (existing === undefined || entry.lastHeartbeat > existing.lastHeartbeat) {
          deduped.set(key, entry)
        }
      }
      return Array.from(deduped.values())
    } catch {
      return []
    }
  })

export const deleteWindowEntry = (
  globalStoragePath: string,
  windowId: string,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    fs.unlinkSync(getWindowEntryPath(globalStoragePath, windowId))
  }).pipe(Effect.catchAll(() => Effect.void))

export const pruneDuplicateWindowFiles = (
  globalStoragePath: string,
  ownWindowId: string,
  ownWorkspaceFolderPath: string | undefined,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    if (ownWorkspaceFolderPath === undefined) return
    const files = fs.readdirSync(globalStoragePath)
    for (const file of files) {
      if (!file.startsWith('window-') || !file.endsWith('.json')) continue
      if (file === 'window-' + ownWindowId + '.json') continue
      const filePath = path.join(globalStoragePath, file)
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const entry = JSON.parse(content) as WindowEntry
        if (entry.workspaceFolderPath === ownWorkspaceFolderPath) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // Skip files that can't be read or parsed
      }
    }
  }).pipe(Effect.catchAll(() => Effect.void))

// CTM-4829
export const pruneStaleWindowFiles = (
  globalStoragePath: string,
  maxAgeMs?: number,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    const now = Date.now()
    const maxAge = maxAgeMs ?? 90_000
    const files = fs.readdirSync(globalStoragePath)
    for (const file of files) {
      if (!file.startsWith('window-') || !file.endsWith('.json')) continue
      const filePath = path.join(globalStoragePath, file)
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const entry = JSON.parse(content) as WindowEntry
        if (now - entry.lastHeartbeat > maxAge) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // Skip files that can't be read or parsed
      }
    }
  }).pipe(Effect.catchAll(() => Effect.void))
