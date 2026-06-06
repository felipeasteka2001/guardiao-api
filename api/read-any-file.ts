function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "").trim();
}

function isSafePath(path: string): boolean {
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

async function githubGetFile(path: string) {
  const token = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const safePath = normalizePath(path);

  if (!isSafePath(safePath)) {
    throw new Error(`Path não permitido: ${path}`);
  }

  const encodedPath = encodeURIComponent(safePath).replace(/%2F/g, "/");

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${branch}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "guardiao-api"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`GitHub error ${response.status}: ${JSON.stringify(data)}`);
  }

  if (data.type !== "file") {
    throw new Error(`Path não é um arquivo: ${safePath}`);
  }

  const content = Buffer.from(data.content, "base64").toString("utf8");

  return {
    path: data.path,
    sha: data.sha,
    content,
    html_url: data.html_url
  };
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Use POST."
      });
    }

    const expectedKey = requireEnv("GUARDIAO_API_KEY");
    const receivedKeyRaw =
      req.headers["x-api-key"] ||
      req.headers["X-API-Key"] ||
      req.headers["X-Api-Key"];

    const receivedKey = Array.isArray(receivedKeyRaw)
      ? receivedKeyRaw[0]
      : receivedKeyRaw;

    if (!receivedKey || String(receivedKey).trim() !== expectedKey.trim()) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const { path } = req.body;

    if (!path || typeof path !== "string") {
      return res.status(400).json({
        ok: false,
        error: "path é obrigatório."
      });
    }

    const file = await githubGetFile(path);

    return res.status(200).json({
      ok: true,
      ...file
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown error"
    });
  }
}
