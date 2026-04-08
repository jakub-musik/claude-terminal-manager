# Manual Release Steps

## Prerequisites

- [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/) installed
- [vsce](https://github.com/microsoft/vscode-vsce) available (included in devDependencies as `@vscode/vsce`)
- A [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) Personal Access Token (PAT) with **Marketplace > Manage** scope

## Steps

### 1. Ensure a clean working tree

```sh
git status            # should be clean
git pull origin master
```

### 2. Bump the version

Update the `"version"` field in `package.json` following semver:

| Change type               | Bump    | Example         |
|---------------------------|---------|-----------------|
| Bug fix / minor tweak     | patch   | 0.0.73 → 0.0.74 |
| New feature               | minor   | 0.0.73 → 0.1.0  |
| Breaking change           | major   | 0.0.73 → 1.0.0  |

### 3. Compile and package

```sh
pnpm install
pnpm compile
pnpm exec vsce package --no-dependencies
```

This produces a `.vsix` file in the project root (e.g. `claude-terminal-manager-0.0.74.vsix`).

### 4. Smoke-test locally

```sh
code --install-extension claude-terminal-manager-<version>.vsix
```

Open VS Code, verify the extension loads and basic functionality works.

### 5. Commit and tag

```sh
git add package.json
git commit -m "Release v<version>"
git tag v<version>
git push origin master --tags
```

### 6. Publish to the Marketplace

```sh
pnpm exec vsce publish --no-dependencies
```

You will be prompted for your PAT if not already logged in. To log in ahead of time:

```sh
pnpm exec vsce login jakub-musik
```

### 7. Verify

- Check the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=jakub-musik.claude-terminal-manager) shows the new version.
- Install from the Marketplace in a fresh VS Code window to confirm.

## One-liner (build + install locally)

```sh
pnpm run build-install
```

This compiles, packages, and installs the extension into your local VS Code in one step.
