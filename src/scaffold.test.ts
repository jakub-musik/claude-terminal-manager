import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { describe, it, expect } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const root = join(__dirname, '..')

type Json = Record<string, unknown>

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Json
const tsconfig = JSON.parse(
  readFileSync(join(root, 'tsconfig.json'), 'utf8'),
) as Json

describe('project scaffold (T1.1)', () => {
  describe('package metadata', () => {
    it('has correct engines, main, activationEvents, contributes, publisher, type', () => {
      const engines = pkg['engines'] as Json
      expect(String(engines['vscode'])).toMatch(/^\^1\.85/)
      expect(pkg['main']).toBe('./out/extension.cjs')
      expect(pkg['activationEvents']).toContain('onStartupFinished')
      expect(typeof pkg['contributes']).toBe('object')
      expect(pkg['contributes']).not.toBeNull()
      expect(typeof pkg['publisher']).toBe('string')
      expect((pkg['publisher'] as string).length).toBeGreaterThan(0)
      expect(pkg['type']).toBe('module')
    })
  })

  describe('TypeScript strict options', () => {
    it('has all required strict compiler options', () => {
      const opts = (tsconfig['compilerOptions'] ?? {}) as Json
      expect(opts['target']).toBe('ES2022')
      expect(opts['module']).toBe('Node16')
      expect(opts['moduleResolution']).toBe('Node16')
      expect(opts['strict']).toBe(true)
      expect(opts['exactOptionalPropertyTypes']).toBe(true)
      expect(opts['noUncheckedIndexedAccess']).toBe(true)
      expect(opts['noPropertyAccessFromIndexSignature']).toBe(true)
      expect(opts['verbatimModuleSyntax']).toBe(true)
      expect(opts['outDir']).toBe('./out')
      expect(opts['rootDir']).toBe('./src')
    })
  })

  describe('.prettierrc config', () => {
    it('has correct Prettier settings', () => {
      const prettier = JSON.parse(
        readFileSync(join(root, '.prettierrc'), 'utf8'),
      ) as Json
      expect(prettier['semi']).toBe(false)
      expect(prettier['singleQuote']).toBe(true)
      expect(prettier['tabWidth']).toBe(2)
      expect(prettier['printWidth']).toBe(80)
      expect(prettier['trailingComma']).toBe('all')
    })
  })

  describe('vitest.config.ts', () => {
    it('uses forks pool and src/**/*.test.ts include', () => {
      const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
      expect(config).toContain('forks')
      expect(config).toContain('src/**/*.test.ts')
    })
  })

  describe('project scripts', () => {
    it('compile and watch use esbuild; test scripts use vitest', () => {
      const scripts = (pkg['scripts'] ?? {}) as Record<string, string>
      expect(scripts['compile']).toContain('esbuild')
      expect(scripts['watch']).toContain('esbuild')
      expect(scripts['test']).toBe('vitest run')
      expect(scripts['test:watch']).toBe('vitest')
    })
  })

  describe('required dev dependencies', () => {
    it('declares all required dev dependencies', () => {
      const devDeps = (pkg['devDependencies'] ?? {}) as Record<string, string>
      expect(devDeps['typescript']).toBeDefined()
      expect(devDeps['vitest']).toBeDefined()
      expect(devDeps['@effect/vitest']).toBeDefined()
      expect(devDeps['@types/vscode']).toBeDefined()
      expect(devDeps['@types/node']).toBeDefined()
      expect(devDeps['eslint']).toBeDefined()
      expect(devDeps['@typescript-eslint/eslint-plugin']).toBeDefined()
      expect(devDeps['@typescript-eslint/parser']).toBeDefined()
      expect(devDeps['prettier']).toBeDefined()
      expect(devDeps['@vitest/coverage-v8']).toBeDefined()
    })
  })

  describe('required runtime dependencies', () => {
    it('declares all required runtime dependencies', () => {
      const deps = (pkg['dependencies'] ?? {}) as Record<string, string>
      expect(deps['effect']).toBeDefined()
      expect(deps['@effect/platform']).toBeDefined()
      expect(deps['@effect/platform-node']).toBeDefined()
    })
  })

  describe('.npmrc', () => {
    it('contains shamefully-hoist=false', () => {
      const npmrc = readFileSync(join(root, '.npmrc'), 'utf8')
      expect(npmrc).toContain('shamefully-hoist=false')
    })
  })

  describe('extension.ts exports', () => {
    it('exports activate and deactivate functions', () => {
      const src = readFileSync(join(__dirname, 'extension.ts'), 'utf8')
      expect(src).toContain('export function activate')
      expect(src).toContain('function deactivate')
    })
  })

  describe('directory structure', () => {
    it('src/, bin/, test/, resources/ directories exist', () => {
      expect(existsSync(__dirname)).toBe(true)
      expect(existsSync(join(root, 'bin'))).toBe(true)
      expect(existsSync(join(root, 'test'))).toBe(true)
      expect(existsSync(join(root, 'resources'))).toBe(true)
    })
  })
})

describe('package.json manifest (T1.2)', () => {
  const contributes = (pkg['contributes'] ?? {}) as Json

  describe('contributes.views', () => {
    it('no explorer view is registered', () => {
      const views = contributes['views'] as Json
      expect(views['explorer']).toBeUndefined()
    })
  })

  describe('contributes.commands', () => {
    const commands = (contributes['commands'] as Json[])
    const findCmd = (id: string): Json | undefined =>
      commands.find((c) => c['command'] === id)

    it('renameSession has correct title, icon, category', () => {
      const cmd = findCmd('claudeTerminalManager.renameSession')
      expect(cmd).toBeDefined()
      expect(cmd?.['title']).toBe('Rename')
      expect(cmd?.['icon']).toBe('$(pencil)')
      expect(cmd?.['category']).toBe('Agent Terminal Manager')
    })

    it('focusTerminal has correct title, icon, category', () => {
      const cmd = findCmd('claudeTerminalManager.focusTerminal')
      expect(cmd).toBeDefined()
      expect(cmd?.['title']).toBe('Focus Terminal')
      expect(cmd?.['icon']).toBe('$(arrow-right)')
      expect(cmd?.['category']).toBe('Agent Terminal Manager')
    })

    it('focusRemoteTerminal has correct title, icon, category', () => {
      const cmd = findCmd('claudeTerminalManager.focusRemoteTerminal')
      expect(cmd).toBeDefined()
      expect(cmd?.['title']).toBe('Focus Remote Terminal')
      expect(cmd?.['icon']).toBe('$(arrow-right)')
      expect(cmd?.['category']).toBe('Agent Terminal Manager')
    })
  })

  describe('contributes.menus', () => {
    const menuEntries = (
      (contributes['menus'] as Json)['view/item/context'] as Json[]
    )
    const findEntry = (id: string): Json | undefined =>
      menuEntries.find((e) => e['command'] === id)

    it('has at least 2 entries', () => {
      expect(menuEntries.length).toBeGreaterThanOrEqual(2)
    })

    it('renameSession is NOT present in inline menus', () => {
      expect(findEntry('claudeTerminalManager.renameSession')).toBeUndefined()
    })

    it('focusTerminal is NOT present in inline menus', () => {
      expect(findEntry('claudeTerminalManager.focusTerminal')).toBeUndefined()
    })

    it('focusRemoteTerminal is NOT present in inline menus', () => {
      expect(findEntry('claudeTerminalManager.focusRemoteTerminal')).toBeUndefined()
    })
  })

  describe('contributes.configuration', () => {
    const configArray = contributes['configuration'] as Json[]
    const mainConfig = configArray[0] as Json
    const properties = (mainConfig['properties'] as Record<string, Json>)

    it('has title Agent Terminal Manager and properties object', () => {
      expect(mainConfig['title']).toBe('Agent Terminal Manager')
      expect(typeof properties).toBe('object')
      expect(properties).not.toBeNull()
    })

    it('showNonClaudeTerminals setting has type boolean, default false, description', () => {
      const s =
        properties['claudeTerminalManager.sidebar.showNonClaudeTerminals']
      expect(s?.['type']).toBe('boolean')
      expect(s?.['default']).toBe(false)
      expect((s?.['description'] as string | undefined)?.length).toBeGreaterThan(
        0,
      )
    })

    it('verboseToolNames setting has type boolean, default true, description', () => {
      const s = properties['claudeTerminalManager.status.verboseToolNames']
      expect(s?.['type']).toBe('boolean')
      expect(s?.['default']).toBe(true)
      expect((s?.['description'] as string | undefined)?.length).toBeGreaterThan(
        0,
      )
    })

    it('has a Hooks section with manage entry', () => {
      const hooksConfig = configArray[1] as Json
      expect(hooksConfig['title']).toContain('Hooks')
      const hooksProps = hooksConfig['properties'] as Record<string, Json>
      expect(hooksProps['claudeTerminalManager.hooks.manage']).toBeDefined()
    })

    it('enableTerminalShortcuts description mentions customization', () => {
      const setting =
        properties['claudeTerminalManager.keyboard.enableTerminalShortcuts']
      const desc = setting?.['description'] as string
      expect(desc).toContain('Customize')
      expect(desc).toContain('Focus Session')
    })

    it('has a keyboard.customize entry with markdownDescription linking to customizeShortcuts', () => {
      const setting =
        properties['claudeTerminalManager.keyboard.customize']
      expect(setting).toBeDefined()
      expect(setting?.['type']).toBe('null')
      const desc = setting?.['markdownDescription'] as string | undefined
      expect(desc).toBeDefined()
      expect(desc).toContain('customizeShortcuts')
    })
  })

  describe('resources/icon.svg', () => {
    it('exists, contains <svg and xmlns, is non-empty', () => {
      const iconContent = readFileSync(
        join(root, 'resources', 'icon.svg'),
        'utf8',
      )
      expect(iconContent.length).toBeGreaterThan(0)
      expect(iconContent).toContain('<svg')
      expect(iconContent).toContain('xmlns')
    })
  })

  describe('no duplicate command IDs', () => {
    it('all command IDs in contributes.commands are unique', () => {
      const commands = (contributes['commands'] as Json[])
      const ids = commands.map((c) => c['command'])
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  describe('no orphan menu entries', () => {
    it('every menu command appears in contributes.commands', () => {
      const commands = (contributes['commands'] as Json[])
      const commandIds = new Set(commands.map((c) => c['command'] as string))
      const menuEntries = (
        (contributes['menus'] as Json)['view/item/context'] as Json[]
      )
      for (const entry of menuEntries) {
        expect(commandIds.has(entry['command'] as string)).toBe(true)
      }
    })
  })
})

describe('vsce build compliance (T4.1)', () => {
  it('(a) package.json has a repository field with type and url', () => {
    const repo = pkg['repository'] as { type: string; url: string } | undefined
    expect(repo).toBeDefined()
    expect(typeof repo?.type).toBe('string')
    expect(typeof repo?.url).toBe('string')
    expect((repo?.url ?? '').length).toBeGreaterThan(0)
  })

  it('(b) LICENSE file exists at project root', () => {
    expect(existsSync(join(root, 'LICENSE'))).toBe(true)
  })

  it('(c) LICENSE file is non-empty', () => {
    const content = readFileSync(join(root, 'LICENSE'), 'utf8')
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('MIT')
  })
})

describe('build-install script (T3.7)', () => {
  const scripts = (pkg['scripts'] ?? {}) as Record<string, string>

  it('(a) build-install script is defined', () => {
    expect(scripts['build-install']).toBeDefined()
  })

  it('(b) build-install contains compile', () => {
    expect(scripts['build-install']).toContain('compile')
  })

  it('(c) build-install contains vsce package', () => {
    expect(scripts['build-install']).toContain('vsce package')
  })

  it('(d) build-install contains code --install-extension', () => {
    expect(scripts['build-install']).toContain('code --install-extension')
  })
})

describe('README (T4.3)', () => {
  const readmePath = join(root, 'README.md')

  it('(a) README.md file exists', () => {
    expect(existsSync(readmePath)).toBe(true)
  })

  it('(b) README.md contains guidance about hook setup', () => {
    const content = readFileSync(readmePath, 'utf8')
    expect(content.toLowerCase()).toContain('settings.json')
  })

  it('(c) README.md contains VSCODE_CLAUDE_SOCKET troubleshooting hint', () => {
    const content = readFileSync(readmePath, 'utf8')
    expect(content).toContain('VSCODE_CLAUDE_SOCKET')
  })

  it('(d) README.md contains accessibility section', () => {
    const content = readFileSync(readmePath, 'utf8')
    expect(content.toLowerCase()).toContain('accessibility')
  })

  it('(e) README.md is non-trivially long (> 500 chars)', () => {
    const content = readFileSync(readmePath, 'utf8')
    expect(content.length).toBeGreaterThan(500)
  })

  it('(f) README.md contains keyboard shortcuts section', () => {
    const content = readFileSync(readmePath, 'utf8')
    expect(content).toContain('Keyboard Shortcuts')
    expect(content).toContain('Customizing Shortcuts')
  })

  it('(g) README.md mentions the Customize Terminal Shortcuts command', () => {
    const content = readFileSync(readmePath, 'utf8')
    expect(content).toContain('Customize Terminal Shortcuts')
  })
})

describe('individual focus commands (T6.1)', () => {
  const contributes = (pkg['contributes'] ?? {}) as Json
  const commands = contributes['commands'] as Json[]
  const findCmd = (id: string): Json | undefined =>
    commands.find((c) => c['command'] === id)

  it('(a) focusTerminal0 through focusTerminal9 commands exist', () => {
    for (let idx = 0; idx <= 9; idx++) {
      const cmd = findCmd(`claudeTerminalManager.focusTerminal${idx}`)
      expect(cmd, `focusTerminal${idx} should exist`).toBeDefined()
      expect(cmd?.['title']).toBe(`Focus Session ${idx}`)
      expect(cmd?.['category']).toBe('Agent Terminal Manager')
    }
  })

  it('(b) focusTerminalByIndex is NOT in contributes.commands', () => {
    expect(findCmd('claudeTerminalManager.focusTerminalByIndex')).toBeUndefined()
  })

  it('(c) keybindings use individual commands (not focusTerminalByIndex)', () => {
    const keybindings = contributes['keybindings'] as Json[]
    for (const kb of keybindings) {
      expect(kb['command']).not.toBe('claudeTerminalManager.focusTerminalByIndex')
    }
  })

  it('(d) each focusTerminalN has exactly 2 keybindings (regular + numpad)', () => {
    const keybindings = contributes['keybindings'] as Json[]
    for (let idx = 0; idx <= 9; idx++) {
      const matches = keybindings.filter(
        (kb) => kb['command'] === `claudeTerminalManager.focusTerminal${idx}`,
      )
      expect(matches, `focusTerminal${idx} should have 2 keybindings`).toHaveLength(2)
    }
  })

  it('(e) keybindings have no args property', () => {
    const keybindings = contributes['keybindings'] as Json[]
    for (const kb of keybindings) {
      expect(kb['args']).toBeUndefined()
    }
  })

  it('(f) commandsToSkipShell includes all 10 individual commands', () => {
    const defaults = contributes['configurationDefaults'] as Json
    const skipList = defaults['terminal.integrated.commandsToSkipShell'] as string[]
    for (let idx = 0; idx <= 9; idx++) {
      expect(skipList).toContain(`claudeTerminalManager.focusTerminal${idx}`)
    }
  })

  it('(g) keybindings are gated by enableTerminalShortcuts when clause', () => {
    const keybindings = contributes['keybindings'] as Json[]
    for (const kb of keybindings) {
      expect(kb['when']).toBe('config.claudeTerminalManager.keyboard.enableTerminalShortcuts')
    }
  })

  it('4(a) all 10 commands have unique IDs', () => {
    const focusIds = new Set<string>()
    for (let idx = 0; idx <= 9; idx++) {
      focusIds.add(`claudeTerminalManager.focusTerminal${idx}`)
    }
    expect(focusIds.size).toBe(10)
    for (const id of focusIds) {
      expect(findCmd(id)).toBeDefined()
    }
  })

  it('4(d) commandsToSkipShell includes focusTerminalByIndex', () => {
    const defaults = contributes['configurationDefaults'] as Json
    const skipList = defaults[
      'terminal.integrated.commandsToSkipShell'
    ] as string[]
    expect(skipList).toContain(
      'claudeTerminalManager.focusTerminalByIndex',
    )
  })
})

describe('Codex icon (T5.6)', () => {
  it('(a) codex-ai.svg exists in resources/', () => {
    expect(existsSync(join(root, 'resources', 'codex-ai.svg'))).toBe(true)
  })

  it('(b) codex-ai.svg is valid SVG (starts with <svg or <?xml)', () => {
    const content = readFileSync(
      join(root, 'resources', 'codex-ai.svg'),
      'utf8',
    )
    expect(content.trimStart()).toMatch(/^(<\?xml|<svg)/)
  })

  it('(c) codex-ai.svg uses currentColor for theme compatibility', () => {
    const content = readFileSync(
      join(root, 'resources', 'codex-ai.svg'),
      'utf8',
    )
    expect(content).toContain('currentColor')
  })

  it('(d) codex-ai.svg has viewBox matching claude-icon.svg (0 0 16 16)', () => {
    const content = readFileSync(
      join(root, 'resources', 'codex-ai.svg'),
      'utf8',
    )
    expect(content).toContain('viewBox="0 0 16 16"')
  })

  it('(e) codex-ai.svg has no external dependencies (no <image>, <use>, or xlink)', () => {
    const content = readFileSync(
      join(root, 'resources', 'codex-ai.svg'),
      'utf8',
    )
    expect(content).not.toContain('<image')
    expect(content).not.toContain('<use')
    expect(content).not.toContain('xlink')
  })
})

