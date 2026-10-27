//! The `sync` Lambda function: push and pull over sync scopes (HLD §4).

#[tokio::main]
async fn main() -> Result<(), lambda_http::Error> {
    // JSON logs when the function's log format is JSON (set in CDK).
    lambda_http::tracing::init_default_subscriber();
    lambda_http::run(server::sync_router()).await
}
