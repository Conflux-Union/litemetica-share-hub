use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub listen: String,
    pub data_dir: PathBuf,
    pub site_name: String,
    pub sso: SsoConfig,
    #[serde(default)]
    pub limits: LimitsConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SsoConfig {
    pub base_url: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LimitsConfig {
    pub download_per_ip: u32,
    pub download_window_secs: u64,
    pub max_upload_mb: u64,
    /// Cap on the gzip-inflated NBT size of an uploaded schematic. This is
    /// the real memory bound of parsing: a small uploaded file can inflate
    /// a hundredfold.
    #[serde(default = "default_max_decompressed_mb")]
    pub max_decompressed_mb: u64,
    pub min_permission_level: i64,
    pub trust_x_forwarded_for: bool,
}

/// Default for [`LimitsConfig::max_decompressed_mb`]; also usable directly
/// by offline code paths (regen CLI, tests).
pub const DEFAULT_MAX_DECOMPRESSED_MB: u64 = 512;

fn default_max_decompressed_mb() -> u64 {
    DEFAULT_MAX_DECOMPRESSED_MB
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            download_per_ip: 3,
            download_window_secs: 60,
            max_upload_mb: 64,
            max_decompressed_mb: DEFAULT_MAX_DECOMPRESSED_MB,
            min_permission_level: 1,
            trust_x_forwarded_for: false,
        }
    }
}

impl Config {
    pub fn load(path: &str) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read config file {path}: {e}"))?;
        toml::from_str(&raw).map_err(|e| format!("cannot parse config file {path}: {e}"))
    }
}
