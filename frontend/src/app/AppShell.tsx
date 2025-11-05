"use client";

import Nav from "./ui/Nav";
import HistoryDock from "./ui/HistoryDock";
import { HistoryProvider } from "./ui/HistoryStore";
import { UIVisibilityProvider, useUIVisibility } from "./ui/UIVisibility";

function Shell({ children }: { children: React.ReactNode }) {
  const { showHistory } = useUIVisibility();
  return (
    <HistoryProvider>
      <div className="flex min-h-screen">
        <div className="flex-1 flex flex-col min-w-0">
          <Nav />
          <div className="px-6 py-6">{children}</div>
        </div>
        {showHistory && <HistoryDock />}
      </div>
    </HistoryProvider>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <UIVisibilityProvider>
      <Shell>{children}</Shell>
    </UIVisibilityProvider>
  );
}

