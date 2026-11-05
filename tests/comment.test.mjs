import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  caseResults,
  jobBlock,
  publishEvalComment,
  readEvalName,
  renderComment,
  resultLabel,
  upsertJob,
} from "../src/comment.mjs";

test("the results table lists what ran and keeps a failed case visible", () => {
  const rows = caseResults({
    results: [
      { caseId: "a", state: "scored", metrics: [{ name: "verdict", passed: true }] },
      { caseId: "b", state: "scored", metrics: [{ name: "verdict", passed: false }] },
      { caseId: "b", state: "scored", metrics: [{ name: "verdict", passed: true }] },
    ],
  });
  assert.equal(resultLabel(rows.find((row) => row.id === "b")), "Failed");
  const outcome = caseResults({
    results: [
      { caseId: "c", state: "scored", metrics: [{ name: "verdict", passed: true }, { name: "task_success", passed: false }] },
    ],
  });
  assert.equal(resultLabel(outcome[0]), "Failed");
  const skipped = caseResults({ results: [{ caseId: "d", state: "skipped", metrics: [] }] });
  assert.equal(resultLabel(skipped[0]), "Incomplete");
  const block = jobBlock("Town recruiting", {
    runUrl: "https://app.hue.run/runs/two",
    rows,
    names: new Map([["a", "REC-09 · Schedule Imani"], ["b", "REC-05 · Draft | rejection"]]),
  });
  const comment = renderComment([block]);
  assert.match(comment, /<img src="https:\/\/raw\.githubusercontent\.com\/hue-run\/eval-action\/v1\/assets\/hue-mark\.png" height="28" alt="" \/>\n\n\*\*Hue\*\*/);
  assert.match(comment, /\*\*\[Town recruiting\]\(https:\/\/app\.hue\.run\/runs\/two\)\*\*: 1 passed, 1 failed/);
  assert.match(comment, /\| REC-05 · Draft rejection \| <img src="https:\/\/raw\.githubusercontent\.com\/hue-run\/eval-action\/v1\/assets\/fail\.png\?v=5" height="13" alt="" align="absmiddle" \/> Failed \|/);
  assert.match(comment, /\| REC-09 · Schedule Imani \| <img src="https:\/\/raw\.githubusercontent\.com\/hue-run\/eval-action\/v1\/assets\/pass\.png\?v=5" height="13" alt="" align="absmiddle" \/> Passed \|/);
  const failed = comment.indexOf("fail.png");
  const passed = comment.indexOf("pass.png");
  assert.ok(failed < passed);
});

test("a second job edits the same comment", () => {
  const first = upsertJob("", jobBlock("Town recruiting", { status: "running" }));
  const both = upsertJob(first, jobBlock("Town recruiting routines", { status: "passed", runUrl: "https://app.hue.run/runs/one" }));
  const finished = upsertJob(both, jobBlock("Town recruiting", { status: "failed", runUrl: "https://app.hue.run/runs/two" }));
  assert.equal(finished.split("<!-- hue-evals -->").length, 2);
  assert.match(finished, /Town recruiting routines/);
  assert.match(finished, /runs\/two/);
  assert.doesNotMatch(finished, /\*\*Town recruiting\*\*: Running/);
});

test("the config name is the comment section", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-comment-"));
  const path = join(directory, "hue.eval.json");
  await writeFile(path, JSON.stringify({ name: "Town recruiting" }));
  assert.equal(await readEvalName(path), "Town recruiting");
  assert.equal(await readEvalName(join(directory, "missing.json")), "Evals");
});

test("a pull request gets one comment, then that comment is edited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-event-"));
  const eventPath = join(directory, "event.json");
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 14 } }));
  const env = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "hue-run/example",
    HUE_ACTION_GITHUB_TOKEN: "synthetic",
    HUE_API_KEY: "synthetic",
  };
  const calls = [];
  let comments = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method || "GET" });
    if (String(url).includes("app.hue.run")) {
      return Response.json({ items: [{ id: "case-1", externalKey: "REC-09 · Schedule Imani" }] });
    }
    if ((init.method || "GET") === "GET") return Response.json(comments);
    if (init.method === "POST") {
      comments = [{ id: 7, body: JSON.parse(init.body).body }];
      return Response.json(comments[0], { status: 201 });
    }
    comments = [{ id: 7, body: JSON.parse(init.body).body }];
    return Response.json(comments[0]);
  };
  assert.equal(await publishEvalComment(env, { name: "Town recruiting", status: "running" }, fetcher), "unchanged");
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  calls.length = 0;
  const report = {
    runId: "9105c093-e3f3-4216-bc44-3b63ba89f753",
    runUrl: "https://app.hue.run/runs/9105c093-e3f3-4216-bc44-3b63ba89f753",
    verdict: "fail",
    receipt: { verdict: "fail", results: [{ caseId: "case-1", state: "scored", metrics: [{ name: "verdict", passed: false }] }] },
    errors: [],
  };
  assert.equal(await publishEvalComment(env, { name: "Town recruiting", report }, fetcher), "updated");
  assert.equal(calls.some((call) => call.method === "POST"), false);
  assert.match(comments[0].body, /REC-09 · Schedule Imani \| <img src="https:\/\/raw\.githubusercontent\.com\/hue-run\/eval-action\/v1\/assets\/fail\.png\?v=5" height="13" alt="" align="absmiddle" \/> Failed/);
  assert.equal(comments.length, 1);

  const recovery = "Hue evaluation could not complete; recover with hue eval status";
  for (const verdict of [null, "incomplete"]) {
    const unfinished = {
      ...report,
      verdict,
      receipt: verdict ? { verdict, results: [] } : null,
      category: verdict || "hue_error",
      errors: [{ code: "HUE_ERROR", message: recovery }],
    };
    assert.equal(await publishEvalComment(env, { name: "Town recruiting", report: unfinished }, fetcher), "updated");
    assert.ok(comments[0].body.includes(`\n<img src="https://raw.githubusercontent.com/hue-run/eval-action/v1/assets/incomplete.png?v=5" height="13" alt="" align="absmiddle" /> ${recovery}\n`));
    assert.doesNotMatch(comments[0].body, /\| Case \| Result \|/);
    assert.equal(comments.length, 1);
  }
});

test("no pull request and a refused token leave the evaluation alone", async () => {
  assert.equal(await publishEvalComment({}, { name: "Evals", status: "running" }, async () => {
    throw new Error("should not be called");
  }), "skipped");
  const directory = await mkdtemp(join(tmpdir(), "hue-event-"));
  const eventPath = join(directory, "event.json");
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 14 } }));
  const fetcher = async () => Response.json({ message: "Resource not accessible" }, { status: 403 });
  assert.equal(await publishEvalComment({
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "hue-run/example",
    GITHUB_TOKEN: "synthetic",
  }, { name: "Evals", status: "running" }, fetcher), "forbidden");
});
