use std::path::Path;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};

use crate::{Error, Result};

/// Recursive filesystem watcher. The debouncer coalesces bursts of events into
/// one callback per quiet window, so a "save all" or branch switch produces a
/// single snapshot instead of dozens.
pub struct FsWatcher {
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
}

pub fn spawn<F>(root: &Path, debounce: Duration, on_change: F) -> Result<FsWatcher>
where
    F: Fn() + Send + Sync + 'static,
{
    let mut debouncer = new_debouncer(debounce, None, move |result: DebounceEventResult| {
        if matches!(result, Ok(ref events) if !events.is_empty()) {
            on_change();
        }
    })
    .map_err(|e| Error::Msg(e.to_string()))?;

    debouncer
        .watcher()
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| Error::Msg(e.to_string()))?;

    Ok(FsWatcher { _debouncer: debouncer })
}
