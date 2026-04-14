# Agent Terminal Manager

A VS Code extension that tracks AI agent sessions (Claude, Codex) in VS Code terminals with a sidebar panel. See at a glance which sessions are running, waiting for input, or need your attention — across all your VS Code windows.

## Requirements

- **VS Code 1.85+**
- **Claude Code CLI** and/or **Codex CLI** must be installed and available in your terminal PATH (verify with `which claude` or `which codex`)
- **Python 3** must be available as `python3` (used by the hook reporter script for JSON parsing and socket communication)
- **Git** — used to detect the current branch for sidebar labels. Branch detection fails gracefully if git is not installed, but labels will be missing.
- **`ps`** (Unix) — used to walk the process tree and match Claude sessions to their VS Code terminals. Pre-installed on macOS and Linux.
- **`code` CLI** (or `code-insiders`) — required for the multi-window feature to activate remote VS Code windows. Install via Command Palette → "Shell Command: Install 'code' command in PATH". Only needed if `showTerminalsFromAllWindows` is enabled.

## Installation

Install via **Extensions** panel → `...` → **Install from VSIX...**.

## Setup

The extension registers hooks in `~/.claude/settings.json` and `~/.codex/hooks.json` on activation. No special terminal setup is required.

- Claude and Codex sessions will appear in the **Terminals** panel in the Explorer view.

## Features

### Sidebar Panel

The extension adds a **Terminals** panel to two locations:

- **Explorer sidebar** — nested under your file explorer
- **Dedicated activity bar icon** — a standalone Agent Terminal Manager sidebar

Both panels show the same live tree of terminals and sessions.

### Session Tracking

Each CLI agent session (Claude Code, Codex) is tracked through its full lifecycle via hook events:

| Event | What it means |
|-------|---------------|
| **SessionStart** | A new agent process starts (claude or codex). The extension records the session ID, PID, working directory, and git branch. |
| **UserPromptSubmit** | You sent a prompt. The session status moves to **running** and the prompt text appears as a subtitle in the sidebar. |
| **PreToolUse** | Claude is about to use a tool (e.g. Bash, Read, Write). With verbose mode enabled, the tool name is shown (e.g. "Running: Bash"). If the tool is `AskUserQuestion` or `ExitPlanMode`, the session is flagged as **needs attention**. |
| **Stop** | Claude finished responding and is waiting for your next prompt. The session is flagged as **needs attention**. |

### Session Status Indicators

Sessions in the sidebar display visual indicators:

- **●** (filled dot) — **Needs attention**: Claude has stopped and is waiting for input, or is asking a question. This is the initial indicator after a `Stop` or `AskUserQuestion` event.
- **○** (open dot) — **Seen / waiting for input**: The user has clicked the session to acknowledge it, but has not yet submitted a new prompt. This clears the "needs attention" flag while the session remains idle.
- No prefix — **Running**: Claude is actively processing

### Session Naming & Slugs

Sessions are labeled using the following priority:

1. **Custom name** — set via the rename command (pencil icon)
2. **Slug** — automatically resolved from Claude Code's conversation JSONL file. The extension reads `customTitle` (user-set title) first, falling back to `slug` (auto-generated identifier like "structured-fluttering-church"). Slugs are re-checked every 5 seconds to pick up renames.
3. **"Claude"** — default fallback

### Terminal Correlation

The extension automatically matches Claude sessions to their VS Code terminal by walking the process tree (child → parent) up to 20 hops. This lets you click a session in the sidebar to jump directly to the terminal running it.

### Multi-Window Support

When enabled, the sidebar shows terminals from **all open VS Code windows**, grouped by workspace:

- **Local section** — terminals in the current window (labeled with workspace name and git branch)
- **Remote sections** — terminals from other VS Code windows, each showing their workspace name and branch

Each window publishes its terminal state to a shared registry file (heartbeat every 30s, stale entries pruned after 90s). Clicking a remote terminal sends a focus request via IPC and activates the target window using the `code` CLI (`code -r <folder>`, or `code-insiders -r` for Insiders builds).

### Focus & Navigation

| Action | What it does |
|--------|--------------|
| **Click a local session** | Shows that terminal and clears the "needs attention" flag |
| **Click a remote terminal** | Sends a focus request to the owning window, which shows the terminal. The target window is activated via `code -r`. |
| **Focus Window** (window icon on remote section header) | Activates the remote VS Code window via `code -r` |

### Session Reaper

A background process checks every 5 seconds whether tracked Claude processes are still alive. Dead processes are automatically cleaned up with a synthetic `session_end` event and immediately removed from the sidebar.

### Git Branch Detection

The current git branch is detected every 5 seconds and displayed next to the workspace name in the sidebar section headers (e.g. "my-project - feature/auth").

### Commands

| Command | Description |
|---------|-------------|
| **Rename** (pencil icon) | Set a custom display name for a Claude session |
| **Focus Terminal** (arrow icon) | Jump to the terminal running a local Claude session |
| **Focus Remote Terminal** (arrow icon) | Focus a terminal in another VS Code window |
| **Focus Window** (window icon) | Activate a remote VS Code window |
| **Close Terminal** (trash icon) | Close a terminal or end a Claude session |
| **Reset Terminal State** (trash icon) | Clear all tracked sessions (with confirmation) |
| **Install Hooks** | Register hooks in `~/.claude/settings.json` and `~/.codex/hooks.json` |
| **Remove Hooks** | Remove hooks from `~/.claude/settings.json` and `~/.codex/hooks.json` |
| **Check Hooks Status** | Check whether hooks are currently installed for Claude and Codex |

## How It Works

1. The extension registers hooks in `~/.claude/settings.json` and `~/.codex/hooks.json` on activation.
2. The hooks forward session lifecycle events (start, prompts, tool use, stop) to the extension via a Unix socket.
3. The extension parses events, updates a state machine, and renders the live session tree in the sidebar. Claude and Codex sessions are distinguished by their source-specific icons.

## Settings

### `claudeTerminalManager.sidebar.showNonClaudeTerminals`

**Default:** `false`

Controls whether plain (non-agent) terminals appear in the sidebar. When `false`, only terminals with an active agent session are shown. When `true`, all open terminals are listed — terminals without an agent session show with a generic terminal icon, while agent sessions show with their source-specific icon (Claude or Codex).

### `claudeTerminalManager.status.verboseToolNames`

**Default:** `true`

Controls whether the currently running tool name is displayed next to a session in the sidebar. When enabled, sessions show a status label like "Running: Bash" or "Running: Read" while Claude is executing a tool. When disabled, no tool name is shown — sessions just show the prompt subtitle.

### `claudeTerminalManager.sidebar.showTerminalsFromAllWindows`

**Default:** `true`

Controls whether terminals from other VS Code windows appear in the sidebar. When enabled, the sidebar is split into sections: a **local** section for the current window and a **remote** section for each other open VS Code window. Each section header shows the workspace name and git branch. When disabled, only terminals from the current window are shown.

## Keyboard Shortcuts

The extension provides shortcuts to quickly focus terminals and sessions by their sidebar position.

### Enabling Shortcuts

Shortcuts are disabled by default. Enable them in Settings:

1. Open **Settings** (Cmd+, / Ctrl+,)
2. Search for `claudeTerminalManager.keyboard.enableTerminalShortcuts`
3. Check the box to enable

### Default Bindings

| Shortcut | Action |
|----------|--------|
| Ctrl+Alt+0 | Focus Session 0 (first item in sidebar) |
| Ctrl+Alt+1 | Focus Session 1 |
| ... | ... |
| Ctrl+Alt+9 | Focus Session 9 |

Numpad equivalents (Ctrl+Alt+Numpad0–9) are also bound.

### Customizing Shortcuts

To rebind any shortcut:

1. Open the Command Palette (Cmd+Shift+P / Ctrl+Shift+P)
2. Run **Agent Terminal Manager: Customize Terminal Shortcuts**
3. This opens the Keyboard Shortcuts editor filtered to the focus commands
4. Double-click any entry to assign a new keybinding

Alternatively, open **Keyboard Shortcuts** (Cmd+K Cmd+S) and search for `Focus Session`.

## Troubleshooting

If sessions are not appearing in the sidebar:

1. Check that hooks are registered in `~/.claude/settings.json` and/or `~/.codex/hooks.json` — look for entries containing `--vscode-ctm`.
2. Run `echo $VSCODE_CLAUDE_SOCKET` in a VS Code terminal — it should print a socket path like `/tmp/vscode-claude-<uuid>.sock`. If it is empty, try relaunching the terminal or reloading VS Code.

## Accessibility

All session tree items include `accessibilityInformation` labels so screen readers can announce the session name and current status. Session status indicators (filled dot, open dot) are also conveyed through text labels, not just visual symbols.

## Development

### Building from Source

Clone the repo, then build and install the extension:

```sh
pnpm build-install
```

This compiles the extension, packages it as a `.vsix` file, and installs it into your running VS Code instance.
