"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { importModelsFromProviderConnection } from "@/shared/utils/importProviderModels";
import { getImportModelsUiState } from "@/shared/utils/providerModelsImportCapability";

/**
 * Pull model IDs from provider GET /v1/models (via /api/providers/:connectionId/models)
 * and add them to Available Models.
 */
export default function ImportModelsFromProviderButton({
  connections,
  providerStorageAlias,
  providerId = "",
  onAddCustomModel,
  getExistingModelIds,
  type = "llm",
  className = "",
  label = "Import from /v1/models",
}) {
  const [importing, setImporting] = useState(false);

  const ui = getImportModelsUiState({ providerId, connections });
  const active = connections?.find((c) => c.isActive !== false);

  if (!ui.show) {
    return ui.hint ? (
      <p className="text-xs text-text-muted w-full">{ui.hint}</p>
    ) : null;
  }

  const disabled = ui.disabled || !active?.id || importing;

  const handleImport = async () => {
    if (disabled) return;
    setImporting(true);
    try {
      const result = await importModelsFromProviderConnection({
        connectionId: active.id,
        providerStorageAlias,
        providerId,
        onAddCustomModel,
        getExistingModelIds,
        type,
      });
      const { importedCount, skippedCount, total, warning } = result;
      if (total === 0) {
        alert(warning || "No models returned from the provider /models endpoint.");
        return;
      }
      if (importedCount === 0) {
        alert(`All ${skippedCount || total} model(s) were already in your list.`);
        return;
      }
      const msg = `Added ${importedCount} model(s)${skippedCount ? ` (${skippedCount} already existed)` : ""}.`;
      alert(warning ? `${msg}\n\nNote: ${warning}` : msg);
    } catch (e) {
      alert(e.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleImport}
        disabled={disabled}
        title={ui.hint || undefined}
        className={
          className ||
          "flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-blue-500/40 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 transition-colors hover:border-blue-500 hover:bg-blue-500/5 sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
        }
      >
        <span
          className="material-symbols-outlined text-sm"
          style={importing ? { animation: "spin 1s linear infinite" } : undefined}
        >
          {importing ? "progress_activity" : "cloud_download"}
        </span>
        {importing ? "Importing..." : label}
      </button>
      {ui.hint && ui.disabled && (
        <p className="text-xs text-text-muted">{ui.hint}</p>
      )}
    </div>
  );
}

ImportModelsFromProviderButton.propTypes = {
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
    provider: PropTypes.string,
  })).isRequired,
  providerStorageAlias: PropTypes.string.isRequired,
  providerId: PropTypes.string,
  onAddCustomModel: PropTypes.func.isRequired,
  getExistingModelIds: PropTypes.func.isRequired,
  type: PropTypes.string,
  className: PropTypes.string,
  label: PropTypes.string,
};