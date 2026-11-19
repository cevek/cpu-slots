#!/usr/bin/env node
// `cpu-slots-node <node args>` = `node --import <this package's register, by absolute URL> <node args>`.
// By URL, not by name: a test that forks a child with a cwd of its own hands the child the same
// `--import`, and a bare `cpu-slots/register` resolved from that cwd is a module not found.
import { runInGroup } from './group.js';

const register = new URL('./register.js', import.meta.url).href;
runInGroup(process.execPath, ['--import', register, ...process.argv.slice(2)], process.env, 'cpu-slots-node');
