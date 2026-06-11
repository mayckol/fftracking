use crate::store::{delete_snapshot, delete_snapshots, BlobStore};
use crate::{day_bucket, Db, Result};

const SECS_PER_DAY: i64 = 86_400;

#[derive(Debug, Default, Clone, Copy)]
pub struct PruneStats {
    pub expired: usize,
    pub coalesced: usize,
    pub capped: usize,
}

impl PruneStats {
    pub fn total(&self) -> usize {
        self.expired + self.coalesced + self.capped
    }
}

/// Enforces retention: drop snapshots older than `retention_days`, coalesce
/// each monitor's past days to `snapshots_per_past_day` (today stays dense),
/// then evict oldest past-day snapshots until disk is under `max_disk_gb`.
/// Labeled breaking points are never auto-pruned — a user named them on
/// purpose, so only an explicit delete removes them. Orphan blobs are freed
/// by [`delete_snapshot`]; a final sweep catches any stragglers.
pub fn prune(db: &Db, store: &BlobStore, now: i64) -> Result<PruneStats> {
    let s = db.settings()?;
    let today = day_bucket(now);
    let mut stats = PruneStats::default();

    // 1. Age out anything past the retention window.
    let cutoff = now - s.retention_days * SECS_PER_DAY;
    let expired = query_ids(db, "SELECT id FROM snapshots WHERE ts < ?1 AND label IS NULL", [cutoff])?;
    delete_snapshots(db, store, &expired)?;
    stats.expired = expired.len();

    // 2. Coalesce each monitor's past days down to N evenly spaced
    // representatives. Grouping must include the monitor: a shared day bucket
    // would otherwise let one monitor's snapshots evict another's.
    let monitor_days: Vec<(i64, String)> = {
        let mut stmt = db.conn.prepare(
            "SELECT DISTINCT monitor_id, day_bucket FROM snapshots WHERE day_bucket != ?1",
        )?;
        let rows = stmt.query_map([&today], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut coalesce: Vec<i64> = Vec::new();
    for (monitor_id, day) in monitor_days {
        let mut stmt = db.conn.prepare(
            "SELECT id FROM snapshots
             WHERE monitor_id = ?1 AND day_bucket = ?2 AND label IS NULL
             ORDER BY ts, id",
        )?;
        let ids = stmt
            .query_map((monitor_id, &day), |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        coalesce.extend(drop_indices(ids.len(), s.snapshots_per_past_day).into_iter().map(|i| ids[i]));
    }
    delete_snapshots(db, store, &coalesce)?;
    stats.coalesced = coalesce.len();

    // 3. Evict oldest past-day snapshots until under the disk cap.
    let max_bytes = (s.max_disk_gb * 1e9) as i64;
    while disk_bytes(db)? > max_bytes {
        let oldest: Option<i64> = db
            .conn
            .query_row(
                "SELECT id FROM snapshots
                 WHERE day_bucket != ?1 AND label IS NULL
                 ORDER BY ts, id LIMIT 1",
                [&today],
                |r| r.get(0),
            )
            .ok();
        match oldest {
            Some(id) => {
                delete_snapshot(db, store, id)?;
                stats.capped += 1;
            }
            None => break, // only today's or labeled snapshots remain; never evict those
        }
    }

    // 4. Sweep any orphaned blobs (defensive; refs are decremented inline).
    for hash in query_strings(db, "SELECT hash FROM blobs WHERE refcount <= 0", [])? {
        store.remove(&hash)?;
        db.conn.execute("DELETE FROM blobs WHERE hash = ?1", [&hash])?;
    }

    Ok(stats)
}

fn disk_bytes(db: &Db) -> Result<i64> {
    Ok(db.conn.query_row(
        "SELECT COALESCE(SUM(size), 0) FROM blobs WHERE refcount > 0",
        [],
        |r| r.get(0),
    )?)
}

/// Indices to delete when coalescing a day's `len` snapshots to `keep`.
/// Survivors are spread evenly across the day (first and last always kept
/// when keep >= 2); keep<=1 retains only the last.
fn drop_indices(len: usize, keep: i64) -> Vec<usize> {
    let keep = keep.max(1) as usize;
    if len <= keep {
        return Vec::new();
    }
    let survivors: std::collections::HashSet<usize> = if keep == 1 {
        std::iter::once(len - 1).collect()
    } else {
        (0..keep).map(|i| i * (len - 1) / (keep - 1)).collect()
    };
    (0..len).filter(|i| !survivors.contains(i)).collect()
}

fn query_ids<P: rusqlite::Params>(db: &Db, sql: &str, params: P) -> Result<Vec<i64>> {
    let mut stmt = db.conn.prepare(sql)?;
    let rows = stmt.query_map(params, |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn query_strings<P: rusqlite::Params>(db: &Db, sql: &str, params: P) -> Result<Vec<String>> {
    let mut stmt = db.conn.prepare(sql)?;
    let rows = stmt.query_map(params, |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_keeps_first_and_last() {
        assert_eq!(drop_indices(5, 2), vec![1, 2, 3]);
        assert_eq!(drop_indices(2, 2), Vec::<usize>::new());
        assert_eq!(drop_indices(4, 1), vec![0, 1, 2]);
        assert_eq!(drop_indices(1, 2), Vec::<usize>::new());
    }

    #[test]
    fn drop_honors_keep_above_two() {
        // keep=3 over 5: survivors evenly spaced at 0, 2, 4.
        assert_eq!(drop_indices(5, 3), vec![1, 3]);
        // keep=4 over 7: survivors at 0, 2, 4, 6.
        assert_eq!(drop_indices(7, 4), vec![1, 3, 5]);
        // already at or under the target → nothing dropped.
        assert_eq!(drop_indices(3, 3), Vec::<usize>::new());
        assert_eq!(drop_indices(2, 5), Vec::<usize>::new());
    }
}
