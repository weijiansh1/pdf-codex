#!/usr/bin/env node
// npm commands work in the user's report directory, outside the global install folder.
if (!process.argv.includes('--workspace')) process.argv.push('--workspace', process.cwd());
await import('../start.mjs');
