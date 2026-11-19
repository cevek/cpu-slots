// For `node --test --import cpu-slots/register`: the process of each test file takes a slot before
// the file runs and keeps it until it exits. The runner's own process takes none: only a test
// file's child process has `NODE_TEST_CONTEXT` (`child`, `child-v8`).
import { acquireSlot } from './index.ts';

if (process.env['NODE_TEST_CONTEXT']?.startsWith('child')) {
  Object.assign(process.env, (await acquireSlot()).env);
}
