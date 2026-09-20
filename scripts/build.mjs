/**
 * Build and dev server.
 *
 * `node scripts/build.mjs`               one-off production bundle
 * `node scripts/build.mjs --watch --serve`  dev server with rebuild on save
 *
 * The browser target is deliberately ancient. Custom-firmware watches ship a
 * frozen AOSP WebView, which on Android 7.1 is Chromium ~55 and on 8.1 is ~61.
 * esbuild will hard-error on syntax it cannot lower to that target, which is
 * what we want: fail here, at build time, rather than silently on the watch.
 *
 * Note this lowers *syntax* only. Missing runtime APIs are handled in
 * src/compat.ts, which must be imported before anything else.
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const serve = args.has('--serve');
/**
 * 5174, because Custom-Spotify's dev server owns 5173 and both need to run at
 * once. `PORT=5180 npm run dev` overrides it.
 */
const port = Number(process.env.PORT) || 5174;

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(root, 'public/bundle.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome58'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
  },
};

if (watch || serve) {
  const ctx = await esbuild.context(options);
  if (watch) await ctx.watch();
  if (serve) {
    const served = await ctx.serve({
      servedir: path.join(root, 'public'),
      host: '0.0.0.0',
      port,
    });
    // esbuild returns { hosts, port } here; there is no `host`, and reading one
    // is how this line used to print "http://undefined:5173".
    const lan = (served.hosts ?? []).filter((h) => h !== '0.0.0.0' && h !== '127.0.0.1');
    console.log(`\n  Dot dev server\n  → http://localhost:${served.port}\n`);
    console.log(
      lan.length > 0
        ? '  On your phone or watch: ' + lan.map((h) => `http://${h}:${served.port}`).join('  ') + '\n'
        : "  On your phone or watch, use this machine's LAN address on the same port.\n",
    );
  }
} else {
  await esbuild.build(options);
  console.log('Built public/bundle.js');
}
