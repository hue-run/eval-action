import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hue-action-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'bin'));
  await mkdir(join(directory, 'temp'));
  await copyFile(join(root, 'tests/fixtures/npm.mjs'), join(directory, 'bin/npm'));
  // The copied npm fixture finds its runner beside itself.
  await copyFile(join(root, 'tests/fixtures/runner.mjs'), join(directory, 'bin/runner.mjs'));
  await chmod(join(directory, 'bin/npm'), 0o755);
  const env = {
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    GITHUB_WORKSPACE: directory,
    RUNNER_TEMP: join(directory, 'temp'),
    GITHUB_OUTPUT: join(directory, 'outputs'),
    GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    HUE_API_KEY: 'synthetic-key-for-process-fixture',
    HUE_ACTION_NODE_OUTCOME: 'success',
    FIXTURE_LOG: join(directory, 'npm-args'),
    FIXTURE_ARGS: join(directory, 'runner-args'),
    FIXTURE_STARTED: join(directory, 'started'),
    ...overrides,
  };
  return { directory, env };
}

async function drive(t, overrides) {
  const item = await fixture(t, overrides);
  const result = spawnSync(process.execPath, [join(root, 'src/run.mjs')], { env: item.env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  const raw = await readFile(item.env.GITHUB_OUTPUT, 'utf8');
  const outputs = Object.fromEntries([...raw.matchAll(/^([^\n]+)<<([^\n]+)\n(.*?)\n\2\n/gms)].map((match) => [match[1], match[3]]));
  const report = JSON.parse(await readFile(outputs['results-json'], 'utf8'));
  assert.equal(await readFile(item.env.GITHUB_STEP_SUMMARY, 'utf8'), await readFile(outputs['summary-md'], 'utf8'));
  assert.match(await readFile(outputs['junit-xml'], 'utf8'), /<testsuites/);
  assert.deepEqual(await readdir(item.env.RUNNER_TEMP), []);
  // Run the same final shell step used by the composite.
  const final = spawnSync('bash', ['-c', 'exit "${HUE_EXIT_CODE:-2}"'], { env: { HUE_EXIT_CODE: outputs['exit-code'] } });
  return { ...item, outputs, report, result, final };
}

for (const [mode, exitCode, verdict] of [['pass', 0, 'pass'], ['quality', 1, 'fail'], ['auth', 2, ''], ['incomplete', 1, '']]) {
  test(`preserves ${mode} process, receipt, reports, and final exit`, async (t) => {
    const item = await drive(t, { FIXTURE_MODE: mode });
    assert.equal(item.final.status, exitCode);
    assert.equal(item.outputs.verdict, verdict);
    assert.equal(item.outputs['run-url'], item.report.runUrl);
    assert.equal(item.report.category, { pass: 'pass', quality: 'quality_failure', auth: 'authentication_error', incomplete: 'incomplete' }[mode]);
    assert.match(item.result.stdout, /::stop-commands::[^\n]+\n::error::synthetic/);
  });
}

test('latest selects and installs an exact stable release without project changes', async (t) => {
  const item = await drive(t);
  const calls = (await readFile(item.env.FIXTURE_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls[0][0], 'view');
  assert.equal(calls[1].at(-1), '@hue-run/sdk@1.2.3');
  assert.ok(calls[1].includes('--ignore-scripts'));
  const { args, cwd } = JSON.parse(await readFile(item.env.FIXTURE_ARGS, 'utf8'));
  assert.deepEqual(args, ['eval', '--ci', '--config', 'hue.eval.json', '--report-dir', join(item.directory, '.hue/reports')]);
  assert.equal(cwd, item.directory);
});

test('preserves a pass receipt and failure evidence when the process fails after finalization', async (t) => {
  const item = await drive(t, { FIXTURE_MODE: 'post-receipt-error' });
  assert.equal(item.final.status, 1);
  assert.equal(item.outputs.verdict, 'pass');
  assert.equal(item.report.receipt.verdict, 'pass');
  assert.equal(item.report.category, 'hue_error');
  assert.equal(item.report.errors[0].code, 'TRANSPORT_ERROR');
});

test('exact version skips latest lookup and passes spaces without shell expansion', async (t) => {
  const item = await drive(t, { HUE_ACTION_VERSION: '2.3.4-rc.1', HUE_ACTION_CONFIG: 'config with spaces; echo bad.json' });
  const calls = (await readFile(item.env.FIXTURE_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), '@hue-run/sdk@2.3.4-rc.1');
  const { args } = JSON.parse(await readFile(item.env.FIXTURE_ARGS, 'utf8'));
  assert.equal(args[3], 'config with spaces; echo bad.json');
});

test('a receipt must have a known verdict even when the process already failed', async (t) => {
  const item = await drive(t, { FIXTURE_MODE: 'post-receipt-error', FIXTURE_CORRUPT: 'null-receipt-verdict' });
  assert.equal(item.final.status, 1);
  assert.equal(item.report.errors[0].code, 'ACTION_REPORTS');
  assert.equal(item.outputs.verdict, '');
});

for (const [name, overrides, code, category] of [
  ['missing key', { HUE_API_KEY: '' }, 'ACTION_MISSING_KEY', 'authentication_error'],
  ['Node setup', { HUE_ACTION_NODE_OUTCOME: 'failure' }, 'ACTION_NODE_SETUP', 'configuration_error'],
  ['npm install', { FIXTURE_MODE: 'install-error' }, 'ACTION_INSTALL', 'configuration_error'],
  ['version range', { HUE_ACTION_VERSION: '^1.2.3' }, 'ACTION_VERSION', 'configuration_error'],
  ['prerelease latest', { FIXTURE_VERSION: '1.2.3-beta.1' }, 'ACTION_VERSION', 'configuration_error'],
  ['missing reports', { FIXTURE_MODE: 'no-reports' }, 'ACTION_REPORTS', 'hue_error'],
  ['verdict without receipt', { FIXTURE_MODE: 'invalid-report' }, 'ACTION_REPORTS', 'hue_error'],
]) {
  test(`${name} emits all setup reports without a verdict`, async (t) => {
    const item = await drive(t, overrides);
    assert.notEqual(item.final.status, 0);
    assert.equal(item.report.errors[0].code, code);
    assert.equal(item.report.category, category);
    assert.equal(item.report.receipt, null);
    assert.equal(item.outputs.verdict, '');
    assert.equal(item.outputs['run-url'], '');
    if (name === 'missing key') assert.match(await readFile(item.outputs['summary-md'], 'utf8'), /Fork and Dependabot/);
  });
}

for (const corruption of ['failed-receipt-zero-exit', 'receipt-disagrees', 'unknown-verdict', 'error-category', 'unknown-category', 'errors-on-pass']) {
  test(`inconsistent ${corruption} report cannot produce a green check`, async (t) => {
    const item = await drive(t, { FIXTURE_CORRUPT: corruption });
    assert.equal(item.final.status, 1);
    assert.equal(item.report.errors[0].code, 'ACTION_REPORTS');
    assert.equal(item.outputs.verdict, '');
  });
}

test('working-directory changes the CLI cwd and report base, preserving native GitHub context', async (t) => {
  const item = await fixture(t, { HUE_ACTION_WORKING_DIRECTORY: 'agent', GITHUB_EVENT_PATH: '/event/path' });
  await mkdir(join(item.directory, 'agent'));
  const result = spawnSync(process.execPath, [join(root, 'src/run.mjs')], { env: item.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(await readFile(item.env.FIXTURE_ARGS, 'utf8'));
  assert.equal(args.cwd, join(item.directory, 'agent'));
  assert.equal(args.event, '/event/path');
});

test('report paths cannot escape through a workspace symlink', async (t) => {
  const item = await fixture(t, { HUE_ACTION_REPORT_DIR: 'escape/reports' });
  const outside = await mkdtemp(join(tmpdir(), 'hue-action-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(item.directory, 'escape'));
  const result = spawnSync(process.execPath, [join(root, 'src/run.mjs')], { env: item.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(outside), []);
  const reports = (await readdir(item.env.RUNNER_TEMP)).find((name) => name.startsWith('hue-reports-'));
  const report = JSON.parse(await readFile(join(item.env.RUNNER_TEMP, reports, 'results.json'), 'utf8'));
  assert.equal(report.errors[0].code, 'ACTION_PATH');
});

test('invalid working-directory never writes through the fallback .hue symlink', async (t) => {
  const item = await fixture(t, { HUE_ACTION_WORKING_DIRECTORY: '../outside' });
  const outside = await mkdtemp(join(tmpdir(), 'hue-action-fallback-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(item.directory, '.hue'));
  const result = spawnSync(process.execPath, [join(root, 'src/run.mjs')], { env: item.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(outside), []);
  const reports = (await readdir(item.env.RUNNER_TEMP)).find((name) => name.startsWith('hue-reports-'));
  const report = JSON.parse(await readFile(join(item.env.RUNNER_TEMP, reports, 'results.json'), 'utf8'));
  assert.equal(report.errors[0].code, 'ACTION_PATH');
});

test('SIGTERM preserves interruption and produces reports', async (t) => {
  const item = await fixture(t, { FIXTURE_MODE: 'cancel' });
  const child = spawn(process.execPath, [join(root, 'src/run.mjs')], { env: item.env, stdio: 'ignore' });
  const ended = new Promise((resolveResult) => child.once('close', (code) => resolveResult(code)));
  t.after(() => child.kill('SIGKILL'));
  for (let count = 0; count < 100; count++) {
    try { await readFile(item.env.FIXTURE_STARTED); break; } catch { await setTimeout(20); }
  }
  child.kill('SIGTERM');
  assert.equal(await ended, 0);
  const report = JSON.parse(await readFile(join(item.directory, '.hue/reports/results.json'), 'utf8'));
  assert.equal(report.exitCode, 130);
  assert.equal(report.category, 'cancelled');
});

test('workflow uses the actual check name, tested checkout, isolated merge groups, and minimum permissions', async () => {
  const workflow = parse(await readFile(join(root, 'examples/hue-evals.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'merge_group']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.evals.name, 'Hue / Evals');
  assert.match(workflow.concurrency.group, /github.event_name/);
  assert.match(workflow.concurrency.group, /github.ref/);
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  const checkout = workflow.jobs.evals.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, undefined);
  assert.equal(checkout.with['persist-credentials'], false);
  const action = parse(await readFile(join(root, 'action.yml'), 'utf8'));
  const upload = action.runs.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.match(upload.if, /always\(\)/);
  assert.equal(upload.with['include-hidden-files'], true);
  assert.equal(upload.with.path.trim().split('\n').length, 3);
  const last = action.runs.steps.at(-1);
  assert.match(last.if, /always\(\)/);
  assert.equal(last.run, 'exit "${HUE_EXIT_CODE:-2}"');
});
