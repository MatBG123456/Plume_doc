//! `plume-core` — cœur de Plume.
//!
//! À ce stade (Wave 0), le crate n'expose que [`ping`], qui sert à valider
//! l'aller-retour end-to-end entre le webview, la command Tauri et le Rust.
//!
//! Les waves suivantes y ajouteront les opérations (`ops`), la validation, le
//! reducer `apply` / `inverse` et les exports. Le *reducer* devra rester
//! **pur** (aucune I/O).

pub mod model;

pub use model::{Block, BlockId, Cell, Document, Marks, Meta, Node, Run};

/// Réponse au `ping` de Wave 0 : prouve que le cœur Rust est joignable.
///
/// ```
/// assert_eq!(plume_core::ping(), "pong from plume-core");
/// ```
pub fn ping() -> String {
    format!("pong from {}", env!("CARGO_PKG_NAME"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_repond_pong() {
        assert_eq!(ping(), "pong from plume-core");
    }
}
