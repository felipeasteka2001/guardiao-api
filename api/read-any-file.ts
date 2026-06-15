```ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const GITHUB_API = "https://api.github.com";

type ErrorWithStatus = Error & {
  statusCode?: number;
};

type GitHubFileResponse = {
  type?: string;
  path?: string;
  sha?: string;
  content?: string;
  encoding?: string;
  size?: number;
  html_url?: string;
  download_url?: string;
};

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
 * Permissão máxima de leitura dentro do repositório configurado.
 *
 * Qualquer arquivo existente no repositório poderá ser lido.
 * O acesso continua limitado ao GITHUB_OWNER, GITHUB_REPO
 * e GITHUB_BRANCH configurados na Vercel.
 */
function isAllowedPath(path: string): boolean {
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

function createError(
  message: string,
  statusCode: number
): ErrorWithStatus {
  const error = new Error(message) as ErrorWithStatus;
  error.statusCode = statusCode;

  return error;
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

function buildGitHubFileUrl(
  owner: string,
  repo: string,
  branch: string,
  path: string
): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const baseUrl = [
    GITHUB_API,
    "repos",
    encodeURIComponent(owner),
    encodeURIComponent(repo),
    "contents",
    encodedPath
  ].join("/");

  return baseUrl + "?ref=" + encodeURIComponent(branch);
}

async function githubGetFile(path: string) {
  const token = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH?.trim() || "main";

  const normalizedPath = normalizePath(path);

  if (!isAllowedPath(normalizedPath)) {
    throw createError("Path vazio ou inválido.", 400);
  }

  const url = buildGitHubFileUrl(
    owner,
    repo,
    branch,
    normalizedPath
  );

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
    if (response.status === 404) {
      throw createError(
        `Arquivo não encontrado: ${normalizedPath}`,
        404
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw createError(
        `GitHub authentication error ${response.status}: ${JSON.stringify(data)}`,
        502
      );
    }

    throw createError(
      `GitHub error ${response.status}: ${JSON.stringify(data)}`,
      500
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw createError(
      "Resposta inválida recebida do GitHub.",
      500
    );
  }

  const githubData = data as GitHubFileResponse;

  if (githubData.type !== "file") {
    throw createError(
      `O path informado não é um arquivo: ${normalizedPath}`,
      400
    );
  }

  if (
    githubData.encoding !== "base64" ||
    typeof githubData.content !== "string"
  ) {
    throw createError(
      `O conteúdo do arquivo não foi retornado em base64: ${normalizedPath}`,
      500
    );
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

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;

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
