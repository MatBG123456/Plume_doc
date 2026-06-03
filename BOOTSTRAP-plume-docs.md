# BOOTSTRAP — Atelier **Plume** (équivalent Word)

> Éditeur de documents riches, *AI-native*. L'app n'est qu'un renderer fin ; l'intelligence vit dans Claude. Architecture **B** : Claude n'écrit jamais de fichier brut, il émet des **opérations structurées validées** contre un schéma.
>
> Codename libre à renommer. Suite : Plume (docs) · Treillis (sheets) · Scène (slides).

---

## 0. Comment démarrer dans Claude Code

1. Place ce fichier à la racine d'un repo vide sous le nom `BOOTSTRAP.md`.
2. Ouvre Claude Code dans ce dossier.
3. Prompt de lancement :
   > « Lis `BOOTSTRAP.md` en entier. Exécute **Wave 0**, puis arrête-toi et liste ce qui a été fait. J'enchaînerai les waves une par une. »
4. **Règle d'or** : une wave = un commit ; tests verts avant de passer à la suivante ; jamais de saut de wave.

---

## 1. Principe (archi B)

- **Source de vérité** = un modèle de document typé en Rust, sérialisé en JSON natif (`.plume.json`).
- Claude reçoit l'état + une boîte d'**outils = opérations**. Il renvoie des `tool_use`. Le cœur Rust **valide** chaque op puis l'**applique** (reducer pur). Op invalide → renvoyée en `tool_result` d'erreur → Claude se corrige seul.
- **Bénéfices** : undo/redo (chaque op a son inverse), preview live, diff propre, intégrité garantie (le modèle ne touche jamais le disque).
- **UX hybride** : la frappe directe dans l'UI produit *exactement les mêmes ops* → undo et collab uniformes. On ne tape pas tout au chat ; le chat sert au génératif / transform / bulk.

---

## 2. Stack (vérifie les versions au build, l'écosystème bouge)

| Couche | Choix |
|---|---|
| Shell | **Tauri 2.x** (cœur Rust + webview) |
| Front | React + Vite + TypeScript + **Tailwind** (DS Claude : tokens sobres, typographie soignée, peu de chrome) |
| Core | crate Rust `plume-core` (modèle, ops, validate, apply, export). Types exportés vers TS via **`ts-rs`** |
| IA | API **Anthropic Messages**, tool use + streaming, appelée **côté Rust** (clé `ANTHROPIC_API_KEY` jamais exposée au webview) |
| Modèle | défaut `claude-sonnet-4-6` (constante de config ; confirme la dernière version Sonnet sur https://docs.claude.com/en/api/overview) |

> Si tu montes les 3 apps en monorepo plus tard, factorise le pattern `Op / validate / apply / inverse` dans un crate `atelier-core` partagé.

---

## 3. Modèle de document

```rust
// plume-core :: model.rs  — l'ordre du Vec<Block> = l'ordre du document
struct Document { meta: Meta, blocks: Vec<Block> }
struct Meta     { title: String, lang: String }              // lang: "fr", "en"...
struct Block    { id: BlockId, node: Node }                  // BlockId = ULID stable, jamais réutilisé
enum Node {
    Paragraph { runs: Vec<Run> },
    Heading   { level: u8 /* 1..=6 */, runs: Vec<Run> },
    ListItem  { ordered: bool, level: u8 /* 0..=5 */, runs: Vec<Run> },
    Quote     { runs: Vec<Run> },
    CodeBlock { lang: Option<String>, text: String },
    Table     { rows: Vec<Vec<Cell>> },                      // rectangulaire : toutes lignes = même largeur
    Image     { src: String, alt: String, width_pct: Option<u8> },
    PageBreak,
}
struct Run  { text: String, marks: Marks }                   // segment inline + styles
struct Marks{ bold: bool, italic: bool, underline: bool, strike: bool,
              code: bool, link: Option<String>, color: Option<String> /* hex #RRGGBB */ }
struct Cell { runs: Vec<Run> }
```

**Pourquoi pas de l'OOXML en natif :** illisible/instable pour un LLM. Le JSON ci-dessus est la vérité ; `.docx` n'est qu'une cible d'export (§7).

---

## 4. Opérations (= surface d'outils exposée à Claude)

Source unique de vérité. **1 op ⇒ 1 outil Anthropic** (le `input_schema` de l'outil = les champs de la variante).

```rust
// plume-core :: ops.rs
enum Op {
    InsertBlock  { at: usize, block: Block },                // insère à l'index `at`
    DeleteBlock  { id: BlockId },
    MoveBlock    { id: BlockId, to: usize },
    SetNode      { id: BlockId, node: Node },                // remplace contenu + type du bloc
    SetRuns      { id: BlockId, runs: Vec<Run> },            // remplace texte + marks du bloc
    ApplyMark    { id: BlockId, range: (usize, usize), mark: MarkPatch }, // marque sur un range de caractères
    SetTableCell { id: BlockId, row: usize, col: usize, runs: Vec<Run> },
    SetMeta      { title: Option<String>, lang: Option<String> },
}
struct MarkPatch { bold: Option<bool>, italic: Option<bool>, underline: Option<bool>,
                   strike: Option<bool>, code: Option<bool>,
                   link: Option<Option<String>>, color: Option<Option<String>> } // None = inchangé
```

> Le ciblage se fait **par `BlockId`**, jamais par offset global fragile. `range` d'`ApplyMark` est exprimé sur le texte concaténé des runs du bloc.

---

## 5. Validation (avant `apply`, sinon `tool_result` d'erreur)

- `id` référencé **existe** ; `at` / `to` ∈ `[0, blocks.len()]`.
- `range = (a,b)` : `a ≤ b ≤ len(texte_concaténé(bloc))`.
- `Heading.level ∈ 1..=6` ; `ListItem.level ∈ 0..=5`.
- `Table` rectangulaire (toutes les lignes de même largeur) ; `row`/`col` dans les bornes.
- `color` = hex `#RRGGBB` valide ; `link` = URL absolue valide.
- Toute erreur renvoie `{ ok: false, reason: "..." }` à Claude pour auto-correction (n'altère pas l'état).

---

## 6. Boucle agent (Tauri command `chat_send`)

```
1. messages = historique de la conversation ; tools = [un outil par variante d'Op]
2. POST https://api.anthropic.com/v1/messages  (stream SSE)  — header x-api-key côté Rust uniquement
3. Collecte les blocs `text` (→ event "assistant_text") et `tool_use`
4. Pour chaque tool_use :
      op = parse(tool_use.input)
      match validate(op, &state):
        Ok  -> state = apply(op, state);  push undo_stack(inverse(op));
               event "op_applied" (preview live) ; tool_result = { ok:true, doc_version }
        Err -> tool_result = { ok:false, reason }
5. Append (assistant turn) + (user turn = tool_results) ; reboucle tant que stop_reason != "end_turn"
```

**Garde-fous :** aucune écriture disque par le modèle ; seules les ops validées mutent l'état ; tout passe par `apply`.

---

## 7. Export / Import

- **Markdown** ⇄ natif (trivial, c'est quasi un iso-morphisme du modèle).
- **`.docx`** via `docx-rs` (mapper Node → éléments OOXML).
- **PDF** : rendu webview → `tauri` print-to-pdf (ou sidecar `typst`/`weasyprint` pour pagination fine).
- Import `.docx` (v2) : `docx-rs` en lecture → reconstruire le modèle.

---

## 8. Plan de build (waves)

| Wave | Livrable | Critère d'acceptation |
|---|---|---|
| **W0** | Scaffold Tauri 2 + Vite + React + TS + Tailwind ; crate `plume-core` ; une command Tauri `ping` testée end-to-end | `npm run tauri dev` ouvre une fenêtre ; `ping` répond depuis Rust |
| **W1** | Modèle (§3) + `serde` + doc vide + `ts-rs` | round-trip JSON ⇄ struct ; types TS générés |
| **W2** | `Op` + `validate` + `apply` + `inverse` (undo) | tests unitaires : insert / delete / move / setruns / applymark + inverse rejoue l'état initial |
| **W3** | Renderer React : blocks → composants DS, curseur, sélection | un doc fixture s'affiche fidèlement |
| **W4** | Édition directe : frappe → `SetRuns`/`ApplyMark` ; Entrée → `InsertBlock` ; toolbar marks | éditer au clavier passe par le pipeline d'ops |
| **W5** | Boucle agent (§6) + 8 outils = 8 ops + panneau chat streaming | « mets le titre en gras et ajoute un paragraphe d'intro » fonctionne via Claude |
| **W6** | Persistance `.plume.json` (open / save / autosave) | fermer/rouvrir conserve tout |
| **W7** | Export Markdown + `.docx` + PDF | les 3 exports ouvrent sans corruption |
| **W8** | Polish : undo/redo UI (Cmd+Z), palette de commandes, recherche, raccourcis | undo multi-niveaux fiable |

---

## 9. Conventions

- Rust : `cargo fmt` + `clippy -D warnings` ; reducer **pur** (pas d'I/O dans `apply`).
- Tests d'ops obligatoires en W2 (c'est le cœur de l'intégrité).
- Commits : `wave(N): …`. Un commit par wave, tests verts.
- Le modèle Claude ne reçoit **que** l'état + les outils ; il ne voit jamais le filesystem.

### ▶ Première action (Wave 0)
Scaffold le projet Tauri 2 (Rust + Vite/React/TS/Tailwind), crée le crate `plume-core`, expose une command `ping() -> String` et vérifie l'aller-retour dans la webview. Puis stop et résume.
