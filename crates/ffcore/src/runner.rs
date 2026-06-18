use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::watcher::{self, FsWatcher};
use crate::{Engine, Result};

const DEBOUNCE: Duration = Duration::from_millis(750);
const TICK: Duration = Duration::from_secs(1);
/// How often the tree-refresh poll fingerprints the working tree. The OS
/// filesystem watcher drives breaking-point capture; this poll only keeps the
/// project tree in sync, catching changes (external terminal, AI agent) the
/// watcher misses or delays. Coarse enough to stay cheap, short enough to feel
/// live.
const TREE_POLL: Duration = Duration::from_millis(2000);
/// Poll sleeps in short slices so a stop is honored within one slice rather
/// than after a whole `TREE_POLL` window.
const TREE_POLL_TICK: Duration = Duration::from_millis(500);

/// Fired (debounced) whenever a watched tree changes on disk, so the UI can
/// refresh its file list / open file without polling.
type ChangeCb = Arc<dyn Fn(i64) + Send + Sync>;

struct Handle {
    stop: Arc<AtomicBool>,
    interval_thread: Option<JoinHandle<()>>,
    tree_thread: Option<JoinHandle<()>>,
    _watcher: FsWatcher,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.interval_thread.take() {
            let _ = t.join();
        }
        if let Some(t) = self.tree_thread.take() {
            let _ = t.join();
        }
    }
}

/// Drives live monitoring: each started monitor gets a debounced filesystem
/// watcher (event-triggered snapshots) plus an interval thread (timed
/// snapshots). Both funnel through [`Engine::snapshot_now`].
pub struct MonitorManager {
    engine: Arc<Engine>,
    handles: Mutex<HashMap<i64, Handle>>,
    change_cb: Mutex<Option<ChangeCb>>,
    tree_cb: Mutex<Option<ChangeCb>>,
}

impl MonitorManager {
    pub fn new(engine: Arc<Engine>) -> Self {
        Self {
            engine,
            handles: Mutex::new(HashMap::new()),
            change_cb: Mutex::new(None),
            tree_cb: Mutex::new(None),
        }
    }

    /// Registers a callback fired on every debounced filesystem change for any
    /// running monitor. Must be set before monitors start to take effect.
    pub fn set_change_listener<F: Fn(i64) + Send + Sync + 'static>(&self, f: F) {
        *self.change_cb.lock().expect("manager mutex poisoned") = Some(Arc::new(f));
    }

    /// Registers a callback fired when the tree-refresh poll detects the working
    /// tree drifted from disk. Separate from [`set_change_listener`] so project-
    /// tree refresh stays decoupled from breaking-point capture: it fires for
    /// external changes (AI agent, terminal) the OS watcher never delivered.
    /// Must be set before monitors start to take effect.
    pub fn set_tree_change_listener<F: Fn(i64) + Send + Sync + 'static>(&self, f: F) {
        *self.tree_cb.lock().expect("manager mutex poisoned") = Some(Arc::new(f));
    }

    pub fn start(&self, monitor_id: i64, root: &Path, interval_secs: i64) -> Result<()> {
        let mut handles = self.handles.lock().expect("manager mutex poisoned");
        if handles.contains_key(&monitor_id) {
            return Ok(());
        }

        let eng = self.engine.clone();
        let throttle = Arc::new(Mutex::new(EventThrottle::default()));
        // Snapshots are throttled to one per gap (default 20s), but the UI needs
        // to learn about added/removed/edited files right away — notify on every
        // debounced watcher tick instead of waiting for the next snapshot.
        let change_cb = self.change_cb.lock().expect("manager mutex poisoned").clone();
        let watcher = watcher::spawn(root, DEBOUNCE, move || {
            fire_event(&eng, monitor_id, &throttle);
            if let Some(cb) = &change_cb {
                cb(monitor_id);
            }
        })?;

        let stop = Arc::new(AtomicBool::new(false));
        let interval_thread = spawn_interval(self.engine.clone(), monitor_id, interval_secs, stop.clone());

        let tree_cb = self.tree_cb.lock().expect("manager mutex poisoned").clone();
        let tree_thread = tree_cb.map(|cb| {
            spawn_tree_poll(TreePoll { engine: self.engine.clone(), monitor_id, cb, stop: stop.clone() })
        });

        handles.insert(
            monitor_id,
            Handle {
                stop,
                interval_thread: Some(interval_thread),
                tree_thread,
                _watcher: watcher,
            },
        );
        Ok(())
    }

    pub fn stop(&self, monitor_id: i64) {
        self.handles.lock().expect("manager mutex poisoned").remove(&monitor_id);
    }

    pub fn stop_all(&self) {
        self.handles.lock().expect("manager mutex poisoned").clear();
    }

    pub fn is_running(&self, monitor_id: i64) -> bool {
        self.handles.lock().expect("manager mutex poisoned").contains_key(&monitor_id)
    }
}

#[derive(Default)]
struct EventThrottle {
    last: Option<Instant>,
    pending: bool,
}

/// Rate-limits event snapshots to one per `event_min_gap_secs`: the first event
/// snapshots immediately (leading edge); bursts within the window schedule a
/// single trailing snapshot at the window boundary so continuous editing still
/// produces a point every gap, plus a final one when edits stop.
fn fire_event(engine: &Arc<Engine>, monitor_id: i64, throttle: &Arc<Mutex<EventThrottle>>) {
    let gap = Duration::from_secs(
        engine.get_settings().map(|s| s.event_min_gap_secs.max(0) as u64).unwrap_or(20),
    );
    let now = Instant::now();
    let mut t = throttle.lock().expect("throttle mutex poisoned");

    if t.last.map_or(true, |l| now.duration_since(l) >= gap) {
        t.last = Some(now);
        drop(t);
        let _ = engine.snapshot_now(monitor_id, "event");
    } else if !t.pending {
        t.pending = true;
        let wait = (t.last.unwrap() + gap).saturating_duration_since(now);
        let engine = engine.clone();
        let throttle = throttle.clone();
        drop(t);
        thread::spawn(move || {
            thread::sleep(wait);
            {
                let mut t = throttle.lock().expect("throttle mutex poisoned");
                t.pending = false;
                t.last = Some(Instant::now());
            }
            let _ = engine.snapshot_now(monitor_id, "event");
        });
    }
}

struct TreePoll {
    engine: Arc<Engine>,
    monitor_id: i64,
    cb: ChangeCb,
    stop: Arc<AtomicBool>,
}

/// Polls a cheap working-tree fingerprint and fires `cb` whenever it changes,
/// so the project tree refreshes for changes the OS watcher missed (external
/// terminal, AI agent). The first successful fingerprint seeds the baseline
/// silently — the callback fires only on subsequent drift, even if the very
/// first attempt errored. Independent of snapshot capture: this never writes a
/// breaking point.
fn spawn_tree_poll(p: TreePoll) -> JoinHandle<()> {
    let TreePoll { engine, monitor_id, cb, stop } = p;
    thread::spawn(move || {
        let mut last = engine.tree_signature(monitor_id).ok();
        let mut elapsed = Duration::ZERO;
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(TREE_POLL_TICK);
            elapsed += TREE_POLL_TICK;
            if elapsed < TREE_POLL {
                continue;
            }
            elapsed = Duration::ZERO;
            if let Ok(sig) = engine.tree_signature(monitor_id) {
                match &last {
                    // Seed silently when the baseline never computed, so a failed
                    // first attempt doesn't masquerade as a change.
                    None => last = Some(sig),
                    Some(prev) if *prev != sig => {
                        last = Some(sig);
                        cb(monitor_id);
                    }
                    _ => {}
                }
            }
        }
    })
}

/// Sleeps in short ticks (so stop is responsive) and snapshots once per
/// interval. The engine skips the write when nothing changed.
fn spawn_interval(engine: Arc<Engine>, monitor_id: i64, interval_secs: i64, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    let interval = interval_secs.max(1) as u64;
    thread::spawn(move || {
        let mut elapsed = 0u64;
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(TICK);
            elapsed += 1;
            if elapsed >= interval {
                elapsed = 0;
                let _ = engine.snapshot_now(monitor_id, "interval");
            }
        }
    })
}
