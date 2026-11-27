// Prototype B of M14 (Issue #167): the one build step of Hof — the React views of the way through
// the court, bundled by esbuild into one file the server serves with its version, as any other
// static file of Core (src/static.ts). Never merged into main: the comparison of M14.6 decides.
//
// node src/build.ts            — the bundle of production: minified, no source map.
// node src/build.ts --watch    — rebuilt on every change, for npm run dev.

import { build, context, type BuildOptions } from 'esbuild';
import { join } from 'node:path';

export const BUNDLE_DIR = join(import.meta.dirname, 'core', 'static', 'build');

const options: BuildOptions = {
  entryPoints: [join(import.meta.dirname, 'web', 'main.tsx')],
  outfile: join(BUNDLE_DIR, 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  legalComments: 'linked',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
};

if (import.meta.main) {
  if (process.argv.includes('--watch')) {
    await (await context({ ...options, minify: false })).watch();
  } else {
    await build(options);
  }
}
