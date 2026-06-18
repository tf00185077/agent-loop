export type LocalProviderKind = "mock" | "codex-local";

export type ProviderConnectionState =
  | "not_checked"
  | "detected"
  | "not_found"
  | "connected"
  | "login_required"
  | "network_failure"
  | "command_failure";

export interface ProviderStatus {
  state: ProviderConnectionState;
  detected: boolean;
  checkedAt: string | null;
  message: string | null;
}

export interface MockProviderSettings {
  provider: "mock";
  modelLabel: "mock-v1";
  codexCommandPath: null;
  status: ProviderStatus;
}

export interface CodexLocalProviderSettings {
  provider: "codex-local";
  modelLabel: string;
  codexCommandPath: string | null;
  status: ProviderStatus;
}

export type ProviderSettings = MockProviderSettings | CodexLocalProviderSettings;

export const defaultProviderStatus: ProviderStatus = {
  state: "not_checked",
  detected: false,
  checkedAt: null,
  message: null,
};

export function createDefaultProviderSettings(): MockProviderSettings {
  return {
    provider: "mock",
    modelLabel: "mock-v1",
    codexCommandPath: null,
    status: { ...defaultProviderStatus },
  };
}

export function sanitizeProviderStatus(status: ProviderStatus): ProviderStatus {
  return {
    ...status,
    message: status.message ? redactCredentialMaterial(status.message) : null,
  };
}

function redactCredentialMaterial(value: string): string {
  return value
    .replace(/"(?:access_token|refresh_token|id_token|api_key)"\s*:\s*"[^"]*"/gi, (match) => {
      const [key] = match.split(":", 1);
      return `${key}:"[redacted]"`;
    })
    .replace(/\b(?:OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN)=[^\s;]+/gi, (match) => {
      const [key] = match.split("=", 1);
      return `${key}=[redacted]`;
    })
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/\bcookie=[^\s;]+;?/gi, "cookie=[redacted]")
    .replace(/--(?:api-key|token|access-token)\s+\S+/gi, (match) => {
      const [flag] = match.split(/\s+/, 1);
      return `${flag} [redacted]`;
    });
}
