import { build } from 'esbuild'

await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  outdir: 'dist/main',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  minify: false,
})
