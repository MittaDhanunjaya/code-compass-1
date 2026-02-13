/**
 * Token estimation: tokenizer when available, char heuristic fallback.
 * Used when provider usage is missing (e.g. streaming, older providers).
 */

let _encoder: { encode: (text: string) => number[] | Uint32Array } | null = null;
let _encoderPromise: Promise<{ encode: (text: string) => number[] | Uint32Array } | null> | null = null;

async function getEncoderAsync(): Promise<{ encode: (text: string) => number[] | Uint32Array } | null> {
  if (_encoder) return _encoder;
  if (_encoderPromise) return _encoderPromise;
  _encoderPromise = (async () => {
    try {
      const { getEncoding } = await import("js-tiktoken");
      _encoder = getEncoding("cl100k_base");
      return _encoder;
    } catch {
      return null;
    }
  })();
  return _encoderPromise;
}

/**
 * Estimate tokens from text. Uses cl100k_base tokenizer when available; falls back to chars (~4 per token).
 */
export async function estimateTokensFromTextAsync(text: string): Promise<number> {
  if (!text || text.length === 0) return 0;
  const enc = await getEncoderAsync();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      // fallback
    }
  }
  return Math.ceil(text.length / 4);
}

/**
 * Sync estimate: char heuristic only. Use estimateTokensFromTextAsync when tokenizer accuracy matters.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}
