use crate::config::Config;
use crate::db::Db;
use crate::schematics::storage::Storage;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Arc<Db>,
    pub storage: Arc<Storage>,
    pub http: reqwest::Client,
}
