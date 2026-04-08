import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({ get: mockGet }),
  },
}))

import {
  getShowNonClaudeTerminals,
  getVerboseToolNames,
  getShowTerminalsFromAllWindows,
} from './settings.js'
import * as vscode from 'vscode'

describe('settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockReturnValue(undefined)
  })

  describe('getShowNonClaudeTerminals', () => {
    it('reads sidebar.showNonClaudeTerminals from claudeTerminalManager config', () => {
      mockGet.mockReturnValue(true)
      const result = getShowNonClaudeTerminals()
      expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(
        'claudeTerminalManager',
      )
      expect(mockGet).toHaveBeenCalledWith('sidebar.showNonClaudeTerminals', false)
      expect(result).toBe(true)
    })

    it('returns false when configured to false', () => {
      mockGet.mockReturnValue(false)
      const result = getShowNonClaudeTerminals()
      expect(result).toBe(false)
    })

    it('returns default false when configuration returns undefined', () => {
      mockGet.mockImplementation(
        (_key: string, defaultValue: boolean) => defaultValue,
      )
      const result = getShowNonClaudeTerminals()
      expect(result).toBe(false)
    })
  })

  describe('getVerboseToolNames', () => {
    it('reads status.verboseToolNames from claudeTerminalManager config', () => {
      mockGet.mockReturnValue(false)
      const result = getVerboseToolNames()
      expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(
        'claudeTerminalManager',
      )
      expect(mockGet).toHaveBeenCalledWith('status.verboseToolNames', true)
      expect(result).toBe(false)
    })

    it('returns true when configured to true', () => {
      mockGet.mockReturnValue(true)
      const result = getVerboseToolNames()
      expect(result).toBe(true)
    })

    it('returns default true when configuration returns undefined', () => {
      mockGet.mockImplementation(
        (_key: string, defaultValue: boolean) => defaultValue,
      )
      const result = getVerboseToolNames()
      expect(result).toBe(true)
    })
  })

  describe('getShowTerminalsFromAllWindows', () => {
    it('returns true when configuration value is true', () => {
      mockGet.mockReturnValue(true)
      const result = getShowTerminalsFromAllWindows()
      expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(
        'claudeTerminalManager',
      )
      expect(mockGet).toHaveBeenCalledWith(
        'sidebar.showTerminalsFromAllWindows',
        true,
      )
      expect(result).toBe(true)
    })

    it('returns default true when configuration returns undefined', () => {
      mockGet.mockImplementation(
        (_key: string, defaultValue: boolean) => defaultValue,
      )
      const result = getShowTerminalsFromAllWindows()
      expect(result).toBe(true)
    })

    it('returns false when configuration value is false', () => {
      mockGet.mockReturnValue(false)
      const result = getShowTerminalsFromAllWindows()
      expect(result).toBe(false)
    })
  })
})
