import type { VercelRequest, VercelResponse } from "@vercel/node";

const GITHUB_API = "https://api.github.com";
const MAX_FILES_PER_REQUEST = 20;

type FileInput = {
  path: string;
  content: string;
};

function isAuthorized(req: VercelRequest) {
  const receivedKey = req.headers["x-api-key"];
  const expectedKey = process.env.GUARDIAO_API_KEY;

  return typeof receivedKey === "string" && !!expectedKey && receivedKey === expectedKey;
}

function normalizeFilePath(path: string) {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

function isSafeFilePath(path: string) {
  if (!path) return false;

  const allowedRoots = [
    "campaigns/",
    "checkpoints/",
    "systems/",
    "templates/",
    "shared/",
    "tests/",
    "docs/"
  ];

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

  return (
    allowedRoots.some((root) => path.startsWith(root)) &&
    !blockedPatterns.some((pattern) => path.includes(pattern))
  );
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

async function fileExists(owner: string, repo: string, branch: string, path: string) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, "/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${branch}`;

  const result = await githubRequest(url, { method: "GET" });

  if (result.ok) return true;
  if (result.status === 404) return false;

  throw new Error(
    `Failed checking file ${path}: ${result.status} ${JSON.stringify(result.data)}`
  );
}

async function createFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  reason: string
) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, "/");
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;

  const encodedContent = Buffer.from(content, "utf8").toString("base64");

  return githubRequest(url, {
    method: "PUT",
    body: JSON.stringify({
      message: reason,
      content: encodedContent,
      branch
    })
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
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

    const { files, reason, require_explicit_permission } = req.body || {};

    if (require_explicit_permission !== true) {
      return res.status(403).json({
        ok: false,
        error: "Explicit permission is required"
      });
    }

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid field: files"
      });
    }

    if (files.length > MAX_FILES_PER_REQUEST) {
      return res.status(400).json({
        ok: false,
        error: `Too many files. Maximum is ${MAX_FILES_PER_REQUEST}`
      });
    }

    if (typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid field: reason"
      });
    }

    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || "main";
    const token = process.env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      return res.status(500).json({
        ok: false,
        error: "Missing GitHub environment variables"
      });
    }

    const results = [];

    for (const file of files as FileInput[]) {
      const normalizedPath =
        typeof file?.path === "string" ? normalizeFilePath(file.path) : "";

      if (
        !normalizedPath ||
        typeof file?.content !== "string" ||
        !isSafeFilePath(normalizedPath)
      ) {
        results.push({
          ok: false,
          path: normalizedPath || file?.path || null,
          error: "Invalid or unsafe file"
        });
        continue;
      }

      try {
        const exists = await fileExists(owner, repo, branch, normalizedPath);

        if (exists) {
          results.push({
            ok: false,
            path: normalizedPath,
            error: "File already exists"
          });
          continue;
        }

        const result = await createFile(
          owner,
          repo,
          branch,
          normalizedPath,
          file.content,
          reason
        );

        if (!result.ok) {
          results.push({
            ok: false,
            path: normalizedPath,
            error: "Failed to create file",
            status: result.status,
            details: result.data
          });
          continue;
        }

        results.push({
          ok: true,
          path: normalizedPath,
          html_url: result.data?.content?.html_url || null
        });
      } catch (error) {
        results.push({
          ok: false,
          path: normalizedPath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const created = results.filter((item) => item.ok);
    const failed = results.filter((item) => !item.ok);

    return res.status(failed.length > 0 ? 207 : 200).json({
      ok: failed.length === 0,
      created_count: created.length,
      failed_count: failed.length,
      results
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Unhandled createFiles error",
      details: error instanceof Error ? error.message : String(error)
    });
  }
}
