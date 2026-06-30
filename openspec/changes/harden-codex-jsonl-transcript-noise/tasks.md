## 1. Parser Test Coverage

- [x] 1.1 Add Codex JSONL parser tests for `command_execution` start, completion, and failure item payloads
- [x] 1.2 Add Codex JSONL parser tests for nested `agent_message` final-message extraction
- [x] 1.3 Add Codex JSONL parser tests proving unknown `item.started` and `item.completed` payloads do not emit visible unrecognized progress

## 2. Parser Implementation

- [x] 2.1 Update the Codex JSONL parser to support both `command_execution` and legacy `command` item types
- [x] 2.2 Update the Codex JSONL parser to extract nested `agent_message`, reasoning, tool, file-change, and error item observations when useful
- [x] 2.3 Update unrecognized item handling so harmless unknown nested item types are ignored while malformed JSONL and failure events remain visible

## 3. Verification

- [x] 3.1 Run focused Codex parser/provider tests
- [x] 3.2 Run project typecheck and test suite
- [x] 3.3 Validate the OpenSpec change in strict mode
