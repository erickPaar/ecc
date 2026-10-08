#!/usr/bin/env node
// Runs a hook module that exports run(rawInput), the interface ECC's hooks use.
// run() returns the input unchanged to allow, or {stdout, stderr, exitCode}.
'use strict';
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let result;
  try {
    result = require(path.resolve(process.argv[2])).run(raw);
  } catch (err) {
    process.stderr.write(`[ecc] ${path.basename(process.argv[2])} failed: ${err.message}\n`);
    process.exit(0);
  }
  if (result && typeof result === 'object') {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    process.exit(result.exitCode || 0);
  }
  process.exit(0);
});
