import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { BaseExecutor } from "../base.js";
import { PROVIDERS } from "../../config/providers.js";
import { refreshXaiToken } from "../../services/tokenRefresh/providers.js";

/**
 * XAI_HOSTED_TOOL_TYPES — tools that xAI Responses API executes server-side.
 * These are NOT client-defined functions and must be preserved or stripped
 * depending on CPA Go behavior.
 */
const XAI_STRIP_TOOL_TYPES = new Set(["tool_search", "image_generation"]);

/**
 * XAI_CUSTOM_TOOL_TYPES — freeform tools that get converted to function type.
 */
const XAI_CUSTOM_TOOL_TYPE = "custom";

/**
 * XAI_WEB_SEARCH_TOOL_TYPE — web_search tool type.
 */
const XAI_WEB_SEARCH_TYPE = "web_search";

/**
 * XAI_FUNCTION_TOOL_TYPE — standard function tool type.
 */
const XAI_FUNCTION_TYPE = "function";

/**
 * XAI_NAMESPACE_TOOL_TYPE — namespace tool type (contains nested tools).
 */
const XAI_NAMESPACE_TYPE = "namespace";

/**
 * XAI_RESPONSES_URL — the single xAI Responses API endpoint.
 * Streaming and non-streaming requests both go to this URL.
 */
const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";

/**
 * XAI_REFRESH_LEAD_MS — 5 minutes before expiry, matching CPA Go.
 * Source: CLIProxyAPI/internal/auth/xai/types.go refreshLead = 5 * time.Minute
 */
const XAI_REFRESH_LEAD_MS = 5 * 60 * 1000;
const XAI_COMPOSER_MODEL_PREFIX = "grok-composer-";
const sessionContext = new AsyncLocalStorage();

/**
 * XaiResponsesExecutor — Executor for xAI Grok's Responses API.
 *
 * This executor:
 * - Normalizes tools to match xAI Responses API expectations
 * - Injects OAuth Bearer credentials
 * - Handles session IDs via x-grok-conv-id header
 * - Sanitizes reasoning/thinking fields
 * - Delegates OAuth refresh to refreshXaiToken (singleflight-deduped)
 *
 * Reference: CLIProxyAPI/internal/runtime/executor/xai_executor.go
 */
export class XaiResponsesExecutor extends BaseExecutor {
  constructor() {
    const provider = PROVIDERS.xai;
    if (!provider) {
      throw new Error("xAI provider not found in registry");
    }
    super("xai", provider);
  }

  // ── credential extraction ──────────────────────────────────────────

  /**
   * Extract the Bearer token from credentials.
   * Priority: metadata.access_token → auth attributes.access_token → credentials.accessToken
   * Mirrors CPA Go: xaiCreds() in xai_executor.go
   */
  _extractAccessToken(credentials) {
    if (!credentials) return null;

    // Check metadata (OAuth token storage)
    if (credentials.accessToken && typeof credentials.accessToken === "string") {
      return credentials.accessToken;
    }

    // Check providerSpecificData (connection-level metadata)
    const psd = credentials.providerSpecificData;
    if (psd?.access_token && typeof psd.access_token === "string") {
      return psd.access_token;
    }

    // Fallback: apiKey
    if (credentials.apiKey && typeof credentials.apiKey === "string") {
      return credentials.apiKey;
    }

    return null;
  }

  // ── URL construction ───────────────────────────────────────────────

  /**
   * Build the xAI Responses API URL.
   * Both streaming and non-streaming go to the same endpoint.
   * CPA Go: url := strings.TrimSuffix(baseURL, "/") + "/responses"
   */
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const psd = credentials?.providerSpecificData;
    const customBase = psd?.baseUrl || psd?.base_url;
    if (typeof customBase === "string" && customBase.trim()) {
      return `${customBase.trim().replace(/\/$/, "")}/responses`;
    }
    return this.config.responsesUrl || XAI_RESPONSES_URL;
  }

  // ── headers ─────────────────────────────────────────────────────────

  /**
   * Build headers for the xAI Responses API request.
   * Injects: Authorization Bearer, Content-Type, Accept (SSE or JSON),
   * x-grok-conv-id (session ID), Connection: Keep-Alive.
   */
  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
    };

    const token = this._extractAccessToken(credentials);
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    headers["Accept"] = stream ? "text/event-stream" : "application/json";
    headers["Connection"] = "Keep-Alive";

    const sessionId = sessionContext.getStore()?.sessionId || null;
    if (sessionId) {
      headers["x-grok-conv-id"] = sessionId;
    }

    return headers;
  }

  // ── session ID ──────────────────────────────────────────────────────

  /**
   * Resolve the session/conversation ID for the x-grok-conv-id header.
   * Priority: prompt_cache_key → connectionId → null
   */
  _resolveSessionId(body, credentials, model = null) {
    // Check prompt_cache_key in body (set by upstream translator)
    if (body?.prompt_cache_key && typeof body.prompt_cache_key === "string") {
      return body.prompt_cache_key;
    }

    // Composer requests require isolated conversations when the client did not provide one.
    if (this._requiresIsolatedConversation(model || body?.model)) {
      return randomUUID();
    }

    // Check connectionId for non-composer requests.
    if (credentials?.connectionId) {
      return credentials.connectionId;
    }

    return null;
  }

  _requiresIsolatedConversation(model) {
    return String(model || "").trim().toLowerCase().startsWith(XAI_COMPOSER_MODEL_PREFIX);
  }

  // ── tool normalization ─────────────────────────────────────────────

  /**
   * Normalize tools to match xAI Responses API expectations.
   *
   * Mirrors CPA Go normalizeXAITools / normalizeXAITool:
   * 1. Strip tool_search and image_generation tools (server-side, unsupported)
   * 2. Convert custom tools to function type (name becomes function name)
   * 3. Flatten namespace tools by unwrapping nested tools
   * 4. Remove web_search.external_web_access field
   * 5. Ensure parameters object exists on function tools (default: {type:"object",properties:{}})
   * 6. Drop tool_choice and parallel_tool_calls when no tools remain
   *
   * Returns the filtered/normalized tools array, or null if all tools were stripped.
   */
  _normalizeTools(tools) {
    if (!Array.isArray(tools)) return null;

    const normalized = [];

    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;

      // Handle namespace tools: flatten nested tools into the top-level array
      if (tool.type === XAI_NAMESPACE_TYPE) {
        if (Array.isArray(tool.tools)) {
          for (const nested of tool.tools) {
            const result = this._normalizeSingleTool(nested);
            if (result) normalized.push(result);
          }
        }
        continue;
      }

      const result = this._normalizeSingleTool(tool);
      if (result) normalized.push(result);
    }

    return normalized.length > 0 ? normalized : [];
  }

  /**
   * Normalize a single tool entry.
   * Returns the normalized tool object, or null if it should be stripped.
   */
  _normalizeSingleTool(tool) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;

    const toolType = tool.type;

    // Strip tool_search and image_generation
    if (XAI_STRIP_TOOL_TYPES.has(toolType)) {
      return null;
    }

    // Strip apply_patch custom tools (CPA Go special case)
    if (toolType === XAI_CUSTOM_TOOL_TYPE && tool.name === "apply_patch") {
      return null;
    }

    // Create a copy to mutate
    const normalized = { ...tool };

    // Convert custom tools to function type
    if (normalized.type === XAI_CUSTOM_TOOL_TYPE) {
      normalized.type = XAI_FUNCTION_TYPE;
    }

    // Remove external_web_access from web_search tools
    if (normalized.type === XAI_WEB_SEARCH_TYPE && "external_web_access" in normalized) {
      delete normalized.external_web_access;
    }

    // Ensure parameters object exists on function tools
    if (normalized.type === XAI_FUNCTION_TYPE && !normalized.parameters) {
      normalized.parameters = { type: "object", properties: {} };
    }

    return normalized;
  }

  /**
   * Clean up tool_choice and parallel_tool_calls when no tools remain.
   * CPA Go: normalizeXAIToolChoiceForTools
   */
  _normalizeToolChoice(body) {
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return; // Tools exist, keep tool_choice
    }

    delete body.tools;
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }

  // ── reasoning sanitization ─────────────────────────────────────────

  /**
   * Sanitize reasoning/thinking items in the input array.
   * Remove null content and null encrypted_content fields from reasoning items.
   * Mirrors CPA Go: normalizeXAIInputReasoningItems
   */
  _sanitizeReasoningItems(body) {
    if (!Array.isArray(body.input)) return;

    for (const item of body.input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (item.type !== "reasoning") continue;

      // Remove null content
      if ("content" in item && item.content === null) {
        delete item.content;
      }

      // Remove null encrypted_content
      if ("encrypted_content" in item && item.encrypted_content === null) {
        delete item.encrypted_content;
      }
    }
  }

  // ── body sanitization ──────────────────────────────────────────────

  /**
   * Strip fields that xAI Responses API rejects.
   * Mirrors CPA Go: sanitizeXAIResponsesBody + prepareResponsesRequest deletions
   */
  _sanitizeBody(body, model = null) {
    // xAI /v1/responses accepts max_output_tokens, not Chat Completions token fields.
    if (body.max_output_tokens === undefined) {
      if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      else if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
    }
    delete body.max_tokens;
    delete body.max_completion_tokens;

    // Fields xAI rejects
    delete body.previous_response_id;
    delete body.prompt_cache_retention;
    delete body.safety_identifier;
    delete body.stream_options;

    if (!this._supportsReasoningEffort(model || body.model)) {
      delete body.reasoning?.effort;
      if (body.reasoning && Object.keys(body.reasoning).length === 0) delete body.reasoning;
    }

    // Remove "reasoning.encrypted_content" from include array
    if (Array.isArray(body.include)) {
      body.include = body.include.filter(
        (v) => v !== "reasoning.encrypted_content"
      );
      if (body.include.length === 0) {
        delete body.include;
      }
    }
  }

  // ── main request transformation ──────────────────────────────────

  transformRequest(model, body, stream, credentials) {
    // Clone mutable containers to avoid mutating the caller's request body.
    const transformed = {
      ...body,
      model: model || body.model,
      input: Array.isArray(body.input) ? body.input.map((item) => ({ ...item })) : body.input,
      tools: Array.isArray(body.tools) ? body.tools.map((tool) => ({ ...tool })) : body.tools,
      include: Array.isArray(body.include) ? [...body.include] : body.include,
      reasoning: body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
        ? { ...body.reasoning }
        : body.reasoning,
    };

    // Set stream flag
    transformed.stream = stream;

    // Strip unsupported fields
    this._sanitizeBody(transformed, model);

    // Sanitize reasoning items
    this._sanitizeReasoningItems(transformed);

    // Normalize tools
    if (transformed.tools) {
      transformed.tools = this._normalizeTools(transformed.tools);
    }

    // Clean up tool_choice if no tools remain
    this._normalizeToolChoice(transformed);

    return transformed;
  }

  _supportsReasoningEffort(model) {
    const name = String(model || "").trim().toLowerCase().split("/").pop();
    return name.startsWith("grok-3-mini")
      || name.startsWith("grok-4.20-multi-agent")
      || name.startsWith("grok-4.3");
  }

  // ── refresh credentials ───────────────────────────────────────────

  /**
   * Refresh xAI OAuth credentials.
   * Delegates to refreshXaiToken (singleflight-deduped).
   * Writes back tokens and expiry to the credentials object.
   *
   * Mirrors CPA Go: XAIExecutor.Refresh() → XAIAuth.RefreshTokens() → refreshXaiToken
   */
  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) {
      return null;
    }

    try {
      const result = await refreshXaiToken(credentials.refreshToken, log);

      if (!result || result.error) {
        log?.warn?.("XAIRESP", `Token refresh failed: ${result?.error || "no result"}`);
        return null;
      }

      // Write back tokens
      if (result.accessToken) {
        credentials.accessToken = result.accessToken;
      }
      if (result.refreshToken) {
        credentials.refreshToken = result.refreshToken;
      }

      // Calculate expiry
      if (result.expiresIn) {
        credentials.expiresAt = new Date(
          Date.now() + result.expiresIn * 1000
        ).toISOString();
      }

      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      };
    } catch (error) {
      log?.warn?.("XAIRESP", `Token refresh error: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if credentials need refresh.
   * Uses 5-minute lead time matching CPA Go.
   */
  needsRefresh(credentials) {
    if (!credentials) return false;

    // Check expiry with lead time
    const expiresAtMs =
      credentials.expiresAt != null
        ? new Date(credentials.expiresAt).getTime()
        : credentials.tokenExpiresAt != null
          ? new Date(credentials.tokenExpiresAt).getTime()
          : null;

    if (expiresAtMs !== null && !isNaN(expiresAtMs)) {
      return expiresAtMs - Date.now() < XAI_REFRESH_LEAD_MS;
    }

    return false;
  }

  // ── error parsing ─────────────────────────────────────────────────

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const sessionId = this._resolveSessionId(body, credentials, model);
    return sessionContext.run({ sessionId }, () =>
      super.execute({ model, body, stream, credentials, signal, log, proxyOptions })
    );
  }

  parseError(response, bodyText) {
    // Try to extract a meaningful error message from the response body
    if (bodyText) {
      try {
        const json = JSON.parse(bodyText);
        if (json.error?.message) {
          return { status: response.status, message: json.error.message };
        }
      } catch {
        // Not JSON, use raw text
      }
    }

    return super.parseError(response, bodyText);
  }
}

export default XaiResponsesExecutor;
