use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized(&'static str),
    Forbidden(&'static str),
    NotFound,
    TooManyRequests { retry_after_secs: u64 },
    Internal(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::BadRequest(m) => write!(f, "bad request: {m}"),
            AppError::Unauthorized(m) => write!(f, "unauthorized: {m}"),
            AppError::Forbidden(m) => write!(f, "forbidden: {m}"),
            AppError::NotFound => write!(f, "not found"),
            AppError::TooManyRequests { .. } => write!(f, "rate limited"),
            AppError::Internal(m) => write!(f, "internal error: {m}"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message, extra) = match &self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone(), None),
            AppError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m.to_string(), None),
            AppError::Forbidden(m) => (StatusCode::FORBIDDEN, m.to_string(), None),
            AppError::NotFound => (StatusCode::NOT_FOUND, "resource not found".into(), None),
            AppError::TooManyRequests { retry_after_secs } => (
                StatusCode::TOO_MANY_REQUESTS,
                format!("download quota exceeded for your IP, retry after {retry_after_secs}s"),
                Some(format!("Retry-After: {retry_after_secs}")),
            ),
            AppError::Internal(m) => {
                tracing::error!("internal error: {m}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".into(),
                    None,
                )
            }
        };
        let mut resp = (status, Json(json!({ "error": message }))).into_response();
        if let Some(header) = extra {
            if let Ok(v) = header.parse() {
                resp.headers_mut()
                    .insert(axum::http::HeaderName::from_static("retry-after"), v);
            }
        }
        resp
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Internal(format!("db: {e}"))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Internal(format!("http: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(format!("io: {e}"))
    }
}
