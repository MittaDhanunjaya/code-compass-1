import type { ProviderId } from "@/lib/llm/providers";

/** Resolved config for a single model call (chat/plan/execute). */
export interface ModelInvocationConfig {
  modelId: string;
  modelLabel: string;
  providerId: ProviderId;
  modelSlug: string;
  apiKey: string;
  /** Role in a group: planner | coder | reviewer */
  role?: "planner" | "coder" | "reviewer";
}

/** DB row shape for public.models */
export interface ModelRow {
  id: string;
  label: string;
  provider: string;
  model_slug: string;
  is_default: boolean;
  is_free: boolean;
  capabilities: { chat?: boolean; code?: boolean };
}

/** DB row shape for public.user_models (without key in responses) */
export interface UserModelRow {
  id: string;
  user_id: string;
  model_id: string;
  api_key_encrypted: string | null;
  enabled: boolean;
  alias_label: string | null;
}

/** DB row shape for public.model_groups */
export interface ModelGroupRow {
  id: string;
  user_id: string;
  label: string;
  description: string | null;
}

/** DB row shape for public.model_group_members */
export interface ModelGroupMemberRow {
  id: string;
  group_id: string;
  model_id: string;
  role: string;
  priority: number;
}
