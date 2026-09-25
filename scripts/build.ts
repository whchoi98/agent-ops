import { build } from 'esbuild';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.js',
  platform: 'node',
  target: 'node20',
  format: 'esm',
  bundle: true,
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
});
await chmod('dist/server/index.js', 0o755);

// Preserve license texts in compiled distributions. This inventory also includes
// build dependencies, which are not necessarily bundled into runtime assets.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8')) as { packages: Record<string, unknown> };
const notices = await Promise.all(Object.keys(lock.packages).filter((path) => path.includes('node_modules/')).map(async (path) => {
  try {
    const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
    const names = (await readdir(path)).filter((name) => /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(name));
    const texts = await Promise.all(names.map(async (name) => {
      try { return await readFile(join(path, name), 'utf8'); } catch { return ''; }
    }));
    return `\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense metadata: ${pkg.license || 'See package license'}\n${texts.filter(Boolean).join('\n') || 'See the installed package distribution for complete license terms.'}\n`;
  } catch { return ''; }
}));
await writeFile('dist/client/THIRD_PARTY_NOTICES.txt',
  'Agent Ops dependency notices\nIncludes installed runtime and build dependencies; not all are bundled.\n'
  + notices.filter(Boolean).join(''));
console.log(`Third-party notices: ${notices.filter(Boolean).length} installed packages.`);
