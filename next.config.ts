import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Phase 10.1: Content Security Policy - restrict script/style/connect sources
const cspHeader = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net" + (isDev ? " 'unsafe-eval'" : ""),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://openrouter.ai https://api.openai.com https://generativelanguage.googleapis.com blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Optional: tree-sitter is not in package.json; avoid bundling so runtime require can fail gracefully
  serverExternalPackages: ["tree-sitter", "tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-python"],
  async headers() {
    return [
      {
        source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: cspHeader,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
