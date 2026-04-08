import * as vscode from 'vscode'

export const getShowNonClaudeTerminals = (): boolean =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<boolean>('sidebar.showNonClaudeTerminals', false)

export const getVerboseToolNames = (): boolean =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<boolean>('status.verboseToolNames', true)

export const getShowTerminalsFromAllWindows = (): boolean =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<boolean>('sidebar.showTerminalsFromAllWindows', true)
