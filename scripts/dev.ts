import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const demo = process.argv.includes('--demo');
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', demo ? 'demo' : 'serve', '--data-dir', resolve('.data')], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  children.forEach((child) => { if (child.exitCode === null) child.kill('SIGTERM'); });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
children.forEach((child) => {
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; stop(); });
  child.once('exit', (code) => { if (!closing) { process.exitCode = code || 0; stop(); } });
});
