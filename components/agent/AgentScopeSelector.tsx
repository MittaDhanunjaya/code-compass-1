"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ScopeMode } from "@/lib/agent/types";

type AgentScopeSelectorProps = {
  scopeMode: ScopeMode;
  setScopeMode: (mode: ScopeMode) => void;
};

export function AgentScopeSelector({ scopeMode, setScopeMode }: AgentScopeSelectorProps) {
  return (
    <>
      <span className="text-[11px] text-muted-foreground">Scope:</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs min-w-[100px]">
            {scopeMode === "conservative" ? "Conservative" : scopeMode === "aggressive" ? "Aggressive" : "Normal"}
            {" ▼"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setScopeMode("conservative")} className={scopeMode === "conservative" ? "bg-accent" : ""}>
            Conservative
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setScopeMode("normal")} className={scopeMode === "normal" ? "bg-accent" : ""}>
            Normal
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setScopeMode("aggressive")} className={scopeMode === "aggressive" ? "bg-accent" : ""}>
            Aggressive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-[10px] text-muted-foreground hidden sm:inline">(whole workspace)</span>
    </>
  );
}
