use crate::auth::session::{
    build_session_cookie, clear_session_cookie, random_token, SESSION_COOKIE,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

const OAUTH_STATE_TTL_SECS: i64 = 600;

#[derive(Deserialize)]
pub struct LoginQuery {}

/// Redirect the browser to the SSO authorize endpoint with PKCE.
pub async fn login(
    State(state): State<AppState>,
    Query(_q): Query<LoginQuery>,
) -> AppResult<Response> {
    let oauth_state = random_token(24);
    let verifier = random_token(48); // 64 chars, within the 43..=128 PKCE range
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));

    let cfg = &state.config.sso;
    {
        let conn = state.db.0.lock().unwrap();
        // Best-effort cleanup of stale states.
        let _ = conn.execute(
            "DELETE FROM oauth_states WHERE created_at < ?1",
            [crate::db::Db::now() - OAUTH_STATE_TTL_SECS],
        );
        conn.execute(
            "INSERT INTO oauth_states (state, verifier, created_at) VALUES (?1, ?2, ?3)",
            (&oauth_state, &verifier, crate::db::Db::now()),
        )?;
    }

    let url = format!(
        "{}/oauth/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        cfg.base_url.trim_end_matches('/'),
        urlencode(&cfg.client_id),
        urlencode(&cfg.redirect_uri),
        urlencode("openid profile email"),
        urlencode(&oauth_state),
        urlencode(&challenge),
    );
    Ok(Redirect::to(&url).into_response())
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_description: Option<String>,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(serde::Deserialize)]
struct UserInfo {
    #[serde(default)]
    sub: Option<String>,
    username: String,
    #[serde(default)]
    nickname: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    permission_level: Option<i64>,
}

/// OAuth callback: exchange code -> token -> userinfo -> local session.
pub async fn callback(
    State(state): State<AppState>,
    Query(q): Query<CallbackQuery>,
) -> AppResult<Response> {
    let fail = |msg: &str| -> Response {
        Redirect::to(&format!("/?login_error={}", urlencode(msg))).into_response()
    };

    let Some(code) = q.code else {
        let msg = q
            .error_description
            .or(q.error)
            .unwrap_or_else(|| "missing code".into());
        return Ok(fail(&format!("sso 登录失败: {msg}")));
    };
    let Some(oauth_state) = q.state else {
        return Ok(fail("缺少 state 参数"));
    };

    // Verify + consume the state, recover the PKCE verifier.
    let verifier = {
        let conn = state.db.0.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT verifier, created_at FROM oauth_states WHERE state = ?1",
                [&oauth_state],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|e| AppError::Internal(format!("db: {e}")))?;
        match row {
            Some((verifier, created)) if created >= crate::db::Db::now() - OAUTH_STATE_TTL_SECS => {
                conn.execute("DELETE FROM oauth_states WHERE state = ?1", [&oauth_state])?;
                verifier
            }
            _ => return Ok(fail("state 已过期或无效，请重新登录")),
        }
    };

    let cfg = state.config.sso.clone();
    let token_url = format!("{}/oauth/token", cfg.base_url.trim_end_matches('/'));
    let token_resp: TokenResponse = state
        .http
        .post(&token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", cfg.client_id.as_str()),
            ("client_secret", cfg.client_secret.as_str()),
            ("redirect_uri", cfg.redirect_uri.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await?
        .error_for_status()
        .map_err(|e| AppError::Internal(format!("sso token exchange failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("sso token decode failed: {e}")))?;

    let userinfo_url = format!("{}/oauth/userinfo", cfg.base_url.trim_end_matches('/'));
    let userinfo: UserInfo = state
        .http
        .get(&userinfo_url)
        .bearer_auth(&token_resp.access_token)
        .send()
        .await?
        .error_for_status()
        .map_err(|e| AppError::Internal(format!("sso userinfo failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("sso userinfo decode failed: {e}")))?;

    let sub = userinfo.sub.ok_or_else(|| {
        AppError::Internal("sso userinfo missing sub; check openid scope on the client".into())
    })?;
    let user = state.db.upsert_user(
        &sub,
        &userinfo.username,
        userinfo.nickname.as_deref().unwrap_or(&userinfo.username),
        userinfo.avatar_url.as_deref(),
        userinfo.permission_level.unwrap_or(1),
    )?;

    let session_token = random_token(32);
    state
        .db
        .create_session(&session_token, user.id, token_resp.refresh_token.as_deref())?;

    let mut resp = Redirect::to("/").into_response();
    resp.headers_mut().insert(
        header::SET_COOKIE,
        build_session_cookie(&session_token, 7 * 24 * 3600),
    );
    Ok(resp)
}

pub async fn me(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> AppResult<Json<serde_json::Value>> {
    let user = crate::auth::session::current_user(&state, &headers).await?;
    Ok(Json(json!({ "user": user })))
}

pub async fn logout(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> AppResult<Response> {
    if let Some(token) = crate::auth::session::session_token(&headers) {
        if let Ok(Some(refresh)) = state.db.delete_session(&token) {
            // Revoke the SSO refresh token; failure here should not block local logout.
            let cfg = state.config.sso.clone();
            let http = state.http.clone();
            tokio::spawn(async move {
                let url = format!("{}/oauth/revoke", cfg.base_url.trim_end_matches('/'));
                let _ = http
                    .post(&url)
                    .form(&[
                        ("token", refresh.as_str()),
                        ("client_id", cfg.client_id.as_str()),
                        ("client_secret", cfg.client_secret.as_str()),
                    ])
                    .send()
                    .await;
            });
        }
    }
    let mut resp = (StatusCode::OK, Json(json!({ "ok": true }))).into_response();
    resp.headers_mut()
        .insert(header::SET_COOKIE, clear_session_cookie());
    Ok(resp)
}

/// Public site config for the frontend.
pub async fn site_config(State(state): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "site_name": state.config.site_name,
        "download_per_ip": state.config.limits.download_per_ip,
        "download_window_secs": state.config.limits.download_window_secs,
        "max_upload_mb": state.config.limits.max_upload_mb,
    })))
}

pub fn urlencode(s: &str) -> String {
    // Minimal percent-encoding for query values.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// Keep the cookie name referenced so the constant stays in one place.
#[allow(dead_code)]
const _: &str = SESSION_COOKIE;

use rusqlite::OptionalExtension;
