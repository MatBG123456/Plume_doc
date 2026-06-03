# Plume

> Éditeur de documents riches **AI-native** (équivalent Word). L'application n'est qu'un *renderer* fin : l'intelligence vit dans Claude.

Plume est le premier volet d'une suite bureautique **Atelier** :

| App | Domaine | Statut |
|---|---|---|
| **Plume** | Documents texte (équivalent Word) | En cours |
| **Treillis** | Tableurs (équivalent Excel) | Prévu |
| **Scène** | Présentations (équivalent PowerPoint) | Prévu |

---

## Sommaire

- [Principe](#principe)
- [Pourquoi cette architecture](#pourquoi-cette-architecture)
- [Stack technique](#stack-technique)
- [Architecture du projet](#architecture-du-projet)
- [Modèle de document](#modèle-de-document)
- [Opérations & validation](#opérations--validation)
- [Boucle agent](#boucle-agent)
- [Export / Import](#export--import)
- [Démarrage](#démarrage)
- [Feuille de route](#feuille-de-route)
- [Conventions de développement](#conventions-de-développement)
- [Documentation complémentaire](#documentation-complémentaire)

---

## Principe

Plume repose sur une **architecture B** : Claude n'écrit **jamais** de fichier brut. Il émet des **opérations structurées**, validées contre un schéma typé, puis appliquées par un cœur Rust.

- **Source de vérité** : un modèle de document typé en Rust, sérialisé en JSON natif (`.plume.json`).
- Claude reçoit l'**état du document** + une boîte d'**outils = opérations**. Il renvoie des `tool_use`. Le cœur Rust **valide** chaque opération puis l'**applique** via un *reducer* pur. Une opération invalide est renvoyée en `tool_result` d'erreur → Claude se corrige seul.
- **UX hybride** : la frappe directe dans l'interface produit *exactement les mêmes opérations* que le chat. Undo, redo et collaboration sont donc uniformes. On ne tape pas tout au chat ; le chat sert au génératif, à la transformation et aux opérations en masse.

```
┌──────────┐   tool_use (Op)   ┌───────────────────────────┐
│  Claude  │ ────────────────▶ │  plume-core (Rust)        │
│ (API)    │                   │  validate → apply → inverse│
│          │ ◀──────────────── │  (reducer pur, sans I/O)  │
└──────────┘   tool_result     └───────────┬───────────────┘
                                           │ events (preview live)
                                           ▼
                                ┌───────────────────────┐
                                │  UI React (renderer)  │
                                │  frappe → mêmes Ops   │
                                └───────────────────────┘
```

## Pourquoi cette architecture

- **Undo/redo gratuit** : chaque opération possède son inverse.
- **Preview live** : l'UI réagit aux events `op_applied` au fil du stream.
- **Diff propre** et **intégrité garantie** : le modèle ne touche jamais le disque.
- **Pas d'OOXML natif** : le format Word est illisible/instable pour un LLM. Le JSON typé est la vérité ; `.docx` n'est qu'une cible d'export.

## Stack technique

> ⚠️ Vérifie les versions au moment du build, l'écosystème bouge vite.

| Couche | Choix |
|---|---|
| Shell | **Tauri 2.x** (cœur Rust + webview) |
| Front | React + Vite + TypeScript + **Tailwind** (design system sobre, typographie soignée, peu de chrome) |
| Core | crate Rust `plume-core` (modèle, ops, validate, apply, export). Types exportés vers TS via **`ts-rs`** |
| IA | API **Anthropic Messages**, *tool use* + streaming, appelée **côté Rust** (la clé `ANTHROPIC_API_KEY` n'est jamais exposée au webview) |
| Modèle par défaut | `claude-sonnet-4-6` (constante de config ; confirmer la dernière version sur la [doc Anthropic](https://docs.claude.com/en/api/overview)) |

## Architecture du projet

```
Plume_doc/
├── README.md                  # Ce document
├── BOOTSTRAP-plume-docs.md    # Spécification complète + plan de build par waves
│
└── (à scaffolder — voir Wave 0)
    ├── src/                   # Front React + Vite + TS + Tailwind
    ├── src-tauri/             # Shell Tauri (commands : ping, chat_send, open, save…)
    └── crates/plume-core/     # Modèle, ops, validate, apply, inverse, export
```

> Si les 3 apps de la suite passent en monorepo, factoriser le pattern `Op / validate / apply / inverse` dans un crate partagé `atelier-core`.

## Modèle de document

Le document est un `Vec<Block>` ordonné. L'ordre du vecteur = l'ordre du document.

```rust
// plume-core :: model.rs
struct Document { meta: Meta, blocks: Vec<Block> }
struct Meta     { title: String, lang: String }              // lang: "fr", "en"...
struct Block    { id: BlockId, node: Node }                  // BlockId = ULID stable, jamais réutilisé
enum Node {
    Paragraph { runs: Vec<Run> },
    Heading   { level: u8 /* 1..=6 */, runs: Vec<Run> },
    ListItem  { ordered: bool, level: u8 /* 0..=5 */, runs: Vec<Run> },
    Quote     { runs: Vec<Run> },
    CodeBlock { lang: Option<String>, text: String },
    Table     { rows: Vec<Vec<Cell>> },                      // rectangulaire
    Image     { src: String, alt: String, width_pct: Option<u8> },
    PageBreak,
}
struct Run  { text: String, marks: Marks }                   // segment inline + styles
struct Marks{ bold: bool, italic: bool, underline: bool, strike: bool,
              code: bool, link: Option<String>, color: Option<String> /* #RRGGBB */ }
struct Cell { runs: Vec<Run> }
```

## Opérations & validation

**Source unique de vérité** de la surface d'outils exposée à Claude : **1 opération ⇒ 1 outil Anthropic** (l'`input_schema` de l'outil = les champs de la variante).

```rust
// plume-core :: ops.rs
enum Op {
    InsertBlock  { at: usize, block: Block },
    DeleteBlock  { id: BlockId },
    MoveBlock    { id: BlockId, to: usize },
    SetNode      { id: BlockId, node: Node },                // remplace contenu + type
    SetRuns      { id: BlockId, runs: Vec<Run> },            // remplace texte + marks
    ApplyMark    { id: BlockId, range: (usize, usize), mark: MarkPatch },
    SetTableCell { id: BlockId, row: usize, col: usize, runs: Vec<Run> },
    SetMeta      { title: Option<String>, lang: Option<String> },
}
```

Le ciblage se fait **par `BlockId`**, jamais par offset global fragile. Le `range` d'`ApplyMark` s'exprime sur le texte concaténé des runs du bloc.

**Règles de validation** (avant `apply`, sinon `tool_result` d'erreur) :

- `id` référencé **existe** ; `at` / `to` ∈ `[0, blocks.len()]`.
- `range = (a,b)` : `a ≤ b ≤ len(texte_concaténé(bloc))`.
- `Heading.level ∈ 1..=6` ; `ListItem.level ∈ 0..=5`.
- `Table` rectangulaire ; `row`/`col` dans les bornes.
- `color` = hex `#RRGGBB` valide ; `link` = URL absolue valide.
- Toute erreur renvoie `{ ok: false, reason: "..." }` à Claude pour auto-correction (sans altérer l'état).

## Boucle agent

Implémentée dans la command Tauri `chat_send` :

```
1. messages = historique ; tools = [un outil par variante d'Op]
2. POST https://api.anthropic.com/v1/messages  (stream SSE)  — header x-api-key côté Rust uniquement
3. Collecte les blocs `text` (→ event "assistant_text") et `tool_use`
4. Pour chaque tool_use :
     op = parse(tool_use.input)
     match validate(op, &state):
       Ok  -> state = apply(op, state); push undo_stack(inverse(op));
              event "op_applied" (preview live); tool_result = { ok:true, doc_version }
       Err -> tool_result = { ok:false, reason }
5. Append (assistant turn) + (user turn = tool_results); reboucle tant que stop_reason != "end_turn"
```

**Garde-fous** : aucune écriture disque par le modèle ; seules les opérations validées mutent l'état ; tout passe par `apply`.

## Export / Import

- **Markdown** ⇄ natif : quasi iso-morphisme du modèle.
- **`.docx`** : via `docx-rs` (mapper `Node` → éléments OOXML).
- **PDF** : rendu webview → `tauri` print-to-pdf (ou sidecar `typst` / `weasyprint` pour une pagination fine).
- **Import `.docx`** (v2) : `docx-rs` en lecture → reconstruction du modèle.

## Démarrage

Le projet est encore au stade **spécification** : le scaffold reste à produire (Wave 0).

1. Place la spec à la racine du repo sous le nom `BOOTSTRAP.md`.
2. Ouvre Claude Code dans ce dossier.
3. Prompt de lancement :
   > « Lis `BOOTSTRAP.md` en entier. Exécute **Wave 0**, puis arrête-toi et liste ce qui a été fait. J'enchaînerai les waves une par une. »
4. **Règle d'or** : une wave = un commit ; tests verts avant de passer à la suivante ; jamais de saut de wave.

Une fois le scaffold en place (Wave 0) :

```bash
# Variable d'environnement requise pour la boucle agent (Wave 5+)
export ANTHROPIC_API_KEY="sk-ant-..."

# Lancer l'app en développement
npm run tauri dev
```

## Feuille de route

| Wave | Livrable | Critère d'acceptation |
|---|---|---|
| **W0** | Scaffold Tauri 2 + Vite/React/TS/Tailwind ; crate `plume-core` ; command `ping` | `npm run tauri dev` ouvre une fenêtre ; `ping` répond depuis Rust |
| **W1** | Modèle + `serde` + doc vide + `ts-rs` | round-trip JSON ⇄ struct ; types TS générés |
| **W2** | `Op` + `validate` + `apply` + `inverse` (undo) | tests unitaires : insert / delete / move / setruns / applymark + inverse rejoue l'état initial |
| **W3** | Renderer React : blocks → composants DS, curseur, sélection | un doc fixture s'affiche fidèlement |
| **W4** | Édition directe : frappe → `SetRuns`/`ApplyMark` ; Entrée → `InsertBlock` ; toolbar | éditer au clavier passe par le pipeline d'ops |
| **W5** | Boucle agent + 8 outils = 8 ops + panneau chat streaming | « mets le titre en gras et ajoute un paragraphe d'intro » fonctionne via Claude |
| **W6** | Persistance `.plume.json` (open / save / autosave) | fermer/rouvrir conserve tout |
| **W7** | Export Markdown + `.docx` + PDF | les 3 exports ouvrent sans corruption |
| **W8** | Polish : undo/redo UI (Cmd+Z), palette de commandes, recherche, raccourcis | undo multi-niveaux fiable |

## Conventions de développement

- **Rust** : `cargo fmt` + `clippy -D warnings` ; reducer **pur** (aucune I/O dans `apply`).
- **Tests d'ops obligatoires** dès la Wave 2 — c'est le cœur de l'intégrité.
- **Commits** : format `wave(N): …`. Un commit par wave, tests verts.
- Le modèle Claude ne reçoit **que** l'état + les outils ; il ne voit jamais le filesystem.

## Documentation complémentaire

- [`BOOTSTRAP-plume-docs.md`](./BOOTSTRAP-plume-docs.md) — spécification complète, détails du modèle, plan de build wave par wave et première action.
- [Documentation API Anthropic](https://docs.claude.com/en/api/overview)
- [Documentation Tauri 2](https://v2.tauri.app/)
