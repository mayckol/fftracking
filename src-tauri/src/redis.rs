use std::collections::HashMap;
use std::sync::Mutex;

use redis::{Commands, Connection, ConnectionAddr, ConnectionInfo, RedisConnectionInfo, Value};
use serde::{Deserialize, Serialize};

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Service name under which connection passwords live in the OS keychain
/// (macOS Keychain / Windows Credential Manager / Linux Secret Service).
const KEYRING_SERVICE: &str = "fftracking-redis";

#[derive(Default)]
pub struct RedisManager {
    conns: Mutex<HashMap<u64, Connection>>,
    next: Mutex<u64>,
}

#[derive(Deserialize)]
pub struct ConnConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub db: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub tls: bool,
}

/// A key's value, shaped per Redis type. Only the field matching `kind` is set;
/// values are decoded as UTF-8 lossily (binary-unsafe by design — this is a
/// browse/edit tool, not a backup utility).
#[derive(Serialize)]
pub struct KeyValue {
    pub kind: String,
    pub ttl: i64,
    pub string: Option<String>,
    pub list: Option<Vec<String>>,
    pub set: Option<Vec<String>>,
    pub hash: Option<Vec<[String; 2]>>,
    pub zset: Option<Vec<ZItem>>,
}

#[derive(Serialize)]
pub struct ZItem {
    pub member: String,
    pub score: f64,
}

fn bytes_to_string(v: &[u8]) -> String {
    String::from_utf8_lossy(v).into_owned()
}

impl RedisManager {
    pub fn connect(&self, cfg: ConnConfig) -> Result<u64, String> {
        let addr = if cfg.tls {
            ConnectionAddr::TcpTls { host: cfg.host, port: cfg.port, insecure: false, tls_params: None }
        } else {
            ConnectionAddr::Tcp(cfg.host, cfg.port)
        };
        let info = ConnectionInfo {
            addr,
            redis: RedisConnectionInfo {
                db: cfg.db,
                username: cfg.username.filter(|u| !u.is_empty()),
                password: cfg.password.filter(|p| !p.is_empty()),
                protocol: redis::ProtocolVersion::RESP2,
            },
        };
        let client = redis::Client::open(info).map_err(e2s)?;
        let mut conn = client.get_connection().map_err(e2s)?;
        // Fail fast on a bad host/auth instead of erroring on the first query.
        redis::cmd("PING").query::<()>(&mut conn).map_err(e2s)?;

        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };
        self.conns.lock().unwrap().insert(id, conn);
        Ok(id)
    }

    pub fn disconnect(&self, id: u64) {
        self.conns.lock().unwrap().remove(&id);
    }

    fn with<T>(&self, id: u64, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        let mut conns = self.conns.lock().unwrap();
        let conn = conns.get_mut(&id).ok_or("connection not open")?;
        f(conn)
    }

    pub fn scan(&self, id: u64, pattern: &str, cursor: u64, count: u32) -> Result<(u64, Vec<String>), String> {
        self.with(id, |c| {
            let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(count)
                .query(c)
                .map_err(e2s)?;
            Ok((next, keys))
        })
    }

    pub fn get(&self, id: u64, key: &str) -> Result<KeyValue, String> {
        self.with(id, |c| {
            let kind: String = redis::cmd("TYPE").arg(key).query(c).map_err(e2s)?;
            let ttl: i64 = redis::cmd("TTL").arg(key).query(c).map_err(e2s)?;
            let mut out = KeyValue { kind: kind.clone(), ttl, string: None, list: None, set: None, hash: None, zset: None };
            match kind.as_str() {
                "string" => {
                    let v: Vec<u8> = c.get(key).map_err(e2s)?;
                    out.string = Some(bytes_to_string(&v));
                }
                "list" => {
                    let v: Vec<Vec<u8>> = c.lrange(key, 0, -1).map_err(e2s)?;
                    out.list = Some(v.iter().map(|b| bytes_to_string(b)).collect());
                }
                "set" => {
                    let v: Vec<Vec<u8>> = c.smembers(key).map_err(e2s)?;
                    out.set = Some(v.iter().map(|b| bytes_to_string(b)).collect());
                }
                "hash" => {
                    let v: Vec<Vec<u8>> = c.hgetall(key).map_err(e2s)?;
                    out.hash = Some(v.chunks(2).map(|p| [bytes_to_string(&p[0]), bytes_to_string(p.get(1).map(|x| x.as_slice()).unwrap_or(&[]))]).collect());
                }
                "zset" => {
                    let v: Vec<(Vec<u8>, f64)> = c.zrange_withscores(key, 0, -1).map_err(e2s)?;
                    out.zset = Some(v.into_iter().map(|(m, score)| ZItem { member: bytes_to_string(&m), score }).collect());
                }
                _ => {}
            }
            Ok(out)
        })
    }

    pub fn set_string(&self, id: u64, key: &str, value: &str) -> Result<(), String> {
        self.with(id, |c| c.set::<_, _, ()>(key, value).map_err(e2s))
    }

    pub fn delete(&self, id: u64, key: &str) -> Result<(), String> {
        self.with(id, |c| c.del::<_, ()>(key).map_err(e2s))
    }

    pub fn rename(&self, id: u64, from: &str, to: &str) -> Result<(), String> {
        self.with(id, |c| c.rename::<_, _, ()>(from, to).map_err(e2s))
    }

    /// `secs <= 0` removes the TTL (PERSIST); otherwise EXPIRE.
    pub fn set_ttl(&self, id: u64, key: &str, secs: i64) -> Result<(), String> {
        self.with(id, |c| {
            if secs <= 0 {
                c.persist::<_, ()>(key).map_err(e2s)
            } else {
                c.expire::<_, ()>(key, secs).map_err(e2s)
            }
        })
    }

    /// Create (or overwrite) a key of a given type. `value` is parsed per kind:
    /// string → as-is; list/set → one entry per line; hash → `field value` per
    /// line; zset → `score member` per line. Blank lines are skipped.
    pub fn create_key(&self, id: u64, key: &str, kind: &str, value: &str) -> Result<(), String> {
        let lines = || value.lines().map(str::trim).filter(|l| !l.is_empty());
        self.with(id, |c| {
            match kind {
                "string" => {
                    c.set::<_, _, ()>(key, value).map_err(e2s)?;
                }
                "list" => {
                    for l in lines() {
                        c.rpush::<_, _, ()>(key, l).map_err(e2s)?;
                    }
                }
                "set" => {
                    for l in lines() {
                        c.sadd::<_, _, ()>(key, l).map_err(e2s)?;
                    }
                }
                "hash" => {
                    for l in lines() {
                        let (f, v) = l.split_once(char::is_whitespace).ok_or_else(|| format!("hash line needs 'field value': {l}"))?;
                        c.hset::<_, _, _, ()>(key, f.trim(), v.trim()).map_err(e2s)?;
                    }
                }
                "zset" => {
                    for l in lines() {
                        let (s, m) = l.split_once(char::is_whitespace).ok_or_else(|| format!("zset line needs 'score member': {l}"))?;
                        let score: f64 = s.trim().parse().map_err(|_| format!("invalid score: {s}"))?;
                        c.zadd::<_, _, _, ()>(key, m.trim(), score).map_err(e2s)?;
                    }
                }
                other => return Err(format!("unsupported type: {other}")),
            }
            Ok(())
        })
    }

    pub fn run_command(&self, id: u64, args: &[String]) -> Result<String, String> {
        if args.is_empty() {
            return Err("empty command".into());
        }
        self.with(id, |c| {
            let mut cmd = redis::cmd(&args[0]);
            for a in &args[1..] {
                cmd.arg(a);
            }
            let reply: Value = cmd.query(c).map_err(e2s)?;
            Ok(format_reply(&reply, 0))
        })
    }
}

/// Render a RESP reply as readable text for the console pane.
fn format_reply(v: &Value, depth: usize) -> String {
    match v {
        Value::Nil => "(nil)".into(),
        Value::Int(n) => format!("(integer) {n}"),
        Value::BulkString(b) => format!("\"{}\"", bytes_to_string(b)),
        Value::SimpleString(s) => s.clone(),
        Value::Okay => "OK".into(),
        Value::Double(d) => format!("(double) {d}"),
        Value::Boolean(b) => format!("(boolean) {b}"),
        Value::Array(items) | Value::Set(items) => {
            if items.is_empty() {
                return "(empty list or set)".into();
            }
            let pad = "  ".repeat(depth);
            items
                .iter()
                .enumerate()
                .map(|(i, it)| format!("{pad}{}) {}", i + 1, format_reply(it, depth + 1)))
                .collect::<Vec<_>>()
                .join("\n")
        }
        Value::Map(pairs) => pairs
            .iter()
            .map(|(k, val)| format!("{} => {}", format_reply(k, depth + 1), format_reply(val, depth + 1)))
            .collect::<Vec<_>>()
            .join("\n"),
        other => format!("{other:?}"),
    }
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, name).map_err(e2s)
}

pub fn save_secret(name: &str, password: &str) -> Result<(), String> {
    entry(name)?.set_password(password).map_err(e2s)
}

pub fn load_secret(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e2s(e)),
    }
}

pub fn delete_secret(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e2s(e)),
    }
}

/// Probe whether an OS keychain backend is actually usable. On Linux this is
/// the common failure point (no Secret Service daemon on a headless/barebones
/// session); macOS and Windows effectively always return true. The frontend
/// uses this to decide between "remember password" and "prompt each connect".
pub fn secrets_available() -> bool {
    match keyring::Entry::new(KEYRING_SERVICE, "__probe__") {
        Ok(e) => !matches!(e.get_password(), Err(keyring::Error::PlatformFailure(_)) | Err(keyring::Error::NoStorageAccess(_))),
        Err(_) => false,
    }
}
