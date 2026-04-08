import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { describe, it, expect } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkgPath = join(__dirname, '..', 'package.json')

interface MenuEntry {
  command: string
  when?: string
  group?: string
}

interface PackageJson {
  contributes: {
    menus: {
      'view/item/context': MenuEntry[]
    }
  }
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson
const menuEntries = pkg.contributes.menus['view/item/context']

describe('manifest', () => {
  describe('inline icons are limited to close actions', () => {
    it('only closeTerminal entries remain inline', () => {
      const inlineEntries = menuEntries.filter((entry) => entry.group === 'inline')
      expect(inlineEntries).toHaveLength(2)
      expect(inlineEntries.every((entry) => entry.command === 'claudeTerminalManager.closeTerminal')).toBe(true)
    })

    it('renameSession is not an inline menu entry', () => {
      const entry = menuEntries.find(
        (entry) => entry.command === 'claudeTerminalManager.renameSession',
      )
      expect(entry).toBeUndefined()
    })

    it('focusTerminal is not an inline menu entry', () => {
      const entry = menuEntries.find(
        (entry) => entry.command === 'claudeTerminalManager.focusTerminal',
      )
      expect(entry).toBeUndefined()
    })

    it('focusRemoteTerminal is not an inline menu entry', () => {
      const entry = menuEntries.find(
        (entry) => entry.command === 'claudeTerminalManager.focusRemoteTerminal',
      )
      expect(entry).toBeUndefined()
    })
  })
})
