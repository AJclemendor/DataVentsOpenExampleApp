"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

type UIVisibilityCtx = {
  showHistory: boolean;
  setShowHistory: (v: boolean) => void;
};

const Ctx = createContext<UIVisibilityCtx | null>(null);
const KEY = "dv_show_history";

export function UIVisibilityProvider({ children }: { children: React.ReactNode }) {
  const [showHistory, setShowHistoryState] = useState<boolean>(true);

  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v === "0" || v === "false") setShowHistoryState(false);
    } catch {}
  }, []);

  const setShowHistory = (v: boolean) => {
    setShowHistoryState(v);
    try { localStorage.setItem(KEY, v ? "1" : "0"); } catch {}
  };

  const value = useMemo(() => ({ showHistory, setShowHistory }), [showHistory]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUIVisibility() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUIVisibility must be used within UIVisibilityProvider");
  return ctx;
}
