import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commentLine,
  publishEvalComment,
  readEvalName,
  statusForReport,
  upsertLine,
} from "../src/comment.mjs";

test("one comment keeps each job on its own line and replaces that line", () => {
  const running = upsertLine("", commentLine("Town recruiting", "running"));
  const both = upsertLine(running, commentLine("Town recruiting routines", "passed", "https://app.hue.run/runs/one"));
  const finished = upsertLine(both, commentLine("Town recruiting", "failed", "https://app.hue.run/runs/two"));
  assert.equal(finished, `<!-- hue-evals -->
### <img src="https://app.hue.run/hue-mark.png" height="32" alt="" align="center" /> Hue

Town recruiting — failed · [run](https://app.hue.run/runs/two)
Town recruiting routines — passed · [run](https://app.hue.run/runs/one)
`);
  assert.equal(finished.split("<!-- hue-evals -->").length, 2);
});

test("a finished report becomes one status and drops an unsafe link", () => {
  assert.deepEqual(statusForReport({ verdict: "fail", runUrl: "https://app.hue.run/runs/two", receipt: { verdict: "fail" } }), {
    status: "failed",
    runUrl: "https://app.hue.run/runs/two",
  });
  assert.equal(commentLine("Evals", "did not finish", "http://example.test"), "Evals — did not finish");
});

test("the config name is the comment line", async () => {
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
  };
  const calls = [];
  let comments = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "GET") return Response.json(comments);
    if (init.method === "POST") {
      comments = [{ id: 7, body: JSON.parse(init.body).body }];
      return Response.json(comments[0], { status: 201 });
    }
    comments = [{ id: 7, body: JSON.parse(init.body).body }];
    return Response.json(comments[0]);
  };
  assert.equal(await publishEvalComment(env, { name: "Town recruiting", status: "running" }, fetcher), "unchanged");
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].body.body, /Town recruiting — running/);
  calls.length = 0;
  assert.equal(
    await publishEvalComment(env, { name: "Town recruiting", status: "failed", runUrl: "https://app.hue.run/runs/two" }, fetcher),
    "updated",
  );
  assert.equal(calls.some((call) => call.method === "POST"), false);
  assert.match(comments[0].body, /\[run\]\(https:\/\/app\.hue\.run\/runs\/two\)/);
  assert.equal(comments.length, 1);
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
