import type { VercelRequest, VercelResponse } from "@vercel/node";

const GITHUB_API = "https://api.github.com";

function isAuthorized(req: VercelRequest) {
  const receivedKey = req.headers["x-api-key"];
  const expectedKey = process.env.GUARDIAO_API_KEY;

  return receivedKey && expectedKey && receivedKey === expectedKey;
}

function isSafePath(path: string) {
  if (!path) return false;

  const blockedPatterns = [
    "..",
    ".env",
    "node_modules",
    ".git",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "vercel.json",
    "api/",
    ".github/"
  ];

  return !blockedPatterns.some((pattern) => path.includes(pattern));
}

async function githubRequest(url: string, options: RequestInit = {}) {
  const token = process.env.GITHUB_TOKEN;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  if (!isAuthorized(req)) {
    return res.status(403).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  const {
    path,
    content,
    reason,
    require_explicit_permission
  } = req.body || {};

  if (!require_explicit_permission) {
    return res.status(403).json({
      ok: false,
      error: "Explicit permission is required"
    });
  }

  if (!path || !content || !reason) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields: path, content, reason"
    });
  }

  if (!isSafePath(path)) {
    return res.status(400).json({
      ok: false,
      error: "Blocked or unsafe path"
    });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";

  if (!owner || !repo || !process.env.GITHUB_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing GitHub environment variables"
    });
  }

  const encodedPath = encodeURIComponent(path).replace(/%2F/g, "/");

  const checkUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${branch}`;

  const existingFile = await githubRequest(checkUrl, {
    method: "GET"
  });

  if (existingFile.ok) {
    return res.status(409).json({
      ok: false,
      error: "File already exists",
      path
    });
  }

  const createUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;

  const encodedContent = Buffer.from(content, "utf8").toString("base64");

  const result = await githubRequest(createUrl, {
    method: "PUT",
    body: JSON.stringify({
      message: reason,
      content: encodedContent,
      branch
    })
  });

  if (!result.ok) {
    return res.status(result.status).json({
      ok: false,
      error: "Failed to create file",
      details: result.data
    });
  }

  return res.status(200).json({
    ok: true,
    message: "File created successfully",
    path,
    html_url: result.data?.content?.html_url
  });
}
