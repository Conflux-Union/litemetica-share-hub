use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../frontend/dist/"]
struct FrontendAssets;

/// Serve embedded frontend assets with an SPA fallback to index.html.
pub async fn serve_static(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = FrontendAssets::get(path) {
        return asset_response(path, &file);
    }
    // SPA fallback: unknown non-API paths get the app shell.
    match FrontendAssets::get("index.html") {
        Some(file) => {
            let mut resp = asset_response("index.html", &file);
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-cache"),
            );
            resp
        }
        None => (StatusCode::NOT_FOUND, "frontend not built").into_response(),
    }
}

fn asset_response(path: &str, file: &rust_embed::EmbeddedFile) -> Response {
    let mime = mime_from_ext(path);
    let mut resp = (StatusCode::OK, file.data.to_vec()).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(mime)
            .unwrap_or(header::HeaderValue::from_static("application/octet-stream")),
    );
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=3600"),
    );
    resp
}

fn mime_from_ext(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        "ico" => "image/x-icon",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}
