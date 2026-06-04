function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

async function getRepositoryTree() {
  const token = requireEnv("GITHUB_TOKEN");
  const owner = requireEnv("GITHUB_OWNER");
  const repo = requireEnv("GITHUB_REPO");
  const branch = process.env.GITHUB_BRANCH || "main";

  const refResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "guardiao-api"
      }
    }
  );

  const refData = await refResponse.json();

  if (!refResponse.ok) {
    throw new Error(
      `GitHub ref error ${refResponse.status}: ${JSON.stringify(refData)}`
    );
  }

  const treeSha = refData.object.sha;

  const commitResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${treeSha}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "guardiao-api"
      }
    }
  );

  const commitData = await commitResponse.json();

  if (!commitResponse.ok) {
    throw new Error(
      `GitHub commit error ${commitResponse.status}: ${JSON.stringify(commitData)}`
    );
  }

  const rootTreeSha = commitData.tree.sha;

  const treeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${rootTreeSha}?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "guardiao-api"
      }
    }
  );

  const treeData = await treeResponse.json();

  if (!treeResponse.ok) {
    throw new Error(
      `GitHub tree error ${treeResponse.status}: ${JSON.stringify(treeData)}`
    );
  }

  return treeData.tree;
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use GET."
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

    const tree = await getRepositoryTree();

    return res.status(200).json({
      ok: true,
      items: tree
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown error"
    });
  }
}
