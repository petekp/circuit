import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const [, , mode, ...args] = process.argv;

if (mode === 'environment') {
  process.stdout.write(
    JSON.stringify({
      cwd: process.cwd(),
      home: process.env.HOME,
      temp: process.env.TMPDIR,
      cache: process.env.XDG_CACHE_HOME,
      secret: process.env.OPENAI_API_KEY,
      proxy: process.env.HTTPS_PROXY,
      marker: process.env.CI,
    }),
  );
} else if (mode === 'writes') {
  const [workspaceFile, outsideFile] = args;
  const result = {};
  try {
    await writeFile(workspaceFile, 'workspace\n');
    result.workspace = true;
  } catch {
    result.workspace = false;
  }
  try {
    await writeFile(outsideFile, 'outside\n');
    result.outside = true;
  } catch {
    result.outside = false;
  }
  try {
    await writeFile(`${process.env.TMPDIR}/temp.txt`, 'temp\n');
    result.temp = true;
  } catch {
    result.temp = false;
  }
  process.stdout.write(JSON.stringify(result));
} else if (mode === 'reads') {
  const result = {};
  for (const [index, candidate] of args.entries()) {
    try {
      await readFile(candidate, 'utf8');
      result[index] = true;
    } catch {
      result[index] = false;
    }
  }
  process.stdout.write(JSON.stringify(result));
} else if (mode === 'identity') {
  await writeFile(args[0], `${process.pid}\n`);
  setInterval(() => undefined, 1_000);
} else if (mode === 'output') {
  process.stdout.write('x'.repeat(Number(args[0] ?? '0')));
} else if (mode === 'sleep') {
  setInterval(() => undefined, 1_000);
} else if (mode === 'background') {
  const [pidFile] = args;
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'sleep'], {
    detached: false,
    stdio: 'ignore',
  });
  await writeFile(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));
  // Give the process observer a deterministic window under full-suite load.
  await delay(5_000);
  child.unref();
} else if (mode === 'detached-background') {
  const [pidFile] = args;
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'sleep'], {
    detached: true,
    stdio: 'ignore',
  });
  await writeFile(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));
  // Keep the detached child observable even when the full test suite heavily
  // loads the host. A descendant that detaches and disappears between
  // observations remains a documented limit.
  await delay(5_000);
  child.unref();
} else if (mode === 'foreground-child') {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("child")'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.pipe(process.stdout);
  await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('close', resolvePromise);
  });
} else if (mode === 'tcp') {
  const [port] = args;
  const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
  socket.setTimeout(1_000);
  socket.once('connect', () => {
    process.stdout.write('connected');
    socket.destroy();
  });
  socket.once('error', (error) => {
    process.stderr.write(error.message);
    process.exitCode = 2;
  });
  socket.once('timeout', () => {
    socket.destroy();
    process.exitCode = 3;
  });
} else {
  process.stderr.write(`unknown fixture mode: ${String(mode)}`);
  process.exitCode = 64;
}
