import { readFile } from "node:fs/promises";

const MARKER = "<!-- hue-evals -->";
const MARK = "https://raw.githubusercontent.com/hue-run/eval-action/v1/assets/hue-mark.png";
const HEADING = `<img src="${MARK}" height="28" alt="" />\n\n**Hue**`;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERDICT = {
  pass: "passed",
  fail: "failed",
  incomplete: "incomplete",
  error: "errored",
  cancelled: "cancelled",
};

function clean(value, max = 80) {
  return String(value || "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function statusLine(status) {
  const text = clean(status, 40) || "running";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function jobKey(name) {
  return encodeURIComponent(clean(name, 80) || "Evals");
}

export function caseResults(receipt) {
  const by = new Map();
  for (const result of receipt?.results || []) {
    if (typeof result?.caseId !== "string") continue;
    const row = by.get(result.caseId) || { id: result.caseId, passed: 0, failed: 0, errored: false, pending: false, skipped: false };
    if (result.state === "error") row.errored = true;
    if (result.state === "pending") row.pending = true;
    if (result.state === "skipped") row.skipped = true;
    for (const metric of result.metrics || []) {
      if (metric?.passed === true) row.passed += 1;
      if (metric?.passed === false) row.failed += 1;
    }
    by.set(result.caseId, row);
  }
  return [...by.values()];
}

const ICON = "https://raw.githubusercontent.com/hue-run/eval-action/v1/assets";

function resultMark(file, label) {
  return `<img src="${ICON}/${file}" height="13" alt="" align="absmiddle" /> ${label}`;
}

const RESULT_MARK = {
  Passed: resultMark("pass.png", "Passed"),
  Failed: resultMark("fail.png", "Failed"),
  Errored: resultMark("error.png", "Errored"),
  Incomplete: resultMark("incomplete.png", "Incomplete"),
  "No score": resultMark("none.png", "No score"),
};

export function resultLabel(row) {
  if (row.errored) return "Errored";
  if (row.failed > 0) return "Failed";
  if (row.pending || (row.passed === 0 && row.skipped)) return "Incomplete";
  if (row.passed > 0) return "Passed";
  return "No score";
}

function tally(rows) {
  const counts = { Passed: 0, Failed: 0, Errored: 0, Incomplete: 0, "No score": 0 };
  for (const row of rows) counts[resultLabel(row)] += 1;
  const parts = ["Passed", "Failed", "Errored", "Incomplete"].filter((label) => counts[label] > 0).map((label) => `${counts[label]} ${label.toLowerCase()}`);
  return parts.join(", ") || "no cases";
}

function table(rows, names) {
  const lines = rows
    .map((row) => ({ name: clean(names?.get(row.id) || row.id, 72) || row.id, label: resultLabel(row) }))
    .sort((left, right) => Number(right.label !== "Passed") - Number(left.label !== "Passed") || left.name.localeCompare(right.name));
  const shown = lines.slice(0, 20).map((line) => `| ${line.name} | ${RESULT_MARK[line.label] || line.label} |`);
  const more = lines.length > 20 ? `\n\n${lines.length - 20} more cases are in the run.` : "";
  return `| Case | Result |\n| :--- | :--- |\n${shown.join("\n")}${more}`;
}

/** One job's block: a linked summary and, once results exist, the case table. */
export function jobBlock(name, { status, runUrl, rows, names, detail } = {}) {
  const title = clean(name, 80) || "Evals";
  const url = typeof runUrl === "string" && /^https:\/\/\S+$/.test(runUrl) ? runUrl : "";
  const heading = url ? `**[${title}](${url})**` : `**${title}**`;
  const summary = rows?.length ? tally(rows) : statusLine(status);
  const body = [`${heading}: ${summary}`];
  if (rows?.length) body.push("", table(rows, names));
  else if (detail) body.push("", clean(detail, 240));
  const key = jobKey(title);
  return `<!-- hue-eval:${key} -->\n${body.join("\n")}\n<!-- /hue-eval:${key} -->`;
}

export function renderComment(blocks) {
  const sections = new Map();
  for (const block of blocks) {
    const key = block.match(/<!-- hue-eval:([^ ]+) -->/)?.[1];
    if (key) sections.set(key, block.trim());
  }
  const ordered = [...sections.values()].sort((left, right) => left.localeCompare(right));
  return `${MARKER}\n${HEADING}\n\n${ordered.join("\n\n")}\n`;
}

export function upsertJob(body, block) {
  const key = block.match(/<!-- hue-eval:([^ ]+) -->/)?.[1];
  const pattern = /<!-- hue-eval:([^ ]+) -->[\s\S]*?<!-- \/hue-eval:\1 -->/g;
  const existing = [...String(body || "").matchAll(pattern)].map((match) => match[0]);
  const kept = existing.filter((section) => !section.startsWith(`<!-- hue-eval:${key} -->`));
  return renderComment([...kept, block]);
}

export async function readEvalName(path) {
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    if (typeof config.name === "string" && config.name.trim()) return config.name.trim();
  } catch {
    // A missing config still gets one comment section.
  }
  return "Evals";
}

async function pullRequestNumber(env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_EVENT_PATH) return null;
  try {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
    const number = event.pull_request?.number;
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

async function github(fetcher, repository, path, token, method, payload) {
  return fetcher(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: payload ? JSON.stringify(payload) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

async function caseNames(fetcher, env, runId) {
  const names = new Map();
  const key = env.HUE_API_KEY?.trim();
  if (!key || !RUN_ID.test(runId || "")) return names;
  try {
    const response = await fetcher(`https://app.hue.run/api/v1/experiments/${runId}/items?limit=100`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return names;
    const text = await response.text();
    const start = text.indexOf("{");
    const listStart = text.indexOf("[");
    const slice = start === -1 ? listStart : listStart === -1 ? start : Math.min(start, listStart);
    const payload = JSON.parse(slice === -1 ? text : text.slice(slice));
    const items = Array.isArray(payload) ? payload : payload?.items || payload?.data || [];
    for (const item of items) {
      const label = clean(item?.externalKey || item?.displayName, 72);
      if (!label) continue;
      if (typeof item?.id === "string") names.set(item.id, label);
      if (typeof item?.caseId === "string") names.set(item.caseId, label);
    }
  } catch {
    // The table still renders with case ids when the name lookup fails.
  }
  return names;
}

function blockFor(name, view, names) {
  if (!view.report) return jobBlock(name, { status: view.status || "running" });
  const report = view.report;
  const rows = caseResults(report.receipt);
  const verdict = report.receipt?.verdict || report.verdict;
  return jobBlock(name, {
    status: VERDICT[verdict] || "did not finish",
    runUrl: report.runUrl,
    rows,
    names,
    detail: rows.length ? "" : report.errors?.[0]?.message,
  });
}

async function listComments(fetcher, repository, number, token) {
  const comments = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await github(fetcher, repository, `/issues/${number}/comments?per_page=100&page=${page}`, token, "GET");
    if (!response.ok) return { ok: false, status: response.status, comments };
    const pageItems = await response.json();
    if (!Array.isArray(pageItems)) return { ok: false, status: response.status, comments };
    comments.push(...pageItems);
    if (pageItems.length < 100) break;
  }
  return { ok: true, comments };
}

/**
 * Create or edit the single Hue comment. Each job replaces only its own section.
 * A missing token or permission leaves the evaluation unchanged.
 */
export async function publishEvalComment(env, view = {}, fetcher = fetch) {
  const token = env.HUE_ACTION_GITHUB_TOKEN || env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY || "";
  if (!token || !REPOSITORY.test(repository)) return "skipped";
  const number = await pullRequestNumber(env);
  if (!number) return "skipped";
  const names = await caseNames(fetcher, env, view.report?.runId);
  const block = blockFor(view.name, view, names);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await listComments(fetcher, repository, number, token);
      if (!listed.ok) return listed.status === 403 ? "forbidden" : "failed";
      const ours = listed.comments
        .filter((comment) => typeof comment?.body === "string" && comment.body.includes(MARKER) && Number.isInteger(comment.id))
        .sort((left, right) => left.id - right.id);
      const body = upsertJob(ours[0]?.body, block);
      if (!ours[0]) {
        const created = await github(fetcher, repository, `/issues/${number}/comments`, token, "POST", { body });
        if (!created.ok) return created.status === 403 ? "forbidden" : "failed";
        continue;
      }
      if (ours[0].body !== body) {
        const patched = await github(fetcher, repository, `/issues/comments/${ours[0].id}`, token, "PATCH", { body });
        if (!patched.ok) return patched.status === 403 ? "forbidden" : "failed";
      }
      let removed = true;
      for (const extra of ours.slice(1)) {
        const deleted = await github(fetcher, repository, `/issues/comments/${extra.id}`, token, "DELETE");
        if (!deleted.ok) removed = false;
      }
      if (removed) return ours[0].body === body && ours.length === 1 ? "unchanged" : "updated";
    }
    return "failed";
  } catch {
    return "failed";
  }
}
