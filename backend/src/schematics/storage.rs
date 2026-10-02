use std::io::Write;
use std::path::{Path, PathBuf};

pub fn new_schematic_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..10)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

pub struct Storage {
    root: PathBuf,
}

impl Storage {
    pub fn new(data_dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(data_dir.join("schematics"))?;
        std::fs::create_dir_all(data_dir.join("previews"))?;
        Ok(Storage {
            root: data_dir.to_path_buf(),
        })
    }

    pub fn schematic_path(&self, id: &str) -> PathBuf {
        self.root.join("schematics").join(format!("{id}.litematic"))
    }

    pub fn preview_path(&self, id: &str) -> PathBuf {
        self.root.join("previews").join(format!("{id}.json.gz"))
    }

    pub fn store_schematic(&self, id: &str, bytes: &[u8]) -> std::io::Result<()> {
        atomic_write(self.schematic_path(id), bytes)
    }

    pub fn store_preview(&self, id: &str, value: &serde_json::Value) -> std::io::Result<()> {
        let json = serde_json::to_vec(value)?;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&json)?;
        let compressed = gz.finish()?;
        atomic_write(self.preview_path(id), &compressed)
    }

    pub fn read_preview(&self, id: &str) -> std::io::Result<Vec<u8>> {
        std::fs::read(self.preview_path(id))
    }

    pub fn read_schematic(&self, id: &str) -> std::io::Result<Vec<u8>> {
        std::fs::read(self.schematic_path(id))
    }

    pub fn delete_all(&self, id: &str) {
        let _ = std::fs::remove_file(self.schematic_path(id));
        let _ = std::fs::remove_file(self.preview_path(id));
    }
}

fn atomic_write(path: PathBuf, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)
}
