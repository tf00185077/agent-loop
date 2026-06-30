## ADDED Requirements

### Requirement: Control plane uses provider resume capability metadata
The agent runtime control plane SHALL choose true resume or fresh continuation based on provider capability metadata and stored session params.

#### Scenario: Provider supports true resume
- **WHEN** a supervisor continuation starts and the provider reports true resume support with a known session id
- **THEN** the control plane requests a true resume continuation

#### Scenario: Provider lacks true resume
- **WHEN** a continuation starts and the provider does not support true resume
- **THEN** the control plane builds a fresh continuation prompt with summarized prior context and records the fallback

### Requirement: Continuation input remains transport-independent
The agent runtime control plane SHALL represent continuation input independently from Codex-specific command syntax.

#### Scenario: Codex provider receives continuation
- **WHEN** the control plane sends continuation input to the Codex provider
- **THEN** the provider maps it to Codex resume or fresh exec invocation without exposing Codex command details to higher-level runtime code
