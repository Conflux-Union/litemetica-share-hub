mod auth;
mod config;
mod db;
mod error;
mod schematics;
mod state;
mod staticfiles;
mod textures;
mod utils;

use crate::config::Config;
use crate::state::AppState;
use axum::routing::{get, post};
use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("extract-textures") => {
            let config = load_config();
            let mut version = None;
            let mut jar: Option<PathBuf> = None;
            let mut it = args[2..].iter();
            while let Some(arg) = it.next() {
                match arg.as_str() {
                    "--version" => version = it.next().cloned(),
                    "--jar" => jar = it.next().map(PathBuf::from),
                    other => {
                        eprintln!("unknown flag: {other}");
                        std::process::exit(2);
                    }
                }
            }
            let opts = textures::TextureOptions {
                version,
                jar_path: jar,
                data_dir: resolve_data_dir(&config),
            };
            if let Err(e) = textures::run_extract_textures(opts).await {
                eprintln!("extract-textures failed: {e}");
                std::process::exit(1);
            }
        }
        Some(other) => {
            eprintln!("unknown subcommand: {other}");
            eprintln!(
                "usage: litemetica-share-hub [serve] | extract-textures [--version X] [--jar PATH]"
            );
            std::process::exit(2);
        }
        None => serve().await,
    }
}

fn load_config() -> Config {
    let path = std::env::var("LSH_CONFIG").unwrap_or_else(|_| "config.toml".into());
    Config::load(&path).unwrap_or_else(|e| {
        eprintln!("{e}\nhint: copy config.example.toml to config.toml and fill it in");
        std::process::exit(1);
    })
}

fn resolve_data_dir(config: &Config) -> PathBuf {
    let dir = &config.data_dir;
    std::fs::create_dir_all(dir).expect("create data dir");
    dir.clone()
}

async fn serve() {
    let config = load_config();
    let data_dir = resolve_data_dir(&config);
    let listen = config.listen.clone();
    let db = Arc::new(db::Db::open(&data_dir.join("hub.db")).expect("open database"));
    let storage =
        Arc::new(schematics::storage::Storage::new(&data_dir).expect("create storage dirs"));

    let app_state = AppState {
        config: Arc::new(config),
        db: db.clone(),
        storage,
        http: reqwest::Client::builder()
            .user_agent("litemetica-share-hub")
            .build()
            .expect("reqwest client"),
    };

    let max_body = (app_state.config.limits.max_upload_mb * 1024 * 1024) as usize;

    let api = Router::new()
        .route("/config", get(auth::sso::site_config))
        .route("/auth/login", get(auth::sso::login))
        .route("/auth/callback", get(auth::sso::callback))
        .route("/auth/me", get(auth::sso::me))
        .route("/auth/logout", post(auth::sso::logout))
        .route(
            "/schematics",
            get(schematics::list).post(schematics::upload),
        )
        .route(
            "/schematics/{id}",
            get(schematics::detail).delete(schematics::delete),
        )
        .route("/schematics/{id}/preview", get(schematics::preview))
        .route("/schematics/{id}/download", get(schematics::download))
        .route("/textures/manifest", get(textures::serve_manifest))
        .route("/textures/{name}", get(textures::serve_atlas));

    let app = Router::new()
        .nest("/api", api)
        .route("/oauth/callback", get(auth::sso::callback))
        .fallback(staticfiles::serve_static)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(axum::extract::DefaultBodyLimit::max(max_body))
        .with_state(app_state);

    // Periodic cleanup of stale download-log rows.
    {
        let db = db.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(600)).await;
                schematics::quota::cleanup(&db, 600);
            }
        });
    }

    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {listen}: {e}"));
    tracing::info!("listening on http://{listen}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("server error");
}
