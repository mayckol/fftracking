use std::path::Path;

use ffcore::ignore::build_manifest;
use ffcore::store::BlobStore;

fn main() {
    let repo = std::env::args().nth(1).expect("usage: count <repo>");
    let root = Path::new(&repo);
    let tmp = std::env::temp_dir().join("ffcount-store");
    let _ = std::fs::remove_dir_all(&tmp);
    let store = BlobStore::new(&tmp).unwrap();

    for respect in [true, false] {
        let m = build_manifest(root, &store, &[], respect).unwrap();
        println!(
            "respect_gitignore={:<5} files={:<4} manifest_hash={}",
            respect,
            m.entries.len(),
            m.content_hash().unwrap()
        );
    }
}
