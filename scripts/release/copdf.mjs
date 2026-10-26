#!/usr/bin/env node
// The copdf command works in the user's report directory, outside the install folder.
if (!process.argv.includes('--workspace')) process.argv.push('--workspace', process.cwd());
await import('../start.mjs');
