import REGISTRY from "../providers/registry/index.js";
import { PROVIDER_MODELS_LIST_IDS } from "../config/providerModelsListIds.js";
import { createOpenAIModelsConfig, parseOpenAIStyleModels } from "./providerModelsImportShared.js";

export { parseOpenAIStyleModels, createOpenAIModelsConfig } from "./providerModelsImportShared.js";

/** Registry categories that may use connection-based model import */
export const IMPORTABLE_REGISTRY_CATEGORIES = new Set([
  "apikey",
  "oauth",
  "freeTier",
  "free",
  "webCookie",
]);

const NON_LLM_KINDS = new Set([
  "tts",
  "stt",
  "embedding",
  "image",
  "imageToText",
  "video",
  "music",
  "webSearch",
  "webFetch",
]);

export function getRegistryEntry(providerId) {
  return REGISTRY.find((r) => r.id === providerId) || null;
}

/** Any dashboard registry provider (incl. media/search) — show import UI */
export function isRegistryDashboardProvider(entry) {
  if (!entry) return false;
  return IMPORTABLE_REGISTRY_CATEGORIES.has(entry.category);
}

/**
 * LLM chat providers — preferred for automatic /models URL derivation.
 */
export function isRegistryLlmProvider(entry) {
  if (!entry) return false;
  if (!IMPORTABLE_REGISTRY_CATEGORIES.has(entry.category)) return false;
  const kinds = entry.serviceKinds || entry.media?.serviceKinds;
  if (!kinds || !Array.isArray(kinds) || kinds.length === 0) {
    return true;
  }
  if (kinds.includes("llm")) return true;
  const onlyNonLlm = kinds.every((k) => NON_LLM_KINDS.has(k));
  return !onlyNonLlm;
}

export function deriveOpenAIModelsListUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return null;
  const normalized = baseUrl.trim().replace(/\/$/, "");
  if (!normalized) return null;
  if (normalized.endsWith("/chat/completions")) {
    return normalized.replace(/\/chat\/completions$/, "/models");
  }
  if (normalized.endsWith("/models")) return normalized;
  if (/\/messages(\?|$)/.test(normalized) || normalized.endsWith("/messages")) {
    return null;
  }
  return `${normalized}/models`;
}

function pickAuthTransport(entry, { preferOpenai = true } = {}) {
  if (preferOpenai && Array.isArray(entry.transports)) {
    const openai = entry.transports.find((t) => t?.format === "openai");
    if (openai) return openai;
  }
  return entry.transport || {};
}

/**
 * Build GET /models config using registry transport auth (x-api-key, Bearer, custom headers).
 */
export function buildModelsConfigFromRegistry(entry, url) {
  const base = createOpenAIModelsConfig(url);
  if (!entry) return base;

  const t = pickAuthTransport(entry);
  const auth = t.auth || {};
  const extraHeaders = { ...(t.headers || {}), ...(entry.transport?.headers || {}) };
  base.headers = { ...base.headers, ...extraHeaders };

  const headerName = auth.header || base.authHeader;
  const scheme = auth.scheme || "bearer";

  if (scheme === "raw") {
    base.authHeader = headerName;
    base.authPrefix = "";
  } else if (scheme === "bearer" || scheme === "combined") {
    base.authHeader = headerName || "Authorization";
    base.authPrefix = scheme === "combined" ? "Bearer " : "Bearer ";
  } else {
    base.authHeader = headerName;
    base.authPrefix = auth.scheme ? `${auth.scheme} ` : "Bearer ";
  }

  return base;
}

function collectTransportCandidates(entry) {
  const out = [];
  if (Array.isArray(entry.transports)) {
    for (const t of entry.transports) {
      if (t?.format === "openai" && t.baseUrl) out.push(t);
    }
  }
  if (entry.transport?.baseUrl) out.push(entry.transport);
  return out;
}

export function resolveRegistryOpenAIModelsUrl(providerId) {
  const entry = getRegistryEntry(providerId);
  if (!entry || !isRegistryDashboardProvider(entry)) return null;

  const t = entry.transport || {};
  if (typeof t.validateUrl === "string" && t.validateUrl.trim()) {
    return t.validateUrl.trim();
  }

  for (const cand of collectTransportCandidates(entry)) {
    const url = deriveOpenAIModelsListUrl(cand.baseUrl);
    if (url) return url;
  }
  return null;
}

export function providerHasExplicitModelsListing(providerId) {
  return PROVIDER_MODELS_LIST_IDS.has(providerId);
}

export function providerSupportsRegistryOpenAIFallback(providerId) {
  if (PROVIDER_MODELS_LIST_IDS.has(providerId)) return false;
  return !!resolveRegistryOpenAIModelsUrl(providerId);
}

/** Known registry id (oauth, apikey, free, freeTier, webCookie) — incl. media-only */
export function providerIsKnownRegistryId(providerId) {
  if (!providerId || typeof providerId !== "string") return false;
  const entry = getRegistryEntry(providerId);
  return isRegistryDashboardProvider(entry);
}

/** @deprecated alias */
export function providerIsImportableRegistryId(providerId) {
  return providerIsKnownRegistryId(providerId);
}

export function connectionSupportsModelsImport(connection) {
  if (!connection?.provider) return { supported: false, reason: "unknown_provider" };
  const pid = connection.provider;
  if (pid.startsWith("openai-compatible-") || pid.startsWith("anthropic-compatible-")) {
    return { supported: true, mode: "compatible_node" };
  }
  if (PROVIDER_MODELS_LIST_IDS.has(pid)) {
    return { supported: true, mode: "explicit" };
  }
  if (providerSupportsRegistryOpenAIFallback(pid)) {
    return { supported: true, mode: "registry_fallback" };
  }
  if (providerIsKnownRegistryId(pid)) {
    return {
      supported: true,
      mode: "try_openai",
      message: "Will try /models using registry auth when a base URL is available.",
    };
  }
  return {
    supported: false,
    reason: "not_supported",
    message: `Provider "${pid}" is not in the provider registry.`,
  };
}

export function buildOpenAIFallbackModelsConfig(url, providerId) {
  const entry = getRegistryEntry(providerId);
  if (entry) return buildModelsConfigFromRegistry(entry, url);
  return createOpenAIModelsConfig(url);
}

export function formatModelsImportHttpError(status, code = "upstream_error") {
  return {
    error: `Provider returned HTTP ${status} from models endpoint. Check API key and base URL.`,
    code,
    status,
  };
}