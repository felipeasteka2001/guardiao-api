type UpdateMode = "append" | "replace";

type UpdateFilePayload = {
  path?: string;
  mode?: UpdateMode;
  content?: string;
  reason?: string;
  require_explicit_permission?: boolean;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
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
    throw new Error(`GitHub GET error ${response.status}: ${JSON.stringify(data)}`);
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

async function githubPutFile(path: string, content: string, sha: string, reason: string) {
  const token = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const safePath = normalizePath(path);

  if (!isSafePath(safePath)) {
    throw new Error(`Path não permitido: ${path}`);
  }

  const encodedPath = encodeURIComponent(safePath).replace(/%2F/g, "/");

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

  const body = {
    message: `Atualizar ${safePath}: ${reason || "update do Guardião"}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    sha,
    branch
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "guardiao-api"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`GitHub PUT error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

function buildUpdatedContent(oldContent: string, payload: UpdateFilePayload): string {
  const mode = payload.mode || "append";
  const newContent = payload.content || "";

  if (!newContent.trim()) {
    throw new Error("content vazio. Nada foi alterado.");
  }

  if (mode === "replace") {
    return newContent.trimEnd() + "\n";
  }

  if (mode === "append") {
    const separator = oldContent.endsWith("\n") ? "\n" : "\n\n";
    return oldContent.trimEnd() + separator + newContent.trimEnd() + "\n";
  }

  throw new Error(`Modo inválido: ${mode}`);
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

    const payload = req.body as UpdateFilePayload;
    const path = payload.path;

    if (!path || typeof path !== "string") {
      return res.status(400).json({
        ok: false,
        error: "path é obrigatório."
      });
    }

    const safePath = normalizePath(path);

    if (!isSafePath(safePath)) {
      return res.status(400).json({
        ok: false,
        error: `Path não permitido: ${safePath}`
      });
    }

    if (payload.require_explicit_permission !== true) {
      return res.status(403).json({
        ok: false,
        error: "Alteração bloqueada. require_explicit_permission precisa ser true."
      });
    }

    const mode = payload.mode || "append";

    if (!["append", "replace"].includes(mode)) {
      return res.status(400).json({
        ok: false,
        error: "mode deve ser append ou replace."
      });
    }

    const current = await githubGetFile(safePath);
    const updatedContent = buildUpdatedContent(current.content, payload);

    const result = await githubPutFile(
      safePath,
      updatedContent,
      current.sha,
      payload.reason || "alteração autorizada"
    );

    return res.status(200).json({
      ok: true,
      message: `${safePath} atualizado com sucesso.`,
      path: safePath,
      mode,
      html_url: result.content?.html_url
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown error"
    });
  }
}
