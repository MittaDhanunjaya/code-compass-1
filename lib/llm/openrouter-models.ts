// Free models available through OpenRouter. openrouter/free is a router that picks an available free model (most reliable).
// Coding-focused models listed first, then reasoning/planning, then general chat.
export const OPENROUTER_FREE_MODELS = [
  { id: "openrouter/free", label: "Free (auto-select)" },
  // Coding & agentic (best for code, planning, debugging)
  { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder 480B (free) – coding" },
  { id: "qwen/qwen-2.5-coder-32b-instruct:free", label: "Qwen2.5 Coder 32B (free) – coding" },
  { id: "deepseek/deepseek-chat:free", label: "DeepSeek Chat (free)" },
  { id: "deepseek/deepseek-r1-0528:free", label: "DeepSeek R1 0528 (free) – reasoning" },
  { id: "deepseek/deepseek-r1-0528-qwen3-8b:free", label: "DeepSeek R1 Qwen3 8B (free) – reasoning" },
  { id: "arcee-ai/trinity-large-preview:free", label: "Arcee Trinity Large (free) – agentic" },
  { id: "arcee-ai/trinity-mini:free", label: "Arcee Trinity Mini (free) – agentic" },
  { id: "openrouter/aurora-alpha", label: "Aurora Alpha (free) – coding" },
  { id: "tngtech/deepseek-r1t2-chimera:free", label: "DeepSeek R1T2 Chimera (free) – reasoning" },
  { id: "tngtech/deepseek-r1t-chimera:free", label: "DeepSeek R1T Chimera (free)" },
  { id: "stepfun/step-3.5-flash:free", label: "StepFun Step 3.5 Flash (free)" },
  { id: "z-ai/glm-4.5-air:free", label: "GLM 4.5 Air (free) – agentic" },
  { id: "openai/gpt-oss-120b:free", label: "GPT OSS 120B (free)" },
  { id: "nvidia/nemotron-3-nano-30b-a3b:free", label: "NVIDIA Nemotron 3 Nano (free)" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free)" },
  { id: "meta-llama/llama-3.2-3b-instruct:free", label: "Llama 3.2 3B (free)" },
  { id: "upstage/solar-pro-3:free", label: "Solar Pro 3 (free)" },
  { id: "mistralai/mistral-7b-instruct:free", label: "Mistral 7B Instruct (free)" },
] as const;

export type OpenRouterModelId = (typeof OPENROUTER_FREE_MODELS)[number]["id"];
