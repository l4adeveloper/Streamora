"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useWorkspacePanel(
  userId: string | undefined,
  defaultOpen: boolean,
) {
  const key = `streamora-workspace-panel:${userId ?? "guest"}`;
  const [state, setState] = useState({ key: "", open: false });
  const preference = useRef<{ key: string; open: boolean | null }>({
    key: "",
    open: null,
  });
  useEffect(() => {
    let saved: boolean | null = null;
    try {
      const value = localStorage.getItem(key);
      if (value === "open" || value === "closed") saved = value === "open";
    } catch {}
    preference.current = { key, open: saved };
    setState({
      key,
      open: saved ?? (defaultOpen && !matchMedia("(max-width: 900px)").matches),
    });
    // Defaults only apply when entering an account, not on every view change.
  }, [key]);

  // Automatic meeting/navigation changes must respect an explicitly closed panel.
  const setPanel = useCallback(
    (open: boolean) => {
      setState({
        key,
        open:
          open &&
          !(
            preference.current.key === key && preference.current.open === false
          ),
      });
    },
    [key],
  );
  const setPanelPreference = useCallback(
    (open: boolean) => {
      preference.current = { key, open };
      try {
        localStorage.setItem(key, open ? "open" : "closed");
      } catch {}
      setState({ key, open });
    },
    [key],
  );
  return {
    panel: state.key === key && state.open,
    setPanel,
    setPanelPreference,
  };
}
