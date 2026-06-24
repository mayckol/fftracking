// Saved Redis connection definitions: persisted to localStorage and broadcast
// to subscribers (same pattern as uiPrefs). Passwords are NOT stored here —
// when `remember` is set they live in the OS keychain keyed by the saved id;
// otherwise they're prompted for on each connect.

import { useEffect, useReducer } from "react";

export interface RedisConn {
  id: string;
  name: string;
  host: string;
  port: number;
  db: number;
  username: string;
  tls: boolean;
  // Whether the password was saved to the OS keychain for this connection.
  remember: boolean;
}

const KEY = "ff.redis.connections";
const subs = new Set<() => void>();

function load(): RedisConn[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RedisConn[]) : [];
  } catch {
    return [];
  }
}

let conns = load();

function commit() {
  localStorage.setItem(KEY, JSON.stringify(conns));
  subs.forEach((fn) => fn());
}

export function getConnections(): RedisConn[] {
  return conns;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `conn-${conns.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1}`;
}

export function upsertConnection(conn: Omit<RedisConn, "id"> & { id?: string }): RedisConn {
  const id = conn.id ?? newId();
  const next: RedisConn = { ...conn, id };
  const i = conns.findIndex((c) => c.id === id);
  conns = i >= 0 ? conns.map((c) => (c.id === id ? next : c)) : [...conns, next];
  commit();
  return next;
}

export function removeConnection(id: string) {
  conns = conns.filter((c) => c.id !== id);
  commit();
}

export function useConnections(): RedisConn[] {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    subs.add(force);
    return () => {
      subs.delete(force);
    };
  }, []);
  return conns;
}
