/**
 * Redaction patterns target the secret shapes that show up in CLI process
 * output: bearer/auth headers, common provider API key prefixes, cookies,
 * and `--flag <secret>` style command arguments.
 */
const REDACTION_PATTERNS: RegExp[] = [
  /authorization\s*:\s*[^\n]+/gi,
  /bearer\s+\S+/gi,
  /\bsk-[a-zA-Z0-9_-]{10,}\b/g,
  /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|token|secret)\s*[=:]\s*\S+/gi,
  /--(?:api-key|token|password|secret)[= ]\S+/gi,
  /\bcookie\s*:\s*\S+/gi,
];

const REDACTED = "[redacted]";

export function sanitizeProcessOutput(text: string): string {
  let sanitized = text;
  for (const pattern of REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTED);
  }
  return sanitized;
}
