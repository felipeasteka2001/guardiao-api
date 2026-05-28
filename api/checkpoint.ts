type CheckpointPayload = {
  session_id?: string;
  checkpoint_id?: string;
  title?: string;
  summary?: string;
  events?: string[];
  canon_confirmed?: string[];
  numeric_changes?: Record<string, unknown>;
  powers_used?: string[];
  npcs_locations?: string[];
  pending_threads?: string[];
  files_to_update_later?: string[];
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function toMarkdown(payload: CheckpointPayload): string {
  const now = new Date().toISOString();

  const list = (items?: string[]) =>
    items && items.length > 0
      ? items.map((item) => `- ${item}`).join("\n")
      : "- Nenhum registrado.";

  const numeric =
    payload.numeric_changes && Object.keys(payload.numeric_changes).length > 0
      ? Object.entries(payload.numeric_changes)
          .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
          .join("\n")
      : "- Nenhuma alteração numérica.";

  return `# ${payload.checkpoint_id || "CHECKPOINT"} — ${
    payload.title || "Checkpoint do Guardião"
  }

Criado em: ${now}

## Sessão
${payload.session_id || "Não informada"}

## Resumo
${payload.summary || "Sem resumo informado."}

## Eventos
${list(payload.events)}

## Canon confirmado
${list(payload.canon_confirmed)}

## Alterações numéricas
${numeric}

## Poderes/Técnicas usados
${list(payload.powers_used)}

## NPCs, locais e entidades afetadas
${list(payload.npcs_locations)}

## Pendências
${list(payload.pending_threads)}

## Arquivos a atualizar depois
${list(payload.files_to_update_later)}
`;
}

async function githubPutFile(path: string, content: string) {
  const token = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
    path
  ).replace(/%2F/g, "/")}`;

  const body = {
    message: `Salvar checkpoint ${path}`,
    content: Buffer.from(content, "utf8").toString("base64"),
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
    throw new Error(
      `GitHub error ${response.status}: ${JSON.stringify(data, null, 2)}`
    );
  }

  return data;
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use POST."
      });
    }

    const expectedKey = requireEnv("GUARDIAO_API_KEY");
    const receivedKey = req.headers["x-api-key"];

    if (!receivedKey || receivedKey !== expectedKey) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const payload = req.body as CheckpointPayload;

    const sessionId = payload.session_id || "S00";
    const checkpointId =
      payload.checkpoint_id || `${sessionId}-C${Date.now()}`;

    const safeCheckpointId = checkpointId.replace(/[^a-zA-Z0-9-_]/g, "_");
    const path = `checkpoints/${safeCheckpointId}.md`;

    const markdown = toMarkdown({
      ...payload,
      session_id: sessionId,
      checkpoint_id: checkpointId
    });

    const result = await githubPutFile(path, markdown);

    return res.status(200).json({
      ok: true,
      message: "Checkpoint salvo com sucesso.",
      path,
      html_url: result.content?.html_url
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown error"
    });
  }
}
