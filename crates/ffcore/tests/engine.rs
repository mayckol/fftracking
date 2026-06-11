use ffcore::store::prune::prune;
use ffcore::store::{create_snapshot, BlobStore, Manifest, SnapshotInput};
use ffcore::Db;

const DAY: i64 = 86_400;
const NOW: i64 = 1_700_000_000; // fixed clock for deterministic day buckets

struct Env {
    db: Db,
    store: BlobStore,
    _tmp: tempfile::TempDir,
    monitor: i64,
    seq: u64,
}

impl Env {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let store = BlobStore::new(tmp.path()).unwrap();
        let db = Db::open_in_memory().unwrap();
        let monitor = db.add_monitor("/tmp/proj", 900, "manual", NOW).unwrap();
        Self { db, store, _tmp: tmp, monitor, seq: 0 }
    }

    /// Snapshot of three files; `vary` makes the tree distinct from the
    /// previous snapshot so it is not skipped as a no-op.
    fn snap(&mut self, ts: i64, vary: bool) -> Option<i64> {
        let monitor = self.monitor;
        self.snap_for(monitor, ts, vary)
    }

    fn snap_for(&mut self, monitor: i64, ts: i64, vary: bool) -> Option<i64> {
        if vary {
            self.seq += 1;
        }
        let mut m = Manifest::default();
        m.add_file(&self.store, "a.txt", 0o644, b"alpha").unwrap();
        m.add_file(&self.store, "b.txt", 0o644, b"beta").unwrap();
        m.add_file(&self.store, "c.txt", 0o644, format!("c-{}", self.seq).as_bytes())
            .unwrap();
        create_snapshot(
            &self.db,
            &self.store,
            SnapshotInput { monitor_id: monitor, trigger: "manual".into(), ts, manifest: m },
        )
        .unwrap()
    }

    fn label(&self, snapshot_id: i64, label: &str) {
        self.db
            .conn
            .execute("UPDATE snapshots SET label = ?1 WHERE id = ?2", (label, snapshot_id))
            .unwrap();
    }

    fn blob_count(&self) -> i64 {
        self.db
            .conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0))
            .unwrap()
    }

    fn snap_count(&self) -> i64 {
        self.db
            .conn
            .query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get(0))
            .unwrap()
    }

    fn snaps_on(&self, day_offset: i64) -> i64 {
        let day = ffcore::day_bucket(NOW + day_offset * DAY);
        self.db
            .conn
            .query_row("SELECT COUNT(*) FROM snapshots WHERE day_bucket = ?1", [day], |r| {
                r.get(0)
            })
            .unwrap()
    }
}

#[test]
fn identical_resnapshot_is_skipped_and_dedups() {
    let mut e = Env::new();

    assert!(e.snap(NOW, true).is_some(), "first snapshot recorded");
    // a.txt + b.txt + c.txt + manifest = 4 blobs
    assert_eq!(e.blob_count(), 4);

    assert!(e.snap(NOW + 1, false).is_none(), "unchanged tree is skipped");
    assert_eq!(e.blob_count(), 4, "no new blobs for an unchanged tree");

    assert!(e.snap(NOW + 2, true).is_some(), "changed tree recorded");
    // only c.txt content + the new manifest are added; a/b are shared
    assert_eq!(e.blob_count(), 6);
}

#[test]
fn prune_expires_coalesces_caps_and_gcs() {
    let mut e = Env::new();

    e.snap(NOW - 40 * DAY, true); // beyond 30d retention

    for i in 0..3 {
        e.snap(NOW - 3 * DAY + i * 60, true); // day -3
    }
    for i in 0..3 {
        e.snap(NOW - 2 * DAY + i * 60, true); // day -2
    }
    for i in 0..3 {
        e.snap(NOW + i * 60, true); // today
    }
    assert_eq!(e.snap_count(), 10);

    let stats = prune(&e.db, &e.store, NOW).unwrap();
    assert_eq!(stats.expired, 1, "the >30d snapshot is dropped");
    assert_eq!(stats.coalesced, 2, "each past day 3->2");
    assert_eq!(e.snaps_on(-3), 2);
    assert_eq!(e.snaps_on(-2), 2);
    assert_eq!(e.snaps_on(0), 3, "today stays dense");
    assert_eq!(e.snap_count(), 7);

    // No orphan blobs survive a prune.
    let orphans: i64 = e
        .db
        .conn
        .query_row("SELECT COUNT(*) FROM blobs WHERE refcount <= 0", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orphans, 0);

    // Tighten the cap to near-zero: every past-day snapshot is evicted,
    // today's are protected.
    e.db.set_setting("max_disk_gb", "0.0000000001").unwrap();
    let stats = prune(&e.db, &e.store, NOW).unwrap();
    assert_eq!(stats.capped, 4, "all four past-day snapshots evicted");
    assert_eq!(e.snaps_on(0), 3, "cap never evicts today");
    assert_eq!(e.snap_count(), 3);
}

#[test]
fn coalesce_is_scoped_per_monitor() {
    let mut e = Env::new();
    let m2 = e.db.add_monitor("/tmp/proj2", 900, "manual", NOW).unwrap();

    // Same past day, two monitors, three snapshots each.
    for i in 0..3 {
        e.snap(NOW - 2 * DAY + i * 60, true);
    }
    for i in 0..3 {
        e.snap_for(m2, NOW - 2 * DAY + i * 60 + 10, true);
    }
    assert_eq!(e.snap_count(), 6);

    let stats = prune(&e.db, &e.store, NOW).unwrap();
    assert_eq!(stats.coalesced, 2, "each monitor coalesces 3->2 independently");

    let per_monitor = |id: i64| -> i64 {
        e.db.conn
            .query_row("SELECT COUNT(*) FROM snapshots WHERE monitor_id = ?1", [id], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(per_monitor(e.monitor), 2, "monitor 1 keeps its own first+last");
    assert_eq!(per_monitor(m2), 2, "monitor 2 keeps its own first+last");
}

#[test]
fn coalesce_honors_points_per_past_day_setting() {
    let mut e = Env::new();
    e.db.set_setting("snapshots_per_past_day", "4").unwrap();

    for i in 0..8 {
        e.snap(NOW - 2 * DAY + i * 60, true);
    }
    let stats = prune(&e.db, &e.store, NOW).unwrap();
    assert_eq!(stats.coalesced, 4, "8 -> 4 per the setting, not hardcoded 2");
    assert_eq!(e.snaps_on(-2), 4);
}

#[test]
fn labeled_snapshots_survive_every_prune_stage() {
    let mut e = Env::new();

    // Beyond retention, labeled → survives expiry.
    let expired_candidate = e.snap(NOW - 40 * DAY, true).unwrap();
    e.label(expired_candidate, "before refactor");

    // Middle of a past day, labeled → survives coalescing.
    e.snap(NOW - 2 * DAY, true);
    let mid = e.snap(NOW - 2 * DAY + 60, true).unwrap();
    e.label(mid, "checkpoint");
    e.snap(NOW - 2 * DAY + 120, true);

    let stats = prune(&e.db, &e.store, NOW).unwrap();
    assert_eq!(stats.expired, 0, "labeled point outlives the retention window");
    assert_eq!(stats.coalesced, 0, "two unlabeled + one labeled is already within keep=2");
    assert_eq!(e.snap_count(), 4);

    // Near-zero disk cap → unlabeled past-day points evicted, labeled kept.
    e.db.set_setting("max_disk_gb", "0.0000000001").unwrap();
    let stats = prune(&e.db, &e.store, NOW).unwrap();
    assert_eq!(stats.capped, 2, "only the unlabeled past-day points are evicted");
    let labels: i64 = e
        .db
        .conn
        .query_row("SELECT COUNT(*) FROM snapshots WHERE label IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(labels, 2, "labeled breaking points are never auto-pruned");
}
