#!/usr/bin/env node
// `cpu-slots-node <node args>` = `node --import <this package's register, by absolute URL> <node args>`.
// By URL, not by name: a test that forks a child with a cwd of its own hands the child the same
// `--import`, and a bare `cpu-slots/register` resolved from that cwd is a module not found.
import { runInGroup } from './group.ts';

// Beside this file: the source's own when run from the source (a checkout, a clone), the build's in a
// published install.
const register = new URL(import.meta.url.endsWith('.ts') ? './register.ts' : './register.js', import.meta.url).href;
// `node --test` ends its file processes on SIGTERM, not on SIGHUP: it dies of that one, and they run on.
runInGroup(process.execPath, ['--import', register, ...process.argv.slice(2)], process.env, 'cpu-slots-node', { SIGHUP: 'SIGTERM' });
