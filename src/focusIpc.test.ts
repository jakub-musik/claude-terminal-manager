import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, beforeEach, expect } from 'vitest'
import {
  deleteFocusRequest,
  getFocusRequestPath,
  writeFocusRequest,
  type FocusRequest,
} from './focusIpc.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), 'focus-test-' + Date.now())
  fs.mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('focusIpc', () => {
  // (a) writeFocusRequest creates a JSON file at the correct path
  it.effect(
    'writeFocusRequest creates a JSON file at the correct path with terminalName and timestamp',
    () =>
      Effect.gen(function* () {
        const before = Date.now()
        yield* writeFocusRequest(tmpDir, 'win42', 'bash')
        const filePath = getFocusRequestPath(tmpDir, 'win42')
        expect(fs.existsSync(filePath)).toBe(true)
        const req = JSON.parse(
          fs.readFileSync(filePath, 'utf8'),
        ) as FocusRequest
        expect(req.terminalName).toBe('bash')
        expect(req.timestamp).toBeGreaterThanOrEqual(before)
        expect(req.timestamp).toBeLessThanOrEqual(Date.now())
      }),
  )

  // (b) writeFocusRequest is a no-op when directory does not exist
  it.effect(
    'writeFocusRequest does not throw when directory does not exist',
    () =>
      Effect.gen(function* () {
        const nonExistentDir = path.join(tmpDir, 'does-not-exist')
        yield* writeFocusRequest(nonExistentDir, 'win1', 'bash')
        // Effect completed without error — file was not created (directory missing)
        expect(fs.existsSync(getFocusRequestPath(nonExistentDir, 'win1'))).toBe(
          false,
        )
      }),
  )

  // (c) deleteFocusRequest deletes the file
  it.effect('deleteFocusRequest deletes the file', () =>
    Effect.gen(function* () {
      yield* writeFocusRequest(tmpDir, 'win99', 'zsh')
      const filePath = getFocusRequestPath(tmpDir, 'win99')
      expect(fs.existsSync(filePath)).toBe(true)
      yield* deleteFocusRequest(tmpDir, 'win99')
      expect(fs.existsSync(filePath)).toBe(false)
    }),
  )

  // (d) deleteFocusRequest does not throw when file is missing
  it.effect('deleteFocusRequest does not throw when file is missing', () =>
    Effect.gen(function* () {
      yield* deleteFocusRequest(tmpDir, 'nonexistent')
      // No assertion needed — effect must complete without error
    }),
  )
})
