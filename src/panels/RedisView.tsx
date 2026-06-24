import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/ipc";
import type { RedisKeyValue } from "../lib/types";
import {
  removeConnection,
  upsertConnection,
  useConnections,
  type RedisConn,
} from "../lib/redis/connections";

const SCAN_COUNT = 300;

const BLANK_FORM: RedisConn & { password: string } = {
  id: "",
  name: "",
  host: "127.0.0.1",
  port: 6379,
  db: 0,
  username: "",
  tls: false,
  remember: true,
  password: "",
};

const KEY_TYPES: { value: string; label: string }[] = [
  { value: "string", label: "String" },
  { value: "list", label: "List" },
  { value: "set", label: "Set" },
  { value: "hash", label: "Hash" },
  { value: "zset", label: "Sorted set" },
];

// Per-type guidance for the value editor in the New key dialog.
const VALUE_HINT: Record<string, string> = {
  string: "Value",
  list: "One element per line",
  set: "One member per line",
  hash: "field value   — one pair per line",
  zset: "score member   — one pair per line",
};

// Namespace tree built from `:`-delimited key names (JetBrains-style). A node is
// a folder when it has children and/or a leaf when `full` is set (some keys are
// both a key and a prefix of others).
interface KeyNode {
  name: string;
  full: string | null;
  count: number;
  children: Map<string, KeyNode>;
}

function buildKeyTree(keys: string[], sep: string): KeyNode {
  const root: KeyNode = { name: "", full: null, count: 0, children: new Map() };
  for (const k of keys) {
    const parts = k.split(sep);
    let node = root;
    parts.forEach((p, i) => {
      let child = node.children.get(p);
      if (!child) {
        child = { name: p, full: null, count: 0, children: new Map() };
        node.children.set(p, child);
      }
      child.count += 1;
      node = child;
      if (i === parts.length - 1) node.full = k;
    });
  }
  return root;
}

// Collapse single-child folder chains into one row (IntelliJ "compact middle
// packages"): grouping appears only where keys actually branch, so a lone key
// like `a:b:c:::` is one leaf row instead of a stack of empty nodes.
function compress(node: KeyNode): KeyNode {
  const children = new Map<string, KeyNode>();
  for (const raw of node.children.values()) {
    let child = compress(raw);
    while (child.full == null && child.children.size === 1) {
      const only = [...child.children.values()][0];
      child = { name: `${child.name}:${only.name}`, full: only.full, count: only.count, children: only.children };
    }
    children.set(child.name, child);
  }
  return { ...node, children };
}

const sortedChildren = (n: KeyNode): KeyNode[] =>
  [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name));

function CaretIcon({ open }: { open: boolean }) {
  return (
    <svg className={`redis-caret${open ? " open" : ""}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M3.5 2.5 6.5 5l-3 2.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function tryFormatJson(s: string): string | null {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
}

function byteSize(s: string): number {
  return new TextEncoder().encode(s).length;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function typeBadge(kind: string): string {
  switch (kind) {
    case "string":
      return "str";
    case "zset":
      return "zset";
    default:
      return kind;
  }
}

// Split a console line into argv, honoring single/double quotes so values with
// spaces survive (e.g. SET foo "a b c").
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " ") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function ttlLabel(ttl: number): string {
  if (ttl === -1) return "no expiry";
  if (ttl === -2) return "—";
  return `${ttl}s`;
}

// Stacked-cylinder mark for the empty state — the database "layers" motif.
function RedisMark() {
  return (
    <svg className="redis-mark" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden>
      <ellipse cx="28" cy="14" rx="18" ry="7" stroke="currentColor" strokeWidth="2.2" />
      <path d="M10 14v12c0 3.9 8.06 7 18 7s18-3.1 18-7V14" stroke="currentColor" strokeWidth="2.2" />
      <path d="M10 26v12c0 3.9 8.06 7 18 7s18-3.1 18-7V26" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

interface Props {
  toast: (msg: string, error?: boolean) => void;
}

export default function RedisView({ toast }: Props) {
  const saved = useConnections();
  const [secretsOk, setSecretsOk] = useState(true);

  const [connId, setConnId] = useState<number | null>(null);
  const [activeConn, setActiveConn] = useState<RedisConn | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [form, setForm] = useState<(RedisConn & { password: string }) | null>(null);
  const [pwPrompt, setPwPrompt] = useState<{ conn: RedisConn; value: string } | null>(null);
  const [addKey, setAddKey] = useState<{ key: string; kind: string; value: string } | null>(null);
  const [rename, setRename] = useState<{ from: string; to: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);

  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [scanning, setScanning] = useState(false);

  const [selKey, setSelKey] = useState<string | null>(null);
  const [value, setValue] = useState<RedisKeyValue | null>(null);
  const [editStr, setEditStr] = useState("");
  const [ttlInput, setTtlInput] = useState("");
  const [viewAs, setViewAs] = useState<"text" | "json">("text");

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => compress(buildKeyTree(keys, ":")), [keys]);
  const jsonFmt = useMemo(
    () => (value?.kind === "string" ? tryFormatJson(editStr) : null),
    [value, editStr],
  );
  const toggleNode = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const [cmdLog, setCmdLog] = useState<{ cmd: string; out: string; error: boolean }[]>([]);
  const [cmdInput, setCmdInput] = useState("");
  const consoleEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.redisSecretsAvailable().then(setSecretsOk).catch(() => setSecretsOk(false));
  }, []);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ block: "end" });
  }, [cmdLog]);

  const resetBrowser = useCallback(() => {
    setKeys([]);
    setCursor(0);
    setSelKey(null);
    setValue(null);
  }, []);

  const doScan = useCallback(
    async (id: number, pat: string, cur: number, append: boolean) => {
      setScanning(true);
      try {
        const [next, found] = await api.redisScan(id, pat || "*", cur, SCAN_COUNT);
        setKeys((prev) => (append ? [...prev, ...found] : found));
        setCursor(next);
      } catch (e) {
        toast(String(e), true);
      } finally {
        setScanning(false);
      }
    },
    [toast],
  );

  const finishConnect = useCallback(
    async (conn: RedisConn, password: string) => {
      setConnecting(true);
      try {
        const id = await api.redisConnect({
          host: conn.host,
          port: conn.port,
          db: conn.db,
          username: conn.username || undefined,
          password: password || undefined,
          tls: conn.tls,
        });
        setConnId(id);
        setActiveConn(conn);
        resetBrowser();
        setCmdLog([]);
        await doScan(id, pattern, 0, false);
      } catch (e) {
        toast(`Connect failed: ${e}`, true);
      } finally {
        setConnecting(false);
      }
    },
    [doScan, pattern, resetBrowser, toast],
  );

  const connect = useCallback(
    async (conn: RedisConn) => {
      if (connId != null) await api.redisDisconnect(connId).catch(() => {});
      setConnId(null);
      let password = "";
      if (conn.remember && secretsOk) {
        try {
          password = (await api.redisLoadSecret(conn.id)) ?? "";
        } catch {
          password = "";
        }
      }
      // No stored secret (never saved, or no keychain) → ask for it now.
      if (!password) {
        setPwPrompt({ conn, value: "" });
        return;
      }
      await finishConnect(conn, password);
    },
    [connId, finishConnect, secretsOk],
  );

  const disconnect = useCallback(async () => {
    if (connId != null) await api.redisDisconnect(connId).catch(() => {});
    setConnId(null);
    setActiveConn(null);
    resetBrowser();
    setCmdLog([]);
  }, [connId, resetBrowser]);

  const saveForm = useCallback(
    async (connectAfter: boolean) => {
      if (!form) return;
      if (!form.host || !form.port) {
        toast("Host and port are required", true);
        return;
      }
      const stored = upsertConnection({
        id: form.id || undefined,
        name: form.name || `${form.host}:${form.port}`,
        host: form.host,
        port: Number(form.port),
        db: Number(form.db) || 0,
        username: form.username,
        tls: form.tls,
        remember: form.remember && secretsOk,
      });
      if (form.password && form.remember && secretsOk) {
        try {
          await api.redisSaveSecret(stored.id, form.password);
        } catch (e) {
          toast(`Could not save password to keychain: ${e}`, true);
        }
      }
      setForm(null);
      if (connectAfter) {
        if (form.password) await finishConnect(stored, form.password);
        else await connect(stored);
      }
    },
    [form, connect, finishConnect, secretsOk, toast],
  );

  const deleteConn = useCallback(
    async (conn: RedisConn) => {
      if (conn.remember) await api.redisDeleteSecret(conn.id).catch(() => {});
      removeConnection(conn.id);
      if (activeConn?.id === conn.id) await disconnect();
    },
    [activeConn, disconnect],
  );

  const openKey = useCallback(
    async (key: string) => {
      if (connId == null) return;
      setSelKey(key);
      try {
        const v = await api.redisGet(connId, key);
        setValue(v);
        setEditStr(v.string ?? "");
        setTtlInput(v.ttl > 0 ? String(v.ttl) : "");
        setViewAs("text");
      } catch (e) {
        toast(String(e), true);
      }
    },
    [connId, toast],
  );

  const saveString = useCallback(async () => {
    if (connId == null || !selKey) return;
    try {
      await api.redisSetString(connId, selKey, editStr);
      toast("Value saved");
      await openKey(selKey);
    } catch (e) {
      toast(String(e), true);
    }
  }, [connId, selKey, editStr, openKey, toast]);

  const applyTtl = useCallback(
    async (persist: boolean) => {
      if (connId == null || !selKey) return;
      try {
        await api.redisSetTtl(connId, selKey, persist ? -1 : Number(ttlInput) || -1);
        await openKey(selKey);
      } catch (e) {
        toast(String(e), true);
      }
    },
    [connId, selKey, ttlInput, openKey, toast],
  );

  const delKey = useCallback(
    async (name: string) => {
      if (connId == null) return;
      try {
        await api.redisDelete(connId, name);
        setKeys((prev) => prev.filter((k) => k !== name));
        if (selKey === name) {
          setSelKey(null);
          setValue(null);
        }
      } catch (e) {
        toast(String(e), true);
      }
    },
    [connId, selKey, toast],
  );

  const deleteKey = useCallback(() => selKey && delKey(selKey), [selKey, delKey]);

  const doRename = useCallback(async () => {
    if (connId == null || !rename) return;
    const to = rename.to.trim();
    if (!to || to === rename.from) {
      setRename(null);
      return;
    }
    try {
      await api.redisRename(connId, rename.from, to);
      setRename(null);
      await doScan(connId, pattern, 0, false);
      await openKey(to);
    } catch (e) {
      toast(String(e), true);
    }
  }, [connId, rename, pattern, doScan, openKey, toast]);

  const createKey = useCallback(async () => {
    if (connId == null || !addKey) return;
    const name = addKey.key.trim();
    if (!name) {
      toast("Key name is required", true);
      return;
    }
    try {
      await api.redisCreateKey(connId, name, addKey.kind, addKey.value);
      setAddKey(null);
      await doScan(connId, pattern, 0, false);
      await openKey(name);
    } catch (e) {
      toast(String(e), true);
    }
  }, [connId, addKey, pattern, doScan, openKey, toast]);

  const runCommand = useCallback(async () => {
    if (connId == null) return;
    const args = tokenize(cmdInput);
    if (!args.length) return;
    setCmdInput("");
    try {
      const out = await api.redisCommand(connId, args);
      setCmdLog((p) => [...p, { cmd: cmdInput, out, error: false }]);
    } catch (e) {
      setCmdLog((p) => [...p, { cmd: cmdInput, out: String(e), error: true }]);
    }
  }, [connId, cmdInput]);

  const renderTree = (node: KeyNode, depth: number, path: string): ReactNode =>
    sortedChildren(node).map((child) => {
      const childPath = path ? `${path}:${child.name}` : child.name;
      const isFolder = child.children.size > 0;
      const open = expanded.has(childPath);
      const selected = !isFolder && child.full != null && child.full === selKey;
      return (
        <Fragment key={childPath}>
          <div
            className={`redis-tree-row${selected ? " on" : ""}`}
            style={{ paddingLeft: depth * 13 + 8 }}
            title={child.full ?? child.name}
            onClick={() => (isFolder ? toggleNode(childPath) : child.full && openKey(child.full))}
            onContextMenu={
              isFolder || !child.full
                ? undefined
                : (e) => {
                    e.preventDefault();
                    openKey(child.full!);
                    setMenu({ x: e.clientX, y: e.clientY, key: child.full! });
                  }
            }
          >
            {isFolder ? (
              <CaretIcon open={open} />
            ) : (
              <span className="redis-caret-spacer" />
            )}
            {isFolder ? (
              <svg className="redis-tree-icon folder" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M2 4.5a1 1 0 0 1 1-1h3l1.2 1.4H13a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
            ) : (
              <span className="redis-tree-icon leaf" aria-hidden>{"{}"}</span>
            )}
            <span className="redis-tree-name">{child.name}</span>
            {isFolder && <span className="redis-tree-count">{child.count}</span>}
          </div>
          {isFolder && open && renderTree(child, depth + 1, childPath)}
        </Fragment>
      );
    });

  // ---- Connection editor form -------------------------------------------
  if (form) {
    const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });
    const uri = `redis${form.tls ? "s" : ""}://${form.username ? `${form.username}@` : ""}${
      form.host || "host"
    }:${form.port || 6379}/${form.db || 0}`;
    return (
      <div className="col main redis redis-form-view">
        <form
          className="redis-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveForm(true);
          }}
        >
          <header className="redis-form-head">
            <span className="redis-form-eyebrow">Redis connection</span>
            <h2 className="redis-form-title">{form.id ? "Edit connection" : "New connection"}</h2>
            <code className="redis-uri" title="Connection target">
              {uri}
            </code>
          </header>

          <label className="redis-field">
            <span>Name</span>
            <input value={form.name} placeholder="My Redis" onChange={(e) => set("name", e.target.value)} />
          </label>

          <fieldset className="redis-fieldset">
            <legend>Server</legend>
            <div className="redis-row">
              <label className="redis-field grow">
                <span>Host</span>
                <input value={form.host} placeholder="127.0.0.1" onChange={(e) => set("host", e.target.value)} />
              </label>
              <label className="redis-field w-port">
                <span>Port</span>
                <input type="number" value={form.port} onChange={(e) => set("port", Number(e.target.value))} />
              </label>
              <label className="redis-field w-db">
                <span>DB</span>
                <input type="number" value={form.db} onChange={(e) => set("db", Number(e.target.value))} />
              </label>
            </div>
          </fieldset>

          <fieldset className="redis-fieldset">
            <legend>Authentication</legend>
            <div className="redis-row">
              <label className="redis-field grow">
                <span>Username</span>
                <input value={form.username} placeholder="default" onChange={(e) => set("username", e.target.value)} />
              </label>
              <label className="redis-field grow">
                <span>Password</span>
                <input
                  type="password"
                  value={form.password}
                  placeholder={form.id ? "•••••• unchanged" : ""}
                  onChange={(e) => set("password", e.target.value)}
                />
              </label>
            </div>
          </fieldset>

          <div className="redis-options">
            <label className="redis-switch">
              <input type="checkbox" checked={form.tls} onChange={(e) => set("tls", e.target.checked)} />
              <span className="redis-switch-track" aria-hidden />
              <span>TLS / SSL</span>
            </label>
            <label className="redis-switch" title={secretsOk ? "" : "No OS keychain available on this system"}>
              <input
                type="checkbox"
                checked={form.remember && secretsOk}
                disabled={!secretsOk}
                onChange={(e) => set("remember", e.target.checked)}
              />
              <span className="redis-switch-track" aria-hidden />
              <span>Remember password{secretsOk ? " in OS keychain" : " — no keychain available"}</span>
            </label>
          </div>

          <footer className="redis-form-actions">
            <button type="button" className="tbtn ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
            <span className="redis-actions-spacer" />
            <button type="button" className="tbtn" onClick={() => saveForm(false)}>
              Save
            </button>
            <button type="submit" className="tbtn primary">
              Connect
            </button>
          </footer>
        </form>
      </div>
    );
  }

  // ---- Main 3-pane browser ----------------------------------------------
  return (
    <div className="col main redis">
      {addKey && (
        <div className="redis-pw-overlay" onClick={() => setAddKey(null)}>
          <div className="redis-pw-box redis-addkey" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">New key</div>
            <label className="redis-field">
              <span>Key</span>
              <input
                autoFocus
                value={addKey.key}
                placeholder="user:1"
                onChange={(e) => setAddKey({ ...addKey, key: e.target.value })}
              />
            </label>
            <label className="redis-field">
              <span>Type</span>
              <select value={addKey.kind} onChange={(e) => setAddKey({ ...addKey, kind: e.target.value })}>
                {KEY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="redis-field">
              <span>Value</span>
              <textarea
                className="redis-stredit"
                value={addKey.value}
                placeholder={VALUE_HINT[addKey.kind]}
                onChange={(e) => setAddKey({ ...addKey, value: e.target.value })}
              />
            </label>
            <div className="redis-form-actions">
              <button className="tbtn ghost" onClick={() => setAddKey(null)}>
                Cancel
              </button>
              <span className="redis-actions-spacer" />
              <button className="tbtn primary" onClick={createKey}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              onClick={() => {
                openKey(menu.key);
                setMenu(null);
              }}
            >
              Open
            </button>
            <button
              onClick={() => {
                setRename({ from: menu.key, to: menu.key });
                setMenu(null);
              }}
            >
              Rename key…
            </button>
            <div className="ctx-sep" />
            <button
              className="danger"
              onClick={() => {
                delKey(menu.key);
                setMenu(null);
              }}
            >
              Delete key
            </button>
          </div>
        </>
      )}

      {rename && (
        <div className="redis-pw-overlay" onClick={() => setRename(null)}>
          <div className="redis-pw-box" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">Rename key</div>
            <div className="redis-rename-from" title={rename.from}>
              {rename.from}
            </div>
            <input
              autoFocus
              value={rename.to}
              onChange={(e) => setRename({ ...rename, to: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") doRename();
                else if (e.key === "Escape") setRename(null);
              }}
            />
            <div className="redis-form-actions">
              <button className="tbtn ghost" onClick={() => setRename(null)}>
                Cancel
              </button>
              <span className="redis-actions-spacer" />
              <button className="tbtn primary" onClick={doRename}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {pwPrompt && (
        <div className="redis-pw-overlay" onClick={() => setPwPrompt(null)}>
          <div className="redis-pw-box" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">Password for {pwPrompt.conn.name}</div>
            <input
              autoFocus
              type="password"
              value={pwPrompt.value}
              onChange={(e) => setPwPrompt({ ...pwPrompt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const { conn, value } = pwPrompt;
                  setPwPrompt(null);
                  finishConnect(conn, value);
                } else if (e.key === "Escape") {
                  setPwPrompt(null);
                }
              }}
            />
            <div className="redis-form-actions">
              <button className="tbtn ghost" onClick={() => setPwPrompt(null)}>
                Cancel
              </button>
              <span className="redis-actions-spacer" />
              <button
                className="tbtn primary"
                onClick={() => {
                  const { conn, value } = pwPrompt;
                  setPwPrompt(null);
                  finishConnect(conn, value);
                }}
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="redis-rail">
        <div className="redis-rail-head">
          <span className="section-title">Connections</span>
          <button
            className="tbtn"
            title="New connection"
            onClick={() => setForm({ ...BLANK_FORM, remember: secretsOk })}
          >
            +
          </button>
        </div>
        {saved.length === 0 && (
          <div className="redis-rail-empty">
            <span>No connections yet</span>
            <button className="tbtn" onClick={() => setForm({ ...BLANK_FORM, remember: secretsOk })}>
              Add one
            </button>
          </div>
        )}
        <div className="redis-conn-list">
          {saved.map((c) => (
            <div
              key={c.id}
              className={`redis-conn${activeConn?.id === c.id ? " on" : ""}`}
              onDoubleClick={() => connect(c)}
            >
              <div className="redis-conn-info" onClick={() => connect(c)}>
                <div className="redis-conn-name">
                  {activeConn?.id === c.id && connId != null && <span className="redis-dot" />}
                  {c.name}
                </div>
                <div className="redis-conn-sub">
                  {c.host}:{c.port}/{c.db}
                </div>
              </div>
              <div className="redis-conn-actions">
                <button className="redis-iconbtn" title="Edit" onClick={() => setForm({ ...c, password: "" })}>
                  ✎
                </button>
                <button className="redis-iconbtn" title="Delete" onClick={() => deleteConn(c)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
        {activeConn && connId != null && (
          <button className="tbtn redis-disconnect" onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>

      {connId == null && (
        <div className="redis-welcome">
          <RedisMark />
          <h2 className="redis-welcome-title">
            {connecting ? "Connecting…" : saved.length ? "Pick a connection" : "Connect to Redis"}
          </h2>
          <p className="redis-welcome-sub">
            {connecting
              ? "Opening a session and loading keys."
              : saved.length
                ? "Choose a server on the left, or add another to start browsing keys."
                : "Add a server to browse keys, edit values, set TTLs, and run commands."}
          </p>
          {!connecting && (
            <button className="tbtn primary" onClick={() => setForm({ ...BLANK_FORM, remember: secretsOk })}>
              New connection
            </button>
          )}
        </div>
      )}

      {connId != null && (
        <>
          <div className="redis-browser">
            <div className="redis-toolbar">
              <button
                className="redis-tbtn"
                title="Refresh keys"
                disabled={scanning}
                onClick={() => doScan(connId, pattern, 0, false)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                className="redis-tbtn"
                title="New key"
                onClick={() => setAddKey({ key: "", kind: "string", value: "" })}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              <span className="redis-toolbar-count">
                {keys.length}
                {cursor !== 0 ? "+" : ""} key{keys.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="redis-keybar">
              <input
                className="redis-pattern"
                value={pattern}
                placeholder="Pattern e.g. user:*"
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doScan(connId, pattern, 0, false)}
              />
              <button className="tbtn" disabled={scanning} onClick={() => doScan(connId, pattern, 0, false)}>
                Scan
              </button>
            </div>
            <div className="redis-keylist">
              {keys.length > 0 && (
                <>
                  <div className="redis-tree-db">
                    DB{activeConn?.db ?? 0} ({keys.length}
                    {cursor !== 0 ? "+" : ""})
                  </div>
                  <div className="redis-tree">{renderTree(tree, 0, "")}</div>
                </>
              )}
              {keys.length === 0 && !scanning && <div className="redis-empty">No keys match.</div>}
              {cursor !== 0 && (
                <button className="tbtn redis-more" disabled={scanning} onClick={() => doScan(connId, pattern, cursor, true)}>
                  {scanning ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
          </div>

          <div className="redis-detail">
        {selKey && value ? (
          <>
            <div className="redis-detail-head">
              <div className="redis-key-title" title={selKey}>
                <span className="redis-badge">{typeBadge(value.kind)}</span>
                {selKey}
              </div>
              <button className="tbtn ghost" title="Reload value" onClick={() => openKey(selKey)}>
                Reload
              </button>
              <button className="tbtn danger" onClick={deleteKey}>
                Delete
              </button>
            </div>

            <div className="redis-ttl">
              <span>TTL: {ttlLabel(value.ttl)}</span>
              <input
                className="redis-ttl-input"
                type="number"
                placeholder="seconds"
                value={ttlInput}
                onChange={(e) => setTtlInput(e.target.value)}
              />
              <button className="tbtn" onClick={() => applyTtl(false)}>
                Set
              </button>
              <button className="tbtn" onClick={() => applyTtl(true)}>
                Persist
              </button>
            </div>

            <div className="redis-value">
              {value.kind === "string" && (
                <div className="redis-strpane">
                  <div className="redis-valbar">
                    <span className="redis-valsize">{humanSize(byteSize(editStr))}</span>
                    <span className="redis-actions-spacer" />
                    {jsonFmt && viewAs === "text" && editStr !== jsonFmt && (
                      <button className="redis-linkbtn" onClick={() => setEditStr(jsonFmt)}>
                        Beautify JSON
                      </button>
                    )}
                    <label className="redis-viewas">
                      View as
                      <select value={viewAs} onChange={(e) => setViewAs(e.target.value as "text" | "json")}>
                        <option value="text">Plain text</option>
                        <option value="json" disabled={!jsonFmt}>
                          JSON
                        </option>
                      </select>
                    </label>
                  </div>
                  {viewAs === "json" && jsonFmt ? (
                    <pre className="redis-stredit redis-json">{jsonFmt}</pre>
                  ) : (
                    <textarea
                      className="redis-stredit"
                      value={editStr}
                      onChange={(e) => setEditStr(e.target.value)}
                    />
                  )}
                  <button className="tbtn primary redis-save" onClick={saveString}>
                    Save value
                  </button>
                </div>
              )}
              {value.kind === "hash" && (
                <table className="redis-table">
                  <tbody>
                    {(value.hash ?? []).map(([f, v], i) => (
                      <tr key={i}>
                        <td className="redis-cell-key">{f}</td>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {value.kind === "zset" && (
                <table className="redis-table">
                  <tbody>
                    {(value.zset ?? []).map((z, i) => (
                      <tr key={i}>
                        <td className="redis-cell-key">{z.score}</td>
                        <td>{z.member}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {(value.kind === "list" || value.kind === "set") && (
                <table className="redis-table">
                  <tbody>
                    {((value.kind === "list" ? value.list : value.set) ?? []).map((m, i) => (
                      <tr key={i}>
                        <td className="redis-cell-idx">{i}</td>
                        <td>{m}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {value.kind !== "string" && (
                <div className="redis-hint">Edit collection values from the console below.</div>
              )}
            </div>
          </>
        ) : (
          <div className="redis-placeholder">Select a key to inspect.</div>
        )}

            <div className="redis-console">
              <div className="redis-console-out">
                {cmdLog.map((c, i) => (
                  <div key={i} className="redis-console-entry">
                    <div className="redis-console-cmd">&gt; {c.cmd}</div>
                    <pre className={`redis-console-reply${c.error ? " error" : ""}`}>{c.out}</pre>
                  </div>
                ))}
                <div ref={consoleEndRef} />
              </div>
              <input
                className="redis-console-input"
                value={cmdInput}
                placeholder="Type a command, e.g. HSET user:1 name Ada"
                onChange={(e) => setCmdInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runCommand()}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
