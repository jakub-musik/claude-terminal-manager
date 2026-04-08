import { defineConfig } from '@vscode/test-cli'

export default defineConfig({
  files: 'test/suite/**/*.test.js',
  workspaceFolder: './test/fixtures/workspace',
  mocha: {
    timeout: 10000,
  },
})
