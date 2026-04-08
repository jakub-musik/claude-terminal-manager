import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.cjs',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
})
