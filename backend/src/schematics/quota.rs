use crate::db::Db;
use crate::error::AppError;

/// Count downloads from `ip` inside the sliding window.
pub fn window_count(db: &Db, ip: &str, window_secs: u64) -> Result<u32, AppError> {
    let conn = db.0.lock().unwrap();
    let cutoff = Db::now() - window_secs as i64;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM download_log WHERE ip = ?1 AND created_at > ?2",
        (ip, cutoff),
        |r| r.get(0),
    )?;
    Ok(count as u32)
}

/// Record a download and enforce the per-IP quota. Returns Ok on allowance.
pub fn check_and_consume(
    db: &Db,
    ip: &str,
    schematic_id: &str,
    limit: u32,
    window_secs: u64,
) -> Result<(), AppError> {
    let conn = db.0.lock().unwrap();
    let cutoff = Db::now() - window_secs as i64;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM download_log WHERE ip = ?1 AND created_at > ?2",
        (ip, cutoff),
        |r| r.get(0),
    )?;
    if count as u32 >= limit {
        // Seconds until the oldest entry in the window ages out.
        let oldest: Option<i64> = conn
            .query_row(
                "SELECT MIN(created_at) FROM download_log WHERE ip = ?1 AND created_at > ?2",
                (ip, cutoff),
                |r| r.get(0),
            )
            .unwrap_or(None);
        let retry = oldest
            .map(|t| (t + window_secs as i64 - Db::now()).max(1))
            .unwrap_or(window_secs as i64);
        return Err(AppError::TooManyRequests {
            retry_after_secs: retry as u64,
        });
    }
    conn.execute(
        "INSERT INTO download_log (schematic_id, ip, created_at) VALUES (?1, ?2, ?3)",
        (schematic_id, ip, Db::now()),
    )?;
    Ok(())
}

/// Best-effort periodic cleanup of stale download log rows.
pub fn cleanup(db: &Db, window_secs: u64) {
    let conn = db.0.lock().unwrap();
    let cutoff = Db::now() - (window_secs as i64) * 10;
    let _ = conn.execute("DELETE FROM download_log WHERE created_at < ?1", [cutoff]);
}
