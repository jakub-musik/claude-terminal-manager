// Mocha test runner entry point for @vscode/test-electron direct API.
// With @vscode/test-cli (vscode-test), test discovery uses the files glob in
// .vscode-test.mjs instead — this file is a compatibility fallback.
//
// Compiled by test/tsconfig.json (module: commonjs) so __dirname is available.

import * as path from 'path'

export function run(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Mocha = require('mocha') as typeof import('mocha')
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 10000 })

  mocha.addFile(path.resolve(__dirname, 'extension.test.js'))

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`))
      } else {
        resolve()
      }
    })
  })
}
