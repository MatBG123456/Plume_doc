# Intégrer le CLI `claude` comme backend IA (modèle « bring‑your‑own‑auth »)

> Guide réutilisable pour brancher **Claude Code** (le CLI `claude`) en arrière‑plan
> d'une application, de façon à ce que **chaque utilisateur consomme sa propre
> auth** (abonnement ou clé) au lieu d'une clé API centralisée. Tiré de
> l'implémentation de **Plume** (`src-tauri/src/chat.rs`).

---

## 1. Le principe

Au lieu d'appeler l'API Anthropic avec **une** clé (`ANTHROPIC_API_KEY`) que tu
fournis/factures, l'app **délègue au binaire `claude` local** que l'utilisateur a
lui‑même installé et authentifié. L'app :

1. **localise** le binaire `claude` ;
2. lui **passe un prompt** (l'état + la demande) ;
3. **récupère sa sortie** (texte et/ou actions structurées) ;
4. **applique** les actions via sa propre logique validée.

```
┌──────────┐  prompt (stdin)   ┌───────────────┐  inférence  ┌─────────┐
│  ton app │ ────────────────▶ │  claude -p    │ ───────────▶│ Anthropic│
│ (backend)│ ◀──────────────── │ (auth locale) │ ◀───────────│  (auth   │
└────┬─────┘  JSON (stdout)    └───────────────┘             │ de l'user)│
     │ applique les actions                                  └─────────┘
     ▼ (ton pipeline validé)
```

**Avantage clé :** tu ne centralises **aucune** crédential. Chaque utilisateur
branche son `claude`. C'est le pattern « bring‑your‑own‑auth », adapté à
l'**open source**.

---

## 2. Quand l'utiliser — et la limite à connaître ⚠️

Ce pattern convient à une app **locale**, **déclenchée par l'utilisateur**, où
chacun apporte son propre `claude`.

**Limite de conformité (à vérifier toi‑même dans les [CGU Anthropic](https://www.anthropic.com/legal)) :**
Anthropic encadre l'usage de l'abonnement (Pro/Max) et de Claude Code — pensé
pour un usage **interactif** de dev, **pas** comme backend d'inférence
programmatique, et **interdit** de *router des requêtes via les crédentials d'un
abonnement pour le compte d'autrui* ou d'offrir un « login Claude » dans un
produit. La nuance courante : un **job automatique/autonome** est plus
problématique qu'une **action déclenchée par l'utilisateur** sur **sa propre**
machine avec **son propre** `claude`. La voie pleinement *sanctionnée* pour un
produit reste l'**API** (clé, facturée au token).

➡️ **Recommandation :** rends ce mode **optionnel et désactivé par défaut**,
affiche un avertissement, et propose toujours l'**API key** comme alternative.

---

## 3. Détecter le binaire `claude` (cross‑platform)

Piège n°1 : sous **Windows**, une install **npm** de Claude Code ne crée **pas**
de `claude.exe` mais des **shims** `claude.cmd` / `claude.ps1`. Il faut donc
essayer plusieurs noms.

```rust
fn claude_candidates() -> &'static [&'static str] {
    if cfg!(windows) {
        &["claude.exe", "claude.cmd", "claude.bat", "claude.ps1", "claude"]
    } else {
        &["claude"]
    }
}

fn find_claude() -> Option<std::path::PathBuf> {
    // 1. Override explicite
    if let Ok(p) = std::env::var("APP_CLAUDE_BIN") {
        let pb = std::path::PathBuf::from(p);
        if pb.is_file() { return Some(pb); }
    }
    // 2. ~/.local/bin (install native)
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let bin = std::path::Path::new(&home).join(".local").join("bin");
        for name in claude_candidates() {
            let pb = bin.join(name);
            if pb.is_file() { return Some(pb); }
        }
    }
    // 3. PATH (couvre l'install npm globale)
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in claude_candidates() {
                let pb = dir.join(name);
                if pb.is_file() { return Some(pb); }
            }
        }
    }
    None
}
```

---

## 4. Le lancer — sans tomber dans les pièges

Piège n°2 : `CreateProcess` (Windows) **ne lance pas** directement un `.cmd` /
`.bat` / `.ps1` ; il faut passer par `cmd.exe /C` (ou `powershell -File`).

Piège n°3 (**inter‑blocage**) : si tu écris **tout** le prompt sur `stdin` *avant*
de lire `stdout`, un gros prompt peut saturer le pipe pendant que l'enfant tente
d'écrire sa sortie → blocage mutuel. **Écris `stdin` dans une tâche** pendant que
tu draines `stdout`/`stderr`.

```rust
/// Passe par cmd/powershell pour les shims, exécution directe sinon.
fn claude_command(path: &std::path::Path) -> tokio::process::Command {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(path); c
        }
        Some("ps1") => {
            let mut c = tokio::process::Command::new("powershell");
            c.arg("-NoProfile").arg("-ExecutionPolicy").arg("Bypass").arg("-File").arg(path); c
        }
        _ => tokio::process::Command::new(path),
    }
}

async fn run_claude(claude: &std::path::Path, prompt: String) -> std::io::Result<String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let mut cmd = claude_command(claude);
    cmd.arg("-p").arg("--output-format").arg("text")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn()?;

    // stdin écrit en parallèle du drain stdout → pas d'inter-blocage.
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await; // EOF : claude commence alors à répondre
        });
    }

    let out = child.wait_with_output().await?; // draine stdout/stderr en parallèle
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
```

> **Vérifié contre le vrai CLI** : `claude -p/--print` lit le **prompt sur stdin**
> (« Input must be provided either through stdin or as a prompt argument when using
> --print »), et `--output-format` accepte `"text"` (défaut), `"json"`,
> `"stream-json"`.

---

## 5. Faire faire des actions à Claude — deux approches

Ton app a sa propre logique (« insère un bloc », « modifie une cellule »…). Pour
que Claude la pilote, deux voies :

### A. Sortie structurée (recommandé pour démarrer) — *ce que fait Plume*

Tu **demandes au modèle de répondre par du JSON** (message + actions), tu le
**parses**, et tu appliques les actions par **ta propre logique validée**. Pas de
serveur tiers : simple et robuste.

1. **Prompt** : décris l'état (ex. document JSON) + le format des actions + la
   demande, et exige **un seul objet JSON sans prose** :

   ```
   Réponds par UN SEUL objet JSON, sans texte autour :
   {"message": "...", "ops": [ {"op":"InsertBlock", ...}, ... ]}
   ```

2. **Extraction tolérante** (le modèle ajoute parfois des ``` ou de la prose) :

   ```rust
   /// Premier objet JSON équilibré (ignore les accolades dans les strings).
   fn extract_json_object(s: &str) -> Option<&str> {
       let start = s.find('{')?;
       let (mut depth, mut in_str, mut esc) = (0i32, false, false);
       for (i, c) in s[start..].char_indices() {
           if in_str {
               if esc { esc = false; } else if c == '\\' { esc = true; } else if c == '"' { in_str = false; }
           } else {
               match c {
                   '"' => in_str = true,
                   '{' => depth += 1,
                   '}' => { depth -= 1; if depth == 0 { return Some(&s[start..start + i + c.len_utf8()]); } }
                   _ => {}
               }
           }
       }
       None
   }
   ```

3. **Applique** chaque action par **ta** validation (jamais d'écriture brute). En
   *best‑effort* : applique les valides, signale les invalides. (Tu peux ajouter
   un 2ᵉ tour en re‑promptant avec les erreurs pour l'auto‑correction.)

**Compromis :** un seul aller‑retour, pas de boucle d'outils native ; mais
zéro plomberie et tu réutilises ta logique existante.

### B. Outils MCP (tool‑use natif) — plus « propre », plus de plomberie

Claude Code sait appeler des **outils MCP**. Tu héberges un **serveur MCP**
(stdio/HTTP) exposant tes actions, et tu lances `claude` avec
`--mcp-config <fichier>` + `--allowedTools <noms>`. Claude appelle les outils ;
ton serveur exécute et renvoie le résultat. Plus fidèle au modèle « tool use »
(boucle d'auto‑correction native), mais il faut un serveur MCP qui rappelle
l'état de ton app (sidecar + IPC). Voir aussi le **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk` en Python) pour des outils
**in‑process** si ton backend est Node/Python.

---

## 6. Flags & formats utiles (validés)

| Besoin | Flag |
|---|---|
| Mode non‑interactif | `-p` / `--print` |
| Sortie texte (défaut) | `--output-format text` |
| Sortie JSON unique | `--output-format json` |
| Sortie **streaming** (NDJSON) | `--output-format stream-json` (+ `--verbose`) |
| Streaming des tokens | `--include-partial-messages` |
| Entrée streaming | `--input-format stream-json` |
| Prompt | sur **stdin** (recommandé pour les gros prompts) ou en argument |

`stream-json` émet des lignes JSON (init système, deltas de texte, `tool_use`,
résultats, fin). Pour du **texte brut** : ne pas mettre de flag (défaut `text`).

---

## 7. Auth & détection des providers

`claude` choisit son auth dans cet ordre (variables d'env, puis OAuth local de
`claude login`). Ton app n'a **pas** à gérer les crédentials : elle délègue.

Expose au front une **détection** pour proposer le bon choix :

```rust
#[derive(serde::Serialize)]
pub struct Providers { pub api_key: bool, pub claude_cli: bool }

#[tauri::command]
pub fn detect_providers() -> Providers {
    Providers {
        api_key: std::env::var("ANTHROPIC_API_KEY").map(|k| !k.is_empty()).unwrap_or(false),
        claude_cli: find_claude().is_some(),
    }
}
```

Et un **sélecteur** côté UI (`API key` ↔ `Claude Code local`), persisté, avec la
note de conformité quand le mode CLI est choisi.

---

## 8. Pièges à connaître (résumé)

- **Windows / npm** : `claude.cmd` (pas `.exe`) ; lancer via `cmd /C`. *(§3, §4)*
- **Inter‑blocage** stdin/stdout : écrire stdin en tâche concurrente. *(§4)*
- **stdin requis** : `claude -p` sans prompt **ni** stdin → erreur ; ferme stdin
  (EOF) pour qu'il réponde. *(§4)*
- **Sortie polluée** : le modèle ajoute parfois prose/```` ``` ```` → extraction
  tolérante. *(§5A)*
- **Best‑effort** : sans boucle d'outils, une action invalide est perdue ;
  signale‑la (et/ou re‑prompte). *(§5A)*
- **Bulle vide** : si la réponse n'a pas de `message`, n'affiche pas de bulle
  vide ; synthétise (« actions appliquées ») ou n'affiche rien.
- **Erreurs** : sur exit non‑zero, certains CLI écrivent sur **stdout** (pas
  stderr) — affiche les deux + le code de sortie.
- **Conformité** : voir §2. Mode optionnel, off par défaut, avertissement.

---

## 9. Référence : l'implémentation dans Plume

- `src-tauri/src/chat.rs` :
  - `find_claude`, `claude_candidates`, `claude_command` — localisation + lancement ;
  - `build_cli_prompt`, `extract_json_object`, `run_cli_agent` — sortie structurée ;
  - `detect_chat_providers`, `chat_send(messages, provider)` — providers `api`/`cli`.
- `src/editor/ChatPanel.tsx` — sélecteur de provider + note CGU.
- Le pipeline d'application réutilisé : `crates/plume-core` (`validate` → `apply`
  → `inverse`), partagé par les deux providers.
