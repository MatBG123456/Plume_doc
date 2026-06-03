//! Shell Tauri de Plume. Expose les commands invoquées par le webview.
//!
//! Wave 0 : une seule command, [`ping`], qui délègue au cœur `plume-core`.
//! La logique métier ne vit jamais ici — `src-tauri` n'est qu'un pont entre
//! le webview et `plume-core`.

/// Command `ping` exposée au front via `invoke("ping")`.
///
/// Délègue à [`plume_core::ping`] pour prouver l'aller-retour
/// webview → Tauri → cœur Rust.
#[tauri::command]
fn ping() -> String {
    plume_core::ping()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Plume");
}
