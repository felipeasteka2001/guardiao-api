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
    throw new Error(`GitHub error ${response.status}: ${JSON.stringify(data)}`);
  }

  const content = Buffer.from(data.content, "base64").toString("utf8");

  return {
    filename,
    path: data.path,
    sha: data.sha,
    content,
    html_url: data.html_url
  };
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

    const { filename } = req.body;

    if (!filename || typeof filename !== "string") {
      return res.status(400).json({
        ok: false,
        error: "filename é obrigatório."
      });
    }

    const file = await githubGetFile(filename);

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
