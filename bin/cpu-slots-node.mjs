#!/usr/bin/env node
// In a checkout or a clone (src/ beside, not under node_modules) the TypeScript source runs as is —
// Node strips the types — so a clone with no build has the command, and a stale dist/ never runs. A
// published install has dist/ alone (src/ is not in `files`).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = new URL('../src/node-bin.ts', import.meta.url);
// Checked on the URL: its separator is `/` on Windows too.
const fromSource = existsSync(fileURLToPath(src)) && !src.href.includes('/node_modules/');
await import((fromSource ? src : new URL('../dist/node-bin.js', import.meta.url)).href);
