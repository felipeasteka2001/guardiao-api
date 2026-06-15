```ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const GITHUB_API = "https://api.github.com";

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value.trim();
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Permissão máxima dentro do repositório configurado.
 *
 * Qualquer path não vazio será permitido.
 *
 * Isso inclui:
 * - campaigns/
 * - checkpoints/
 * - systems/
 * - templates/
 * - api/
 * - .github/
 * - .env
 * - package.json
 * - vercel.json
 * - qualquer outro arquivo presente no repositório
 */
function isSafePath(path: string): boolean {
  const normalized = normalizePath(path);

  return normalized.length > 0;
}

function getHeaderValue(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text
    };
  }
}

async function githubGetFile(path: string) {
  const token = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH?.trim() || "main";

  const normalizedPath = normalizePath(path);

  if (!isSafePath(normalizedPath)) {
    const error = new Error("Path vazio ou inválido.");
    Object.assign(error, {
      statusCode: 400
    });

    throw error;
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedBranch = encodeURIComponent(branch);

  const encodedPath = normalizedPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const url =
    `${GITHUB_API}/repos/${encodedOwner}/${encodedRepo}` +
    `/contents/${encodedPath}?ref=${encodedBranch}`;

  console.log("[read-any-file] Reading GitHub file", {
    owner,
    repo,
    branch,
    path: normalizedPath
  });

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "guardiao-api",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  const data = await readResponseBody(response);

  if (!response.ok) {
    let statusCode = 500;

    if (response.status === 404) {
      statusCode = 404;
    }

    if (response.status === 401 || response.status === 403) {
      statusCode = 502;
    }

    const error = new Error(
      `GitHub error ${response.status}: ${JSON.stringify(data)}`
    );

    Object.assign(error, {
      statusCode
    });

    throw error;
  }

  if (!data || typeof data !== "object") {
    const error = new Error("Resposta inválida recebida do GitHub.");

    Object.assign(error, {
      statusCode: 500
    });

    throw error;
  }

  const githubData = data as {
    type?: string;
    path?: string;
    sha?: string;
    content?: string;
    encoding?: string;
    size?: number;
    html_url?: string;
    download_url?: string;
  };

  if (githubData.type !== "file") {
    const error = new Error(
      `O path informado não é um arquivo: ${normalizedPath}`
    );

    Object.assign(error, {
      statusCode: 400
    });

    throw error;
  }

  if (
    githubData.encoding !== "base64" ||
    typeof githubData.content !== "string"
  ) {
    const error = new Error(
      `O conteúdo do arquivo não foi retornado em base64: ${normalizedPath}`
    );

    Object.assign(error, {
      statusCode: 500
    });

    throw error;
  }

  const base64Content = githubData.content.replace(/\s/g, "");

  const content = Buffer.from(
    base64Content,
    "base64"
  ).toString("utf8");

  return {
    path: githubData.path || normalizedPath,
    sha: githubData.sha || null,
    size:
      githubData.size ??
      Buffer.byteLength(content, "utf8"),
    encoding: githubData.encoding,
    content,
    html_url: githubData.html_url || null,
    download_url: githubData.download_url || null
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use POST."
      });
    }

    const expectedKey = requireEnv("GUARDIAO_API_KEY");

    const receivedKey = getHeaderValue(
      req.headers["x-api-key"]
    );

    if (
      !receivedKey ||
      receivedKey.trim() !== expectedKey
    ) {
      console.warn("[read-any-file] Unauthorized request", {
        hasReceivedKey: Boolean(receivedKey),
        hasConfiguredKey: Boolean(expectedKey)
      });

      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const body =
      req.body &&
      typeof req.body === "object" &&
      !Array.isArray(req.body)
        ? req.body
        : {};

    const path =
      typeof body.path === "string"
        ? body.path
        : "";

    if (!path.trim()) {
      return res.status(400).json({
        ok: false,
        error: "path é obrigatório."
      });
    }

    const normalizedPath = normalizePath(path);

    console.log("[read-any-file] Request accepted", {
      path: normalizedPath
    });

    const file = await githubGetFile(normalizedPath);

    console.log("[read-any-file] File read successfully", {
      path: file.path,
      size: file.size
    });

    return res.status(200).json({
      ok: true,
      ...file
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    let statusCode = 500;

    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
    ) {
      statusCode = error.statusCode;
    }

    console.error("[read-any-file] Error", {
      statusCode,
      message
    });

    return res.status(statusCode).json({
      ok: false,
      error: message || "Unknown error"
    });
  }
}
```
