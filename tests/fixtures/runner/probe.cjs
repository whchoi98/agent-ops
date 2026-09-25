const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(`${__filename}.json`, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(`${__filename}.calls`, `${JSON.stringify(args)}\n`);

if (args.length === 1 && args[0] === '--version') {
  if (settings.hangVersion) {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else if (settings.failVersion) {
    process.stderr.write('Version unavailable; token=probe-private-token\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${settings.version || 'fixture 1.2.3'}\n`);
  }
} else if (args.at(-1) === '--help') {
  process.stdout.write(settings.help?.[args.join(' ')] || 'Usage: fixture\n');
} else {
  process.stderr.write('Unexpected invocation: tests never perform inference.\n');
  process.exitCode = 91;
}
