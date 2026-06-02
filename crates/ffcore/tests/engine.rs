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
            SnapshotInput { monitor_id: self.monitor, trigger: "manual".into(), ts, manifest: m },
        )
        .unwrap()
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
