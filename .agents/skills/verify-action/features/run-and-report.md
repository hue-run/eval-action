# Run and report

## Sub-features

- Install latest stable or an exact runner version in a temporary directory.
- Forward reports and authoritative receipt verdicts.
- Retain CLI failure codes after summaries and artifacts.
- Report installer, credential, protocol, and cancellation failures.

## How to get to it (user POV)

Use the Action in `examples/hue-evals.yml`, with `HUE_API_KEY` in its environment.

## Driving it with node

Run `node --test tests/action.test.mjs`. Every behavioral drive launches `src/run.mjs` as a separate process. Expect `results.json`, `junit.xml`, `summary.md`, a matching job summary, output paths, and the original exit code from the composite's final Bash step.

## Gotchas

Synthetic npm and runner processes replace only those external boundaries. This proves no remote case execution, isolation, hosted scoring, or service compatibility.
