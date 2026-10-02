pub mod parse;
pub mod quota;
pub mod storage;

use crate::auth::session::current_user;
use crate::db::{Db, SchematicRow};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::utils::client_ip;

use axum::extract::{ConnectInfo, Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;

fn row_to_summary(row: &SchematicRow, uploader: &str) -> serde_json::Value {
    json!({
        "id": row.id,
        "name": row.name,
        "author": row.author,
        "description": row.description,
        "uploader": uploader,
        "size_bytes": row.size_bytes,
        "mc_version_name": row.mc_version_name,
        "mc_data_version": row.mc_data_version,
        "litematica_version": row.litematica_version,
        "width": row.width,
        "height": row.height,
        "depth": row.depth,
        "region_count": row.region_count,
        "total_blocks": row.total_blocks,
        "created_at": row.created_at,
    })
}

fn get_row(db: &Db, id: &str) -> AppResult<SchematicRow> {
    let conn = db.0.lock().unwrap();
    conn.query_row(SCHEMATIC_COLS, [id], |row| {
        Ok(SchematicRow {
            id: row.get(0)?,
            uploader_id: row.get(1)?,
            original_filename: row.get(2)?,
            size_bytes: row.get(3)?,
            name: row.get(4)?,
            author: row.get(5)?,
            description: row.get(6)?,
            mc_data_version: row.get(7)?,
            mc_version_name: row.get(8)?,
            litematica_version: row.get(9)?,
            width: row.get(10)?,
            height: row.get(11)?,
            depth: row.get(12)?,
            region_count: row.get(13)?,
            total_blocks: row.get(14)?,
            created_at: row.get(15)?,
        })
    })
    .map_err(|_| AppError::NotFound)
}

const SCHEMATIC_COLS: &str = "SELECT id, uploader_id, original_filename, size_bytes, name, author, description, \
     mc_data_version, mc_version_name, litematica_version, width, height, depth, region_count, total_blocks, created_at \
     FROM schematics WHERE id = ?1";

fn uploader_name(db: &Db, user_id: i64) -> String {
    let conn = db.0.lock().unwrap();
    conn.query_row("SELECT nickname FROM users WHERE id = ?1", [user_id], |r| {
        r.get(0)
    })
    .unwrap_or_else(|_| "未知用户".into())
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub size: Option<u32>,
    #[serde(default)]
    pub q: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let page = q.page.unwrap_or(1).max(1);
    let size = q.size.unwrap_or(24).clamp(1, 100);
    let pattern = format!(
        "%{}%",
        q.q.as_deref().unwrap_or("").trim().replace('%', "\\%")
    );

    let (total, items) = {
        let conn = state.db.0.lock().unwrap();
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schematics WHERE name LIKE ?1 ESCAPE '\\' OR author LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\'",
            [&pattern],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.uploader_id, s.original_filename, s.size_bytes, s.name, s.author, s.description, \
             s.mc_data_version, s.mc_version_name, s.litematica_version, s.width, s.height, s.depth, s.region_count, s.total_blocks, s.created_at, u.nickname \
             FROM schematics s JOIN users u ON u.id = s.uploader_id \
             WHERE s.name LIKE ?1 ESCAPE '\\' OR s.author LIKE ?1 ESCAPE '\\' OR s.description LIKE ?1 ESCAPE '\\' \
             ORDER BY s.created_at DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![pattern, size as i64, ((page - 1) * size) as i64],
            |row| {
                let mut r = parse_full_row(row)?;
                let uploader: String = row.get(16)?;
                r.1 = uploader;
                Ok(r)
            },
        )?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(AppError::from)?);
        }
        (total, items)
    };
    let list: Vec<serde_json::Value> = items
        .iter()
        .map(|(row, uploader)| row_to_summary(row, uploader))
        .collect();
    Ok(Json(
        json!({ "total": total, "page": page, "size": size, "items": list }),
    ))
}

fn parse_full_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(SchematicRow, String)> {
    let r = SchematicRow {
        id: row.get(0)?,
        uploader_id: row.get(1)?,
        original_filename: row.get(2)?,
        size_bytes: row.get(3)?,
        name: row.get(4)?,
        author: row.get(5)?,
        description: row.get(6)?,
        mc_data_version: row.get(7)?,
        mc_version_name: row.get(8)?,
        litematica_version: row.get(9)?,
        width: row.get(10)?,
        height: row.get(11)?,
        depth: row.get(12)?,
        region_count: row.get(13)?,
        total_blocks: row.get(14)?,
        created_at: row.get(15)?,
    };
    Ok((r, String::new()))
}

pub async fn detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> AppResult<Json<serde_json::Value>> {
    let row = get_row(&state.db, &id)?;
    let uploader = uploader_name(&state.db, row.uploader_id);

    let user = current_user(&state, &headers).await?;
    let anonymous_remaining = if user.is_some() {
        None
    } else {
        let used = quota::window_count(
            &state.db,
            &client_ip(&headers, addr, state.config.limits.trust_x_forwarded_for),
            state.config.limits.download_window_secs,
        )?;
        Some(state.config.limits.download_per_ip.saturating_sub(used))
    };

    let materials: serde_json::Value = {
        let conn = state.db.0.lock().unwrap();
        let raw: String = conn.query_row(
            "SELECT material_list FROM schematics WHERE id = ?1",
            [&id],
            |r| r.get(0),
        )?;
        serde_json::from_str(&raw).unwrap_or(json!([]))
    };

    let mut summary = row_to_summary(&row, &uploader);
    let obj = summary.as_object_mut().unwrap();
    obj.insert("original_filename".into(), json!(row.original_filename));
    obj.insert("materials".into(), materials);
    obj.insert(
        "can_delete".into(),
        json!(user.map(|u| u.id == row.uploader_id).unwrap_or(false)),
    );
    obj.insert("download_remaining".into(), anonymous_remaining.into());

    Ok(Json(summary))
}

pub async fn upload(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> AppResult<Json<serde_json::Value>> {
    let user = current_user(&state, &headers)
        .await?
        .ok_or(AppError::Unauthorized("登录后才能上传"))?;
    if user.permission_level < state.config.limits.min_permission_level {
        return Err(AppError::Forbidden("账号权限不足，无法上传"));
    }

    let mut file_bytes: Option<Vec<u8>> = None;
    let mut filename = String::new();
    let mut description_override: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("上传内容无效: {e}")))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                filename = field.file_name().unwrap_or("upload.litematic").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::BadRequest(format!("读取文件失败: {e}")))?;
                file_bytes = Some(data.to_vec());
            }
            "description" => {
                description_override = field
                    .text()
                    .await
                    .ok()
                    .map(|t| t.trim().chars().take(500).collect());
            }
            _ => {}
        }
    }

    let bytes = file_bytes.ok_or_else(|| AppError::BadRequest("缺少文件字段".into()))?;
    if !filename.to_lowercase().ends_with(".litematic") {
        return Err(AppError::BadRequest("仅支持 .litematic 文件".into()));
    }
    let max = state.config.limits.max_upload_mb * 1024 * 1024;
    if bytes.len() as u64 > max {
        return Err(AppError::BadRequest(format!(
            "文件过大（上限 {} MB）",
            state.config.limits.max_upload_mb
        )));
    }
    // Defend against path traversal from the client-provided filename.
    let safe_filename = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("upload.litematic")
        .to_string();

    // Parsing may take a while for large schematics; keep it off the async workers.
    let size_bytes = bytes.len() as i64;
    let (bytes, parsed_result) = tokio::task::spawn_blocking(move || {
        let result = parse::parse_litematic(&bytes);
        (bytes, result)
    })
    .await
    .map_err(|e| AppError::Internal(format!("解析任务失败: {e}")))?;
    let parsed = parsed_result.map_err(AppError::BadRequest)?;

    let id = storage::new_schematic_id();
    state.storage.store_schematic(&id, &bytes)?;
    state.storage.store_preview(
        &id,
        &serde_json::to_value(&parsed.preview).map_err(|e| AppError::Internal(e.to_string()))?,
    )?;

    let description = description_override.unwrap_or(parsed.description.clone());
    let materials_json =
        serde_json::to_string(&parsed.materials).map_err(|e| AppError::Internal(e.to_string()))?;

    {
        let conn = state.db.0.lock().unwrap();
        conn.execute(
            "INSERT INTO schematics (id, uploader_id, original_filename, size_bytes, name, author, description, \
             mc_data_version, mc_version_name, litematica_version, width, height, depth, region_count, total_blocks, material_list, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            rusqlite::params![
                id,
                user.id,
                safe_filename,
                size_bytes,
                parsed.name,
                parsed.author,
                description,
                parsed.mc_data_version,
                parsed.mc_version_name,
                parsed.litematica_version,
                parsed.width,
                parsed.height,
                parsed.depth,
                parsed.region_count as i64,
                parsed.total_blocks as i64,
                materials_json,
                Db::now(),
            ],
        )?;
    }

    Ok(Json(json!({ "id": id })))
}

pub async fn preview(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    // Validate the id exists before touching the filesystem.
    get_row(&state.db, &id)?;
    let data = state
        .storage
        .read_preview(&id)
        .map_err(|_| AppError::NotFound)?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/gzip"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        data,
    )
        .into_response())
}

pub async fn download(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> AppResult<Response> {
    let row = get_row(&state.db, &id)?;
    let user = current_user(&state, &headers).await?;
    if user.is_none() {
        let ip = client_ip(&headers, addr, state.config.limits.trust_x_forwarded_for);
        quota::check_and_consume(
            &state.db,
            &ip,
            &id,
            state.config.limits.download_per_ip,
            state.config.limits.download_window_secs,
        )?;
    }
    let bytes = state
        .storage
        .read_schematic(&id)
        .map_err(|_| AppError::NotFound)?;
    let download_name = format!(
        "{}.litematic",
        row.name.replace(['/', '\\', '\0', '"'], "_")
    );
    let mut resp = bytes.into_response();
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&format!(
            "attachment; filename=\"{}\"; filename*=UTF-8''{}",
            download_name,
            crate::auth::sso::urlencode(&download_name)
        ))
        .map_err(|_| AppError::Internal("invalid download filename".into()))?,
    );
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    Ok(resp)
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> AppResult<Json<serde_json::Value>> {
    let user = current_user(&state, &headers)
        .await?
        .ok_or(AppError::Unauthorized("登录后才能删除"))?;
    let row = get_row(&state.db, &id)?;
    if row.uploader_id != user.id {
        return Err(AppError::Forbidden("只能删除自己上传的原理图"));
    }
    {
        let conn = state.db.0.lock().unwrap();
        conn.execute("DELETE FROM schematics WHERE id = ?1", [&id])?;
        conn.execute("DELETE FROM download_log WHERE schematic_id = ?1", [&id])?;
    }
    state.storage.delete_all(&id);
    Ok(Json(json!({ "ok": true })))
}
