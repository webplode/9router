/**
 * Fetch models from GET /api/providers/:connectionId/models and add as custom models.
 * Backend calls provider /v1/models (or provider-specific catalog) using stored credentials.
 */

export function normalizeImportedModelId(raw, providerId) {
  if (!raw || typeof raw !== "string") return null;
  let id = raw.trim();
  if (!id) return null;
  if (providerId === "gemini" && id.startsWith("models/")) {
    id = id.slice("models/".length);
  }
  if (id.includes("/")) {
    const parts = id.split("/").filter(Boolean);
    id = parts[parts.length - 1];
  }
  return id;
}

export function parseModelsListPayload(data) {
  const models = data?.models;
  if (!Array.isArray(models)) return [];
  return models;
}

/**
 * @param {object} opts
 * @param {string} opts.connectionId
 * @param {string} opts.providerStorageAlias
 * @param {string} [opts.providerId] - registry id for id normalization (gemini, etc.)
 * @param {(modelId: string) => Promise<void>} opts.onAddCustomModel
 * @param {() => Iterable<{ id: string }>} opts.getExistingModelIds - returns ids already in Available Models
 * @param {string} [opts.type] - custom model kind, default llm
 */
export async function importModelsFromProviderConnection({
  connectionId,
  providerStorageAlias,
  providerId = "",
  onAddCustomModel,
  getExistingModelIds,
  type = "llm",
}) {
  const res = await fetch(`/api/providers/${connectionId}/models`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.code ? ` [${data.code}]` : "";
    throw new Error((data.error || `Failed to fetch models (${res.status})`) + detail);
  }
  if (data.warning) {
    console.warn("[import models]", data.warning);
  }

  const list = parseModelsListPayload(data);
  if (list.length === 0) {
    return { importedCount: 0, skippedCount: 0, total: 0, warning: data.warning || null };
  }

  const existing = new Set(getExistingModelIds());
  let importedCount = 0;
  let skippedCount = 0;

  for (const model of list) {
    const raw = model.id || model.name || model.model || model.slug;
    const modelId = normalizeImportedModelId(raw, providerId);
    if (!modelId) continue;
    if (existing.has(modelId)) {
      skippedCount += 1;
      continue;
    }
    await onAddCustomModel(modelId, type, providerStorageAlias);
    existing.add(modelId);
    importedCount += 1;
  }

  return {
    importedCount,
    skippedCount,
    total: list.length,
    warning: data.warning || null,
  };
}