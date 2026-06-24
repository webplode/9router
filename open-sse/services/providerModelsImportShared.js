/** Shared parsers/helpers (no registry import) for tests and route. */

export const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

export function createOpenAIModelsConfig(url) {
  return {
    url,
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: parseOpenAIStyleModels,
  };
}