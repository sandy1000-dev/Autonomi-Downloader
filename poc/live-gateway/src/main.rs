//! Live-network encrypted gateway blueprint.
//!
//! Uses `ant-core` to fetch raw encrypted chunks and DataMaps from the live
//! Autonomi network, then serves them over HTTP as raw binary.
//!
//! This gateway NEVER decrypts. It is a dumb encrypted transport.
//!
//! Run:
//!   cargo run --release
//!
//! Endpoints:
//!   GET /datamap/:address  -> msgpack DataMap bytes
//!   GET /chunk/:address    -> encrypted chunk bytes
//!   GET /health            -> peer count & gateway status
//!   GET /                  -> static files (index.html, wasm, etc.)
//!
//! The browser fetches from these endpoints, then decrypts locally in WASM.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use ant_core::data::{
    peer_cache::{self, BootstrapAddressFilter},
    Client, ClientConfig, CoreNodeConfig, IPDiversityConfig, NodeMode, P2PNode,
    MAX_WIRE_MESSAGE_SIZE,
};

/// Shared application state: the Autonomi network client.
struct AppState {
    client: Client,
    node: Arc<P2PNode>,
}

/// GET /health
///
/// Returns the current number of connected peers and a ready flag.
/// Useful for confirming the gateway has actually joined the network.
async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let peers = state.node.connected_peers().await.len();
    Json(serde_json::json!({
        "status": if peers > 0 { "ready" } else { "bootstrapping" },
        "connected_peers": peers,
    }))
}

/// GET /datamap/:address
///
/// Fetches the DataMap chunk from the live network and returns it as raw
/// msgpack bytes (exactly what the network stores).
async fn datamap_get(
    Path(addr_hex): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, StatusCode> {
    let addr = hex_to_bytes32(&addr_hex).map_err(|_| StatusCode::BAD_REQUEST)?;

    let data_map = state
        .client
        .data_map_fetch(&addr)
        .await
        .map_err(|e| {
            tracing::error!("data_map_fetch failed for {}: {e}", hex::encode(addr));
            StatusCode::NOT_FOUND
        })?;

    // Serialize to msgpack — same format the network uses for public DataMaps.
    let msgpack = rmp_serde::to_vec(&data_map).map_err(|e| {
        tracing::error!("msgpack serialize failed: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        msgpack,
    ))
}

/// GET /chunk/:address
///
/// Fetches a single encrypted chunk from the live network and returns the
/// raw encrypted bytes. The gateway never decrypts.
async fn chunk_get(
    Path(addr_hex): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, StatusCode> {
    let addr = hex_to_bytes32(&addr_hex).map_err(|_| StatusCode::BAD_REQUEST)?;

    let chunk = state
        .client
        .chunk_get(&addr)
        .await
        .map_err(|e| {
            tracing::error!("chunk_get failed for {}: {e}", hex::encode(addr));
            StatusCode::NOT_FOUND
        })?
        .ok_or(StatusCode::NOT_FOUND)?;

    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        chunk.content.to_vec(),
    ))
}

fn hex_to_bytes32(hex: &str) -> Result<[u8; 32], hex::FromHexError> {
    let bytes = hex::decode(hex)?;
    bytes.try_into().map_err(|_| hex::FromHexError::OddLength)
}

/// Replicate the bootstrap logic from `ant-cli` so the gateway has the same
/// reachability as the official client.
///
/// 1. Load cached bootstrap peers from disk (written by previous `ant-cli` or
///    gateway runs).
/// 2. Create a P2P node with those peers as bootstrap candidates.
/// 3. Start the node and promote the cache with newly-discovered peers.
/// 4. Wrap the node in a `Client`.
async fn build_client() -> Result<(Client, Arc<P2PNode>), Box<dyn std::error::Error>> {
    let use_peer_cache = true;
    let cache_path = peer_cache::cache_path();

    let mut core_config = CoreNodeConfig::builder()
        .port(0)
        .ipv6(true)
        .local(false)
        .mode(NodeMode::Client)
        .max_message_size(MAX_WIRE_MESSAGE_SIZE)
        .build()
        .map_err(|e| format!("Failed to create core config: {e}"))?;

    core_config.diversity_config = Some(IPDiversityConfig::permissive());

    let dht_k_value = core_config.dht_config.k_value;
    let cache_address_filter = BootstrapAddressFilter::All;
    let cached_bootstrap_peers = cache_path
        .as_deref()
        .map(|path| {
            peer_cache::cached_bootstrap_peers_with_filter(path, dht_k_value, cache_address_filter)
        })
        .unwrap_or_default();

    core_config.bootstrap_peers =
        peer_cache::select_bootstrap_peers(cached_bootstrap_peers, Vec::new());

    tracing::info!(
        "Bootstrapping with {} cached peer(s)",
        core_config.bootstrap_peers.len()
    );

    let node = P2PNode::new(core_config)
        .await
        .map_err(|e| format!("Failed to create P2P node: {e}"))?;
    let node = Arc::new(node);

    node.start()
        .await
        .map_err(|e| format!("Failed to start P2P node: {e}"))?;

    if use_peer_cache {
        if let Some(ref path) = cache_path {
            peer_cache::promote_connected_direct_peers(&node, path, node.dht().k_value()).await;
        }
    }

    let peers = node.connected_peers().await.len();
    tracing::info!("Connected to Autonomi network ({} peers)", peers);

    let config = ClientConfig::default();
    let client = Client::from_node_with_peer_cache(Arc::clone(&node), config, cache_path);

    Ok((client, node))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let (client, node) = build_client().await?;

    let state = Arc::new(AppState { client, node });

    // Static files are served from ../web relative to this crate root.
    // When running via `cargo run` the working directory is the crate root
    // (poc/live-gateway/), so ../web points at poc/web/.
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "../web".into());
    tracing::info!("Serving static files from: {}", static_dir);

    let app = Router::new()
        .route("/health", get(health))
        .route("/datamap/{address}", get(datamap_get))
        .route("/chunk/{address}", get(chunk_get))
        .fallback_service(
            ServeDir::new(&static_dir).append_index_html_on_directories(true),
        )
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8099").await?;
    tracing::info!("Gateway listening on http://localhost:8099");
    tracing::info!("NOTE: this gateway only serves encrypted bytes. It never decrypts.");

    axum::serve(listener, app).await?;
    Ok(())
}
