## Purpose

Define the backend-only model provider integration boundary for provider-backed runtime smoke execution, including OpenAI-compatible adapters, Codex direct-spawn execution, durable lifecycle events, failure handling, and dashboard credential isolation.
## Requirements
### Requirement: Backend provider contract
The system SHALL define a backend-only model provider contract that runtime code can call without depending on provider-specific HTTP or process details. The contract SHALL carry an opaque, provider-owned conversation-state value that the runtime passes through unchanged: a provider MAY return a conversation-state value in its output, and the runtime MAY supply a previously returned value on a later call so a provider can continue a session. The runtime MUST NOT interpret the conversation-state value.

#### Scenario: Runtime uses fake provider
- **WHEN** a runtime test injects a fake provider that returns response text
- **THEN** the runtime completes without importing or constructing a provider-specific adapter

#### Scenario: Runtime passes conversation state through unchanged
- **WHEN** a provider returns a conversation-state value and the runtime later calls the same provider with that value supplied as input
- **THEN** the runtime forwards the exact value to the provider without inspecting or modifying it

#### Scenario: Conversation state is optional
- **WHEN** a provider returns no conversation-state value
- **THEN** the runtime completes the call and does not require a conversation-state value on subsequent calls

### Requirement: OpenAI-compatible adapter
The system SHALL support an OpenAI-compatible chat completions provider adapter configured from backend environment values.

#### Scenario: Adapter sends chat completions request
- **WHEN** the adapter is called with goal context and provider configuration
- **THEN** it sends a `POST` request to the configured `/chat/completions` endpoint with the configured model and backend authorization header

#### Scenario: Adapter extracts response text
- **WHEN** the configured endpoint returns a valid chat completions response with assistant content
- **THEN** the adapter returns the assistant text to the runtime

### Requirement: Codex direct-spawn provider
The system SHALL support a backend Codex provider that spawns the Codex CLI directly, without a generic wrapper process, using the user's locally authenticated Codex access. The provider SHALL own Codex-specific invocation details (running `codex exec`, selecting the model argument from the saved model label, and reading the Codex last-message output) behind the backend provider contract.

#### Scenario: Backend spawns Codex CLI directly
- **WHEN** the backend is configured for the Codex Local provider and a goal is started
- **THEN** the provider invokes the detected Codex command with `codex exec` and the goal prompt and records the Codex response through the provider contract
- **AND** no intermediate wrapper script process is spawned

#### Scenario: Model label selects the Codex model argument
- **WHEN** the saved model label is a concrete model and a goal is started
- **THEN** the provider passes that model to Codex as the model argument
- **AND** when the label is blank or a default/placeholder label, the provider omits the model argument and lets Codex choose its default

#### Scenario: Codex provider does not expose subscription secrets
- **WHEN** the Codex direct-spawn provider is used
- **THEN** dashboard API responses and durable event data do not include Codex authentication tokens, session material, or subscription credential material

#### Scenario: Missing Codex configuration fails visibly
- **WHEN** the backend is configured for the Codex Local provider without a usable command path
- **THEN** starting a goal records an `error` event and the goal reaches failed status rather than remaining running indefinitely

### Requirement: Saved Codex command path is self-healing
The system SHALL verify the saved Codex command path before using it and SHALL re-run Codex CLI detection when the saved path no longer resolves, persisting the newly detected path rather than spawning a stale path.

#### Scenario: Stale saved path is re-detected
- **WHEN** the saved Codex command path no longer exists or can no longer execute Codex and Codex CLI is detectable elsewhere
- **THEN** the backend re-detects the Codex command, updates the saved settings to the newly detected path, and uses the detected path for execution

#### Scenario: Valid saved path is used without re-detection
- **WHEN** the saved Codex command path still resolves and can execute Codex
- **THEN** the backend uses the saved path without overwriting it

#### Scenario: No path can be resolved fails visibly
- **WHEN** the saved Codex command path no longer resolves and no Codex CLI can be detected
- **THEN** starting a goal records an `error` event and the goal reaches failed status, and provider status reports a command-not-found condition without marking the app as connected

### Requirement: Provider-backed runtime completes a smoke step
The system SHALL support a provider-backed runtime path that calls the configured provider once and persists the result as durable lifecycle events.

#### Scenario: Provider-backed goal completes
- **WHEN** a draft goal is started while the backend is configured for a real provider path
- **THEN** the system creates a run, creates one provider-backed step, records an `agent.message` event containing provider response text, marks the step completed, marks the run completed, and marks the goal completed

#### Scenario: Timeline identifies provider metadata
- **WHEN** the provider-backed runtime records run or message events
- **THEN** the event data includes enough provider and model metadata to distinguish the provider-backed path from the mock path

### Requirement: Provider failures are durable
The system SHALL convert provider configuration errors, provider HTTP errors, and malformed provider responses into durable failed runtime state.

#### Scenario: Provider call fails
- **WHEN** the provider-backed runtime cannot obtain valid response text from the provider
- **THEN** it records an `error` event, marks the run failed, and marks the goal failed

#### Scenario: Missing provider configuration fails visibly
- **WHEN** the backend is configured for a real provider path without required provider configuration
- **THEN** starting a goal records an `error` event and the goal reaches failed status rather than remaining running indefinitely

### Requirement: CLI provider output can produce durable progress events
The system SHALL capture safe, meaningful stdout or stderr chunks from local CLI-backed provider processes and persist them as runtime progress events when such chunks are available.

#### Scenario: Provider emits streamable output
- **WHEN** a local CLI-backed provider emits a non-empty progress chunk while a goal run is active
- **THEN** the backend sanitizes the chunk, persists it as a durable event for that goal/run, and makes it available to the live event stream

#### Scenario: Provider emits no streamable output
- **WHEN** a local CLI-backed provider does not expose useful process output before completion
- **THEN** the backend still records normal lifecycle and final result or error events
- **AND** the provider run does not fail solely because no progress chunks were emitted

### Requirement: Process output streaming is credential-safe
The system SHALL sanitize provider process output before storing or streaming it to the dashboard.

#### Scenario: Process output includes credential-like material
- **WHEN** provider process output contains command secret arguments, access tokens, cookies, API keys, authorization headers, or auth cache material
- **THEN** the persisted event and streamed event contain only redacted safe text

### Requirement: Provider final result behavior is preserved
The system SHALL preserve existing provider-backed final response and error semantics while adding live progress events.

#### Scenario: Provider completes after progress chunks
- **WHEN** a provider emits progress chunks and then returns a final response
- **THEN** the timeline contains progress events before the final provider result event
- **AND** the run and goal reach the same terminal state they would have reached without progress streaming

### Requirement: Dashboard remains provider-agnostic
The system SHALL keep provider credentials and provider execution behind the backend boundary.

#### Scenario: Dashboard starts provider-backed run through existing API
- **WHEN** a dashboard user starts a goal
- **THEN** the dashboard still calls only the existing backend start endpoint and reads the resulting events through the existing event timeline endpoint

#### Scenario: Dashboard never receives provider secrets
- **WHEN** the backend is configured with provider credentials
- **THEN** dashboard API responses do not include API keys, authorization headers, or provider secret values

### Requirement: Provider settings are persisted locally
The system SHALL persist the selected local provider settings so a user can restart the app and start provider-backed goals without re-entering terminal environment variables.

#### Scenario: Default provider settings are mock
- **WHEN** no provider settings have been saved
- **THEN** the backend reports `mock` as the selected provider
- **AND** starting a goal uses the mock provider path

#### Scenario: Codex Local provider settings are saved
- **WHEN** the dashboard saves Codex Local provider settings with a model label and Codex command path
- **THEN** the backend persists those non-sensitive settings in local storage
- **AND** subsequent provider status requests return the selected provider and model label

#### Scenario: Provider settings survive restart
- **WHEN** Codex Local provider settings have been saved and the backend process restarts using the same SQLite database
- **THEN** the backend continues to report Codex Local as the selected provider

### Requirement: Codex CLI command can be detected and overridden
The system SHALL help the user resolve a Codex CLI command path for the Codex Local provider without hard-coding a single operating-system-specific path.

#### Scenario: Codex CLI is available on PATH
- **WHEN** the backend checks for Codex CLI and `codex` is available on the process PATH
- **THEN** the provider status reports Codex CLI as detected
- **AND** the detected command can be used for Codex Local connection testing

#### Scenario: Codex CLI requires manual path
- **WHEN** the backend cannot find Codex CLI automatically
- **THEN** the dashboard allows the user to enter a manual command path
- **AND** saving that path makes the backend use it for Codex Local connection testing and goal execution

#### Scenario: Invalid manual path fails clearly
- **WHEN** the saved Codex command path cannot be executed
- **THEN** the provider status or connection test reports a command-not-found failure without marking the app as connected

### Requirement: Codex Local connection can be tested from the dashboard
The system SHALL provide a dashboard-triggered connection test that verifies the configured Codex Local provider can run through the backend wrapper.

#### Scenario: Codex Local connection succeeds
- **WHEN** the user tests Codex Local provider settings and the wrapper obtains a valid Codex response
- **THEN** the backend records a connected status with a last-checked timestamp
- **AND** the dashboard shows that Codex Local is ready for provider-backed goals

#### Scenario: Codex authentication is unavailable
- **WHEN** the user tests Codex Local provider settings and Codex CLI indicates authentication is missing or unusable
- **THEN** the dashboard shows guidance to complete `codex login` using Codex-managed authentication
- **AND** the system does not request, store, or display OpenAI OAuth tokens

#### Scenario: Codex connection test fails
- **WHEN** the user tests Codex Local provider settings and the command exits unsuccessfully
- **THEN** the backend returns a sanitized failure status
- **AND** the dashboard shows actionable failure guidance without exposing credential material

### Requirement: Codex Local settings are tested after save
The system SHALL automatically run the Codex Local connection test after Codex Local provider settings are saved with a command path, using the saved model label or saved Codex CLI default selection that future goal runs will use.

#### Scenario: Saved Codex Local model is auto-tested
- **WHEN** a dashboard user saves Codex Local provider settings with a command path and a selected catalog model
- **THEN** the backend persists the settings
- **AND** the dashboard triggers the backend Codex Local connection test using the saved command path and model label
- **AND** the resulting provider status is persisted and shown to the user

#### Scenario: Saved Codex CLI default is auto-tested
- **WHEN** a dashboard user saves Codex Local provider settings with a command path and no concrete model label
- **THEN** the automatic connection test omits the Codex model argument
- **AND** the result reflects whether the Codex CLI default can answer

#### Scenario: Manual retry remains available
- **WHEN** an automatic Codex Local connection test fails or times out
- **THEN** the dashboard still allows the user to run the manual Test connection action
- **AND** the backend returns only sanitized status information

### Requirement: Run metadata is displayable from durable events
The system SHALL record provider and model metadata in durable run-level or provider-message event data when a runtime path knows that metadata, so the dashboard can distinguish mock, Codex Local, Claude Local, and future provider-backed runs without accessing provider credentials.

#### Scenario: Provider-backed run exposes display metadata
- **WHEN** a provider-backed runtime records `run.started`, `agent.message`, or `error` events with known provider/model metadata
- **THEN** the event data includes non-sensitive provider and model identifiers suitable for dashboard display

#### Scenario: Mock run exposes display metadata
- **WHEN** the mock runtime records run-level events
- **THEN** the event data includes non-sensitive mock provider/model identifiers suitable for dashboard display

#### Scenario: Metadata omits credentials
- **WHEN** provider/model metadata is returned through event APIs
- **THEN** it does not include command secret arguments, access tokens, auth cache contents, cookies, API keys, or authorization headers

### Requirement: Saved provider settings drive goal starts
The system SHALL use saved provider settings when starting a goal, so Codex Local provider-backed runs do not require shell environment setup each time.

#### Scenario: Start goal with saved Codex Local settings
- **WHEN** Codex Local provider settings are saved and a dashboard user starts a draft goal
- **THEN** the backend invokes the Codex Local wrapper using the saved Codex command path and model label
- **AND** the goal timeline records provider-backed runtime events through the existing start endpoint

#### Scenario: Saved mock settings keep mock behavior
- **WHEN** mock provider settings are saved and a dashboard user starts a draft goal
- **THEN** the backend uses the mock runtime path
- **AND** no Codex Local command is invoked

### Requirement: Provider setup remains credential-safe
The system SHALL keep Codex authentication and provider credential material outside dashboard-managed persisted settings and API responses.

#### Scenario: Provider settings omit credential material
- **WHEN** provider settings are saved
- **THEN** the persisted settings do not include OpenAI access tokens, Codex auth cache contents, browser cookies, API keys, authorization headers, or command secret arguments

#### Scenario: Provider APIs omit credential material
- **WHEN** the dashboard reads provider settings, provider status, or connection test results
- **THEN** the response does not include OpenAI access tokens, Codex auth cache contents, browser cookies, API keys, authorization headers, or command secret arguments

### Requirement: Dashboard provides provider setup controls
The system SHALL provide a dashboard provider setup experience for selecting, testing, and saving the local provider configuration, including selecting between the mock, Codex Local, and Claude Local providers.

#### Scenario: User selects Codex Local provider
- **WHEN** the dashboard user selects Codex Local in provider setup
- **THEN** the dashboard shows Codex CLI detection state, model catalog loading state, model selection controls, command path controls, connection test controls, and save controls

#### Scenario: User selects a catalog model
- **WHEN** Codex CLI model catalog discovery returns selectable models
- **THEN** the dashboard allows the user to choose a model from the catalog
- **AND** saving settings persists the chosen model slug as the Codex Local model label

#### Scenario: User chooses Codex CLI default
- **WHEN** the model catalog loaded and the user does not select a specific model
- **THEN** the dashboard saves a blank model label so Codex CLI uses its own default model

#### Scenario: Model catalog lookup fails
- **WHEN** model catalog discovery fails or returns malformed output
- **THEN** the dashboard shows the failure and the raw Codex CLI output
- **AND** the dashboard does not offer a model selection or default fallback until the catalog loads

#### Scenario: User selects mock provider
- **WHEN** the dashboard user selects mock provider in provider setup
- **THEN** the dashboard can save mock as the selected provider
- **AND** the dashboard does not require Codex CLI detection, model catalog lookup, or login checks before saving

#### Scenario: User selects Claude Local provider
- **WHEN** the dashboard user selects Claude Local in provider setup
- **THEN** the dashboard shows a free-text model label input, a command path input, a Detect control, and save controls
- **AND** the dashboard shows Claude-specific detection wording rather than Codex wording
- **AND** the dashboard does not show a model catalog picker or a connection test control for Claude Local

#### Scenario: Switching provider resets the model label
- **WHEN** the dashboard user switches the selected provider segment
- **THEN** the model label is reset so the previous provider's label does not carry across
- **AND** switching back to the currently-saved provider restores its saved model label

### Requirement: Codex Local model catalog is discoverable
The system SHALL provide a backend-mediated way to discover selectable Codex Local model slugs from the configured local Codex CLI.

#### Scenario: Catalog returns selectable models
- **WHEN** Codex CLI model catalog discovery succeeds
- **THEN** the backend returns visible selectable models ordered by priority
- **AND** each model includes only safe display fields such as slug, display name, description, and priority

#### Scenario: Catalog omits unsafe raw metadata
- **WHEN** Codex CLI returns raw model catalog data
- **THEN** returned model catalog entries do not include base instructions, prompt metadata, hidden model entries, upgrade payloads, authentication material, cookies, or access tokens

#### Scenario: Catalog lookup surfaces failures
- **WHEN** Codex CLI model catalog discovery fails or returns malformed output
- **THEN** the backend returns an unavailable status whose detail includes the raw Codex CLI output or error
- **AND** provider setup surfaces the failure, including the raw output, and does not silently fall back to manual model entry or Codex CLI default behavior

### Requirement: Codex Local model selection uses safe defaults
The system SHALL avoid forcing stale or unsupported Codex Local model labels when a user has not selected a known working model.

#### Scenario: No model is selected
- **WHEN** Codex Local settings are saved without a selected model slug
- **THEN** provider-backed goal execution and connection testing do not pass a `--model` argument to Codex CLI
- **AND** Codex CLI uses its own default model

#### Scenario: Catalog model is selected
- **WHEN** Codex Local settings are saved with a selected catalog model slug
- **THEN** provider-backed goal execution and connection testing pass that slug as the Codex CLI model

#### Scenario: Legacy unsupported default is present
- **WHEN** existing saved settings contain the legacy `gpt-5-codex-subscription` model label
- **THEN** provider-backed goal execution and connection testing do not force that label as a Codex CLI model
- **AND** the dashboard allows the user to replace it with a catalog model or Codex CLI default

### Requirement: Reusable CLI command detection
The system SHALL provide a reusable CLI command detection mechanism, parameterized by candidate command names, a capability probe, and common install locations, so that each subscription-backed local CLI provider is configured rather than reimplemented. Codex detection SHALL be expressed as a configuration of this mechanism without changing its existing behavior.

#### Scenario: Detection prefers a command on PATH
- **WHEN** a configured CLI's command name is available on the process PATH and passes the configured capability probe
- **THEN** detection reports the command as detected with its resolved path

#### Scenario: Detection falls back to common install locations
- **WHEN** the configured command is not on PATH but exists at one of the configured common install locations and passes the capability probe
- **THEN** detection reports that location as the detected command path

#### Scenario: Codex detection behavior is preserved
- **WHEN** Codex detection runs through the reusable mechanism with its Codex configuration
- **THEN** it resolves the same command path it resolved before generalization, using the `codex exec --help` capability probe

### Requirement: Reusable self-healing command path resolution
The system SHALL provide reusable command-path resolution that validates a saved path for any CLI provider and re-detects when the saved path no longer resolves, persisting the newly detected path rather than using a stale one.

#### Scenario: Stale saved path is re-detected for any CLI provider
- **WHEN** a CLI provider's saved command path no longer resolves and its command is detectable elsewhere
- **THEN** resolution re-detects the command, reports the new path as changed, and offers it for persistence

#### Scenario: Valid saved path is reused
- **WHEN** a CLI provider's saved command path still resolves and passes its capability probe
- **THEN** resolution returns the saved path without marking it changed

### Requirement: Claude Code direct-spawn provider
The system SHALL support a backend Claude provider that spawns the Claude Code CLI directly, without a wrapper process, using the user's locally authenticated Claude subscription. The provider SHALL own Claude-specific invocation details (running `claude --print` in non-interactive mode, selecting the model argument from the saved model label, and reading the whole response from stdout) behind the backend provider contract.

#### Scenario: Backend spawns Claude CLI directly
- **WHEN** the backend is configured for the Claude Local provider and a goal is started
- **THEN** the provider invokes the detected Claude command in non-interactive print mode with the goal prompt and records the Claude response through the provider contract
- **AND** no intermediate wrapper script process is spawned

#### Scenario: Model label selects the Claude model argument
- **WHEN** the saved model label is a concrete model and a goal is started
- **THEN** the provider passes that model to Claude as the model argument
- **AND** when the label is blank, the provider omits the model argument and lets Claude choose its default

#### Scenario: Claude provider returns no conversation state yet
- **WHEN** the Claude provider completes a goal
- **THEN** it returns the response text and an undefined conversation-state value, deferring session continuation

#### Scenario: Claude provider does not expose subscription secrets
- **WHEN** the Claude direct-spawn provider is used
- **THEN** dashboard API responses and durable event data do not include Claude authentication tokens, session material, or subscription credential material

#### Scenario: Missing Claude configuration fails visibly
- **WHEN** the backend is configured for the Claude Local provider without a usable command path
- **THEN** starting a goal records an `error` event and the goal reaches failed status rather than remaining running indefinitely

### Requirement: Claude Local provider settings are persisted locally
The system SHALL persist the selected Claude Local provider settings so a user can restart the app and start Claude-backed goals without re-entering terminal configuration.

#### Scenario: Claude Local provider settings are saved
- **WHEN** the dashboard saves Claude Local provider settings with a model label and Claude command path
- **THEN** the backend persists those non-sensitive settings in local storage
- **AND** subsequent provider status requests return Claude Local as the selected provider and its model label

#### Scenario: Claude Local provider settings survive restart
- **WHEN** Claude Local provider settings have been saved and the backend process restarts using the same SQLite database
- **THEN** the backend continues to report Claude Local as the selected provider

#### Scenario: Claude CLI command can be detected and overridden
- **WHEN** the backend detects the Claude CLI and `claude` is available on PATH or a common install location such as `~/.local/bin`
- **THEN** the provider status reports Claude CLI as detected and the detected command is used for Claude Local goal execution
- **AND** when Claude CLI cannot be found automatically, the user may save a manual command path that the backend uses instead

### Requirement: Start goal accepts provider override
The backend SHALL accept an optional provider override in the start-goal request and use it for that run instead of saved provider settings.

#### Scenario: Start with Codex Local override
- **WHEN** a draft goal is started with a Codex Local override containing a model label and command path
- **THEN** the backend invokes the Codex Local provider using that override for the run
- **AND** the run metadata records the override provider and model actually used

#### Scenario: Start with mock override
- **WHEN** a draft goal is started with a mock provider override
- **THEN** the backend uses the mock runtime for that run even if saved provider settings point to another provider

#### Scenario: Start without override preserves existing behavior
- **WHEN** a draft goal is started without a provider override
- **THEN** the backend selects the runtime from saved provider settings as before

### Requirement: Provider override is not persisted as settings
The system SHALL NOT persist per-run provider overrides into provider settings unless the user explicitly saves provider settings.

#### Scenario: Override differs from saved settings
- **WHEN** a goal is started with a provider override whose model differs from saved provider settings
- **THEN** the run uses the override model
- **AND** a later provider settings read still returns the saved model

### Requirement: Provider override is credential-safe
The backend SHALL sanitize and validate provider override fields before constructing a runtime.

#### Scenario: Override command path contains secret-like arguments
- **WHEN** a start request includes a command path with credential-like arguments
- **THEN** the backend removes or redacts unsafe secret-like arguments before using or recording the override
- **AND** dashboard responses and durable events do not expose credential material

### Requirement: Providers emit structured observability progress
The backend provider contract SHALL allow providers to emit structured observability progress during execution without changing the final provider response contract.

#### Scenario: Provider emits structured progress
- **WHEN** a provider emits a structured observation before returning a final response
- **THEN** the provider runtime persists a durable observability event for the active goal
- **AND** the provider can still return its final response through the existing provider output path

#### Scenario: Provider emits no structured progress
- **WHEN** a provider does not support structured progress observations
- **THEN** the provider-backed run still records normal lifecycle and final result or error events
- **AND** the run does not fail solely because no observations were emitted

### Requirement: Codex Local maps JSONL events to observations
The Codex Local provider SHALL prefer a Codex execution mode that emits JSONL progress events when the installed Codex CLI supports it, and SHALL map recognized JSONL events into provider-agnostic observations.

#### Scenario: Codex command item starts
- **WHEN** Codex JSONL indicates a command execution item started
- **THEN** the provider emits a command-started observation with a safe command summary and Codex event provenance

#### Scenario: Codex command item completes
- **WHEN** Codex JSONL indicates a command execution item completed
- **THEN** the provider emits a command-completed observation with status and safe bounded output summary when available

#### Scenario: Codex emits an error event
- **WHEN** Codex JSONL emits an error or turn-failed event
- **THEN** the provider emits a failure observation and preserves the existing provider error handling behavior

#### Scenario: Codex emits unknown JSONL
- **WHEN** Codex JSONL contains an unknown event type
- **THEN** the provider ignores it or emits a generic sanitized progress observation without failing the run solely because the event is unknown

### Requirement: Codex final response behavior is preserved
The Codex Local provider SHALL preserve final response and error semantics while adding observability progress.

#### Scenario: Codex completes after progress
- **WHEN** Codex emits observability events and then produces a final answer
- **THEN** the provider returns the final answer through the provider output path
- **AND** the timeline contains progress observations before the final provider result event

#### Scenario: Codex JSONL final message is available
- **WHEN** Codex JSONL includes a final agent message suitable for the provider response
- **THEN** the provider MAY use that final message as the returned response text

#### Scenario: Codex JSONL is unavailable
- **WHEN** the installed Codex CLI does not support the selected JSONL execution mode
- **THEN** the provider falls back to the existing last-message execution path and records a sanitized observation that rich progress is unavailable

### Requirement: Provider timeout diagnostics include live context
The provider runtime SHALL record enough safe context on provider timeouts to help users decide the next debugging step.

#### Scenario: Provider times out after observations
- **WHEN** a provider process times out after emitting observations
- **THEN** the terminal error event includes safe timeout context such as timeout duration, provider, model, and command label
- **AND** previously persisted observations remain visible in the timeline

#### Scenario: Provider times out without observations
- **WHEN** a provider process times out without emitting observations
- **THEN** the terminal error event still includes safe timeout context
- **AND** the timeline indicates that no provider progress was observed before timeout

### Requirement: Provider observations are sanitized before persistence
The provider runtime SHALL sanitize structured observation messages and bounded output summaries before persisting or streaming them.

#### Scenario: Codex output includes credential-like material
- **WHEN** Codex stdout, stderr, JSONL fields, or command output includes credential-like material
- **THEN** the durable event contains redacted safe text
- **AND** dashboard API responses never expose the original credential-like material
