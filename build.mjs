import esbuild from 'esbuild';
import fs from 'node:fs';
const mode = process.argv[2];
const b64 = f => fs.readFileSync(f).toString('base64');
function css() {
  return fs.readFileSync('styles.src.css', 'utf8')
    .replace('__BASKERVILLE__', b64('fonts/LibreBaskerville.woff2'))
    .replace('__BASKERVILLE_ITALIC__', b64('fonts/LibreBaskerville-Italic.woff2'))
    .replace('__BLACKLETTER__', b64('fonts/UnifrakturMaguntia.woff2'));
}
if (mode === 'test') {
  await esbuild.build({ entryPoints: ['src/model.ts', 'src/manuscript.ts', 'src/book.ts', 'src/zip.ts'], outdir: 'tests/build', bundle: true, format: 'cjs', platform: 'node', outExtension: { '.js': '.cjs' }, logLevel: 'warning' });
} else if (mode === 'harness') {
  // The real plugin, bundled for the browser harness: obsidian → mock; CodeMirror bundled in (Obsidian provides it at runtime).
  await esbuild.build({ entryPoints: ['tests/harness-entry.ts'], outfile: 'tests/build/harness.js', bundle: true, format: 'iife', platform: 'browser', logLevel: 'warning', alias: { obsidian: './tests/mock-obsidian.ts' }, loader: { '.woff2': 'binary', '.ttf': 'binary' } });
  fs.mkdirSync('tests/build', { recursive: true });
  fs.writeFileSync('tests/build/styles.css', css());
} else {
  fs.mkdirSync('release/story-engine', { recursive: true });
  await esbuild.build({ entryPoints: ['src/main.ts'], outfile: 'release/story-engine/main.js', bundle: true, format: 'cjs', platform: 'browser', target: 'es2021', external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'], loader: { '.woff2': 'binary', '.ttf': 'binary' }, logLevel: 'info', banner: { js: '/* Story Engine — an Obsidian plugin for writing novels. Bundled fonts: Libre Baskerville, UnifrakturMaguntia (SIL OFL 1.1). */' } });
  fs.copyFileSync('manifest.json', 'release/story-engine/manifest.json');
  fs.writeFileSync('release/story-engine/styles.css', css());
}
