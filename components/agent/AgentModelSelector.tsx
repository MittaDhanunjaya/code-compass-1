"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Users, Settings2 } from "lucide-react";

export type ModelSelection =
  | { type: "auto" }
  | { type: "model"; modelId: string; label: string }
  | { type: "group"; modelGroupId: string; label: string };

interface AvailableModel {
  id: string;
  label: string;
  provider: string;
  modelSlug: string;
  isDefault?: boolean;
  isFree?: boolean;
  hasKey?: boolean | string;
}

interface DefaultGroupInfo {
  groupId: string | null;
  isUserSaved: boolean;
  label?: string;
  members: { modelId: string; label: string; role: string }[];
}

interface AvailableGroup {
  id: string;
  label: string;
  description?: string;
}

type AgentModelSelectorProps = {
  modelSelection: ModelSelection;
  setModelSelection: (sel: ModelSelection) => void;
  modelsAvailable: {
    defaultModels: AvailableModel[];
    userModels: (AvailableModel & { id?: string; modelId: string; enabled: boolean })[];
    groups: AvailableGroup[];
  } | null;
  defaultGroupInfo: DefaultGroupInfo | null;
  defaultGroupSaving: boolean;
  setDefaultGroupSaving: (v: boolean) => void;
  setDefaultGroupInfo: (info: DefaultGroupInfo | null) => void;
  onModelsManagerOpen: () => void;
};

export function AgentModelSelector({
  modelSelection,
  setModelSelection,
  modelsAvailable,
  defaultGroupInfo,
  defaultGroupSaving,
  setDefaultGroupSaving,
  setDefaultGroupInfo,
  onModelsManagerOpen,
}: AgentModelSelectorProps) {
  return (
    <>
      <span className="text-xs text-muted-foreground">Model:</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs font-medium min-w-[140px]">
            {modelSelection.type === "auto"
              ? "Auto"
              : modelSelection.type === "group"
                ? `Group: ${modelSelection.label}`
                : modelSelection.label}
            {" ▼"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[320px] overflow-y-auto overflow-x-hidden min-w-[220px] max-w-[min(100vw-2rem,360px)]">
          <div className="px-2 py-1.5">
            <DropdownMenuItem onClick={() => setModelSelection({ type: "auto" })} className={modelSelection.type === "auto" ? "bg-accent" : ""}>
              Auto (best default)
              {modelSelection.type === "auto" && <span className="ml-2 text-xs">✓</span>}
            </DropdownMenuItem>
            {defaultGroupInfo?.members?.length ? (
              <p className="pl-2 pr-2 pb-1.5 pt-0 text-[11px] text-muted-foreground border-b border-border/60">
                {defaultGroupInfo.isUserSaved && defaultGroupInfo.label
                  ? `Your default: ${defaultGroupInfo.label}`
                  : defaultGroupInfo.members.map((m) => `${m.label} (${m.role})`).join(", ")}
              </p>
            ) : null}
            {defaultGroupInfo?.isUserSaved && (
              <DropdownMenuItem
                className="text-muted-foreground focus:text-foreground"
                onSelect={(e) => {
                  e.preventDefault();
                  (async () => {
                    setDefaultGroupSaving(true);
                    try {
                      const res = await fetch("/api/models/default-group", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ defaultModelGroupId: null }),
                      });
                      if (res.ok) {
                        const data = await fetch("/api/models/default-group").then((r) => (r.ok ? r.json() : null));
                        if (data?.members) setDefaultGroupInfo(data);
                      }
                    } finally {
                      setDefaultGroupSaving(false);
                    }
                  })();
                }}
                disabled={defaultGroupSaving}
              >
                Clear saved default
              </DropdownMenuItem>
            )}
          </div>
          {modelsAvailable?.defaultModels?.length ? (
            <>
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground border-b">Default models</div>
              {modelsAvailable.defaultModels.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onClick={() => setModelSelection({ type: "model", modelId: m.id, label: m.label })}
                  className={modelSelection.type === "model" && modelSelection.modelId === m.id ? "bg-accent" : ""}
                >
                  {m.label}
                  {m.isFree && <span className="ml-1 text-xs text-green-600 dark:text-green-400">(free)</span>}
                  {modelSelection.type === "model" && modelSelection.modelId === m.id && <span className="ml-2 text-xs">✓</span>}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          {modelsAvailable?.userModels?.length ? (
            <>
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground border-b">Your models</div>
              {modelsAvailable.userModels.filter((m) => m.enabled).map((m) => (
                <DropdownMenuItem
                  key={m.modelId}
                  onClick={() => setModelSelection({ type: "model", modelId: m.modelId, label: m.label })}
                  className={modelSelection.type === "model" && modelSelection.modelId === m.modelId ? "bg-accent" : ""}
                >
                  {m.label}
                  {modelSelection.type === "model" && modelSelection.modelId === m.modelId && <span className="ml-2 text-xs">✓</span>}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          {modelsAvailable?.groups?.length ? (
            <>
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground border-b flex items-center gap-1">
                <Users className="h-3 w-3" /> Groups
              </div>
              {modelsAvailable.groups.map((g) => (
                <DropdownMenuItem
                  key={g.id}
                  onClick={() => setModelSelection({ type: "group", modelGroupId: g.id, label: g.label })}
                  className={modelSelection.type === "group" && modelSelection.modelGroupId === g.id ? "bg-accent" : ""}
                >
                  <Users className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                  {g.label}
                  {modelSelection.type === "group" && modelSelection.modelGroupId === g.id && <span className="ml-2 text-xs">✓</span>}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          {modelSelection.type === "group" && (
            <DropdownMenuItem
              className="text-muted-foreground border-t border-border/60 mt-1 pt-1"
              disabled={defaultGroupSaving || (defaultGroupInfo?.isUserSaved && defaultGroupInfo?.groupId === modelSelection.modelGroupId)}
              onSelect={(e) => {
                e.preventDefault();
                (async () => {
                  setDefaultGroupSaving(true);
                  try {
                    const res = await fetch("/api/models/default-group", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ defaultModelGroupId: modelSelection.modelGroupId }),
                    });
                    if (res.ok) {
                      const data = await fetch("/api/models/default-group").then((r) => (r.ok ? r.json() : null));
                      if (data?.members) setDefaultGroupInfo(data);
                    }
                  } finally {
                    setDefaultGroupSaving(false);
                  }
                })();
              }}
            >
              {defaultGroupInfo?.isUserSaved && defaultGroupInfo?.groupId === modelSelection.modelGroupId ? "Saved as default" : "Save as default"}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onModelsManagerOpen} title="Manage models & groups">
        <Settings2 className="h-3.5 w-3.5" />
      </Button>
    </>
  );
}
