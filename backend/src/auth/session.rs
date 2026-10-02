use crate::{error::AppResult, state::AppState};

use axum::http::header::{HeaderValue, COOKIE};

pub const SESSION_COOKIE: &str = "lsh_session";

/// Extract the local session token from the Cookie header, if present.
pub fn session_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(COOKIE)?.to_str().ok()?;
    for pair in raw.split(';') {
        let mut parts = pair.trim().splitn(2, '=');
        if parts.next()? == SESSION_COOKIE {
            return parts.next().map(|v| v.to_string());
        }
    }
    None
}

/// Resolve the current user from the session cookie.
pub async fn current_user(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> AppResult<Option<crate::db::User>> {
    match session_token(headers) {
        Some(token) => Ok(state
            .db
            .session_user(&token)
            .map_err(crate::error::AppError::from)?),
        None => Ok(None),
    }
}

pub fn build_session_cookie(token: &str, max_age_secs: i64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}"
    ))
    .expect("session cookie header must be valid")
}

pub fn clear_session_cookie() -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    ))
    .expect("clear cookie header must be valid")
}

pub fn random_token(n_bytes: usize) -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut buf = vec![0u8; n_bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}
