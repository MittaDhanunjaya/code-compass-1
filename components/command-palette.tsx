"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { FilePicker } from "@/components/file-picker";
import { SearchPanel } from "@/components/search-panel";

/**
 * Registers Ctrl+P (file picker) and Ctrl+Shift+F (text search)
 * and renders the modals. Must be inside EditorProvider.
 */
export function CommandPalette() {
  const pathname = usePathname();
  const workspaceId = pathname.startsWith("/app/")
    ? pathname.replace("/app/", "").split("/")[0]
    : null;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        if (workspaceId) setPickerOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        if (workspaceId) setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspaceId]);

  return (
    <>
      <FilePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        workspaceId={workspaceId}
      />
      <SearchPanel
        open={searchOpen}
        onOpenChange={setSearchOpen}
        workspaceId={workspaceId}
      />
    </>
  );
}
