use crate::store::{delete_snapshot, BlobStore};
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
/// each past day to `snapshots_per_past_day` (today stays dense), then evict
/// oldest past-day snapshots until disk is under `max_disk_gb`. Orphan blobs
/// are freed by [`delete_snapshot`]; a final sweep catches any stragglers.
pub fn prune(db: &Db, store: &BlobStore, now: i64) -> Result<PruneStats> {
    let s = db.settings()?;
    let today = day_bucket(now);
    let mut stats = PruneStats::default();

    // 1. Age out anything past the retention window.
    let cutoff = now - s.retention_days * SECS_PER_DAY;
    for id in query_ids(db, "SELECT id FROM snapshots WHERE ts < ?1", [cutoff])? {
        delete_snapshot(db, store, id)?;
        stats.expired += 1;
    }

    // 2. Coalesce past days down to N representatives (first + last).
    let past_days: Vec<String> = query_strings(
        db,
        "SELECT DISTINCT day_bucket FROM snapshots WHERE day_bucket != ?1",
        [&today],
    )?;
    for day in past_days {
        let ids = query_ids(
            db,
            "SELECT id FROM snapshots WHERE day_bucket = ?1 ORDER BY ts, id",
            [&day],
        )?;
        for id in drop_indices(ids.len(), s.snapshots_per_past_day)
            .into_iter()
            .map(|i| ids[i])
        {
            delete_snapshot(db, store, id)?;
            stats.coalesced += 1;
        }
    }

    // 3. Evict oldest past-day snapshots until under the disk cap.
    let max_bytes = (s.max_disk_gb * 1e9) as i64;
    while disk_bytes(db)? > max_bytes {
        let oldest: Option<i64> = db
            .conn
            .query_row(
                "SELECT id FROM snapshots WHERE day_bucket != ?1 ORDER BY ts, id LIMIT 1",
                [&today],
                |r| r.get(0),
            )
            .ok();
        match oldest {
            Some(id) => {
                delete_snapshot(db, store, id)?;
                stats.capped += 1;
            }
            None => break, // only today's snapshots remain; never evict those
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
/// keep>=2 retains first+last; keep==1 retains last; keep<=0 retains last.
fn drop_indices(len: usize, keep: i64) -> Vec<usize> {
    if len == 0 || len as i64 <= keep.max(1) {
        return Vec::new();
    }
    let survivors: Vec<usize> = if keep >= 2 {
        vec![0, len - 1]
    } else {
        vec![len - 1]
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
}
