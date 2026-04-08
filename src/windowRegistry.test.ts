import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, beforeEach, expect } from 'vitest'
import {
  type WindowEntry,
  deleteWindowEntry,
  pruneDuplicateWindowFiles,
  pruneStaleWindowFiles,
  readAllWindowEntries,
  writeWindowEntry,
} from './windowRegistry.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = os.tmpdir() + '/registry-test-' + Date.now()
  fs.mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const baseEntry = (): WindowEntry => ({
  windowId: '12345',
  workspaceName: 'my-project',
  socketPath: '/tmp/vscode-claude-12345.sock',
  terminals: [{ name: 'bash' }, { name: 'zsh', pid: 99 }],
  lastHeartbeat: Date.now(),
})

describe('windowRegistry', () => {
  // Scenario 1 — writeWindowEntry creates a correctly-formatted JSON file
  it.effect('writeWindowEntry creates a correctly-formatted JSON file', () =>
    Effect.gen(function* () {
      const entry = baseEntry()
      yield* writeWindowEntry(tmpDir, entry)
      const filePath = path.join(tmpDir, 'window-12345.json')
      expect(fs.existsSync(filePath)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WindowEntry
      expect(parsed.windowId).toBe(entry.windowId)
      expect(parsed.workspaceName).toBe(entry.workspaceName)
      expect(parsed.socketPath).toBe(entry.socketPath)
      expect(parsed.terminals).toEqual(entry.terminals)
      expect(parsed.lastHeartbeat).toBe(entry.lastHeartbeat)
    }),
  )

  // Scenario 2 — writeWindowEntry overwrites an existing file
  it.effect('writeWindowEntry overwrites an existing file', () =>
    Effect.gen(function* () {
      const entry: WindowEntry = { ...baseEntry(), windowId: '999' }
      yield* writeWindowEntry(tmpDir, { ...entry, workspaceName: 'old' })
      yield* writeWindowEntry(tmpDir, { ...entry, workspaceName: 'new' })
      const files = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('window-999'))
      expect(files).toHaveLength(1)
      const filePath = path.join(tmpDir, 'window-999.json')
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WindowEntry
      expect(parsed.workspaceName).toBe('new')
    }),
  )

  // Scenario 3 — readAllWindowEntries excludes own windowId
  it.effect(
    'readAllWindowEntries reads files from all OTHER windows (excludes own)',
    () =>
      Effect.gen(function* () {
        yield* writeWindowEntry(tmpDir, { ...baseEntry(), windowId: '111' })
        yield* writeWindowEntry(tmpDir, { ...baseEntry(), windowId: '222' })
        const entries = yield* readAllWindowEntries(tmpDir, '111')
        expect(entries).toHaveLength(1)
        expect(entries[0]?.windowId).toBe('222')
      }),
  )

  // Scenario 4 — readAllWindowEntries skips stale entries
  it.effect(
    'readAllWindowEntries skips entries with lastHeartbeat older than maxAgeMs',
    () =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'fresh',
          lastHeartbeat: now,
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'stale',
          lastHeartbeat: now - 100_000,
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'borderline',
          lastHeartbeat: now - 50_000,
        })
        const entries = yield* readAllWindowEntries(tmpDir, 'own', 60_000)
        const ids = entries.map((e) => e.windowId)
        expect(ids).toContain('fresh')
        expect(ids).toContain('borderline')
        expect(ids).not.toContain('stale')
      }),
  )

  // Scenario 5 — readAllWindowEntries returns empty array when directory is empty
  it.effect(
    'readAllWindowEntries returns empty array when directory is empty',
    () =>
      Effect.gen(function* () {
        const entries = yield* readAllWindowEntries(tmpDir, 'own')
        expect(entries).toEqual([])
      }),
  )

  // Scenario 6 — readAllWindowEntries skips files that are not valid JSON
  it.effect('readAllWindowEntries skips files that are not valid JSON', () =>
    Effect.gen(function* () {
      yield* writeWindowEntry(tmpDir, { ...baseEntry(), windowId: 'aaa' })
      fs.writeFileSync(path.join(tmpDir, 'window-bbb.json'), 'not json{{{')
      const entries = yield* readAllWindowEntries(tmpDir, 'own')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.windowId).toBe('aaa')
    }),
  )

  // Scenario 7 — deleteWindowEntry deletes the file
  it.effect('deleteWindowEntry deletes the file', () =>
    Effect.gen(function* () {
      yield* writeWindowEntry(tmpDir, { ...baseEntry(), windowId: 'todelete' })
      const filePath = path.join(tmpDir, 'window-todelete.json')
      expect(fs.existsSync(filePath)).toBe(true)
      yield* deleteWindowEntry(tmpDir, 'todelete')
      expect(fs.existsSync(filePath)).toBe(false)
    }),
  )

  // Scenario 8 — deleteWindowEntry succeeds even if file does not exist
  it.effect('deleteWindowEntry succeeds even if file does not exist', () =>
    Effect.gen(function* () {
      yield* deleteWindowEntry(tmpDir, 'nonexistent')
      // No assertion needed — effect must complete without error
    }),
  )

  // Scenario 9 — pruneStaleWindowFiles deletes only stale files, preserves fresh ones
  it.effect(
    'pruneStaleWindowFiles deletes only stale files, preserves fresh ones',
    () =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'fresh',
          lastHeartbeat: now,
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'stale1',
          lastHeartbeat: now - 200_000,
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'stale2',
          lastHeartbeat: now - 150_000,
        })
        fs.writeFileSync(path.join(tmpDir, 'other.json'), '{}')
        yield* pruneStaleWindowFiles(tmpDir)
        expect(fs.existsSync(path.join(tmpDir, 'window-fresh.json'))).toBe(true)
        expect(fs.existsSync(path.join(tmpDir, 'window-stale1.json'))).toBe(
          false,
        )
        expect(fs.existsSync(path.join(tmpDir, 'window-stale2.json'))).toBe(
          false,
        )
        expect(fs.existsSync(path.join(tmpDir, 'other.json'))).toBe(true)
      }),
  )

  // Scenario 10 — Heartbeat: two successive writes update lastHeartbeat
  it.effect('two successive writes update lastHeartbeat', () =>
    Effect.gen(function* () {
      const entry: WindowEntry = { ...baseEntry(), windowId: 'heartbeat-win' }
      yield* writeWindowEntry(tmpDir, { ...entry, lastHeartbeat: 1000 })
      const before = Date.now()
      yield* writeWindowEntry(tmpDir, { ...entry, lastHeartbeat: Date.now() })
      const filePath = path.join(tmpDir, 'window-heartbeat-win.json')
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WindowEntry
      expect(parsed.lastHeartbeat).toBeGreaterThan(1000)
      expect(Date.now() - parsed.lastHeartbeat).toBeLessThan(
        Date.now() - before + 1000,
      )
    }),
  )

  // Scenario 11 — Terminals list in the written entry matches input terminals
  it.effect('terminals list in written entry matches input terminals', () =>
    Effect.gen(function* () {
      const entry: WindowEntry = {
        ...baseEntry(),
        windowId: 'terminals-test',
        terminals: [
          { name: 'bash' },
          { name: 'node', pid: 42 },
          { name: 'python', pid: 99, customName: 'b4d92e1f-a378' },
        ],
      }
      yield* writeWindowEntry(tmpDir, entry)
      const filePath = path.join(tmpDir, 'window-terminals-test.json')
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WindowEntry
      expect(parsed.terminals).toHaveLength(3)
      expect(parsed.terminals[0]).toEqual({ name: 'bash' })
      expect(parsed.terminals[1]).toEqual({ name: 'node', pid: 42 })
      expect(parsed.terminals[2]).toEqual({
        name: 'python',
        pid: 99,
        customName: 'b4d92e1f-a378',
      })
    }),
  )

  // Scenario 12 — readAllWindowEntries ignores non-window files
  it.effect('readAllWindowEntries ignores non-window files in the directory', () =>
    Effect.gen(function* () {
      yield* writeWindowEntry(tmpDir, { ...baseEntry(), windowId: 'abc' })
      fs.writeFileSync(
        path.join(tmpDir, 'other-data.json'),
        JSON.stringify({ foo: 'bar' }),
      )
      fs.writeFileSync(path.join(tmpDir, 'window-data'), 'no extension')
      const entries = yield* readAllWindowEntries(tmpDir, 'own')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.windowId).toBe('abc')
    }),
  )

  // Scenario 13 — readAllWindowEntries excludes entries with matching workspaceFolderPath
  it.effect(
    'readAllWindowEntries excludes entries with matching workspaceFolderPath',
    () =>
      Effect.gen(function* () {
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'old-pid',
          workspaceFolderPath: '/projects/myapp',
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'different-project',
          workspaceFolderPath: '/projects/other',
        })
        const entries = yield* readAllWindowEntries(
          tmpDir,
          'current-pid',
          undefined,
          '/projects/myapp',
        )
        expect(entries).toHaveLength(1)
        expect(entries[0]?.windowId).toBe('different-project')
      }),
  )

  // Scenario 14 — readAllWindowEntries deduplicates remote entries with same workspaceFolderPath
  it.effect(
    'readAllWindowEntries deduplicates remote entries by workspaceFolderPath, keeping freshest',
    () =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'old-pid',
          workspaceFolderPath: '/projects/myapp',
          lastHeartbeat: now - 5000,
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'new-pid',
          workspaceFolderPath: '/projects/myapp',
          lastHeartbeat: now,
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'other-project',
          workspaceFolderPath: '/projects/other',
        })
        const entries = yield* readAllWindowEntries(tmpDir, 'own')
        expect(entries).toHaveLength(2)
        const myappEntry = entries.find(
          (entry) => entry.workspaceFolderPath === '/projects/myapp',
        )
        expect(myappEntry?.windowId).toBe('new-pid')
      }),
  )

  // Scenario 15 — pruneDuplicateWindowFiles deletes files with same folder path but different windowId
  it.effect(
    'pruneDuplicateWindowFiles deletes files with same folder path but different windowId',
    () =>
      Effect.gen(function* () {
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'current',
          workspaceFolderPath: '/projects/myapp',
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'stale-old',
          workspaceFolderPath: '/projects/myapp',
        })
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'other-project',
          workspaceFolderPath: '/projects/other',
        })
        yield* pruneDuplicateWindowFiles(tmpDir, 'current', '/projects/myapp')
        expect(
          fs.existsSync(path.join(tmpDir, 'window-current.json')),
        ).toBe(true)
        expect(
          fs.existsSync(path.join(tmpDir, 'window-stale-old.json')),
        ).toBe(false)
        expect(
          fs.existsSync(path.join(tmpDir, 'window-other-project.json')),
        ).toBe(true)
      }),
  )

  // Scenario 16 — pruneDuplicateWindowFiles does nothing when ownWorkspaceFolderPath is undefined
  it.effect(
    'pruneDuplicateWindowFiles does nothing when ownWorkspaceFolderPath is undefined',
    () =>
      Effect.gen(function* () {
        yield* writeWindowEntry(tmpDir, {
          ...baseEntry(),
          windowId: 'some-window',
          workspaceFolderPath: '/projects/myapp',
        })
        yield* pruneDuplicateWindowFiles(tmpDir, 'current', undefined)
        expect(
          fs.existsSync(path.join(tmpDir, 'window-some-window.json')),
        ).toBe(true)
      }),
  )

  // Test 4.1 — Window entry with Codex session data (T5.11)
  it.effect(
    'writes and reads window entry with Codex session source',
    () =>
      Effect.gen(function* () {
        const entry: WindowEntry = {
          windowId: 'win-codex',
          workspaceName: 'my-project',
          socketPath: '/tmp/vscode-claude-99.sock',
          terminals: [
            {
              name: 'bash',
              pid: 42,
              session: {
                sessionId: 'codex-sess-1',
                status: 'running',
                subtitle: 'codex test',
                statusLabel: undefined,
                needsAttention: false,
                source: 'codex',
              },
            },
          ],
          lastHeartbeat: Date.now(),
        }

        yield* writeWindowEntry(tmpDir, entry)

        const filePath = path.join(tmpDir, 'window-win-codex.json')
        const raw = fs.readFileSync(filePath, 'utf8')
        expect(raw).toContain('"source":"codex"')

        const parsed = JSON.parse(raw) as WindowEntry
        expect(parsed.terminals[0]?.session?.source).toBe('codex')

        const entries = yield* readAllWindowEntries(tmpDir, 'own')
        expect(entries).toHaveLength(1)
        expect(entries[0]?.terminals[0]?.session?.source).toBe('codex')
      }),
  )
})
