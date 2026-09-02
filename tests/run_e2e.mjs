/*
 * elips — Editor de LIcitacions PúbliqueS
 * Copyright (C) 2026  Francesc Rambla i Marigot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Orchestrates the Puppeteer e2e suite: builds the app, serves dist/ on
// http://localhost:8000 (the URL every e2e script targets), waits for it to
// respond, then runs each e2e script in turn and forwards their exit code.
// This replaces the previous requirement of manually starting a static
// server in another terminal before `npm run test:e2e` would do anything.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(__dirname);
const PORT = 8000;
const BASE_URL = `http://localhost:${PORT}/index.html`;

// Puppeteer's own Chromium download is often blocked/skipped in restricted
// install environments; fall back to a system-installed browser if present
// so `npm run test:e2e` still works without a manual `npx puppeteer browsers install`.
function resolveChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
  return candidates.find((p) => fs.existsSync(p));
}
const chromiumPath = resolveChromiumPath();

const E2E_SCRIPTS = [
  'e2e_browser.e2e.js',
  'test_nested_features.e2e.js',
  'test_visual_editor.e2e.js',
  'test_zip_recovery.e2e.js',
  'test_project_workflow.js',
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} ha fallat (codi ${code})`))));
  });
}

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`El servidor a ${url} no ha respost dins de ${timeoutMs}ms`);
}

async function main() {
  console.log('🏗️  Construint l\'aplicació (vite build)...');
  await run('node_modules/.bin/vite', ['build']);

  console.log(`🌐 Arrencant servidor estàtic a http://localhost:${PORT}...`);
  const server = spawn('node_modules/.bin/vite', ['preview', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(d));

  let exitCode = 0;
  try {
    await waitForServer(BASE_URL);
    console.log('  ✓ Servidor a punt.\n');

    const scriptEnv = chromiumPath ? { ...process.env, PUPPETEER_EXECUTABLE_PATH: chromiumPath } : process.env;
    for (const script of E2E_SCRIPTS) {
      console.log(`\n=== ${script} ===`);
      await run('node', [path.join('tests', script)], { env: scriptEnv });
    }
    console.log('\n🎉 Totes les proves e2e han passat.');
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    exitCode = 1;
  } finally {
    server.kill();
  }
  process.exit(exitCode);
}

main();
