import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const [mode = 'complete', delayText = '20'] = process.argv.slice(2);
const delayMs = Number(delayText);

if (mode === 'complete') {
  console.error(JSON.stringify({ type: 'fixture.progress', status: 'running' }));
  setTimeout(() => {
    console.log(JSON.stringify({ outcome: 'complete', source: 'runtime-supervisor-fixture' }));
  }, delayMs);
} else if (mode === 'fail') {
  console.error('fixture failed');
  process.exitCode = 7;
} else if (mode === 'report-api-key') {
  console.log(JSON.stringify({ api_key: process.env.OPENAI_API_KEY ?? null }));
} else if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  console.log(JSON.stringify({ root_pid: process.pid }));
  setInterval(() => {}, 1_000);
} else if (mode === 'hang-tree') {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{}, 1000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  process.on('SIGTERM', () => {});
  child.stdout.once('data', (chunk) => {
    console.log(
      JSON.stringify({ root_pid: process.pid, child_pid: Number(chunk.toString().trim()) }),
    );
  });
  setInterval(() => {}, 1_000);
} else if (mode === 'cooperative-orphan' || mode === 'orphan-on-exit') {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"],
    { detached: mode === 'orphan-on-exit', stdio: 'ignore' },
  );
  child.unref();
  console.log(JSON.stringify({ root_pid: process.pid, child_pid: child.pid }));
  if (mode === 'cooperative-orphan') {
    const cancelFile = process.env.CIRCUIT_MCP_CANCEL_FILE;
    const poll = setInterval(() => {
      if (cancelFile !== undefined && existsSync(cancelFile)) {
        clearInterval(poll);
        process.exit(0);
      }
    }, 10);
  } else {
    setTimeout(() => process.exit(0), 50);
  }
} else if (mode === 'flood-stdout' || mode === 'flood-stderr') {
  process.on('SIGTERM', () => {});
  const stream = mode === 'flood-stdout' ? process.stdout : process.stderr;
  const chunk = Buffer.alloc(64 * 1024, mode === 'flood-stdout' ? 'o' : 'e');
  const flood = () => {
    while (stream.write(chunk)) {
      // Keep writing until the supervisor applies backpressure.
    }
    stream.once('drain', flood);
  };
  flood();
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`Unknown runtime supervisor fixture mode: ${mode}`);
}
