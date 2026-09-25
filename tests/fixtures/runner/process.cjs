const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

if (process.argv[2] === '--fixture-grandchild') {
  const heartbeat = process.argv[3];
  fs.writeFileSync(`${heartbeat}.pid`, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => fs.appendFileSync(heartbeat, 'alive\n'), 30);
} else {
  const config = JSON.parse(fs.readFileSync(`${__filename}.json`, 'utf8'));
  const args = process.argv.slice(2);
  let terminating = false;
  if (config.ignoreTerm) process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => {
    if (terminating) return;
    terminating = true;
    Promise.all([
      new Promise((resolve) => process.stdout.write(config.termStdout || '', resolve)),
      new Promise((resolve) => process.stderr.write(config.termStderr || '', resolve)),
    ]).then(() => process.exit(0));
  });

  async function output(stream, text) {
    if (!stream.write(text)) await once(stream, 'drain');
  }
  async function main() {
    if (config.closeStdin) {
      process.stdin.destroy();
      fs.closeSync(0);
      process.stdout.write('stdin deliberately closed\n');
      await new Promise((resolve) => setTimeout(resolve, 40));
      return;
    }
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    const terminator = args.indexOf('--');
    const prompt = input || (terminator >= 0 ? args[terminator + 1] : '') || '';
    const call = { argv: args, cwd: process.cwd(), stdin: input, prompt, pid: process.pid };
    fs.appendFileSync(`${__filename}.calls`, `${JSON.stringify(call)}\n`);
    await output(process.stdout, `${JSON.stringify({ fixture: 'started', ...call })}\n`);

    if (config.heartbeat && (!config.descendantPrompt || prompt === config.descendantPrompt)) {
      const descendant = spawn(process.execPath, [__filename, '--fixture-grandchild', config.heartbeat], {
        stdio: config.descendantIgnoresStdio ? 'ignore' : 'inherit', detached: Boolean(config.detachedDescendant),
      });
      if (config.detachedDescendant) {
        descendant.unref();
        while (!fs.existsSync(`${config.heartbeat}.pid`)) await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (config.checkFilePolicy) {
      const inventory = args[args.indexOf('--tools') + 1];
      const trust = args.find((arg) => arg.startsWith('--trust-tools='));
      const mayWrite = args.includes('workspace-write')
        || args.includes('sandbox_mode="workspace-write"')
        || (inventory === 'Read,Glob,Grep,Edit,Write' && args.includes('acceptEdits'))
        || trust === '--trust-tools=fs_read,fs_write'
        || trust === '--trust-tools=read,grep,write';
      if (mayWrite) fs.writeFileSync('fixture-edit.txt', 'approved file edit\n');
      await output(process.stdout, mayWrite ? 'file edit allowed\n' : 'file edit denied\n');
    }
    if (config.checkShellPolicy) {
      const inventory = args[args.indexOf('--tools') + 1];
      const trust = args.find((arg) => arg.startsWith('--trust-tools='));
      const mayRun = inventory === 'Read,Glob,Grep,Edit,Write,Bash'
        || trust === '--trust-tools=fs_read,fs_write,execute_bash'
        || trust === '--trust-tools=read,grep,write,shell';
      if (mayRun) {
        // A real, controlled subprocess proves the opt-in reaches executable behavior.
        const child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync("fixture-build.txt", "build passed\\n")'], { stdio: 'ignore' });
        const [code] = await once(child, 'close');
        if (code !== 0) throw new Error('Controlled build failed');
      }
      await output(process.stdout, mayRun ? 'build process allowed\n' : 'build process denied\n');
    }
    if (config.chunks) {
      for (const chunk of config.chunks) {
        await output(process.stdout, Buffer.from(chunk));
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (config.bytewiseText) {
      const bytes = Buffer.from(config.bytewiseText);
      for (const byte of bytes) {
        await output(process.stdout, Buffer.from([byte]));
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    for (const value of config.records || []) {
      await output(process.stdout, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    }
    for (const text of config.stderr || []) await output(process.stderr, `${text}\n`);
    if (config.floodLines) {
      const line = `${'x'.repeat(config.lineLength || 20)}\n`;
      for (let i = 0; i < config.floodLines; i++) await output(process.stdout, line);
    }
    if (config.noNewlineBytes) {
      for (let i = 0; i < config.noNewlineBytes; i += 16384) await output(process.stdout, 'z'.repeat(16384));
    }
    const hold = /^hold:([A-Za-z0-9_-]+)$/.exec(prompt);
    if (hold || config.hold) {
      await output(process.stdout, 'fixture ready\n');
      const release = hold ? `${config.controlDir}/${hold[1]}.release` : config.release;
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (release && fs.existsSync(release)) {
            clearInterval(timer);
            resolve();
          }
        }, 20);
      });
    }
    for (const value of config.finalRecords || []) await output(process.stdout, `${JSON.stringify(value)}\n`);
    if (config.tailStdout) await output(process.stdout, config.tailStdout);
    if (config.tailStderr) await output(process.stderr, config.tailStderr);
    if (config.failOnceFile && !fs.existsSync(config.failOnceFile)) {
      fs.writeFileSync(config.failOnceFile, 'failed once\n');
      process.exitCode = 7;
    } else process.exitCode = config.exitCode || 0;
  }
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 93;
  });
}
