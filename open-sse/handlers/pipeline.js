import { detectFormat } from "../services/provider.js";
import { detectFormatByEndpoint, FORMATS } from "../translator/formats.js";

/**
 * Resolve inbound client format (endpoint-first, then body), mirroring CLIProxyAPI's
 * handler-type → wire-format routing without a separate server per API surface.
 *
 * @param {{ pathname?: string|null, body?: object }} ctx
 * @returns {string|null} FORMATS.* value, or null to use body-only detectFormat(body)
 */
export function resolveSourceFormat({ pathname, body }) {
  if (pathname) {
    const byEndpoint = detectFormatByEndpoint(pathname, body);
    if (byEndpoint) return byEndpoint;
  }
  if (body && typeof body === "object") {
    return detectFormat(body);
  }
  return FORMATS.OPENAI;
}

/**
 * Human-readable pipeline step labels for logs/docs (not used in hot path).
 */
export const V1_PIPELINE_STEPS = [
  "route",
  "auth",
  "model",
  "resolveSourceFormat",
  "translateRequest",
  "executor",
  "translateResponse",
];