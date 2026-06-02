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

struct Handle {
    stop: Arc<AtomicBool>,
    interval_thread: Option<JoinHandle<()>>,
    _watcher: FsWatcher,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.interval_thread.take() {
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
}

impl MonitorManager {
    pub fn new(engine: Arc<Engine>) -> Self {
        Self { engine, handles: Mutex::new(HashMap::new()) }
    }

    pub fn start(&self, monitor_id: i64, root: &Path, interval_secs: i64) -> Result<()> {
        let mut handles = self.handles.lock().expect("manager mutex poisoned");
        if handles.contains_key(&monitor_id) {
            return Ok(());
        }

        let eng = self.engine.clone();
        let throttle = Arc::new(Mutex::new(EventThrottle::default()));
        let watcher = watcher::spawn(root, DEBOUNCE, move || {
            fire_event(&eng, monitor_id, &throttle);
        })?;

        let stop = Arc::new(AtomicBool::new(false));
        let interval_thread = spawn_interval(self.engine.clone(), monitor_id, interval_secs, stop.clone());

        handles.insert(
            monitor_id,
            Handle { stop, interval_thread: Some(interval_thread), _watcher: watcher },
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
