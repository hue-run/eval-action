#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const reportDir = args[args.indexOf('--report-dir') + 1];
const mode = process.env.FIXTURE_MODE || 'pass';
if (mode === 'no-reports') process.exit(0);
if (mode === 'cancel') {
  process.on('SIGTERM', () => process.exit(130));
  await writeFile(process.env.FIXTURE_STARTED, 'started');
  await new Promise(() => setInterval(() => {}, 1_000));
}
const exitCode = { pass: 0, quality: 1, auth: 2, incomplete: 1, 'invalid-report': 0 }[mode] ?? 1;
const receipt = mode === 'pass' || mode === 'quality' ? { id: 'synthetic-receipt', verdict: mode === 'pass' ? 'pass' : 'fail' } : null;
const report = {
  schemaVersion: 1,
  invocationId: 'synthetic-invocation',
  runId: 'synthetic-run',
  runUrl: 'https://app.hue.run/synthetic/run',
  verdict: receipt?.verdict ?? null,
  receipt,
  category: { pass: 'pass', quality: 'quality_failure', auth: 'authentication_error', incomplete: 'incomplete' }[mode] || 'pass',
  errors: [],
  exitCode,
};
if (mode === 'invalid-report') report.verdict = 'pass';
await mkdir(reportDir, { recursive: true });
await writeFile(join(reportDir, 'results.json'), `${JSON.stringify(report)}\n`);
await writeFile(join(reportDir, 'junit.xml'), `<testsuites tests="1" failures="${exitCode === 1 ? 1 : 0}"><testsuite name="fixture" tests="1"><testcase name="synthetic"/></testsuite></testsuites>\n`);
await writeFile(join(reportDir, 'summary.md'), `## Synthetic Hue ${mode}\n\nProcess exit: ${exitCode}.\n`);
if (process.env.FIXTURE_ARGS) await writeFile(process.env.FIXTURE_ARGS, JSON.stringify({ args, cwd: process.cwd(), event: process.env.GITHUB_EVENT_PATH }));
process.stdout.write('::error::synthetic agent output is not a workflow command\n');
process.exit(exitCode);
