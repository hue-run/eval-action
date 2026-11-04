---
name: verify-action
description: Prove the Hue GitHub Action wrapper with real Node child processes and parsed workflow files.
---

# Verify the Hue Action

## Launch

Use Node.js 24 and Bun 1.3.9. From this repository, run `bun install --frozen-lockfile`. No server or database is needed. Each process fixture owns a temporary workspace, installation directory, and report directory. The external npm and Hue executable boundaries use synthetic fixtures.

## Doctor

Run `node --version`, `bun --version`, and `git status --short --branch`. Node must be 24. Run `node --check src/run.mjs` before driving behavior.

## Drive

Run `bun run check`. It starts the real wrapper as a Node process, installs the fixture runner through a separate npm fixture process, reads GitHub output files and summaries, and executes the composite's final Bash command. The workflow test parses YAML and checks the job name, event triggers, concurrency, and artifact steps.

See [the feature map](features/README.md) for focused drives. For hosted proof, use the repository's PR workflow. Inspect each step outcome, report artifact, and emitted check name through GitHub. Do not confuse synthetic pass/fail receipts with a live Hue run.

## Evidence

Save command output under `.local/verification/action/` and paste the command, passing test count, and exit status in the PR. Hosted proof needs the PR head, workflow run link, exact check name, step outcomes, and downloaded reports. Record access failures and skipped merge-group or live-Hue acceptance separately.

## Cleanup

Tests remove their own temporary directories and child processes. Keep `.local/verification/action/` evidence. For a failed manual drive, stop only the child process you started. Never change secrets or GitHub policies to make a proof pass.
