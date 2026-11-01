//! Travel Records PWA (Leptos CSR, HLD §2).
//!
//! The walking skeleton shows whether the device is online and what the
//! server's health check answers. Everything else about the app is still to
//! come; the point is that it boots offline and reaches the API through the
//! same origin.

use leptos::prelude::*;
use shared::{HEALTH_PATH, Health};

fn main() {
    console_error_panic_hook::set_once();
    register_service_worker();
    leptos::mount::mount_to_body(App);
}

/// Registers the service worker that caches the app shell (REQ-018).
///
/// Debug builds from `trunk serve` skip it, so live reload never meets a
/// stale cache.
fn register_service_worker() {
    if cfg!(debug_assertions) {
        return;
    }
    // A failed registration is logged by the browser; the app works without it.
    let _ = window().navigator().service_worker().register("/sw.js");
}

#[component]
fn App() -> impl IntoView {
    let (online, set_online) = signal(window().navigator().on_line());
    let _ = window_event_listener(leptos::ev::online, move |_| set_online.set(true));
    let _ = window_event_listener(leptos::ev::offline, move |_| set_online.set(false));

    // Asks again whenever the device comes back online.
    let health = LocalResource::new(move || async move {
        if online.get() {
            Some(fetch_health().await)
        } else {
            None
        }
    });

    view! {
        <main>
            <h1>"Travel Records"</h1>
            <p class="status">
                {move || {
                    if online.get() {
                        "Online"
                    } else {
                        "Offline. Everything on this device still works."
                    }
                }}
            </p>
            <p class="server">
                <Suspense fallback=|| "Asking the server…">
                    {move || {
                        health
                            .get()
                            .map(|answer| match answer {
                                None => "The server will be asked once you're online.".to_owned(),
                                Some(Ok(health)) => {
                                    format!("Server: {} {}", health.service, health.version)
                                }
                                Some(Err(error)) => format!("Server unreachable: {error}"),
                            })
                    }}
                </Suspense>
            </p>
            <button on:click=move |_| health.refetch()>"Ask again"</button>
        </main>
    }
}

async fn fetch_health() -> Result<Health, String> {
    let response = gloo_net::http::Request::get(HEALTH_PATH)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Err(format!("HTTP {}", response.status()));
    }
    response.json().await.map_err(|error| error.to_string())
}
