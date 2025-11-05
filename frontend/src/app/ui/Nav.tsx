"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useUIVisibility } from "./UIVisibility";
import DvWsPanel from "./DvWsPanel";

export default function Nav() {
  const { showHistory, setShowHistory } = useUIVisibility();
  const headerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const updateVar = () => {
      const h = headerRef.current?.getBoundingClientRect().height || 56;
      document.documentElement.style.setProperty("--nav-h", `${Math.round(h)}px`);
    };
    updateVar();
    window.addEventListener("resize", updateVar);
    const ro = headerRef.current ? new ResizeObserver(updateVar) : null;
    if (headerRef.current && ro) ro.observe(headerRef.current);
    return () => {
      window.removeEventListener("resize", updateVar);
      ro?.disconnect();
    };
  }, []);

  return (
    <header ref={headerRef} className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b">
      <div className="px-6 py-3 flex items-center gap-6">
        <Link href="/" className="font-medium tracking-tight">DataVents</Link>
        <nav className="text-sm text-gray-700 flex items-center gap-4">
          <Link href="/search" className="hover:underline">Search</Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <DvWsPanel />
          <button
            className="text-xs px-2 py-1 border rounded hover:bg-gray-50"
            onClick={() => setShowHistory(!showHistory)}
            title={showHistory ? "Hide history sidebar" : "Show history sidebar"}
          >
            {showHistory ? "Hide History" : "Show History"}
          </button>
        </div>
      </div>
    </header>
  );
}
