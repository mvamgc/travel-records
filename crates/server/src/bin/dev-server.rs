//! Local development server: every router under `/api` on localhost
//! (ADR-0005 decision 4). `trunk serve` proxies `/api` here, so local
//! development is same-origin, like CloudFront in AWS.

use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let port = std::env::var("PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("dev-server listening on http://{addr}");
    axum::serve(listener, server::dev_router()).await
}
