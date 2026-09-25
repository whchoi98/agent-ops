import { lstatSync } from 'node:fs';

/** Directory locks cannot protect database files shared through a different directory. */
export function assertDatabaseFile(filename: string, required = false): void {
  let stat;
  try { stat = lstatSync(filename); }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('The Agent Ops database must be a regular file without symbolic or hard links.');
  }
}
