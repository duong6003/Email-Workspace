import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const [packageDirectory] = process.argv.slice(2);
if (!packageDirectory) throw new Error('usage: node scripts/backend-dev.mjs <package-directory>');
const packageRoot = fileURLToPath(new URL(`../${packageDirectory}/`, import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const unquote = (value) => {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
};
for (const line of readFileSync(resolve(repositoryRoot, '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match || process.env[match[1]] !== undefined) continue;
  process.env[match[1]] = unquote(match[2]);
}

const databaseUrl = process.env.DATABASE_URL ?? `postgresql://eow_app:${encodeURIComponent(process.env.EOW_POSTGRES_APP_PASSWORD ?? '')}@${process.env.EOW_POSTGRES_BIND ?? '127.0.0.1'}:${process.env.EOW_POSTGRES_PORT ?? '55432'}/${process.env.EOW_POSTGRES_DB ?? 'eow'}`;
const redisUrl = process.env.REDIS_URL ?? `redis://:${encodeURIComponent(process.env.EOW_REDIS_PASSWORD ?? '')}@${process.env.EOW_REDIS_BIND ?? '127.0.0.1'}:${process.env.EOW_REDIS_PORT ?? '56379'}/0`;
process.env.DATABASE_URL = databaseUrl;
process.env.REDIS_URL = redisUrl;
process.env.SESSION_SECRET ??= process.env.EOW_SESSION_SECRET;
process.env.SENDER_CREDENTIAL_KEY ??= process.env.EOW_SENDER_CREDENTIAL_KEY;

const typescript = resolve(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const children = [
  spawn(process.execPath, [typescript, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], { cwd: packageRoot, stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', `${packageDirectory}/dist/main.js`], { cwd: repositoryRoot, stdio: 'inherit' }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
};

for (const child of children) {
  child.on('error', (error) => {
    console.error(error);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping && (code !== 0 || signal)) stop(code ?? 1);
  });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
