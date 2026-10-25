#!/usr/bin/env node
/**
 * Starts the Nimbus development environment: the Fastify API in watch mode and
 * the Vite dev server with its /api proxy. Works on Windows, macOS and Linux.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

for (const [name, file] of [
  ['tsx', tsxCli],
  ['vite', viteCli],
]) {
  if (!existsSync(file)) {
    console.error(`[dev] ${name} is not installed. Run "npm install" first.`);
    process.exit(1);
  }
}

const children = new Set();
let shuttingDown = false;

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 350).unref();
}

function start(name, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    console.error(`[dev] could not start ${name}:`, error);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`[dev] ${name} stopped (${code ?? signal ?? 'unknown'}).`);
      shutdown(code ?? 1);
    }
  });
  children.add(child);
  return child;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('');
console.log('  Nimbus development');
console.log('  API    http://127.0.0.1:8787');
console.log('  Web    http://127.0.0.1:5173');
console.log('');

start('server', [tsxCli, 'watch', 'src/server/index.ts']);
start('client', [viteCli]);
