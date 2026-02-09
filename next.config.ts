import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Optional: tree-sitter is not in package.json; avoid bundling so runtime require can fail gracefully
  serverExternalPackages: ["tree-sitter", "tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-python"],
};

export default nextConfig;
