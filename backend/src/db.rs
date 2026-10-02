use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub nickname: String,
    pub avatar_url: Option<String>,
    pub permission_level: i64,
}

#[derive(Debug, Clone)]
pub struct SchematicRow {
    pub id: String,
    pub uploader_id: i64,
    pub original_filename: String,
    pub size_bytes: i64,
    pub name: String,
    pub author: String,
    pub description: String,
    pub mc_data_version: i64,
    pub mc_version_name: String,
    pub litematica_version: i64,
    pub width: i64,
    pub height: i64,
    pub depth: i64,
    pub region_count: i64,
    pub total_blocks: i64,
    pub created_at: i64,
}

pub struct Db(pub Mutex<Connection>);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sso_sub TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar_url TEXT,
    permission_level INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sso_refresh_token TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schematics (
    id TEXT PRIMARY KEY,
    uploader_id INTEGER NOT NULL REFERENCES users(id),
    original_filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    name TEXT NOT NULL,
    author TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    mc_data_version INTEGER NOT NULL,
    mc_version_name TEXT NOT NULL,
    litematica_version INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    region_count INTEGER NOT NULL,
    total_blocks INTEGER NOT NULL,
    material_list TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schematics_created ON schematics(created_at DESC);
CREATE TABLE IF NOT EXISTS download_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schematic_id TEXT NOT NULL,
    ip TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_download_ip_time ON download_log(ip, created_at);
CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"#;

impl Db {
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db(Mutex::new(conn)))
    }

    pub fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    pub fn upsert_user(
        &self,
        sub: &str,
        username: &str,
        nickname: &str,
        avatar_url: Option<&str>,
        permission_level: i64,
    ) -> Result<User, rusqlite::Error> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO users (sso_sub, username, nickname, avatar_url, permission_level, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(sso_sub) DO UPDATE SET
                username = excluded.username,
                nickname = excluded.nickname,
                avatar_url = excluded.avatar_url,
                permission_level = excluded.permission_level",
            (sub, username, nickname, avatar_url, permission_level, Self::now()),
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, username, nickname, avatar_url, permission_level FROM users WHERE sso_sub = ?1",
        )?;
        stmt.query_row([sub], |row| {
            Ok(User {
                id: row.get(0)?,
                username: row.get(1)?,
                nickname: row.get(2)?,
                avatar_url: row.get(3)?,
                permission_level: row.get(4)?,
            })
        })
    }

    pub fn create_session(
        &self,
        token: &str,
        user_id: i64,
        refresh_token: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let now = Self::now();
        self.0.lock().unwrap().execute(
            "INSERT INTO sessions (token, user_id, sso_refresh_token, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            (token, user_id, refresh_token, now + 7 * 24 * 3600, now),
        )?;
        Ok(())
    }

    pub fn session_user(&self, token: &str) -> Result<Option<User>, rusqlite::Error> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT u.id, u.username, u.nickname, u.avatar_url, u.permission_level
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token = ?1 AND s.expires_at > ?2",
        )?;
        let mut rows = stmt.query(rusqlite::params![token, Self::now()])?;
        match rows.next()? {
            Some(row) => Ok(Some(User {
                id: row.get(0)?,
                username: row.get(1)?,
                nickname: row.get(2)?,
                avatar_url: row.get(3)?,
                permission_level: row.get(4)?,
            })),
            None => Ok(None),
        }
    }

    pub fn delete_session(&self, token: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.0.lock().unwrap();
        let refresh = conn
            .query_row(
                "SELECT sso_refresh_token FROM sessions WHERE token = ?1",
                [token],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?;
        conn.execute("DELETE FROM sessions WHERE token = ?1", [token])?;
        Ok(refresh.flatten())
    }
}
