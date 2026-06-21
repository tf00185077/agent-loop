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

/**
 * Sanitized Codex Local catalog model entry. Only safe display fields are
 * exposed to the dashboard; raw catalog metadata (base instructions, prompts,
 * upgrade payloads, credentials) is never included.
 */
export interface CodexModelCatalogEntry {
  slug: string;
  displayName: string;
  description: string | null;
  priority: number;
}

export type CodexModelCatalogStatusState = "available" | "empty" | "unavailable";

export interface CodexModelCatalogStatus {
  state: CodexModelCatalogStatusState;
  checkedAt: string | null;
  message: string | null;
  /**
   * Raw Codex CLI output or error captured on a failed lookup. Surfaced to the
   * dashboard for debugging; intentionally not sanitized of non-credential
   * catalog metadata. Null on success.
   */
  detail?: string | null;
}

/**
 * Sanitized result of a Codex Local model catalog lookup. `defaultModelSlug`
 * is the highest-priority visible model when available, or null to indicate
 * "use Codex CLI default". `source` records how the Codex command path was
 * resolved for the lookup.
 */
export interface CodexModelCatalogResult {
  models: CodexModelCatalogEntry[];
  defaultModelSlug: string | null;
  source: CodexModelCatalogSource;
  status: CodexModelCatalogStatus;
}

export type CodexModelCatalogSource = "manual" | "path" | "common" | "none";

/**
 * Legacy model label that must not be forced as a Codex CLI `--model` argument.
 * Existing saved settings may still contain it; treat it as "use Codex CLI
 * default" at execution time.
 */
export const LEGACY_CODEX_MODEL_LABEL = "gpt-5-codex-subscription";

/**
 * Returns the model slug to pass as `--model`, or null when Codex CLI should
 * use its own default model. A blank label or the legacy unsupported default
 * yields null.
 */
export function resolveCodexModelArgument(modelLabel: string | null | undefined): string | null {
  const trimmed = modelLabel?.trim();
  if (!trimmed) return null;
  if (trimmed === LEGACY_CODEX_MODEL_LABEL) return null;
  return trimmed;
}

/**
 * Marker recorded in run metadata when no model label is saved and Codex CLI
 * picks its own default model. Keeps run metadata understandable instead of
 * showing an empty model value.
 */
export const CODEX_DEFAULT_MODEL_LABEL = "codex-default";

/**
 * Returns a human-understandable model label for run metadata: the saved label
 * when present, otherwise the Codex CLI default marker. This is display-only
 * and never used to build a `--model` argument.
 */
export function describeCodexModelLabel(modelLabel: string | null | undefined): string {
  const trimmed = modelLabel?.trim();
  return trimmed ? trimmed : CODEX_DEFAULT_MODEL_LABEL;
}

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
