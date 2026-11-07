// Builds the bundles into dist/ (minified, ES2015) and reports their size. With --check, exits 1 when a
// bundle is over its budget (docs/spec.md, section 9). Modules are build flags: code behind a false flag
// is dropped from the bundle.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

export const BUNDLES = [{ name: 'tinybeam.js', flags: {}, budget: 1536 }];

export async function bundle(flags) {
  const result = await build({
    entryPoints: ['src/core.js'],
    bundle: true,
    minify: true,
    format: 'esm', // the source is already an IIFE; esm keeps esbuild from wrapping it again
    target: 'es2015',
    define: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, String(v)])),
    legalComments: 'none',
    write: false,
  });
  return result.outputFiles[0].text;
}

export const brotliSize = code =>
  brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  mkdirSync('dist', { recursive: true });
  let over = false;
  for (const { name, flags, budget } of BUNDLES) {
    const code = await bundle(flags);
    writeFileSync(`dist/${name}`, code);
    const br = brotliSize(code);
    over ||= br > budget;
    console.log(`${br > budget ? 'OVER' : 'ok  '} dist/${name}: ${code.length} B minified, ${br} B brotli (budget ${budget} B)`);
  }
  if (check && over) process.exit(1);
}
