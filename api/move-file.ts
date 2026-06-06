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

  const normalized = normalizePath(path);

  if (normalized.includes("..")) return false;

  if (normalized === ".env" || normalized.startsWith(".env/")) return false;
  if (normalized.includes("/.env")) return false;

  const blockedExactPaths = [
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "vercel.json"
  ];

  if (blockedExactPaths.includes(normalized)) return false;

  const blockedSegments = [
    "node_modules",
    ".git",
    ".github",
    "api"
  ];

  const segments = normalized.split("/");

  if (segments.some((segment) => blockedSegments.includes(segment))) {
    return false;
  }

  return true;
}

async function githubRequest(url: string, options: RequestInit = {}) {
  const token = requireEnv("GITHUB_TOKEN");

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "guardiao-api",
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

async function githubGetFile(path: string) {
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const safePath = normalizePath(path);

  if (!isSafePath(safePath)) {
    throw new Error(`Path de origem não permitido: ${path}`);
  }

  const encodedPath = encodeURIComponent(safePath).replace(/%2F/g, "/");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${branch}`;

  const result = await githubRequest(url, {
    method: "GET"
  });

  if (!result.ok) {
    throw new Error(`GitHub GET error ${result.status}: ${JSON.stringify(result.data)}`);
  }

  if (result.data.type !== "file") {
    throw new Error(`Path de origem não é um arquivo: ${safePath}`);
  }

  const content = Buffer.from(result.data.content, "base64").toString("utf8");

  return {
    path: result.data.path,
    sha: result.data.sha,
    content,
    html_url: result.data.html_url
  };
}

async function githubCheckDestination(path: string) {
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const safePath = normalizePath(path);

  if (!isSafePath(safePath)) {
    throw new Error(`Path de destino não permitido: ${path}`);
  }

  const encodedPath = encodeURIComponent(safePath).replace(/%2F/g, "/");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${branch}`;

  const result = await githubRequest(url, {
    method: "GET"
  });

  return result.ok;
}

async function githubCreateFile(path: string, content: string, reason: string) {
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const safePath = normalizePath(path);
  const encodedPath = encodeURIComponent(safePath).replace(/%2F/g, "/");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  const result = await githubRequest(url, {
    method: "PUT",
    body: JSON.stringify({
      message: reason,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch
    })
  });

  if (!result.ok) {
    throw new Error(`GitHub CREATE error ${result.status}: ${JSON.stringify(result.data)}`);
  }

  return result.data;
}

async function githubDeleteFile(path: string, sha: string, reason: string) {
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const safePath = normalizePath(path);
  const encodedPath = encodeURIComponent(safePath).replace(/%2F/g, "/");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  const result = await githubRequest(url, {
    method: "DELETE",
    body: JSON.stringify({
      message: reason,
      sha,
      branch
    })
  });

  if (!result.ok) {
    throw new Error(`GitHub DELETE error ${result.status}: ${JSON.stringify(result.data)}`);
  }

  return result.data;
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

    const {
      from_path,
      to_path,
      reason,
      require_explicit_permission
    } = req.body || {};

    if (require_explicit_permission !== true) {
      return res.status(403).json({
        ok: false,
        error: "Alteração bloqueada. require_explicit_permission precisa ser true."
      });
    }

    if (!from_path || typeof from_path !== "string") {
      return res.status(400).json({
        ok: false,
        error: "from_path é obrigatório."
      });
    }

    if (!to_path || typeof to_path !== "string") {
      return res.status(400).json({
        ok: false,
        error: "to_path é obrigatório."
      });
    }

    if (!reason || typeof reason !== "string") {
      return res.status(400).json({
        ok: false,
        error: "reason é obrigatório."
      });
    }

    const sourcePath = normalizePath(from_path);
    const destinationPath = normalizePath(to_path);

    if (sourcePath === destinationPath) {
      return res.status(400).json({
        ok: false,
        error: "from_path e to_path não podem ser iguais."
      });
    }

    if (!isSafePath(sourcePath)) {
      return res.status(400).json({
        ok: false,
        error: `Path de origem não permitido: ${sourcePath}`
      });
    }

    if (!isSafePath(destinationPath)) {
      return res.status(400).json({
        ok: false,
        error: `Path de destino não permitido: ${destinationPath}`
      });
    }

    const destinationExists = await githubCheckDestination(destinationPath);

    if (destinationExists) {
      return res.status(409).json({
        ok: false,
        error: "Arquivo de destino já existe.",
        to_path: destinationPath
      });
    }

    const sourceFile = await githubGetFile(sourcePath);

    const createResult = await githubCreateFile(
      destinationPath,
      sourceFile.content,
      `Mover ${sourcePath} para ${destinationPath}: ${reason}`
    );

    await githubDeleteFile(
      sourcePath,
      sourceFile.sha,
      `Remover origem após mover para ${destinationPath}: ${reason}`
    );

    return res.status(200).json({
      ok: true,
      message: "Arquivo movido com sucesso.",
      from_path: sourcePath,
      to_path: destinationPath,
      html_url: createResult.content?.html_url
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown error"
    });
  }
}
