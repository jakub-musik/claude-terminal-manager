import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Effect, Schedule } from 'effect'

const CUSTOM_TITLE_MARKER = '"custom-title"'

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

/**
 * Search a text chunk for the last `customTitle` value.
 * Uses a fast indexOf pre-check before attempting JSON.parse.
 */
const findLastCustomTitle = (chunk: string): string | undefined => {
  let last: string | undefined
  for (const line of chunk.split('\n')) {
    if (!line.includes(CUSTOM_TITLE_MARKER)) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.length > 0) {
        last = obj.customTitle as string
      }
    } catch {
      // skip malformed lines
    }
  }
  return last
}

/**
 * Search a text chunk for the last `slug` value.
 */
const findLastSlug = (chunk: string): string | undefined => {
  let last: string | undefined
  for (const line of chunk.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const obj = JSON.parse(line)
      if (typeof obj.slug === 'string' && obj.slug.length > 0) {
        last = obj.slug as string
      }
    } catch {
      // skip malformed lines
    }
  }
  return last
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * Full streaming scan of a JSONL file for the last `type: "custom-title"` entry.
 * Only used as a fallback for very large files where the tail read misses it.
 */
const streamScanCustomTitle = (filePath: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    let last: string | undefined
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (!line.includes(CUSTOM_TITLE_MARKER)) return
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.length > 0) {
          last = obj.customTitle as string
        }
      } catch {
        // skip
      }
    })
    rl.on('close', () => resolve(last))
    rl.on('error', () => resolve(undefined))
    stream.on('error', () => resolve(undefined))
  })
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

/** Read a chunk of a file at a given offset. Caller must close fd. */
const readChunk = (fd: number, size: number, offset: number): string => {
  const buf = Buffer.alloc(size)
  const bytesRead = fs.readSync(fd, buf, 0, size, offset)
  return buf.toString('utf8', 0, bytesRead)
}

// 256 KB tail covers most session files entirely
const TAIL_SIZE = 262144

/**
 * Read the display title from a Claude Code conversation JSONL file.
 *
 * Claude Code uses two naming fields:
 * - `slug`: an auto-generated random identifier (e.g. "structured-fluttering-church")
 * - `customTitle`: a human-readable title set via `type: "custom-title"` entries
 *
 * Claude Code displays `customTitle` when present, falling back to `slug`.
 * We mirror that priority here.
 */
export const resolveSessionSlug = (
  cwd: string,
  sessionId: string,
): Effect.Effect<string | undefined> => {
  const encodedCwd = cwd.replaceAll('/', '-')
  const jsonlPath = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodedCwd,
    `${sessionId}.jsonl`,
  )

  const readSlug: Effect.Effect<string | undefined> = Effect.promise(
    async (): Promise<string | undefined> => {
      try {
        // Stream the whole file to find the last customTitle.
        // This only runs at initial detection (with retries), not periodically.
        const customTitle = await streamScanCustomTitle(jsonlPath)
        if (customTitle !== undefined) return customTitle

        // Fallback: read the first 4KB to find the slug field
        let fd: number | undefined
        try {
          fd = fs.openSync(jsonlPath, 'r')
          const chunk = readChunk(fd, 4096, 0)
          for (const line of chunk.split('\n')) {
            if (line.trim().length === 0) continue
            try {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              const obj = JSON.parse(line)
              // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
              if (typeof obj.slug === 'string' && obj.slug.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                return obj.slug as string
              }
            } catch {
              // skip malformed lines
            }
          }
        } finally {
          if (fd !== undefined) {
            try { fs.closeSync(fd) } catch { /* best-effort */ }
          }
        }
        return undefined
      } catch {
        return undefined
      }
    },
  )

  // Retry up to 3 times, 2 seconds apart — slug may not exist at session start
  return readSlug.pipe(
    Effect.flatMap((slug) =>
      slug !== undefined
        ? Effect.succeed(slug)
        : Effect.fail('no slug yet' as const),
    ),
    Effect.retry(Schedule.spaced('2 seconds').pipe(Schedule.intersect(Schedule.recurs(2)))),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )
}

/**
 * Read the latest display title from a Claude Code conversation JSONL file.
 * Called periodically (every 5s), so optimized to read from the end first.
 *
 * Strategy:
 * 1. Read the last 256 KB — scan for the last customTitle, then last slug
 * 2. If no customTitle in tail and file is larger, do a full streaming scan
 *    (rare: only for very large files where customTitle is early)
 */
export const readLatestSlug = (
  cwd: string,
  sessionId: string,
): Effect.Effect<string | undefined> => {
  const encodedCwd = cwd.replaceAll('/', '-')
  const jsonlPath = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodedCwd,
    `${sessionId}.jsonl`,
  )

  return Effect.promise(async (): Promise<string | undefined> => {
    let fd: number | undefined
    try {
      const stat = fs.statSync(jsonlPath)
      fd = fs.openSync(jsonlPath, 'r')

      // Read the tail (up to 256 KB, or the whole file if smaller)
      const tailSize = Math.min(stat.size, TAIL_SIZE)
      const tailOffset = Math.max(0, stat.size - tailSize)
      const tail = readChunk(fd, tailSize, tailOffset)

      // Check tail for customTitle first (last one wins)
      const tailCustomTitle = findLastCustomTitle(tail)
      if (tailCustomTitle !== undefined) return tailCustomTitle

      // Check tail for slug as a fallback value
      const tailSlug = findLastSlug(tail)

      // If the tail covered the whole file, we're done
      if (tailOffset === 0) return tailSlug

      // File is larger than our tail read. The customTitle might be
      // earlier in the file. Do a full streaming scan.
      fs.closeSync(fd)
      fd = undefined
      const fullCustomTitle = await streamScanCustomTitle(jsonlPath)
      return fullCustomTitle ?? tailSlug
    } catch {
      return undefined
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch { /* best-effort */ }
      }
    }
  })
}
