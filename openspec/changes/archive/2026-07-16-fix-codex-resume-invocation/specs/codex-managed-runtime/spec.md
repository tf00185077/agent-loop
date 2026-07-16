## MODIFIED Requirements

### Requirement: Codex managed runtime resumes when available
The Codex managed runtime SHALL detect Codex session-resume support and, when a
verified prior provider session id is available and resume is supported, start a
continuation by invoking Codex resume (`codex exec resume <session id> … -`) with
the continuation prompt delivered on stdin as the post-resume message; the resume
invocation SHALL set the sandbox through a config override (`-c
sandbox_mode=workspace-write`) rather than the `--sandbox` flag, which `codex exec
resume` does not accept. If the resume invocation fails to start or exits with an
error, the runtime SHALL fall back to a fresh continuation session with the same
prompt rather than failing the goal. The `resume` capability SHALL be derived from
the CLI's session-resume support, separate from approval resume.

#### Scenario: Resume support is detected

- **WHEN** the Codex capability probe finds the `resume` subcommand in `codex exec --help`
- **THEN** the adapter reports the `resume` capability as supported

#### Scenario: Resume succeeds

- **WHEN** a continuation starts with a known provider session id and the adapter supports resume
- **THEN** the runtime invokes Codex resume mode for that session id with a config-based sandbox override and delivers the continuation prompt as the next message

#### Scenario: Resume invocation fails and falls back

- **WHEN** the Codex resume subprocess fails to start or exits with an error
- **THEN** the runtime retries the same continuation as a fresh (non-resume) session rather than surfacing a terminal failure for the goal

#### Scenario: Resume is unavailable

- **WHEN** no prior session id is available or the adapter does not support resume
- **THEN** the runtime starts a fresh continuation session instead of resuming
