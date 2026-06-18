import React, { useEffect, useState } from "react";
import {
  detectCodexCli,
  getProviderSettings,
  saveProviderSettings,
  testCodexLocalConnection,
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
  onProviderChange: (provider: LocalProvider) => void;
  onModelLabelChange: (value: string) => void;
  onCodexCommandPathChange: (value: string) => void;
  onSave: () => void;
  onDetect: () => void;
  onTestConnection: () => void;
}

export default function ProviderSetup() {
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [draftProvider, setDraftProvider] = useState<LocalProvider>("mock");
  const [modelLabel, setModelLabel] = useState("gpt-5-codex-subscription");
  const [codexCommandPath, setCodexCommandPath] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProviderSettings()
      .then((nextSettings) => {
        if (cancelled) return;
        applySettings(nextSettings);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
              provider: "codex-local",
              modelLabel: modelLabel.trim() || "gpt-5-codex-subscription",
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
      onProviderChange={setDraftProvider}
      onModelLabelChange={setModelLabel}
      onCodexCommandPathChange={setCodexCommandPath}
      onSave={handleSave}
      onDetect={handleDetect}
      onTestConnection={handleTestConnection}
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
    onProviderChange,
    onModelLabelChange,
    onCodexCommandPathChange,
    onSave,
    onDetect,
    onTestConnection,
  } = props;
  const codexSelected = draftProvider === "codex-local";
  const statusView = providerStatusView(settings.status.state);

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
          <label style={labelStyle}>
            Model label
            <input
              value={modelLabel}
              onChange={(event) => onModelLabelChange(event.target.value)}
              style={inputStyle}
            />
          </label>
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
