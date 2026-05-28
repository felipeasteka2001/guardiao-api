type UpdateMode = "append" | "replace";

type UpdateFilePayload = {
  filename?: string;
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

function assertAllowedFile(filename: string): string {
  const allowed = [
    "00_REGRAS_DO_AGENT.md",
    "01_CAMPAIGN_STATE.md",
    "02_PERSONAGEM_E_PODERES.md",
    "03_LEDGER_NUMERICO.md",
    "04_SESSION_LOGS_DETALHADOS.md",
    "05_INDICE_DE_CANON.md",
    "06_SEGREDOS_DO_MESTRE.md",
    "07_BESTIARIO_E_DUNGEONS.md",
    "08_ACTIONS_E_CHECKPOINTS.md",
    "README_ORGANIZACAO.md"
  ];

  if (!allowed.includes(filename)) {
    throw new Error(`Arquivo não permitido: ${filename}`);
  }

  return filename;
}

async function githubGetFile(filename: string) {
  const token = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const path = assertAllowedFile(filename);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`;

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

  const content = Buffer.from(data.content, "base64").toString("utf8");

  return {
    sha: data.sha,
    content,
    html_url: data.html_url
  };
}

async function githubPutFile(filename: string, content: string, sha: string, reason: string) {
  const token = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const path = assertAllowedFile(filename);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;

  const body = {
    message: `Atualizar ${filename}: ${reason || "update do Guardião"}`,
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
      return res.status(405).json({ ok: false, error: "Use POST." });
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
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const payload = req.body as UpdateFilePayload;
    const filename = payload.filename;

    if (!filename || typeof filename !== "string") {
      return res.status(400).json({
        ok: false,
        error: "filename é obrigatório."
      });
    }

    if (payload.require_explicit_permission !== true) {
      return res.status(403).json({
        ok: false,
        error:
          "Alteração bloqueada. require_explicit_permission precisa ser true."
      });
    }

    const mode = payload.mode || "append";

    if (!["append", "replace"].includes(mode)) {
      return res.status(400).json({
        ok: false,
        error: "mode deve ser append ou replace."
      });
    }

    const current = await githubGetFile(filename);
    const updatedContent = buildUpdatedContent(current.content, payload);

    const result = await githubPutFile(
      filename,
      updatedContent,
      current.sha,
      payload.reason || "alteração autorizada"
    );

    return res.status(200).json({
      ok: true,
      message: `${filename} atualizado com sucesso.`,
      filename,
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
