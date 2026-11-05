import { readFile } from "node:fs/promises";

const MARKER = "<!-- hue-evals -->";
const EM = " — ";
// Same mark the app serves for clients. GitHub keeps the image and align attribute, and drops CSS.
const HUE_MARK = "https://app.hue.run/hue-mark.png";
const HEADING = `### <img src="${HUE_MARK}" height="32" alt="" align="center" /> Hue`;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERDICT = {
  pass: "passed",
  fail: "failed",
  incomplete: "incomplete",
  error: "errored",
  cancelled: "cancelled",
};

export function commentLine(name, status, runUrl) {
  const safe = String(name || "Evals").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Evals";
  const state = String(status || "running").replace(/[\r\n]+/g, " ").trim() || "running";
  const url = typeof runUrl === "string" && /^https:\/\/\S+$/.test(runUrl) ? runUrl : "";
  return url ? `${safe}${EM}${state} · [run](${url})` : `${safe}${EM}${state}`;
}

/** One hidden marker, one heading, and one line per Hue job. A later run replaces its own line. */
export function upsertLine(body, line) {
  const key = line.split(EM)[0];
  const kept = (body || "")
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row.includes(EM) && !row.startsWith("<!--") && !row.startsWith(`${key}${EM}`));
  kept.push(line);
  kept.sort((left, right) => left.localeCompare(right));
  return `${MARKER}\n${HEADING}\n\n${kept.join("\n")}\n`;
}

export function statusForReport(report) {
  const verdict = report?.receipt?.verdict || report?.verdict;
  return {
    status: VERDICT[verdict] || "did not finish",
    runUrl: typeof report?.runUrl === "string" ? report.runUrl : "",
  };
}

export async function readEvalName(path) {
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    if (typeof config.name === "string" && config.name.trim()) return config.name.trim();
  } catch {
    // A missing config still gets one comment line.
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
 * Create or edit the single Hue comment on a pull request. Other jobs and later runs
 * replace only their own line. A missing token or permission leaves the evaluation unchanged.
 */
export async function publishEvalComment(env, { name, status, runUrl } = {}, fetcher = fetch) {
  const token = env.HUE_ACTION_GITHUB_TOKEN || env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY || "";
  if (!token || !REPOSITORY.test(repository)) return "skipped";
  const number = await pullRequestNumber(env);
  if (!number) return "skipped";
  const line = commentLine(name, status, runUrl);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await listComments(fetcher, repository, number, token);
      if (!listed.ok) return listed.status === 403 ? "forbidden" : "failed";
      const ours = listed.comments
        .filter((comment) => typeof comment?.body === "string" && comment.body.includes(MARKER) && Number.isInteger(comment.id))
        .sort((left, right) => left.id - right.id);
      const body = upsertLine(ours[0]?.body, line);
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
