import { getProviderNodeById } from "@/models/index.js";
import {
  isCompatibleProviderId,
  isCustomEmbeddingProviderId,
} from "open-sse/services/compatibleProvider.js";

/** OpenAI/Anthropic compatible + custom embedding nodes store retry policy on the node. */
export function isPassthroughNodeProvider(providerId) {
  return isCompatibleProviderId(providerId) || isCustomEmbeddingProviderId(providerId);
}

/**
 * @param {string} provider
 * @returns {Promise<{ max: number, count: number } | null>}
 */
export async function resolveAggressiveRetryForProvider(provider) {
  if (!isPassthroughNodeProvider(provider)) return null;
  const node = await getProviderNodeById(provider);
  if (node?.retryWithoutModelLock !== true) return null;
  const max =
    typeof node.maxRetriesOnError === "number" && node.maxRetriesOnError > 0
      ? Math.min(node.maxRetriesOnError, 100)
      : 10;
  return { max, count: 0 };
}

/**
 * After markAccountUnavailable + shouldFallback, decide whether to exclude account or retry same connection.
 * @returns {"continue" | "return"}
 */
export function handlePassthroughRetryAfterFallback({
  aggressiveRetry,
  provider,
  excludeConnectionIds,
  connectionId,
  result,
  log,
  tag = "AUTH",
}) {
  if (!aggressiveRetry) {
    log.warn(tag, `Account unavailable (${result.status}), trying fallback`);
    excludeConnectionIds.add(connectionId);
    return "continue";
  }
  aggressiveRetry.count += 1;
  if (aggressiveRetry.count >= aggressiveRetry.max) {
    log.warn(tag, `Passthrough ${provider} | max retries (${aggressiveRetry.max}) reached`);
    return "return";
  }
  log.warn(
    tag,
    `Passthrough ${provider} | retry ${aggressiveRetry.count}/${aggressiveRetry.max} (no model lock)`
  );
  return "continue";
}