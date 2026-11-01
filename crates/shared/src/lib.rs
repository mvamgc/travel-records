//! Types and protocols shared by the client (wasm32) and the server (native).
//!
//! Everything here must build for both targets, so it holds plain data and
//! logic only: no I/O, no async runtime, no platform APIs.

use serde::{Deserialize, Serialize};

/// Path of the health check, served by every HTTP function.
pub const HEALTH_PATH: &str = "/api/health";

/// Response body of `GET /api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    /// The function that answered, such as `sync`.
    pub service: String,
    /// The server's package version.
    pub version: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_round_trips_through_json() {
        let health = Health {
            service: "sync".into(),
            version: "0.1.0".into(),
        };
        let json = serde_json::to_string(&health).unwrap();
        assert_eq!(json, r#"{"service":"sync","version":"0.1.0"}"#);
        assert_eq!(serde_json::from_str::<Health>(&json).unwrap(), health);
    }
}
