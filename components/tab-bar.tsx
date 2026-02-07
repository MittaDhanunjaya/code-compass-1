"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/editor-context";

export function TabBar() {
  const { tabs, activeTab, setActiveTab, closeTab } = useEditor();

  if (tabs.length === 0) {
    return (
      <div className="flex h-9 shrink-0 items-center border-b border-border px-2">
        <span className="text-xs text-muted-foreground">No file open</span>
      </div>
    );
  }

  return (
    <div className="flex h-9 shrink-0 items-center overflow-x-auto border-b border-border bg-muted/20">
      {tabs.map((tab) => {
        const name = tab.path.split("/").pop() ?? tab.path;
        const isActive = tab.path === activeTab;
        return (
          <div
            key={tab.path}
            className={`group flex items-center gap-1 border-r border-border px-3 py-1.5 text-sm ${
              isActive
                ? "bg-background text-foreground"
                : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
            }`}
          >
            <button
              type="button"
              className="flex flex-1 items-center gap-1.5 truncate text-left"
              onClick={() => setActiveTab(tab.path)}
            >
              {tab.dirty && (
                <span className="shrink-0 text-[10px] font-medium text-amber-500" title="Modified">
                  M
                </span>
              )}
              <span className="truncate">{name}</span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
              onClick={() => closeTab(tab.path)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
