use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct ResourceUsage {
    /// Process CPU usage, percent of a single core (can exceed 100 on multi-core).
    pub cpu_percent: f32,
    pub mem_bytes: u64,
}

/// Samples this process's own CPU + memory. CPU is measured over the interval
/// between successive [`SelfMonitor::sample`] calls, so the caller should poll
/// at a steady cadence.
pub struct SelfMonitor {
    sys: System,
    pid: Pid,
}

impl Default for SelfMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl SelfMonitor {
    pub fn new() -> Self {
        Self { sys: System::new(), pid: Pid::from_u32(std::process::id()) }
    }

    pub fn sample(&mut self) -> ResourceUsage {
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[self.pid]),
            true,
            ProcessRefreshKind::new().with_cpu().with_memory(),
        );
        match self.sys.process(self.pid) {
            Some(p) => ResourceUsage { cpu_percent: p.cpu_usage(), mem_bytes: p.memory() },
            None => ResourceUsage::default(),
        }
    }
}
