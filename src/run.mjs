import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const filenames = ['results.json', 'junit.xml', 'summary.md'];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

class ActionError extends Error {
  constructor(code, message, category = 'configuration_error', exitCode = 2) {
    super(message);
    Object.assign(this, { code, category, exitCode });
  }
}

function inside(root, path) {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix);
}

// Resolve existing ancestors so a report directory cannot escape through a symlink.
async function workspacePath(workspace, path) {
  let ancestor = path;
  for (;;) {
    try {
      const actual = resolve(await realpath(ancestor), relative(ancestor, path));
      if (!inside(workspace, actual)) throw new ActionError('ACTION_PATH', 'Paths must stay inside the GitHub workspace.');
      return actual;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
}

function execute(command, args, options, signal, capture = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      ...options,
      signal,
      stdio: capture ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) child.kill();
    });
    child.once('error', reject);
    child.once('close', (code, childSignal) => resolveResult({ code: code ?? (childSignal ? 130 : 1), stdout }));
  });
}

async function setupReports(reportDir, error) {
  const report = {
    schemaVersion: 1,
    invocationId: null,
    runId: null,
    runUrl: null,
    verdict: null,
    receipt: null,
    category: error.category,
    errors: [{ code: error.code, message: error.message }],
    exitCode: error.exitCode,
  };
  const escapeXml = (text) => text.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(reportDir, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" errors="1"><testsuite name="Hue setup" tests="1" errors="1"><testcase name="${error.code}"><error type="${error.category}" message="${escapeXml(error.message)}"/></testcase></testsuite></testsuites>\n`);
  await writeFile(join(reportDir, 'summary.md'), `## Hue evals\n\n${error.message}\n\nCategory: \`${error.category}\`. Exit code: \`${error.exitCode}\`. No gate receipt is available.\n`);
  return report;
}

function parseReport(text) {
  const report = JSON.parse(text);
  if (report?.schemaVersion !== 1 || !Array.isArray(report.errors) ||
      !Number.isInteger(report.exitCode) ||
      !(report.runUrl === null || typeof report.runUrl === 'string') ||
      !(report.receipt === null || (typeof report.receipt === 'object' && !Array.isArray(report.receipt))) ||
      !(report.verdict === null || typeof report.verdict === 'string') ||
      (report.receipt === null && report.verdict !== null)) {
    throw new Error('Invalid runner report');
  }
  return report;
}

async function output(env, name, value) {
  if (!env.GITHUB_OUTPUT) return;
  const delimiter = `hue_${randomUUID()}`;
  await appendFile(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export async function runAction(env = process.env) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const workspace = await realpath(env.GITHUB_WORKSPACE || process.cwd());
  let reportDir = join(workspace, '.hue/reports');
  let installDir;
  let report;
  let exitCode = 2;
  try {
    const cwd = await workspacePath(workspace, resolve(workspace, env.HUE_ACTION_WORKING_DIRECTORY || '.'));
    reportDir = await workspacePath(workspace, resolve(cwd, env.HUE_ACTION_REPORT_DIR || '.hue/reports'));
    await mkdir(reportDir, { recursive: true });
    for (const name of filenames) await rm(join(reportDir, name), { force: true });
    if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) !== 24) {
      throw new ActionError('ACTION_RUNTIME', 'Hue evals requires Linux and Node.js 24.');
    }
    if (env.HUE_ACTION_NODE_OUTCOME && env.HUE_ACTION_NODE_OUTCOME !== 'success') {
      throw new ActionError('ACTION_NODE_SETUP', 'Node.js 24 setup failed. Check the setup step, runner tool cache, and network access.');
    }
    if (!env.HUE_API_KEY?.trim()) {
      throw new ActionError('ACTION_MISSING_KEY', 'HUE_API_KEY is unavailable. Configure a Read and write project key. Fork and Dependabot pull requests do not receive ordinary Actions secrets.', 'authentication_error');
    }
    const requested = env.HUE_ACTION_VERSION || 'latest';
    if (requested !== 'latest' && !stableVersion.test(requested)) {
      throw new ActionError('ACTION_VERSION', 'version must be latest or an exact stable runner version such as 0.26.0.');
    }
    const options = { cwd, env };
    let version = requested;
    if (version === 'latest') {
      const selected = await execute('npm', ['view', '@hue-run/sdk', 'dist-tags.latest', '--json', '--registry=https://registry.npmjs.org'], { ...options, timeout: 120_000 }, abort.signal, true);
      if (selected.code !== 0) throw new ActionError('ACTION_INSTALL', 'Could not resolve the latest stable Hue runner from npm. Check npm access.');
      try { version = JSON.parse(selected.stdout); } catch { version = ''; }
      if (typeof version !== 'string' || !stableVersion.test(version)) throw new ActionError('ACTION_VERSION', 'The npm latest tag does not select an exact stable runner release.');
    }
    installDir = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'hue-runner-'));
    const installed = await execute('npm', ['install', '--prefix', installDir, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--registry=https://registry.npmjs.org', `@hue-run/sdk@${version}`], { ...options, timeout: 120_000 }, abort.signal, true);
    if (installed.code !== 0) throw new ActionError('ACTION_INSTALL', 'Could not install the released Hue runner. Check npm access and the requested version.');
    await output(env, 'runner-version', version);
    // Agent output must not be interpreted as GitHub workflow commands.
    const stopToken = randomUUID();
    process.stdout.write(`::stop-commands::${stopToken}\n`);
    try {
      const result = await execute(join(installDir, 'node_modules/.bin/hue'), ['eval', '--ci', '--config', env.HUE_ACTION_CONFIG || 'hue.eval.json', '--report-dir', reportDir], options, abort.signal);
      exitCode = result.code;
    } finally {
      process.stdout.write(`::${stopToken}::\n`);
    }
    try {
      report = parseReport(await readFile(join(reportDir, 'results.json'), 'utf8'));
      await readFile(join(reportDir, 'junit.xml'), 'utf8');
      await readFile(join(reportDir, 'summary.md'), 'utf8');
      if (exitCode === 0 && (!report.receipt || !report.verdict)) throw new Error('No authoritative receipt');
      if (exitCode !== report.exitCode) throw new Error('Report and process exit disagree');
    } catch {
      throw new ActionError('ACTION_REPORTS', 'The runner did not produce complete CI reports. Use a released runner that supports --ci, --config, and --report-dir.', 'hue_error', exitCode || 1);
    }
  } catch (error) {
    const failure = abort.signal.aborted
      ? new ActionError('ACTION_CANCELLED', 'Hue evals was interrupted before reports completed.', 'cancelled', 130)
      : error instanceof ActionError ? error
        : new ActionError('ACTION_SETUP', 'Hue evals could not start or finish the runner. Check the configuration, Node.js 24, npm, and workspace permissions.', 'hue_error', exitCode === 2 ? 2 : exitCode || 1);
    exitCode = failure.exitCode;
    report = await setupReports(reportDir, failure);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (installDir) await rm(installDir, { recursive: true, force: true });
  }
  await output(env, 'run-url', report.runUrl || '');
  await output(env, 'verdict', report.receipt ? report.verdict || '' : '');
  await output(env, 'exit-code', String(exitCode));
  await output(env, 'report-dir', reportDir);
  for (const [index, name] of ['results-json', 'junit-xml', 'summary-md'].entries()) {
    await output(env, name, join(reportDir, filenames[index]));
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, await readFile(join(reportDir, 'summary.md'), 'utf8'));
  // The composite's last step restores this code after artifact upload.
}

if (import.meta.main) await runAction();
