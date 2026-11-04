# Hue evals for GitHub Actions

Run the same Hue evaluation configuration locally and in GitHub. The Action installs the latest stable released `@hue-run/sdk` runner and invokes:

```sh
hue eval --ci --config hue.eval.json --report-dir .hue/reports
```

## Add the workflow

1. Connect your agent to each case's world with the [agent adapter guide](https://docs.hue.run/evaluations/eval-ready-agent).
2. Commit `hue.eval.json` with your eval set, command, and evaluators. Keep model credentials in your ordinary secret store.
3. Create a **Read and write** project key in Hue **Settings → API keys**. Store it as the GitHub Actions secret `HUE_API_KEY`.
4. Copy [examples/hue-evals.yml](examples/hue-evals.yml) to `.github/workflows/hue-evals.yml`. Replace `npm ci` with your project's dependency installation and add the model credentials your agent already uses to the Action step's environment.

GitHub displays the workflow `Hue` and job `Evals` together as `Hue / Evals`. It handles `pull_request` and `merge_group` with `contents: read`. Checkout uses GitHub's event commit: the PR test merge commit or merge-group commit. The runner records `git HEAD` as the tested commit and keeps the PR head separately. PR updates cancel older runs of that PR; separate merge-group refs have separate concurrency groups and do not cancel one another.

Fork and Dependabot pull requests normally lack ordinary Actions secrets. The Action fails with an authentication report when `HUE_API_KEY` is missing. Run the evaluation on a trusted branch with the required secrets. Do not use `pull_request_target` to execute untrusted code with secrets. Missing model credentials must also fail in your agent or its setup.

## Configure the Action

| Input | Default | Meaning |
| --- | --- | --- |
| `config` | `hue.eval.json` | Configuration path relative to `working-directory`. |
| `working-directory` | `.` | Agent project directory relative to the checked-out workspace. |
| `report-dir` | `.hue/reports` | Report directory relative to `working-directory`, inside the workspace. |
| `version` | `latest` | Latest stable npm release, or an exact released version for debugging. |

The runner installs in a temporary directory. It does not change your lockfile or project dependencies. Install the SDK separately if your agent imports it. The exact runner version appears in `runner-version`.

## Read the result

| Output | Meaning |
| --- | --- |
| `run-url` | Hue run URL, empty before a run exists. |
| `verdict` | Server receipt verdict, empty without a finalized receipt. |
| `exit-code` | CLI exit code, or wrapper setup failure code. |
| `runner-version` | Installed runner version, empty if installation did not finish. |
| `report-dir` | Absolute report directory. |
| `results-json` | Absolute path to `results.json`. |
| `junit-xml` | Absolute path to `junit.xml`. |
| `summary-md` | Absolute path to `summary.md`. |

The Action copies the runner's Markdown to the job summary and uploads only these three report files as a `hue-evals-…` artifact. Checkpoints and agent scratch files are excluded. Installer, Node setup, and missing-key failures also create all three reports, with a null receipt and verdict. An invalid or unwritable report path uses a new directory under the runner's temporary directory. The wrapper checks report and receipt consistency without scoring cases.

Exit codes remain `0` for pass, `1` for quality failure, agent error, Hue error, or incomplete execution, `2` for configuration or credential errors, and `130` for interruption. Reports upload before the final step restores that code. An artifact upload failure also fails the Action. Outputs remain available to later workflow steps that use `if: always()`.

A pass receipt can accompany a nonzero exit if transport fails or the process is interrupted after finalization. The Action preserves both the receipt verdict and the failing exit code. A zero exit requires a pass receipt, a pass category, and no errors.

For results-only recovery, use the released CLI's `hue eval status <run-id> --report-dir .hue/reports`. This reads saved results without executing the agent again. Reports after hard cancellation or runner loss are best effort; the invocation's remote deadline remains independent of the GitHub runner.

## Runner requirements

Use GitHub-hosted Ubuntu or a compatible self-hosted Linux runner with Bash, Node.js 24, npm, and outbound access to npm, GitHub artifacts, and Hue. The bundled `actions/setup-node@v6` and `actions/upload-artifact@v6` require Actions runner `v2.327.1` or later for Node 24. Self-hosted runners need Node 24 on `PATH` so a failed setup step can still write reports. Install your agent's language runtime separately.

GitHub Enterprise Server artifact support is outside this release.

## Verify changes

Use Node.js 24 and Bun 1.3.9:

```sh
bun install --frozen-lockfile
bun run check
```

The [verify-action skill](.agents/skills/verify-action/SKILL.md) drives separate Node processes for pass, failure, setup, authentication, cancellation, and report validation. Synthetic results prove wrapper behavior; they do not prove a live Hue invocation or a merge queue check.
