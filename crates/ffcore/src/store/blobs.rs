use std::fs;
use std::path::{Path, PathBuf};

use crate::Result;

/// Content-addressed blob store. Files live at `<root>/objects/<aa>/<hash>`
/// where `aa` is the first two hex chars of the blake3 hash (sharding keeps
/// any single directory small). Identical content maps to one file regardless
/// of how many snapshots reference it.
pub struct BlobStore {
    objects: PathBuf,
}

impl BlobStore {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let objects = root.as_ref().join("objects");
        fs::create_dir_all(&objects)?;
        Ok(Self { objects })
    }

    pub fn hash(data: &[u8]) -> String {
        blake3::hash(data).to_hex().to_string()
    }

    pub fn objects_dir(&self) -> &Path {
        &self.objects
    }

    fn path(&self, hash: &str) -> PathBuf {
        self.objects.join(&hash[..2]).join(hash)
    }

    pub fn exists(&self, hash: &str) -> bool {
        self.path(hash).exists()
    }

    /// Writes `data` and returns its hash. No-op when the blob already exists.
    /// Write-to-temp + rename so a crash never leaves a partial blob.
    pub fn put(&self, data: &[u8]) -> Result<String> {
        let hash = Self::hash(data);
        let dest = self.path(&hash);
        if dest.exists() {
            return Ok(hash);
        }
        let dir = dest.parent().expect("blob path has parent");
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("{hash}.tmp"));
        fs::write(&tmp, data)?;
        fs::rename(&tmp, &dest)?;
        Ok(hash)
    }

    pub fn get(&self, hash: &str) -> Result<Vec<u8>> {
        Ok(fs::read(self.path(hash))?)
    }

    pub fn remove(&self, hash: &str) -> Result<()> {
        let p = self.path(hash);
        if p.exists() {
            fs::remove_file(p)?;
        }
        Ok(())
    }
}
