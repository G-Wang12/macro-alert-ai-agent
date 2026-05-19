import "dotenv/config";

import { Request } from "zeromq";

type XaiModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

type XaiListModelsResponse = {
  object?: string;
  data: XaiModel[];
};

async function listModels(
  baseUrl: string,
  apiKey: string,
): Promise<XaiListModelsResponse> {
  const res = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `xAI /models failed: ${res.status} ${res.statusText}${text ? `\n${text}` : ""}`,
    );
  }

  return (await res.json()) as XaiListModelsResponse;
}

async function main(): Promise<void> {
  const socket = new Request();
  socket.close();

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.log("ts_agent: XAI_API_KEY not set (see .env.example)");
    return;
  }

  const baseUrl = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";
  const model = process.env.GROK_MODEL ?? "grok-2-latest";
  void model;

  const models = await listModels(baseUrl, apiKey);
  console.log(`ts_agent: xAI reachable (${models.data.length} models visible)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
