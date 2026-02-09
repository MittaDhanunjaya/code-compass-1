/**
 * Persistent chat memory per workspace.
 * Stores conversation history for better context continuity.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage } from "@/lib/llm/types";

const MAX_MESSAGES_PER_WORKSPACE = 100; // Keep last 100 messages per workspace

/**
 * Save a chat message to persistent storage.
 */
export async function saveChatMessage(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  role: "user" | "assistant" | "system",
  content: string,
  metadata?: Record<string, any>
): Promise<void> {
  await supabase.from("chat_messages").insert({
    workspace_id: workspaceId,
    user_id: userId,
    role,
    content,
    metadata: metadata || {},
  });

  // Clean up old messages (keep only last MAX_MESSAGES_PER_WORKSPACE)
  const { data: messages } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_MESSAGES_PER_WORKSPACE + 1);

  if (messages && messages.length > MAX_MESSAGES_PER_WORKSPACE) {
    const idsToDelete = messages.slice(MAX_MESSAGES_PER_WORKSPACE).map((m) => m.id);
    await supabase
      .from("chat_messages")
      .delete()
      .in("id", idsToDelete);
  }
}

/**
 * Load recent chat messages for a workspace.
 */
export async function loadChatHistory(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  limit: number = 50
): Promise<ChatMessage[]> {
  const { data: messages, error } = await supabase
    .from("chat_messages")
    .select("role, content")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error || !messages) {
    return [];
  }

  return messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));
}

/**
 * Clear chat history for a workspace.
 */
export async function clearChatHistory(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string
): Promise<void> {
  await supabase
    .from("chat_messages")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
}
