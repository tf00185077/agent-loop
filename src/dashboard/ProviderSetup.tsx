import React, { useEffect, useState } from "react";
import {
  detectCodexCli,
  getProviderSettings,
  loadCodexModelCatalog,
  saveProviderSettings,
  testCodexLocalConnection,
  type CodexLocalConnectionTestResult,
  type CodexModelCatalogResult,
  type ProviderSettings,
  type SaveProviderSettingsInput,
  type StartGoalProviderOverride,
} from "./api";

type LocalProvider = ProviderSettings["provider"];
type BusyAction = "save" | "auto-test" | "detect" | "test" | null;

interface ProviderSetupPanelProps {
  settings: ProviderSettings;
  draftProvider: LocalProvider;
  modelLabel: string;
  codexCommandPath: string;
  claudeCommandPath: string;
  busy: BusyAction;
  error: string | null;
  modelCatalog: CodexModelCatalogResult | null;
  catalogBusy: boolean;
  onProviderChange: (provider: LocalProvider) => void;
  onModelLabelChange: (value: string) => void;
  onCodexCommandPathChange: (value: string) => void;
  onClaudeCommandPathChange: (value: string) => void;
  onSave: () => void;
  onDetect: () => void;
  onTestConnection: () => void;
  onReloadCatalog: () => void;
}

interface ProviderSetupProps {
  onProviderOverrideChange?: (override: StartGoalProviderOverride) => void;
}

export default function ProviderSetup({ onProviderOverrideChange }: ProviderSetupProps = {}) {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [draftProvider, setDraftProvider] = useState<LocalProvider>("mock");
  const [modelLabel, setModelLabel] = useState("gpt-5-codex-subscription");
  const [codexCommandPath, setCodexCommandPath] = useState("");
  const [claudeCommandPath, setClaudeCommandPath] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<CodexModelCatalogResult | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);

  useEffect(() => {
    onProviderOverrideChange?.(
      toStartGoalProviderOverride({
        draftProvider,
        modelLabel,
        codexCommandPath,
        claudeCommandPath,
      }),
    );
  }, [draftProvider, modelLabel, codexCommandPath, claudeCommandPath, onProviderOverrideChange]);

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
    } catch (err) {
      // Surface the failure instead of silently falling back to manual entry.
      setModelCatalog({
        models: [],
        defaultModelSlug: null,
        source: "none",
        status: {
          state: "unavailable",
          checkedAt: new Date().toISOString(),
          message: "Could not reach the model catalog endpoint.",
          detail: String(err),
        },
      });
    } finally {
      setCatalogBusy(false);
    }
  }

  function handleProviderChange(provider: LocalProvider) {
    setDraftProvider(provider);
    // Reset the model label so a previous provider's label (e.g. mock-v1) does
    // not carry across. Restore the saved label when switching back to the
    // currently-saved provider; otherwise fall back to that provider's default.
    if (settings && settings.provider === provider) {
      setModelLabel(settings.modelLabel);
    } else {
      setModelLabel(provider === "mock" ? "mock-v1" : "");
    }
    if (provider === "codex-local" && !modelCatalog && !catalogBusy) {
      void refreshCatalog();
    }
  }

  function applySettings(nextSettings: ProviderSettings) {
    setSettings(nextSettings);
    setDraftProvider(nextSettings.provider);
    setModelLabel(nextSettings.modelLabel);
    setCodexCommandPath(
      nextSettings.provider === "codex-local" ? nextSettings.codexCommandPath ?? "" : "",
    );
    setClaudeCommandPath(
      nextSettings.provider === "claude-local" ? nextSettings.claudeCommandPath ?? "" : "",
    );
  }

  async function handleSave() {
    setBusy("save");
    setError(null);
    try {
      await saveProviderSettingsWithOptionalCodexTest(toSaveProviderSettingsInput({
        draftProvider,
        modelLabel,
        codexCommandPath,
        claudeCommandPath,
      }), {
        save: saveProviderSettings,
        testConnection: testCodexLocalConnection,
        onSaved: applySettings,
        onBeforeTest: () => setBusy("auto-test"),
      });
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
      const detected = await detectCodexCli(toDetectProviderInput({
        draftProvider,
        codexCommandPath,
        claudeCommandPath,
      }));
      if (draftProvider === "claude-local") {
        setClaudeCommandPath(detected.commandPath ?? claudeCommandPath);
      } else if (draftProvider === "codex-local") {
        setCodexCommandPath(detected.commandPath ?? codexCommandPath);
        await refreshCatalog();
      }
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
      claudeCommandPath={claudeCommandPath}
      busy={busy}
      error={error}
      modelCatalog={modelCatalog}
      catalogBusy={catalogBusy}
      onProviderChange={handleProviderChange}
      onModelLabelChange={setModelLabel}
      onCodexCommandPathChange={setCodexCommandPath}
      onClaudeCommandPathChange={setClaudeCommandPath}
      onSave={handleSave}
      onDetect={handleDetect}
      onTestConnection={handleTestConnection}
      onReloadCatalog={() => void refreshCatalog()}
    />
  );
}

interface SaveProviderSettingsDraft {
  draftProvider: LocalProvider;
  modelLabel: string;
  codexCommandPath: string;
  claudeCommandPath: string;
}

export function toStartGoalProviderOverride(
  draft: SaveProviderSettingsDraft,
): StartGoalProviderOverride {
  if (draft.draftProvider === "mock") return { provider: "mock" };

  if (draft.draftProvider === "claude-local") {
    return {
      provider: "claude-local",
      modelLabel: draft.modelLabel.trim(),
      claudeCommandPath: draft.claudeCommandPath.trim() || null,
    };
  }

  return {
    provider: "codex-local",
    modelLabel: draft.modelLabel.trim(),
    codexCommandPath: draft.codexCommandPath.trim() || null,
  };
}

function toDetectProviderInput(
  draft: Pick<SaveProviderSettingsDraft, "draftProvider" | "codexCommandPath" | "claudeCommandPath">,
) {
  if (draft.draftProvider === "claude-local") {
    return {
      provider: "claude-local" as const,
      claudeCommandPath: draft.claudeCommandPath.trim() || null,
    };
  }

  return {
    provider: "codex-local" as const,
    codexCommandPath: draft.codexCommandPath.trim() || null,
  };
}

function toSaveProviderSettingsInput(draft: SaveProviderSettingsDraft): SaveProviderSettingsInput {
  if (draft.draftProvider === "mock") return { provider: "mock" };

  if (draft.draftProvider === "claude-local") {
    return {
      // A blank model label means "Claude CLI default".
      provider: "claude-local",
      modelLabel: draft.modelLabel.trim(),
      claudeCommandPath: draft.claudeCommandPath.trim() || null,
    };
  }

  return {
    // A blank model label is saved as "" and means "Codex CLI default";
    // we no longer fall back to the stale gpt-5-codex-subscription label.
    provider: "codex-local",
    modelLabel: draft.modelLabel.trim(),
    codexCommandPath: draft.codexCommandPath.trim() || null,
  };
}

interface SaveProviderSettingsWithOptionalCodexTestDeps {
  save: (input: SaveProviderSettingsInput) => Promise<ProviderSettings>;
  testConnection: () => Promise<CodexLocalConnectionTestResult>;
  onSaved?: (settings: ProviderSettings) => void;
  onBeforeTest?: () => void;
}

export async function saveProviderSettingsWithOptionalCodexTest(
  input: SaveProviderSettingsInput,
  deps: SaveProviderSettingsWithOptionalCodexTestDeps,
): Promise<ProviderSettings> {
  const saved = await deps.save(input);
  deps.onSaved?.(saved);

  if (saved.provider === "codex-local" && saved.codexCommandPath) {
    deps.onBeforeTest?.();
    const tested = await deps.testConnection();
    const testedSettings = { ...saved, status: tested.status };
    deps.onSaved?.(testedSettings);
    return testedSettings;
  }

  return saved;
}

export function ProviderSetupPanel(props: ProviderSetupPanelProps) {
  const {
    settings,
    draftProvider,
    modelLabel,
    codexCommandPath,
    claudeCommandPath,
    busy,
    error,
    modelCatalog,
    catalogBusy,
    onProviderChange,
    onModelLabelChange,
    onCodexCommandPathChange,
    onClaudeCommandPathChange,
    onSave,
    onDetect,
    onTestConnection,
    onReloadCatalog,
  } = props;
  const codexSelected = draftProvider === "codex-local";
  const claudeSelected = draftProvider === "claude-local";
  const statusView = providerStatusView(settings.status.state, draftProvider);
  const catalogModels = modelCatalog?.models ?? [];
  const catalogSlugs = new Set(catalogModels.map((model) => model.slug));
  const trimmedModel = modelLabel.trim();
  const savedUnlistedModel =
    trimmedModel !== "" && !catalogSlugs.has(trimmedModel) ? trimmedModel : null;
  // Catalog lookup state. On failure we surface the error (including raw CLI
  // output) instead of silently falling back to manual entry; only a
  // successful catalog with models renders the picker.
  const catalogFailed = !catalogBusy && (!modelCatalog || modelCatalog.status.state === "unavailable");
  const catalogEmpty = !catalogBusy && modelCatalog?.status.state === "empty";

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

      {busy === "auto-test" && (
        <div style={autoTestNoticeStyle}>Testing saved model connection...</div>
      )}

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
        <button
          type="button"
          onClick={() => onProviderChange("claude-local")}
          style={segmentStyle(claudeSelected)}
        >
          Claude Local
        </button>
      </div>

      {claudeSelected && (
        <div style={{ marginTop: 14 }}>
          <label style={labelStyle}>
            Model
            <input
              value={modelLabel}
              onChange={(event) => onModelLabelChange(event.target.value)}
              placeholder="Claude CLI default"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Command path
            <input
              value={claudeCommandPath}
              onChange={(event) => onClaudeCommandPathChange(event.target.value)}
              style={inputStyle}
            />
          </label>
          <div style={actionRowStyle}>
            <button type="button" onClick={onDetect} disabled={busy !== null} style={buttonStyle}>
              {busy === "detect" ? "Detecting..." : "Detect"}
            </button>
          </div>
        </div>
      )}

      {codexSelected && (
        <div style={{ marginTop: 14 }}>
          <div style={labelRowStyle}>
            <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Model</span>
            <button
              type="button"
              onClick={onReloadCatalog}
              disabled={busy !== null || catalogBusy}
              style={buttonStyle}
            >
              {catalogBusy ? "Loading..." : "Refresh models"}
            </button>
          </div>

          {catalogBusy && <div style={catalogNoteStyle}>Loading models from Codex CLI...</div>}

          {catalogFailed && (
            <div style={catalogErrorStyle}>
              <strong>Model catalog lookup failed</strong>
              <div style={{ marginTop: 4 }}>
                {modelCatalog?.status.message ?? "Could not load the Codex CLI model catalog."}
              </div>
              {modelCatalog?.status.detail && (
                <pre style={catalogDetailStyle}>{modelCatalog.status.detail}</pre>
              )}
              <div style={{ marginTop: 6 }}>
                Fix the Codex command path or run Detect, then Refresh models.
              </div>
            </div>
          )}

          {catalogEmpty && (
            <div style={catalogNoteStyle}>
              No selectable models were returned by Codex CLI. Run Detect or Refresh models.
            </div>
          )}

          {!catalogBusy && !catalogFailed && !catalogEmpty && (
            <>
              <label style={labelStyle}>
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
              </label>
              <div style={catalogNoteStyle}>
                {catalogModels.length} model{catalogModels.length === 1 ? "" : "s"} available from Codex
                CLI.
              </div>
            </>
          )}

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

      {(codexSelected || claudeSelected) && (
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

const autoTestNoticeStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "8px 10px",
  background: "#eef6ff",
  borderLeft: "3px solid #1976d2",
  color: "#24415f",
  fontSize: 13,
};

const catalogNoteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#777",
  marginBottom: 12,
};

const catalogErrorStyle: React.CSSProperties = {
  borderLeft: "3px solid #c62828",
  background: "#fdf2f2",
  padding: "10px 12px",
  marginBottom: 12,
  fontSize: 13,
  color: "#7a1f1f",
};

const catalogDetailStyle: React.CSSProperties = {
  marginTop: 6,
  marginBottom: 0,
  padding: "8px 10px",
  background: "#1e1e1e",
  color: "#f5f5f5",
  fontSize: 12,
  borderRadius: 4,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
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

function providerStatusView(
  state: ProviderSettings["status"]["state"],
  provider: LocalProvider,
) {
  const cli = provider === "claude-local" ? "Claude" : "Codex";
  const localLabel = provider === "claude-local" ? "Claude Local" : "Codex Local";
  const loginCmd = provider === "claude-local" ? "claude login" : "codex login";
  switch (state) {
    case "detected":
      return {
        label: `${cli} CLI detected`,
        guidance: "Save this path before starting provider-backed goals.",
        color: "#1976d2",
      };
    case "not_found":
      return {
        label: `${cli} CLI not found`,
        guidance: `Enter a ${cli} command path manually or install ${cli} CLI, then detect again.`,
        color: "#d97706",
      };
    case "connected":
      return {
        label: `${localLabel} connected`,
        guidance: "This provider is ready for new goals.",
        color: "#2e7d32",
      };
    case "login_required":
      return {
        label: `${cli} login required`,
        guidance: `Run ${loginCmd} in a terminal, then test the connection again.`,
        color: "#d97706",
      };
    case "network_failure":
      return {
        label: "Network failure",
        guidance: `Check your network connection, then test ${localLabel} again.`,
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
        guidance: `Detect ${cli} CLI or save mock provider settings.`,
        color: "#777",
      };
  }
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
