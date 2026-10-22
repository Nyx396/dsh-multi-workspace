// Build the prebuilt client bundle for dsh-multi-workspace.
//
// The DSH browser module system serves one client.js per package and materializes
// it as a lazy factory: `factory(require)` returns the plugin exports. Source
// fragments in src/client/ are authored as ordinary script bodies that share one
// closure, so this script concatenates them in file-name order inside the factory
// wrapper. No bundler and no third-party runtime dependency are involved.
//
// Usage: node tools/build-client.mjs [--check]
//   --check  parse the emitted bundle without writing it
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const srcDir = join(root, 'src', 'client')
const outFile = join(root, 'lib', 'client.js')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const pluginId = pkg.name

const entries = (await readdir(srcDir))
  .filter((name) => name.endsWith('.js'))
  .sort((left, right) => left.localeCompare(right, 'en'))

if (entries.length === 0) {
  console.error('build-client: no source fragments in ' + srcDir)
  process.exit(1)
}

const bodies = []
for (const name of entries) {
  const source = await readFile(join(srcDir, name), 'utf8')
  bodies.push(`//#region src/client/${name}\n${source.trimEnd()}\n//#endregion`)
}

const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pluginId)},
  factory(require) {
    'use strict';
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const Fragment = React.Fragment;
${bodies.map((body) => body.split('\n').map((line) => (line ? '    ' + line : line)).join('\n')).join('\n')}
    return { inject: ['slots', 'workspaces', 'uiWorkspace', 'locale'], apply };
  },
});
`

if (process.argv.includes('--check')) {
  new Function('window', 'fetch', bundle)
  console.log('build-client: syntax OK (' + entries.length + ' fragments)')
  process.exit(0)
}

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, bundle, 'utf8')
new Function('window', 'fetch', bundle)
console.log('build-client: wrote ' + outFile + ' from ' + entries.length + ' fragments')
