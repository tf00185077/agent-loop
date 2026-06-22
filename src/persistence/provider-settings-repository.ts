import type {
  ProviderConnectionState,
  ProviderSettings,
  ProviderStatus,
} from "../domain/index.js";
import {
  createDefaultProviderSettings,
  sanitizeProviderCommandPath,
  sanitizeProviderStatus,
} from "../domain/index.js";
import type { AppDatabase } from "./database.js";

const providerSettingsId = "local";

export interface ProviderSettingsRepository {
  get(): ProviderSettings;
  hasSaved(): boolean;
  save(settings: ProviderSettings): ProviderSettings;
}

export function createProviderSettingsRepository(db: AppDatabase): ProviderSettingsRepository {
  return {
    get() {
      const row = db.prepare("SELECT * FROM provider_settings WHERE id = ?").get(providerSettingsId);
      return row ? mapProviderSettingsRow(row) : createDefaultProviderSettings();
    },

    hasSaved() {
      const row = db
        .prepare("SELECT 1 FROM provider_settings WHERE id = ?")
        .get(providerSettingsId);
      return Boolean(row);
    },

    save(settings) {
      const safeSettings = sanitizeProviderSettings(settings);

      db.prepare(`
        INSERT INTO provider_settings (
          id,
          provider,
          model_label,
          codex_command_path,
          claude_command_path,
          status_state,
          status_detected,
          status_checked_at,
          status_message,
          updated_at
        )
        VALUES (
          @id,
          @provider,
          @modelLabel,
          @codexCommandPath,
          @claudeCommandPath,
          @statusState,
          @statusDetected,
          @statusCheckedAt,
          @statusMessage,
          @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          model_label = excluded.model_label,
          codex_command_path = excluded.codex_command_path,
          claude_command_path = excluded.claude_command_path,
          status_state = excluded.status_state,
          status_detected = excluded.status_detected,
          status_checked_at = excluded.status_checked_at,
          status_message = excluded.status_message,
          updated_at = excluded.updated_at
      `).run(toProviderSettingsParams(safeSettings));

      return this.get();
    },
  };
}

function sanitizeProviderSettings(settings: ProviderSettings): ProviderSettings {
  if (settings.provider === "codex-local") {
    return {
      ...settings,
      codexCommandPath: sanitizeProviderCommandPath(settings.codexCommandPath),
      status: sanitizeProviderStatus(settings.status),
    };
  }

  if (settings.provider === "claude-local") {
    return {
      ...settings,
      claudeCommandPath: sanitizeProviderCommandPath(settings.claudeCommandPath),
      status: sanitizeProviderStatus(settings.status),
    };
  }

  return {
    ...settings,
    codexCommandPath: null,
    status: sanitizeProviderStatus(settings.status),
  };
}

function toProviderSettingsParams(settings: ProviderSettings) {
  return {
    id: providerSettingsId,
    provider: settings.provider,
    modelLabel: settings.modelLabel,
    codexCommandPath: settings.provider === "codex-local" ? settings.codexCommandPath : null,
    claudeCommandPath: settings.provider === "claude-local" ? settings.claudeCommandPath : null,
    statusState: settings.status.state,
    statusDetected: settings.status.detected ? 1 : 0,
    statusCheckedAt: settings.status.checkedAt,
    statusMessage: settings.status.message,
    updatedAt: new Date().toISOString(),
  };
}

function mapProviderSettingsRow(row: unknown): ProviderSettings {
  const value = row as Record<string, string | number | null>;
  const status: ProviderStatus = {
    state: value.status_state as ProviderConnectionState,
    detected: value.status_detected === 1,
    checkedAt: value.status_checked_at as string | null,
    message: value.status_message as string | null,
  };

  if (value.provider === "codex-local") {
    return {
      provider: "codex-local",
      modelLabel: value.model_label as string,
      codexCommandPath: value.codex_command_path as string | null,
      status,
    };
  }

  if (value.provider === "claude-local") {
    return {
      provider: "claude-local",
      modelLabel: value.model_label as string,
      claudeCommandPath: value.claude_command_path as string | null,
      status,
    };
  }

  return {
    provider: "mock",
    modelLabel: "mock-v1",
    codexCommandPath: null,
    status,
  };
}
