use axum::http::HeaderMap;
use std::net::SocketAddr;

/// Resolve the client IP: honor X-Forwarded-For only when explicitly trusted
/// (i.e. running behind a reverse proxy we control).
pub fn client_ip(headers: &HeaderMap, addr: SocketAddr, trust_xff: bool) -> String {
    if trust_xff {
        if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(first) = xff.split(',').next() {
                let ip = first.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
    }
    addr.ip().to_string()
}
