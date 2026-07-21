import { spawn } from 'node:child_process';

const [supervisorPath, requestPath] = process.argv.slice(2);
if (supervisorPath === undefined || requestPath === undefined) process.exit(64);

const supervisor = spawn(process.execPath, [supervisorPath, requestPath], {
  detached: true,
  stdio: 'ignore',
});
supervisor.unref();
process.exit(0);
