"use client";

import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";

export type HistoryEntry = {
  id: string;
  ts: number;
  kind: "search" | "sse" | "http" | "ws";
  provider?: "polymarket" | "kalshi" | string;
  method?: string;
  url?: string;
  summary: string;
  meta?: Record<string, any>;
};

type HistoryContextType = {
  entries: HistoryEntry[];
  add: (e: Omit<HistoryEntry, "id" | "ts"> & { id?: string; ts?: number }) => string;
  update: (id: string, patch: Partial<HistoryEntry>) => void;
  clear: () => void;
};

const HistoryContext = createContext<HistoryContextType | null>(null);

const DB_NAME = "dv_history";
const DB_VERSION = 1;
const STORE_NAME = "entries";

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("ts", "ts", { unique: false });
      }
    };
  });
}

async function loadEntries(): Promise<HistoryEntry[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index("ts");
      const request = index.openCursor(null, "prev");
      const entries: HistoryEntry[] = [];
      
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          entries.push(cursor.value);
          cursor.continue();
        } else {
          resolve(entries);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

async function saveEntry(entry: HistoryEntry): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail
  }
}

async function deleteEntry(id: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail
  }
}

async function clearAllEntries(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Silently fail
  }
}

export function HistoryProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const initRef = useRef(false);
  const pendingUpdatesRef = useRef<Map<string, HistoryEntry>>(new Map());

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    loadEntries().then((loaded) => {
      setEntries(loaded.slice(0, 200));
    });
  }, []);

  useEffect(() => {
    if (!initRef.current) return;
    const timeoutId = setTimeout(() => {
      const updates = Array.from(pendingUpdatesRef.current.values());
      pendingUpdatesRef.current.clear();
      Promise.all(updates.map((entry) => saveEntry(entry))).catch(() => {});
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [entries]);

  const add = useCallback((e: Omit<HistoryEntry, "id" | "ts"> & { id?: string; ts?: number }) => {
    const id = e.id ?? Math.random().toString(36).slice(2);
    const ts = e.ts ?? Date.now();
    const entry: HistoryEntry = {
      id,
      ts,
      kind: e.kind,
      provider: e.provider,
      method: e.method,
      url: e.url,
      summary: e.summary,
      meta: e.meta,
    };
    setEntries((prev) => {
      const updated = [entry, ...prev].slice(0, 200);
      pendingUpdatesRef.current.set(id, entry);
      return updated;
    });
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<HistoryEntry>) => {
    setEntries((prev) => {
      const updated = prev.map((it) => {
        if (it.id === id) {
          const updatedEntry = { ...it, ...patch };
          pendingUpdatesRef.current.set(id, updatedEntry);
          return updatedEntry;
        }
        return it;
      });
      return updated;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    clearAllEntries().catch(() => {});
  }, []);

  const api: HistoryContextType = {
    entries,
    add,
    update,
    clear,
  };

  return (
    <HistoryContext.Provider value={api}>{children}</HistoryContext.Provider>
  );
}

export function useHistory() {
  const ctx = useContext(HistoryContext);
  if (!ctx) throw new Error("useHistory must be used within HistoryProvider");
  return ctx;
}
