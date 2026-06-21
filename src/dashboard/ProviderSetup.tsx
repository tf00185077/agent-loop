import React, { useEffect, useState } from "react";
import {
  detectCodexCli,
  getProviderSettings,
  loadCodexModelCatalog,
  saveProviderSettings,
  testCodexLocalConnection,
  type CodexModelCatalogResult,
  type ProviderSettings,
} from "./api";

type LocalProvider = ProviderSettings["provider"];
type BusyAction = "save" | "detect" | "test" | null;

interface ProviderSetupPanelProps {
  settings: ProviderSettings;
  draftProvider: LocalProvider;
  modelLabel: string;
  codexCommandPath: string;
  busy: BusyAction;
  error: string | null;
  modelCatalog: CodexModelCatalogResult | null;
  catalogBusy: boolean;
  manualEntry: boolean;
  onProviderChange: (provider: LocalProvider) => void;
  onModelLabelChange: (value: string) => void;
  onCodexCommandPathChange: (value: string) => void;
  onManualEntryChange: (value: boolean) => void;
  onSave: () => void;
  onDetect: () => void;
  onTestConnection: () => void;
  onReloadCatalog: () => void;
}

export default function ProviderSetup() {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [draftProvider, setDraftProvider] = useState<LocalProvider>("mock");
  const [modelLabel, setModelLabel] = useState("gpt-5-codex-subscription");
  const [codexCommandPath, setCodexCommandPath] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<CodexModelCatalogResult | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProviderSettings()
      .then((nextSettings) => {
        if (cancelled) return;
        applySettings(nextSettings);
        if (nextSettings.provider === "codex-local") {
          void refreshCatalog();
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshCatalog() {
    setCatalogBusy(true);
    try {
      setModelCatalog(await loadCodexModelCatalog());
    } catch {
      setModelCatalog(null);
    } finally {
      setCatalogBusy(false);
    }
  }

  function handleProviderChange(provider: LocalProvider) {
    setDraftProvider(provider);
    if (provider === "codex-local" && !modelCatalog && !catalogBusy) {
      void refreshCatalog();
    }
  }

  function applySettings(nextSettings: ProviderSettings) {
    setSettings(nextSettings);
    setDraftProvider(nextSettings.provider);
    setModelLabel(nextSettings.modelLabel);
    setCodexCommandPath(nextSettings.codexCommandPath ?? "");
  }

  async function handleSave() {
    setBusy("save");
    setError(null);
    try {
      const saved = await saveProviderSettings(
        draftProvider === "mock"
          ? { provider: "mock" }
          : {
              // A blank model label is saved as "" and means "Codex CLI default";
              // we no longer fall back to the stale gpt-5-codex-subscription label.
              provider: "codex-local",
              modelLabel: modelLabel.trim(),
              codexCommandPath: codexCommandPath.trim() || null,
            },
      );
      applySettings(saved);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDetect() {
    setBusy("detect");
    setError(null);
    try {
      await detectCodexCli();
      applySettings(await getProviderSettings());
      await refreshCatalog();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleTestConnection() {
    setBusy("test");
    setError(null);
    try {
      await testCodexLocalConnection();
      applySettings(await getProviderSettings());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!settings) {
    return (
      <section style={panelStyle}>
        <h2 style={headingStyle}>Provider setup</h2>
        <p style={{ color: "#777", margin: 0 }}>Loading provider settings...</p>
      </section>
    );
  }

  return (
    <ProviderSetupPanel
      settings={settings}
      draftProvider={draftProvider}
      modelLabel={modelLabel}
      codexCommandPath={codexCommandPath}
      busy={busy}
      error={error}
      modelCatalog={modelCatalog}
      catalogBusy={catalogBusy}
      manualEntry={manualEntry}
      onProviderChange={handleProviderChange}
      onModelLabelChange={setModelLabel}
      onCodexCommandPathChange={setCodexCommandPath}
      onManualEntryChange={setManualEntry}
      onSave={handleSave}
      onDetect={handleDetect}
      onTestConnection={handleTestConnection}
      onReloadCatalog={() => void refreshCatalog()}
    />
  );
}

export function ProviderSetupPanel(props: ProviderSetupPanelProps) {
  const {
    settings,
    draftProvider,
    modelLabel,
    codexCommandPath,
    busy,
    error,
    modelCatalog,
    catalogBusy,
    manualEntry,
    onProviderChange,
    onModelLabelChange,
    onCodexCommandPathChange,
    onManualEntryChange,
    onSave,
    onDetect,
    onTestConnection,
    onReloadCatalog,
  } = props;
  const codexSelected = draftProvider === "codex-local";
  const statusView = providerStatusView(settings.status.state);
  const catalogModels = modelCatalog?.models ?? [];
  const hasCatalogModels = catalogModels.length > 0;
  const catalogSlugs = new Set(catalogModels.map((model) => model.slug));
  const trimmedModel = modelLabel.trim();
  const savedUnlistedModel =
    trimmedModel !== "" && !catalogSlugs.has(trimmedModel) ? trimmedModel : null;
  // Manual entry is forced when there is no catalog to pick from; otherwise it
  // is an explicit user choice for unlisted or experimental slugs. A blank
  // value always means "use Codex CLI default".
  const showManualInput = manualEntry || !hasCatalogModels;
  const catalogNote = catalogStatusNote(catalogBusy, modelCatalog);

  return (
    <section style={panelStyle}>
      <div style={headerRowStyle}>
        <div>
          <h2 style={headingStyle}>Provider setup</h2>
          <div style={statusLineStyle}>
            <span style={dotStyle(statusView.color)} />
            <span>{settings.provider}</span>
            <span>{statusView.label}</span>
          </div>
        </div>
        <button type="button" onClick={onSave} disabled={busy !== null} style={buttonStyle}>
          {busy === "save" ? "Saving..." : "Save"}
        </button>
      </div>

      <div style={segmentedStyle} role="group" aria-label="Provider">
        <button
          type="button"
          onClick={() => onProviderChange("mock")}
          style={segmentStyle(draftProvider === "mock")}
        >
          Mock
        </button>
        <button
          type="button"
          onClick={() => onProviderChange("codex-local")}
          style={segmentStyle(codexSelected)}
        >
          Codex Local
        </button>
      </div>

      {codexSelected && (
        <div style={{ marginTop: 14 }}>
          <div style={labelRowStyle}>
            <label style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>
              Model
              {showManualInput ? (
                <input
                  value={modelLabel}
                  onChange={(event) => onModelLabelChange(event.target.value)}
                  placeholder="Codex CLI default"
                  style={inputStyle}
                />
              ) : (
                <select
                  value={modelLabel}
                  onChange={(event) => onModelLabelChange(event.target.value)}
                  style={inputStyle}
                >
                  <option value="">Codex CLI default</option>
                  {savedUnlistedModel && (
                    <option value={savedUnlistedModel}>{savedUnlistedModel} (saved)</option>
                  )}
                  {catalogModels.map((model) => (
                    <option key={model.slug} value={model.slug}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <button
              type="button"
              onClick={onReloadCatalog}
              disabled={busy !== null || catalogBusy}
              style={buttonStyle}
            >
              {catalogBusy ? "Loading..." : "Refresh models"}
            </button>
          </div>
          {hasCatalogModels && (
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={manualEntry}
                onChange={(event) => onManualEntryChange(event.target.checked)}
              />
              Enter model manually
            </label>
          )}
          <div style={catalogNoteStyle}>{catalogNote}</div>
          <label style={labelStyle}>
            Command path
            <input
              value={codexCommandPath}
              onChange={(event) => onCodexCommandPathChange(event.target.value)}
              style={inputStyle}
            />
          </label>
          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={onDetect}
              disabled={busy !== null}
              style={buttonStyle}
            >
              {busy === "detect" ? "Detecting..." : "Detect"}
            </button>
            <button
              type="button"
              onClick={onTestConnection}
              disabled={busy !== null}
              style={buttonStyle}
            >
              {busy === "test" ? "Testing..." : "Test connection"}
            </button>
          </div>
        </div>
      )}

      {codexSelected && (
        <div style={statusBoxStyle(statusView.color)}>
          <strong>{statusView.label}</strong>
          <div style={{ marginTop: 4 }}>{statusView.guidance}</div>
          {settings.status.checkedAt && (
            <div style={checkedAtStyle}>
              Checked {new Date(settings.status.checkedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {settings.status.message && (
        <p style={messageStyle}>{redactCredentialMaterial(settings.status.message)}</p>
      )}
      {error && <p style={errorStyle}>{error}</p>}
    </section>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: 18,
  marginBottom: 20,
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
};

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
};

const statusLineStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "#666",
  fontSize: 13,
  marginTop: 6,
};

function dotStyle(color: string): React.CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    display: "inline-block",
  };
}

const segmentedStyle: React.CSSProperties = {
  display: "inline-flex",
  border: "1px solid #ccc",
  borderRadius: 6,
  overflow: "hidden",
  marginTop: 14,
};

function segmentStyle(active: boolean): React.CSSProperties {
  return {
    border: 0,
    borderRight: "1px solid #ccc",
    padding: "7px 12px",
    background: active ? "#222" : "#fff",
    color: active ? "#fff" : "#222",
    cursor: "pointer",
  };
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginBottom: 12,
  fontSize: 14,
  fontWeight: 500,
};

const labelRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 8,
  marginBottom: 12,
};

const checkboxLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 12,
  fontSize: 13,
  color: "#555",
};

const catalogNoteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#777",
  marginBottom: 12,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 400,
};

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 4,
};

function statusBoxStyle(color: string): React.CSSProperties {
  return {
    borderLeft: `3px solid ${color}`,
    background: "#f8f8f8",
    padding: "10px 12px",
    marginTop: 14,
    fontSize: 13,
    color: "#333",
  };
}

const checkedAtStyle: React.CSSProperties = {
  color: "#777",
  marginTop: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: "7px 12px",
  cursor: "pointer",
};

const messageStyle: React.CSSProperties = {
  color: "#555",
  margin: "12px 0 0",
  fontSize: 13,
};

const errorStyle: React.CSSProperties = {
  color: "red",
  margin: "12px 0 0",
  fontSize: 13,
};

function providerStatusView(state: ProviderSettings["status"]["state"]) {
  switch (state) {
    case "detected":
      return {
        label: "Codex CLI detected",
        guidance: "Save this path or run a connection test before starting provider-backed goals.",
        color: "#1976d2",
      };
    case "not_found":
      return {
        label: "Codex CLI not found",
        guidance: "Enter a Codex command path manually or install Codex CLI, then detect again.",
        color: "#d97706",
      };
    case "connected":
      return {
        label: "Codex Local connected",
        guidance: "This provider is ready for new goals.",
        color: "#2e7d32",
      };
    case "login_required":
      return {
        label: "Codex login required",
        guidance: "Run codex login in a terminal, then test the connection again.",
        color: "#d97706",
      };
    case "network_failure":
      return {
        label: "Network failure",
        guidance: "Check your network connection, then test Codex Local again.",
        color: "#c62828",
      };
    case "command_failure":
      return {
        label: "Command failed",
        guidance: "Review the command path and sanitized message, then test again.",
        color: "#c62828",
      };
    case "not_checked":
      return {
        label: "Not checked",
        guidance: "Detect Codex CLI or save mock provider settings.",
        color: "#777",
      };
  }
}

function catalogStatusNote(
  catalogBusy: boolean,
  modelCatalog: CodexModelCatalogResult | null,
): string {
  if (catalogBusy) {
    return "Loading models from Codex CLI...";
  }
  // Only friendly copy is shown here — raw Codex CLI output is never surfaced.
  if (!modelCatalog || modelCatalog.status.state === "unavailable") {
    return "Model catalog unavailable. Enter a model manually or leave blank for the Codex CLI default.";
  }
  if (modelCatalog.status.state === "empty") {
    return "No selectable models were found. Enter a model manually or leave blank for the Codex CLI default.";
  }
  const count = modelCatalog.models.length;
  return `${count} model${count === 1 ? "" : "s"} available from Codex CLI.`;
}

function redactCredentialMaterial(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/\bcookie=[^\s;]+;?/gi, "cookie=[redacted]")
    .replace(/--(?:api-key|token|access-token)\s+\S+/gi, (match) => {
      const [flag] = match.split(/\s+/, 1);
      return `${flag} [redacted]`;
    });
}
