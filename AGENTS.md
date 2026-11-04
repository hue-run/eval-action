# Hue eval Action

Keep this Action a wrapper around the released Hue CLI. Do not add case execution, scoring, or verdict logic. Reports and the server receipt own the result.

Use Node.js 24 and Bun 1.3.9. Run `bun install --frozen-lockfile` and the [verify-action skill](.agents/skills/verify-action/SKILL.md) before a PR. Preserve `Hue / Evals`, both event triggers, Linux requirements, and failure reporting. Keep secrets out of output and fixtures.

Read connected CLI contracts before changing flags or report fields. Keep docs and the workflow template aligned. Public visibility, package publication, stable tags, policy changes, and production deployment require separate authorization.
