#!/usr/bin/env node
import { appendFile, chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (process.env.FIXTURE_LOG) await appendFile(process.env.FIXTURE_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FIXTURE_MODE === 'install-error') process.exit(1);
if (args[0] === 'view') {
  process.stdout.write(JSON.stringify(process.env.FIXTURE_VERSION || '1.2.3'));
} else if (args[0] === 'install') {
  const prefix = args[args.indexOf('--prefix') + 1];
  await mkdir(join(prefix, 'node_modules/.bin'), { recursive: true });
  await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs'), join(prefix, 'node_modules/.bin/hue'));
  await chmod(join(prefix, 'node_modules/.bin/hue'), 0o755);
} else {
  process.exit(2);
}
