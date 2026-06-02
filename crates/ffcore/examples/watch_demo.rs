use std::path::Path;
use std::time::Duration;

use ffcore::runner::MonitorManager;
use ffcore::Engine;

fn main() {
    let data = Path::new("/tmp/ffdemo-data");
    let proj = Path::new("/tmp/ffdemo-proj");
    let _ = std::fs::remove_dir_all(data);
    std::fs::create_dir_all(proj).unwrap();
    std::fs::write(proj.join("main.rs"), "fn main() {}\n").unwrap();

    let engine = Engine::open(data).unwrap();
    let id = engine.add_monitor(proj, 5, "manual").unwrap();
    engine.snapshot_now(id, "manual").unwrap();
    println!("initial: {} snapshot(s)", engine.list_snapshots(id).unwrap().len());

    let mgr = MonitorManager::new(engine.clone());
    mgr.start(id, proj, 5).unwrap();

    for i in 0..6 {
        std::thread::sleep(Duration::from_secs(3));
        std::fs::write(proj.join("main.rs"), format!("fn main() {{ /* edit {i} */ }}\n")).unwrap();
        let snaps = engine.list_snapshots(id).unwrap();
        let triggers: Vec<String> = snaps.iter().map(|s| s.trigger.clone()).collect();
        println!("after edit {i} (t+{}s): {} snapshot(s) {:?}", (i + 1) * 3, snaps.len(), triggers);
    }
}
