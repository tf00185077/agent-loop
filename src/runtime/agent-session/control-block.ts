export interface ExtractedControlBlock {
  /** Parsed JSON payload; undefined when the block body was not valid JSON. */
  payload?: unknown;
  raw: string;
  parseError?: string;
}

export interface ControlBlockExtraction {
  blocks: ExtractedControlBlock[];
  /** Input text with control blocks removed and leftover blank runs collapsed. */
  strippedText: string;
}

const CONTROL_BLOCK_PATTERN = /```auto-agent-control[ \t]*\r?\n([\s\S]*?)```(?:\r?\n)?/g;

export function extractControlBlocks(text: string): ControlBlockExtraction {
  const blocks: ExtractedControlBlock[] = [];
  const strippedText = text
    .replace(CONTROL_BLOCK_PATTERN, (_match, body: string) => {
      blocks.push(parseBlockBody(body));
      return "";
    })
    .replace(/(?:\r?\n){3,}/g, "\n\n")
    .trim();

  return { blocks, strippedText };
}

function parseBlockBody(body: string): ExtractedControlBlock {
  const raw = body.trim();
  try {
    return { payload: JSON.parse(raw), raw };
  } catch (err) {
    return { raw, parseError: err instanceof Error ? err.message : String(err) };
  }
}
