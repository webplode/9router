/** Provider id is the provider node uuid for OpenAI/Anthropic compatible entries. */
export function isCompatibleProviderId(providerId) {
  if (typeof providerId !== "string") return false;
  return (
    providerId.startsWith("openai-compatible-") ||
    providerId.startsWith("anthropic-compatible-")
  );
}

export function isCustomEmbeddingProviderId(providerId) {
  return typeof providerId === "string" && providerId.startsWith("custom-embedding-");
}

export const DEFAULT_COMPATIBLE_MAX_RETRIES = 10;