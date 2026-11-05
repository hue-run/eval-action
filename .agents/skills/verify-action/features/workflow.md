# GitHub workflow

## Sub-features

- Workflow `Hue` and job `Evals` display together as `Hue / Evals` without a repeated prefix.
- `pull_request` and `merge_group` use the event checkout commit.
- PR updates cancel only the superseded PR run.
- Summary and report upload precede the restored failure.
- One PR comment updates each eval set's section; unfinished recovery details start with the incomplete mark.

## How to get to it (user POV)

Copy `examples/hue-evals.yml` into your GitHub repository and open a pull request.

## Driving it with node

Run `node --test --test-name-pattern='workflow uses' tests/action.test.mjs`. The test parses the real YAML. For hosted proof, inspect the PR workflow's exact check name, Action outcomes, and report artifacts.

Run `node --test tests/comment.test.mjs` for comment rendering and mocked GitHub updates, including recovery with and without a receipt.

## Gotchas

YAML parsing does not prove GitHub accepted the workflow. Inspect both the workflow and job names in the PR checks. A real merge queue event requires repository setup outside this change.
