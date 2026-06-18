## Context

Codex Local provider setup can detect a Codex CLI command and test a connection, but model selection is currently a free-form text field with a stale default label. Recent local testing showed the saved label `gpt-5-codex-subscription` can fail even though `codex exec` succeeds when no model is forced. The local Codex CLI exposes a model catalog through `codex debug models`, which provides enough information to offer a safer model picker without asking the dashboard to know Codex internals.

The dashboard must stay behind the backend boundary. Raw Codex CLI output can contain prompt metadata and internal fields, so the backend must sanitize catalog results before returning them.

## Goals / Non-Goals

**Goals:**
- Discover selectable Codex Local model slugs from the configured Codex CLI command.
- Expose only sanitized model catalog fields to the dashboard.
- Let users choose a catalog model from provider setup and save the selected slug.
- Preserve manual entry and Codex CLI default-model fallback when catalog discovery fails.
- Avoid passing stale known-bad defaults such as `gpt-5-codex-subscription` to `codex exec`.

**Non-Goals:**
- Proving account entitlement for every catalog model before save.
- Managing OpenAI API models outside the Codex CLI provider path.
- Adding pricing, token accounting, or model cost comparison.
- Building multi-provider model registries beyond the local Codex CLI catalog.

## Decisions

1. Add a backend catalog service that runs `codex debug models`.

   The service will use the saved Codex command path when available and otherwise the same detection path used by provider setup. It will parse JSON and return entries with `slug`, `displayName`, `description`, `priority`, and optional reasoning metadata if it is simple and safe. It will filter to visible list entries and omit raw catalog fields such as base instructions, prompt metadata, hidden entries, upgrade payloads, or availability copy.

   Alternative considered: hard-code known model slugs in the dashboard. That would be simpler but would age quickly and repeat the stale default problem.

2. Add `GET /api/provider-settings/models`.

   Keeping the endpoint under provider settings matches the current setup flow and avoids adding a broader model registry abstraction. The endpoint returns a stable shape such as `{ models, defaultModelSlug, source, status }`, where `defaultModelSlug` is the highest-priority visible model when available.

   Alternative considered: combine model catalog lookup with Detect. Keeping it separate lets the dashboard refresh models independently and keeps CLI path detection status distinct from catalog availability.

3. Use a catalog-backed picker with manual fallback.

   Provider setup will load the catalog when Codex Local is selected or after detection succeeds. When models are available, the UI shows a select control ordered by priority. It also keeps manual entry available for unlisted or experimental slugs. If catalog lookup fails, the UI remains usable with manual entry and can save an empty model label to mean "Codex CLI default".

   Alternative considered: require catalog lookup before save. That would block valid local setups when `debug models` changes, is unavailable, or returns transient errors.

4. Treat blank model selection as "use Codex CLI default".

   The wrapper will pass `--model <slug>` only when a non-empty selected model is saved and the value is not a known legacy default. This makes the product resilient when account access differs from raw catalog entries or when Codex CLI has a better default than the app.

   Alternative considered: always save the first catalog model. That gives deterministic metadata but can fail for accounts where the catalog and entitlement differ.

## Risks / Trade-offs

- Catalog output shape changes -> Parse defensively and return a sanitized failure state instead of crashing.
- Catalog contains models unavailable to the signed-in account -> Connection test remains the source of truth for whether a selected model works.
- Hidden or internal models leak to dashboard -> Filter `visibility` to list/public-style entries and map only allowlisted fields.
- Empty model labels reduce run metadata detail -> Record the saved label when present and otherwise record a default/auto marker while letting Codex CLI decide.
- Running `codex debug models` may be slow -> Use it on demand from provider setup, not on every dashboard render or goal start.

## Migration Plan

Existing saved Codex Local settings may contain `gpt-5-codex-subscription`. The implementation should keep reading that value but avoid passing it as `--model`, and the dashboard should encourage replacing it with a catalog model or blank default. No SQLite schema migration is required if `modelLabel` remains a nullable/string setting, but persistence tests should cover blank/default semantics if the domain representation changes.

Rollback is straightforward: remove the model endpoint and picker while leaving saved settings unchanged. The wrapper default-model behavior should remain because it fixes a real connection failure mode.

## Open Questions

- Should the UI store an empty model label explicitly as "Codex default", or normalize it to a display label such as `codex-default` while omitting `--model` at execution time?
- Should reasoning levels from the catalog be exposed now, or deferred until model selection is stable?
