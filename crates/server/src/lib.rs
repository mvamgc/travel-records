//! Server library: one axum router per concern (ADR-0005 decision 3).
//!
//! Each Lambda binary serves one router through `lambda_http`; `dev-server`
//! mounts all of them on localhost. Routes live under `/api/…`, so CloudFront
//! forwards paths unchanged.

use axum::{Json, Router, routing::get};
use shared::{HEALTH_PATH, Health};

/// Routes of the `sync` function. For now only the health check.
pub fn sync_router() -> Router {
    Router::new().route(HEALTH_PATH, get(|| health("sync")))
}

/// All routers together, as `dev-server` serves them.
pub fn dev_router() -> Router {
    sync_router()
}

async fn health(service: &str) -> Json<Health> {
    Json(Health {
        service: service.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request, http::StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn sync_answers_the_health_check() {
        let response = sync_router()
            .oneshot(Request::get(HEALTH_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let health: Health = serde_json::from_slice(&body).unwrap();
        assert_eq!(health.service, "sync");
        assert_eq!(health.version, env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn unknown_paths_are_not_found() {
        let response = dev_router()
            .oneshot(Request::get("/api/nope").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
