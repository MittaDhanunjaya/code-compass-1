import { NextResponse } from "next/server";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/api-rate-limit";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { formatCode } from "@/lib/formatters";

const MAX_SIZE = 500 * 1024; // 500KB
const BEAUTIFY_RATE_LIMIT = 30; // per minute

/** Reject binary / invalid content */
function isBinaryOrInvalid(content: string): boolean {
  if (typeof content !== "string") return true;
  return /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content);
}

/** Strip secrets from logs (basic) */
function sanitizeForLog(s: string): string {
  return s
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-***")
    .replace(/ghp_[a-zA-Z0-9]{20,}/g, "ghp_***")
    .replace(/["']?api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=***");
}

export async function POST(request: Request) {
  let user: { id: string };
  try {
    const auth = await requireAuth(request);
    user = auth.user;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const rl = await checkRateLimit(
    getRateLimitIdentifier(request, user.id),
    "beautify",
    BEAUTIFY_RATE_LIMIT
  );
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again later.", retryAfter: rl.retryAfter },
      { status: 429, headers: rl.retryAfter ? { "Retry-After": String(rl.retryAfter) } : {} }
    );
  }

  let body: { code?: string; filename?: string; language?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const code = typeof body?.code === "string" ? body.code : "";
  const filename = typeof body?.filename === "string" ? body.filename : "pasted.txt";
  const language = typeof body?.language === "string" ? body.language : "plaintext";

  if (!code) {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }

  if (code.length > MAX_SIZE) {
    return NextResponse.json(
      { error: "File too large. Maximum size is 500KB." },
      { status: 400 }
    );
  }

  if (isBinaryOrInvalid(code)) {
    return NextResponse.json(
      { error: "Binary or invalid file content not supported." },
      { status: 400 }
    );
  }

  try {
    const result = await formatCode(code, language, filename);
    return NextResponse.json({
      formattedCode: result.formattedCode,
      formatterUsed: result.formatterUsed,
      diagnostics: result.diagnostics,
      language: result.language,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Formatting failed";
    if (process.env.NODE_ENV !== "test") {
      console.warn("[beautify] failed:", sanitizeForLog(msg));
    }
    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
}
