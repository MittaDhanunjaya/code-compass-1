/**
 * User model preferences: up to 10 selected models + toggles for Agent/Chat/Composer.
 * Stored in localStorage (no DB migration needed).
 */

import { MODEL_CATALOG, MAX_PREFERRED_MODELS, type CatalogModel } from "./model-catalog";

const STORAGE_KEY = "model-preferences";

export interface ModelPreferences {
  preferredModelIds: string[];
  showInAgent: boolean;
  showInChat: boolean;
  showInComposer: boolean;
}

const DEFAULTS: ModelPreferences = {
  preferredModelIds: [],
  showInAgent: true,
  showInChat: true,
  showInComposer: true,
};

export function getModelPreferences(): ModelPreferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ModelPreferences>;
    const preferred = Array.isArray(parsed.preferredModelIds)
      ? parsed.preferredModelIds.filter((id): id is string => typeof id === "string").slice(0, MAX_PREFERRED_MODELS)
      : DEFAULTS.preferredModelIds;
    return {
      preferredModelIds: preferred,
      showInAgent: typeof parsed.showInAgent === "boolean" ? parsed.showInAgent : DEFAULTS.showInAgent,
      showInChat: typeof parsed.showInChat === "boolean" ? parsed.showInChat : DEFAULTS.showInChat,
      showInComposer: typeof parsed.showInComposer === "boolean" ? parsed.showInComposer : DEFAULTS.showInComposer,
    };
  } catch {
    return DEFAULTS;
  }
}

export function setModelPreferences(prefs: Partial<ModelPreferences>): void {
  if (typeof window === "undefined") return;
  const current = getModelPreferences();
  const next: ModelPreferences = {
    preferredModelIds: prefs.preferredModelIds ?? current.preferredModelIds,
    showInAgent: prefs.showInAgent ?? current.showInAgent,
    showInChat: prefs.showInChat ?? current.showInChat,
    showInComposer: prefs.showInComposer ?? current.showInComposer,
  };
  if (next.preferredModelIds.length > MAX_PREFERRED_MODELS) {
    next.preferredModelIds = next.preferredModelIds.slice(0, MAX_PREFERRED_MODELS);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function togglePreferredModel(id: string): ModelPreferences {
  const current = getModelPreferences();
  const idx = current.preferredModelIds.indexOf(id);
  let next: string[];
  if (idx >= 0) {
    next = current.preferredModelIds.filter((x) => x !== id);
  } else if (current.preferredModelIds.length >= MAX_PREFERRED_MODELS) {
    next = current.preferredModelIds; // can't add more
  } else {
    next = [...current.preferredModelIds, id];
  }
  const updated = { ...current, preferredModelIds: next };
  setModelPreferences(updated);
  return updated;
}

export function getPreferredModels(): CatalogModel[] {
  const prefs = getModelPreferences();
  return prefs.preferredModelIds
    .map((id) => {
      const catalog = MODEL_CATALOG.byId(id);
      if (catalog) return catalog;
      return { id, label: id, category: "other" as const, hint: "custom" };
    })
    .filter((m): m is CatalogModel => m != null);
}

/** Models to show in dropdowns when user has set preferences. Empty = use full catalog/default. */
export function getDropdownModels(): CatalogModel[] {
  const prefs = getModelPreferences();
  if (prefs.preferredModelIds.length === 0) return [];
  return getPreferredModels();
}

/** Get models for dropdown display, including custom IDs not in catalog. */
export function getModelsForDropdown(): { id: string; label: string }[] {
  return getPreferredModels().map((m) => ({ id: m.id, label: m.label }));
}
