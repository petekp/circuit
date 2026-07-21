#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const [mode, ...args] = process.argv.slice(2);

if (mode === 'environment') {
  process.stdout.write(
    JSON.stringify({
      cwd: process.cwd(),
      home: process.env.HOME,
      temp: process.env.TMPDIR,
      marker: process.env.CIRCUIT_MCP_PROOF_SANDBOX,
      secret: process.env.PROOF_TEST_SECRET,
    }),
  );
} else if (mode === 'leaf') {
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1_000);
} else if (mode === 'tree') {
  const pidFile = args[0];
  if (pidFile === undefined) throw new Error('tree mode requires a pid file');
  const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'], {
    stdio: 'ignore',
  });
  writeFileSync(pidFile, JSON.stringify({ root: process.pid, leaf: leaf.pid }));
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1_000);
} else if (mode === 'background') {
  const pidFile = args[0];
  if (pidFile === undefined) throw new Error('background mode requires a pid file');
  const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'], {
    detached: true,
    stdio: 'ignore',
  });
  leaf.unref();
  writeFileSync(pidFile, JSON.stringify({ root: process.pid, leaf: leaf.pid }));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
} else if (mode === 'output') {
  process.stdout.write('x'.repeat(Number(args[0] ?? 10_000)));
  setInterval(() => undefined, 1_000);
} else if (mode === 'sandbox-probe') {
  const [workspaceFile, outsideFile, portText] = args;
  if (workspaceFile === undefined || outsideFile === undefined || portText === undefined) {
    throw new Error('sandbox-probe mode requires workspace file, outside file, and port');
  }
  let workspaceWrite = false;
  let outsideWrite = false;
  let outsideError;
  try {
    writeFileSync(workspaceFile, 'workspace write allowed\n');
    workspaceWrite = true;
  } catch (error) {
    outsideError = `workspace:${error.code ?? error.message}`;
  }
  try {
    writeFileSync(outsideFile, 'outside write should be blocked\n');
    outsideWrite = true;
  } catch (error) {
    outsideError = error.code ?? error.message;
  }

  const socket = net.createConnection({ host: '127.0.0.1', port: Number(portText) });
  let connected = false;
  let networkError;
  const finish = () => {
    socket.destroy();
    process.stdout.write(
      JSON.stringify({ workspaceWrite, outsideWrite, outsideError, connected, networkError }),
    );
  };
  socket.once('connect', () => {
    connected = true;
    finish();
  });
  socket.once('error', (error) => {
    networkError = error.code ?? error.message;
    finish();
  });
  socket.setTimeout(1_000, () => {
    networkError = 'TIMEOUT';
    finish();
  });
} else {
  throw new Error(`unknown proof command fixture mode: ${String(mode)}`);
}
