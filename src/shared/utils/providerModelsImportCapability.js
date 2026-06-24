import {
  connectionSupportsModelsImport,
  providerHasExplicitModelsListing,
  providerSupportsRegistryOpenAIFallback,
  providerIsKnownRegistryId,
} from "open-sse/services/providerModelsImport.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

export { connectionSupportsModelsImport };

export function providerIdSupportsModelsImport(providerId) {
  if (!providerId || typeof providerId !== "string") return false;
  if (isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)) {
    return true;
  }
  if (providerHasExplicitModelsListing(providerId)) return true;
  if (providerSupportsRegistryOpenAIFallback(providerId)) return true;
  if (providerIsKnownRegistryId(providerId)) return true;
  return false;
}

export function getImportModelsUiState({ providerId, connections = [] }) {
  if (!providerIdSupportsModelsImport(providerId)) {
    return {
      show: false,
      hint: "This provider is not in the 9router provider registry.",
    };
  }
  const active = connections.find((c) => c.isActive !== false);
  if (!active) {
    return {
      show: true,
      hint: "Add an active connection to import models.",
      disabled: true,
    };
  }
  const check = connectionSupportsModelsImport(active);
  if (!check.supported) {
    return { show: false, hint: check.message || "Import not supported for this connection." };
  }
  return { show: true, hint: check.message || null, disabled: false };
}