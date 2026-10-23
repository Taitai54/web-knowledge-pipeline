import fs from "fs/promises";
import path from "path";

export type LlmProviderId = "ollama" | "lmstudio" | "openai" | "gemini";

const SETTINGS_PATH = path.join(process.cwd(), ".llm-settings.json");
const DEFAULT_OLLAMA = "http://127.0.0.1:11434";
const DEFAULT_LMSTUDIO = "http://127.0.0.1:1234";
const OLLAMA_KEEP_ALIVE = "30m";

export const OPENAI_MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"];
export const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];

const PROVIDER_LABEL: Record<LlmProviderId, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openai: "OpenAI",
  gemini: "Gemini",
};

interface StoredSettings {
  provider?: LlmProviderId;
  model?: string;
  ollamaUrl?: string;
  lmStudioUrl?: string;
  openaiKey?: string;
  geminiKey?: string;
}

export interface LlmProviderStatus {
  id: LlmProviderId;
  label: string;
  ready: boolean;
  detail: string;
  models: string[];
}

export interface LlmPublicStatus {
  provider: LlmProviderId;
  model: string;
  ollamaUrl: string;
  lmStudioUrl: string;
  providers: LlmProviderStatus[];
}

export interface LlmSaveInput {
  provider?: LlmProviderId;
  model?: string;
  ollamaUrl?: string;
  lmStudioUrl?: string;
  openaiKey?: string | null;
  geminiKey?: string | null;
}

function isProviderId(value: unknown): value is LlmProviderId {
  return value === "ollama" || value === "lmstudio" || value === "openai" || value === "gemini";
}

function isChatModel(name: string): boolean {
  return !/embed/i.test(name);
}

export function pickChatModel(models: string[]): string {
  const chat = models.filter(isChatModel);
  return (
    chat.find((name) => /llama3\.2/i.test(name)) ||
    chat.find((name) => /gemma/i.test(name)) ||
    chat[0] ||
    ""
  );
}

function serverOrigin(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = new URL(fallback);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new URL(fallback).origin;
  }
  return parsed.origin;
}

async function readStored(): Promise<StoredSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as StoredSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStored(settings: StoredSettings): Promise<void> {
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

function resolveKey(saved: string | undefined, envValue: string | undefined): { key: string; source: "ui" | "env" | "none" } {
  if (saved && saved.trim()) return { key: saved.trim(), source: "ui" };
  if (envValue && envValue.trim()) return { key: envValue.trim(), source: "env" };
  return { key: "", source: "none" };
}

async function fetchJson(url: string, timeoutMs = 2500): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function ollamaModels(origin: string): Promise<string[] | null> {
  const body = await fetchJson(`${origin}/api/tags`);
  if (!body || typeof body !== "object" || !Array.isArray((body as { models?: unknown }).models)) return null;
  return (body as { models: { name?: string }[] })
    .models.map((model) => model.name || "")
    .filter(isChatModel);
}

async function lmStudioModels(origin: string): Promise<string[] | null> {
  const body = await fetchJson(`${origin}/v1/models`);
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) return null;
  return (body as { data: { id?: string }[] })
    .data.map((model) => model.id || "")
    .filter(isChatModel);
}

function keyDetail(source: "ui" | "env" | "none"): string {
  if (source === "ui") return "Key saved in this app";
  if (source === "env") return "Key from the environment";
  return "No key yet";
}

export async function getLlmStatus(): Promise<LlmPublicStatus> {
  const stored = await readStored();
  const ollamaUrl = serverOrigin(stored.ollamaUrl || process.env.OLLAMA_URL, DEFAULT_OLLAMA);
  const lmStudioUrl = serverOrigin(stored.lmStudioUrl || process.env.LMSTUDIO_URL, DEFAULT_LMSTUDIO);
  const openai = resolveKey(stored.openaiKey, process.env.OPENAI_API_KEY);
  const gemini = resolveKey(stored.geminiKey, process.env.GEMINI_API_KEY);

  const [ollamaList, lmList] = await Promise.all([
    ollamaModels(ollamaUrl),
    lmStudioModels(lmStudioUrl),
  ]);

  const providers: LlmProviderStatus[] = [
    {
      id: "ollama",
      label: PROVIDER_LABEL.ollama,
      ready: ollamaList !== null && ollamaList.length > 0,
      detail: ollamaList === null ? "Not running" : `${ollamaList.length} chat models`,
      models: ollamaList || [],
    },
    {
      id: "lmstudio",
      label: PROVIDER_LABEL.lmstudio,
      ready: lmList !== null && lmList.length > 0,
      detail: lmList === null ? "Not running" : `${lmList.length} chat models`,
      models: lmList || [],
    },
    {
      id: "openai",
      label: PROVIDER_LABEL.openai,
      ready: openai.source !== "none",
      detail: keyDetail(openai.source),
      models: OPENAI_MODELS,
    },
    {
      id: "gemini",
      label: PROVIDER_LABEL.gemini,
      ready: gemini.source !== "none",
      detail: keyDetail(gemini.source),
      models: GEMINI_MODELS,
    },
  ];

  const savedProvider = isProviderId(stored.provider) ? stored.provider : undefined;
  const provider =
    savedProvider ||
    providers.find((item) => item.ready)?.id ||
    "ollama";
  const models = providers.find((item) => item.id === provider)?.models || [];
  const model = stored.model && models.includes(stored.model) ? stored.model : pickChatModel(models);

  return { provider, model, ollamaUrl, lmStudioUrl, providers };
}

export async function saveLlmSettings(input: LlmSaveInput): Promise<LlmPublicStatus> {
  const stored = await readStored();
  if (isProviderId(input.provider)) stored.provider = input.provider;
  if (typeof input.model === "string") stored.model = input.model.trim().slice(0, 200);
  if (typeof input.ollamaUrl === "string") stored.ollamaUrl = serverOrigin(input.ollamaUrl, DEFAULT_OLLAMA);
  if (typeof input.lmStudioUrl === "string") stored.lmStudioUrl = serverOrigin(input.lmStudioUrl, DEFAULT_LMSTUDIO);
  if (input.openaiKey === null) stored.openaiKey = "";
  else if (typeof input.openaiKey === "string" && input.openaiKey.trim()) {
    stored.openaiKey = input.openaiKey.trim().slice(0, 400);
  }
  if (input.geminiKey === null) stored.geminiKey = "";
  else if (typeof input.geminiKey === "string" && input.geminiKey.trim()) {
    stored.geminiKey = input.geminiKey.trim().slice(0, 400);
  }
  await writeStored(stored);
  return getLlmStatus();
}

async function completeOpenAICompatible(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  apiKey?: string,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      stream: false,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await res.text();
  if (!res.ok) {
    if (raw.includes("insufficient_quota") || raw.includes("credit_balance_exhausted")) {
      throw new Error("This OpenAI key has no credits left. Switch to Ollama or LM Studio, or add credits.");
    }
    throw new Error(raw.slice(0, 280) || `Model request failed (${res.status})`);
  }
  const data = JSON.parse(raw) as {
    choices?: { message?: { content?: string; reasoning?: string } }[];
  };
  const message = data.choices?.[0]?.message;
  const text = message?.content || message?.reasoning || "";
  if (!text.trim()) throw new Error("The model returned an empty answer.");
  return text;
}

// Ollama's OpenAI-compatible endpoint ignores keep_alive, so the model would unload after 5 idle minutes.
async function completeOllama(origin: string, model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      options: { temperature: 0.2 },
      keep_alive: OLLAMA_KEEP_ALIVE,
      stream: false,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(raw.slice(0, 280) || `Ollama request failed (${res.status})`);
  const data = JSON.parse(raw) as { message?: { content?: string; thinking?: string } };
  const text = data.message?.content || data.message?.thinking || "";
  if (!text.trim()) throw new Error("The model returned an empty answer.");
  return text;
}

async function completeGemini(model: string, systemPrompt: string, userPrompt: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
      }),
      signal: AbortSignal.timeout(90000),
    },
  );
  const raw = await res.text();
  if (!res.ok) throw new Error(raw.slice(0, 280) || `Gemini request failed (${res.status})`);
  const data = JSON.parse(raw) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text.trim()) throw new Error("Gemini returned an empty answer.");
  return text;
}

export async function generateAnswer(
  systemPrompt: string,
  userPrompt: string,
  override?: { provider?: string; model?: string },
): Promise<{ text: string; label: string; model: string }> {
  const status = await getLlmStatus();
  const stored = await readStored();
  const provider = isProviderId(override?.provider) ? override.provider : status.provider;
  const chosen = status.providers.find((item) => item.id === provider);
  const model =
    (override?.model && override.model.trim()) ||
    (provider === status.provider ? status.model : pickChatModel(chosen?.models || []));

  if (!model) {
    throw new Error(`${PROVIDER_LABEL[provider]} has no chat model available. Start it, or pick another provider in Model settings.`);
  }

  if (provider === "ollama") {
    const text = await completeOllama(status.ollamaUrl, model, systemPrompt, userPrompt);
    return { text, label: "Ollama", model };
  }
  if (provider === "lmstudio") {
    const text = await completeOpenAICompatible(`${status.lmStudioUrl}/v1`, model, systemPrompt, userPrompt);
    return { text, label: "LM Studio", model };
  }
  if (provider === "openai") {
    const key = resolveKey(stored.openaiKey, process.env.OPENAI_API_KEY);
    if (!key.key) throw new Error("Add an OpenAI key in Model settings.");
    const text = await completeOpenAICompatible("https://api.openai.com/v1", model, systemPrompt, userPrompt, key.key);
    return { text, label: "OpenAI", model };
  }
  const key = resolveKey(stored.geminiKey, process.env.GEMINI_API_KEY);
  if (!key.key) throw new Error("Add a Gemini key in Model settings.");
  const text = await completeGemini(model, systemPrompt, userPrompt, key.key);
  return { text, label: "Gemini", model };
}
