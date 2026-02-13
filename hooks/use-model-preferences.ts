"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getModelPreferences,
  setModelPreferences,
  getDropdownModels,
  type ModelPreferences,
} from "@/lib/llm/model-preferences";
import type { CatalogModel } from "@/lib/llm/model-catalog";

export function useModelPreferences() {
  const [prefs, setPrefs] = useState<ModelPreferences | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) setPrefs(getModelPreferences());
  }, [mounted]);

  const refresh = useCallback(() => {
    setPrefs(getModelPreferences());
  }, []);

  const updatePrefs = useCallback((next: Partial<ModelPreferences>) => {
    setModelPreferences(next);
    setPrefs(getModelPreferences());
  }, []);

  return { prefs, mounted, refresh, updatePrefs };
}

/** Models to show in Chat/Composer OpenRouter dropdown. Empty = use defaults (OPENROUTER_FREE_MODELS). */
export function useDropdownModels(): { models: CatalogModel[]; mounted: boolean } {
  const { prefs, mounted } = useModelPreferences();
  const models = mounted && prefs && prefs.preferredModelIds.length > 0 ? getDropdownModels() : [];
  return { models, mounted };
}
