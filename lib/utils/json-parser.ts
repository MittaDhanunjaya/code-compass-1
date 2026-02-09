/**
 * Robust JSON parser with multiple fallback strategies.
 * Handles malformed JSON, markdown code blocks, and edge cases from LLMs.
 */

export type ParseResult<T> = {
  success: boolean;
  data: T | null;
  error?: string;
  raw?: string;
};

/**
 * Robustly parse JSON from LLM responses.
 * Handles:
 * - Markdown code blocks
 * - Trailing commas (in objects and arrays)
 * - Comments (single-line and multi-line)
 * - Multiple JSON objects
 * - Malformed JSON
 * - Unescaped quotes in strings
 * - Single quotes instead of double quotes
 */
export function parseJSONRobust<T = any>(
  content: string,
  expectedKeys?: string[]
): ParseResult<T> {
  if (!content || typeof content !== "string") {
    return {
      success: false,
      data: null,
      error: "Empty or invalid content",
    };
  }

  // Strip BOM and trim (helps Perplexity and other providers)
  let cleaned = content.trim().replace(/^\uFEFF/, "");

  // Remove markdown code blocks FIRST (before other processing)
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  } else {
    // Remove markdown markers if present (including unclosed blocks)
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/g, "");
  }

  // Skip leading explanatory text (common LLM pattern: "Looking at...", "Here's...", etc.)
  // Find the first { or [ that's likely the start of JSON
  let jsonStr = cleaned;
  let startIdx = -1;

  // Strategy 1: Look for JSON object with expected keys (double- and single-quoted for all providers)
  const expectedKeyPatterns = [
    /\{\s*"steps"/,
    /\{\s*"summary"/,
    /\{\s*"plan"/,
    /\{\s*"actions"/,
    /\{\s*'steps'/,
    /\{\s*'summary'/,
    /\{\s*'plan'/,
    /\{\s*'actions'/,
  ];

  for (const pattern of expectedKeyPatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index !== undefined) {
      startIdx = match.index;
      break;
    }
  }

  // Strategy 2: Find first { that looks like JSON start (not in a word)
  if (startIdx === -1) {
    const braceMatch = cleaned.match(/\{\s*["'\[]/);
    if (braceMatch && braceMatch.index !== undefined) {
      startIdx = braceMatch.index;
    }
  }

  // Strategy 3: Fallback to first { or [
  if (startIdx === -1) {
    startIdx = cleaned.indexOf("{");
    if (startIdx === -1) startIdx = cleaned.indexOf("[");
  }

  // Skip leading text if found
  if (startIdx !== -1 && startIdx > 0) {
    cleaned = cleaned.slice(startIdx);
  }

  jsonStr = cleaned;

  // Use balanced brace matching that respects strings (double and single quotes)
  const extracted = extractBalancedJSON(jsonStr, 0);
  if (extracted && extracted.length > 2) {
    jsonStr = extracted;
  } else if (startIdx === -1) {
    // No JSON found at all - try one more time with single-quote normalized content (Perplexity etc.)
    const normalized = fixSingleQuotes(content.trim().replace(/^\uFEFF/, ""));
    const retry = parseJSONRobust(normalized, expectedKeys);
    if (retry.success) return retry;
    return {
      success: false,
      data: null,
      error: "No JSON object or array found in content",
      raw: content.slice(0, 500),
    };
  } else if (!extracted || extracted.length <= 2) {
    // We found a { but extraction failed (e.g. single-quoted content) - normalize and re-extract
    jsonStr = fixSingleQuotes(cleaned);
    const reExtracted = extractBalancedJSON(jsonStr, 0);
    if (reExtracted && reExtracted.length > 2) {
      jsonStr = reExtracted;
    }
  }

  // Clean up common LLM JSON mistakes (and single-quote JSON from Perplexity etc.)
  jsonStr = fixSingleQuotes(cleanJSONString(jsonStr));

  // Fix control characters in strings (unescaped newlines, tabs, etc.)
  jsonStr = fixControlCharacters(jsonStr);

  // Try parsing
  try {
    const parsed = JSON.parse(jsonStr);
    
    // Validate expected keys if provided
    if (expectedKeys && typeof parsed === "object" && parsed !== null) {
      const missingKeys = expectedKeys.filter(key => !(key in parsed));
      if (missingKeys.length > 0) {
        return {
          success: false,
          data: null,
          error: `Missing required keys: ${missingKeys.join(", ")}`,
          raw: jsonStr.slice(0, 500),
        };
      }
    }

    return {
      success: true,
      data: parsed as T,
      raw: jsonStr.slice(0, 500),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "JSON parse failed";
    
    // Try more aggressive cleanup
    try {
      let cleanedAgain = cleanJSONStringAggressive(jsonStr);
      cleanedAgain = fixControlCharacters(cleanedAgain);
      const parsed = JSON.parse(cleanedAgain);
      
      return {
        success: true,
        data: parsed as T,
        raw: cleanedAgain.slice(0, 500),
      };
    } catch (secondError) {
      // Try fixing missing commas and control characters
      try {
        let fixed = fixMissingCommas(jsonStr);
        fixed = fixControlCharacters(fixed);
        const parsed = JSON.parse(fixed);
        
        return {
          success: true,
          data: parsed as T,
          raw: fixed.slice(0, 500),
        };
      } catch {
        // All attempts failed
      }
    }

    return {
      success: false,
      data: null,
      error: errorMsg,
      raw: jsonStr.slice(0, 1000), // Show more context for debugging
    };
  }
}

/**
 * Extract balanced JSON object/array, respecting strings (double- and single-quoted).
 * Single-quote support ensures Perplexity and other providers that emit 'key': value work.
 */
function extractBalancedJSON(content: string, startIdx: number): string | null {
  let braceCount = 0;
  let bracketCount = 0;
  let stringChar: '"' | "'" | null = null; // which quote opened the string
  let escapeNext = false;
  const isArray = content[startIdx] === "[";
  const openChar = isArray ? "[" : "{";
  const closeChar = isArray ? "]" : "}";

  for (let i = startIdx; i < content.length; i++) {
    const char = content[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    // Inside a string: only the closing quote (matching stringChar) ends it
    if (stringChar !== null) {
      if (char === stringChar) {
        stringChar = null;
      }
      continue;
    }

    // Start a string (double or single quote)
    if (char === '"' || char === "'") {
      stringChar = char;
      continue;
    }

    // Handle braces and brackets
    if (char === "{") braceCount++;
    if (char === "}") {
      braceCount--;
      if (braceCount === 0 && bracketCount === 0 && !isArray) {
        return content.slice(startIdx, i + 1);
      }
    }

    if (char === "[") bracketCount++;
    if (char === "]") {
      bracketCount--;
      if (bracketCount === 0 && braceCount === 0 && isArray) {
        return content.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}

/**
 * Fix control characters in JSON strings (unescaped newlines, tabs, etc.).
 * Escapes control characters that are invalid in JSON strings.
 */
function fixControlCharacters(jsonStr: string): string {
  let inString = false;
  let escapeNext = false;
  let result = "";
  
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    const charCode = char.charCodeAt(0);
    
    if (escapeNext) {
      // Already escaped - keep as is
      result += char;
      escapeNext = false;
      continue;
    }
    
    if (char === "\\") {
      result += char;
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    
    if (inString) {
      // Inside a string - escape control characters
      // JSON allows: \n, \r, \t, \b, \f, \uXXXX
      // We need to escape: unescaped newlines, tabs, and other control chars
      
      // Check if previous character in original string was a backslash
      // (meaning this character is already escaped)
      const prevChar = i > 0 ? jsonStr[i - 1] : "";
      const isAlreadyEscaped = prevChar === "\\";
      
      if (!isAlreadyEscaped) {
        if (char === "\n") {
          result += "\\n";
        } else if (char === "\r") {
          result += "\\r";
        } else if (char === "\t") {
          result += "\\t";
        } else if (char === "\b") {
          result += "\\b";
        } else if (char === "\f") {
          result += "\\f";
        } else if (charCode < 32) {
          // Other control characters (0x00-0x1F except \n, \r, \t, \b, \f)
          result += `\\u${charCode.toString(16).padStart(4, "0")}`;
        } else {
          result += char;
        }
      } else {
        // Already escaped - keep as is
        result += char;
      }
    } else {
      // Outside string - keep as is
      result += char;
    }
  }
  
  return result;
}

/**
 * Clean JSON string - first pass (conservative).
 * Removes comments while preserving comments inside strings.
 */
function cleanJSONString(jsonStr: string): string {
  // Remove trailing commas more aggressively - handle nested cases
  // This regex removes commas that are followed by whitespace and then } or ]
  let cleaned = jsonStr.replace(/,(\s*[}\]])/g, "$1");
  
  // Also remove trailing commas in arrays/objects more carefully
  // Match: value, followed by whitespace, then } or ]
  cleaned = cleaned.replace(/([^,\s])\s*,\s*([}\]])/g, "$1$2");
  
  // Remove comments while preserving comments inside strings
  cleaned = removeCommentsPreservingStrings(cleaned);
  
  // Fix Python-style booleans/null
  cleaned = cleaned.replace(/\bTrue\b/g, "true");
  cleaned = cleaned.replace(/\bFalse\b/g, "false");
  cleaned = cleaned.replace(/\bNone\b/g, "null");
  
  return cleaned;
}

/**
 * Remove comments from JSON while preserving comments inside strings.
 */
function removeCommentsPreservingStrings(jsonStr: string): string {
  let result = "";
  let inString = false;
  let escapeNext = false;
  let i = 0;
  
  while (i < jsonStr.length) {
    const char = jsonStr[i];
    const nextChar = jsonStr[i + 1];
    
    if (escapeNext) {
      result += char;
      escapeNext = false;
      i++;
      continue;
    }
    
    if (char === "\\") {
      result += char;
      escapeNext = true;
      i++;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      result += char;
      i++;
      continue;
    }
    
    if (inString) {
      // Inside string - preserve everything including // and /*
      result += char;
      i++;
      continue;
    }
    
    // Outside string - check for comments
    if (char === "/" && nextChar === "/") {
      // Single-line comment - skip until newline
      while (i < jsonStr.length && jsonStr[i] !== "\n") {
        i++;
      }
      if (i < jsonStr.length) {
        result += "\n"; // Preserve newline
        i++;
      }
      continue;
    }
    
    if (char === "/" && nextChar === "*") {
      // Multi-line comment - skip until */
      i += 2; // Skip /*
      while (i < jsonStr.length - 1) {
        if (jsonStr[i] === "*" && jsonStr[i + 1] === "/") {
          i += 2; // Skip */
          break;
        }
        i++;
      }
      continue;
    }
    
    result += char;
    i++;
  }
  
  return result;
}

/**
 * Clean JSON string - aggressive pass (for malformed JSON).
 * Removes trailing commas recursively and fixes common issues.
 */
function cleanJSONStringAggressive(jsonStr: string): string {
  let cleaned = jsonStr;
  
  // Remove trailing commas recursively (handle nested objects/arrays)
  // Keep removing until no more trailing commas found
  let previousLength = 0;
  while (cleaned.length !== previousLength) {
    previousLength = cleaned.length;
    // Remove trailing commas before } or ]
    cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");
    // Also handle cases like: "value", } or "value", ]
    cleaned = cleaned.replace(/([^,\s])\s*,\s*([}\]])/g, "$1$2");
  }
  
  // Fix single quotes to double quotes (but preserve escaped quotes and strings)
  // Handle mixed quotes by converting single quotes to double quotes
  cleaned = fixSingleQuotes(cleaned);
  
  // Fix common issues: missing commas between properties
  cleaned = cleaned.replace(/}\s*{/g, "},{");
  cleaned = cleaned.replace(/]\s*\[/g, "],[");
  
  // Remove comments (preserving comments in strings)
  cleaned = removeCommentsPreservingStrings(cleaned);
  
  // Fix Python-style values
  cleaned = cleaned.replace(/\bTrue\b/g, "true");
  cleaned = cleaned.replace(/\bFalse\b/g, "false");
  cleaned = cleaned.replace(/\bNone\b/g, "null");
  
  // Fix unescaped newlines in strings (common LLM mistake)
  cleaned = cleaned.replace(/("(?:[^"\\]|\\.)*")\s*\n\s*(")/g, '$1,\n$2');
  
  return cleaned;
}

/**
 * Fix single quotes to double quotes while preserving escaped quotes.
 */
function fixSingleQuotes(jsonStr: string): string {
  let result = "";
  let inString = false;
  let escapeNext = false;
  let stringStart = -1;
  
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    
    if (escapeNext) {
      result += char;
      escapeNext = false;
      continue;
    }
    
    if (char === "\\") {
      result += char;
      escapeNext = true;
      continue;
    }
    
    // Check for string start/end (both single and double quotes)
    if ((char === '"' || char === "'") && !escapeNext) {
      if (!inString) {
        // Starting a string - convert single quote to double quote
        inString = true;
        stringStart = i;
        result += '"'; // Always use double quote
      } else {
        // Ending a string - check if it matches the opening quote
        const openingQuote = jsonStr[stringStart];
        if (char === openingQuote) {
          inString = false;
          result += '"'; // Always use double quote
          stringStart = -1;
        } else {
          // Different quote type - it's part of the string content
          result += char;
        }
      }
      continue;
    }
    
    if (inString && char === "'") {
      // Single quote inside a double-quoted string - keep as is (it's content)
      result += char;
      continue;
    }
    
    result += char;
  }
  
  return result;
}

/**
 * Fix missing commas in JSON (common LLM mistake).
 * Adds commas where they're missing between properties.
 * This function respects string boundaries to avoid breaking string content.
 */
function fixMissingCommas(jsonStr: string): string {
  let fixed = jsonStr;
  let inString = false;
  let escapeNext = false;
  let result = "";
  
  for (let i = 0; i < fixed.length; i++) {
    const char = fixed[i];
    const nextChar = fixed[i + 1];
    const prevChar = i > 0 ? fixed[i - 1] : "";
    
    if (escapeNext) {
      result += char;
      escapeNext = false;
      continue;
    }
    
    if (char === "\\") {
      result += char;
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    
    if (inString) {
      // Inside string - don't modify
      result += char;
      continue;
    }
    
    // Outside string - check for missing commas
    
    // Pattern: value "key": -> value, "key":
    // Match: number/boolean/null/string/object/array followed by whitespace and then "key":
    if (char === '"' && prevChar !== '"' && prevChar !== ':' && prevChar !== ',') {
      // Check if previous token was a value (number, boolean, null, }, ])
      const beforeValue = result.trimEnd();
      const lastNonWhitespace = beforeValue[beforeValue.length - 1];
      if (lastNonWhitespace && /[0-9\]\}]/.test(lastNonWhitespace)) {
        // Check if next is a property key
        const rest = fixed.slice(i);
        if (rest.match(/^"\s*:/)) {
          result += ', ';
        }
      }
    }
    
    // Pattern: number "key" -> number, "key"
    if (/[0-9]/.test(char) && nextChar === '"') {
      const rest = fixed.slice(i + 1);
      if (rest.match(/^"\s*:/)) {
        result += char + ', ';
        continue;
      }
    }
    
    // Pattern: true "key" -> true, "key"
    if (char === 't' && fixed.slice(i, i + 4) === 'true' && fixed[i + 4] === '"') {
      const rest = fixed.slice(i + 4);
      if (rest.match(/^"\s*:/)) {
        result += 'true, ';
        i += 3; // Skip 'rue'
        continue;
      }
    }
    
    // Pattern: false "key" -> false, "key"
    if (char === 'f' && fixed.slice(i, i + 5) === 'false' && fixed[i + 5] === '"') {
      const rest = fixed.slice(i + 5);
      if (rest.match(/^"\s*:/)) {
        result += 'false, ';
        i += 4; // Skip 'alse'
        continue;
      }
    }
    
    // Pattern: null "key" -> null, "key"
    if (char === 'n' && fixed.slice(i, i + 4) === 'null' && fixed[i + 4] === '"') {
      const rest = fixed.slice(i + 4);
      if (rest.match(/^"\s*:/)) {
        result += 'null, ';
        i += 3; // Skip 'ull'
        continue;
      }
    }
    
    // Pattern: } "key" -> }, "key"
    if (char === '}' && nextChar === '"') {
      const rest = fixed.slice(i + 1);
      if (rest.match(/^"\s*:/)) {
        result += '}, ';
        continue;
      }
    }
    
    // Pattern: ] "key" -> ], "key"
    if (char === ']' && nextChar === '"') {
      const rest = fixed.slice(i + 1);
      if (rest.match(/^"\s*:/)) {
        result += '], ';
        continue;
      }
    }
    
    // Pattern: "value" "key" -> "value", "key"
    if (char === '"') {
      // Find the closing quote
      let j = i + 1;
      while (j < fixed.length && (fixed[j] !== '"' || (j > 0 && fixed[j - 1] === '\\'))) {
        if (fixed[j] === '\\') j++; // Skip escaped char
        j++;
      }
      if (j < fixed.length && fixed[j] === '"') {
        const valueEnd = j;
        const afterValue = fixed.slice(valueEnd + 1).trimStart();
        if (afterValue.startsWith('"') && afterValue.match(/^"\s*:/)) {
          result += char;
          continue; // Will add comma after the string
        }
      }
    }
    
    result += char;
  }
  
  // Post-process: Fix common patterns with regex (safer now that we've handled strings)
  fixed = result;
  
  // Fix missing comma between string properties: "value" "key": -> "value", "key":
  fixed = fixed.replace(/("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*"\s*:)/g, '$1, $2');
  
  // Fix missing comma after number before property: 5 "key": -> 5, "key":
  fixed = fixed.replace(/(\d+)\s+("(?:[^"\\]|\\.)*"\s*:)/g, '$1, $2');
  
  // Fix missing comma after boolean before property: true "key": -> true, "key":
  fixed = fixed.replace(/\b(true|false)\s+("(?:[^"\\]|\\.)*"\s*:)/g, '$1, $2');
  
  // Fix missing comma after null before property: null "key": -> null, "key":
  fixed = fixed.replace(/\bnull\s+("(?:[^"\\]|\\.)*"\s*:)/g, 'null, $1');
  
  // Fix missing comma after closing brace before property: } "key": -> }, "key":
  fixed = fixed.replace(/\}\s+("(?:[^"\\]|\\.)*"\s*:)/g, '}, $1');
  
  // Fix missing comma after closing bracket before property: ] "key": -> ], "key":
  fixed = fixed.replace(/\]\s+("(?:[^"\\]|\\.)*"\s*:)/g, '], $1');
  
  // Fix missing comma between array elements: ] [ -> ], [
  fixed = fixed.replace(/\]\s*\[/g, "], [");
  
  // Fix missing comma between object properties: } { -> }, {
  fixed = fixed.replace(/\}\s*\{/g, "}, {");
  
  return fixed;
}

/**
 * Extract multiple JSON objects from content.
 */
export function extractMultipleJSON<T = any>(content: string): T[] {
  const results: T[] = [];
  let startIdx = 0;
  
  while (startIdx < content.length) {
    const objStart = content.indexOf("{", startIdx);
    if (objStart === -1) break;
    
    const extracted = extractBalancedJSON(content, objStart);
    if (extracted) {
      const result = parseJSONRobust<T>(extracted);
      if (result.success && result.data) {
        results.push(result.data);
      }
      startIdx = objStart + extracted.length;
    } else {
      startIdx = objStart + 1;
    }
  }
  
  return results;
}
