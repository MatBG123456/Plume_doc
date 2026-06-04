# Plume

> Éditeur de documents riches **AI-native** (équivalent Word). L'application n'est qu'un *renderer* fin : l'intelligence vit dans Claude.

Plume est le premier volet d'une suite bureautique **Atelier** :

| App | Domaine | Statut |
|---|---|---|
| **Plume** | Documents texte (équivalent Word) | MVP complet (W0–W8) |
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
- Claude reçoit l'**état du document** + la liste des **opérations** possibles. Il répond par une brève prose **puis** un bloc `json` `{"ops":[…]}`. Le cœur Rust **valide** chaque opération puis l'**applique** via un *reducer* pur ; une opération refusée est signalée à l'utilisateur.
- **UX hybride** : la frappe directe dans l'interface produit *exactement les mêmes opérations* que le chat. Undo, redo et collaboration sont donc uniformes. On ne tape pas tout au chat ; le chat sert au génératif, à la transformation et aux opérations en masse.

```
┌──────────────┐  prose + {ops}  ┌───────────────────────────┐
│  claude -p   │ ──────────────▶ │  plume-core (Rust)        │
│ (CLI local)  │                 │  validate → apply → inverse│
│              │                 │  (reducer pur, sans I/O)  │
└──────────────┘                 └───────────┬───────────────┘
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
| IA | **Claude Code local uniquement** (`claude -p --output-format stream-json`), appelé **côté Rust** ; le modèle répond en prose + bloc `json` d'opérations. Pas de clé API ni de sélecteur. |
| Modèle / effort | choisis dans le panneau (`sonnet`/`opus`/`haiku` × `low`…`max`), passés en flags au binaire `claude` |

## Architecture du projet

```
Plume_doc/
├── README.md                  # Ce document
├── BOOTSTRAP-plume-docs.md    # Spécification complète + plan de build par waves
│
├── Cargo.toml                 # Workspace Rust (membres : plume-core, src-tauri)
├── package.json               # Front (Vite, React, TS, Tailwind, CLI Tauri)
├── vite.config.ts             # Port fixe 1420 attendu par Tauri
├── tailwind.config.js         # + postcss.config.js
│
├── src/                       # Front React + Vite + TS + Tailwind
│   ├── main.tsx
│   ├── App.tsx                # monte le gestionnaire d'onglets (TabManager) + thème clair/sombre + mascotte
│   ├── icons.tsx             # jeu d'icônes SVG inline (style « Perch »)
│   ├── Spark.tsx             # mascotte (astérisque à 8 rais)
│   ├── bindings/             # types TS générés par ts-rs (NE PAS éditer)
│   ├── render/               # Wave 3 : renderer (blocks → DS) ; éditable en W4
│   │   ├── DocumentView.tsx  #   page « feuille » + segmentation listes/blocs
│   │   ├── BlockView.tsx     #   un composant par variante de Node
│   │   ├── ListGroup.tsx     #   ListItem plats → <ul>/<ol> imbriqués (level absolu)
│   │   ├── RunsView.tsx      #   Run[] → spans (lecture seule)
│   │   ├── marks.ts          #   mapping Marks → styles (partagé rendu/édition)
│   │   └── fixture.ts        #   document de démo (fallback hors Tauri)
│   ├── editor/               # édition · multi-onglets · chat · fichier · export · polish
│   │   ├── TabManager.tsx    #   multi-onglets (snapshots, cache de session, fermeture)
│   │   ├── Editor.tsx        #   doc Rust, file de dispatch, fichier/autosave, undo/redo, raccourcis
│   │   ├── EditableText.tsx  #   hôte contentEditable → SetRuns/InsertBlock/…
│   │   ├── EditableTable.tsx · EditableCell.tsx · tableOps.ts  # tableaux éditables (SetTableCell/SetNode)
│   │   ├── Toolbar.tsx       #   type de bloc, marques, lien, couleurs, tableau, image, cible
│   │   ├── actions.ts        #   ApplyMark / SetNode / SetTableCell sur la sélection (blocs + cellules)
│   │   ├── text.ts           #   réconciliation texte ⇄ runs (pure, testée)
│   │   ├── caret.ts          #   sélection DOM ⇄ offsets code points
│   │   ├── ChatPanel.tsx     #   panneau chat (Claude Code local, streaming, contexte)
│   │   ├── CommandPalette.tsx #  palette de commandes (Ctrl+K)
│   │   └── SearchBar.tsx     #   recherche + remplacement dans le document (Ctrl+F)
│   └── styles.css
│
├── src-tauri/                 # Shell Tauri (cœur Rust + webview)
│   ├── src/lib.rs             # commands : ping, get_document, apply_op, undo, redo, save/open, export
│   ├── src/chat.rs            # boucle agent (Claude Code CLI local) : prompt → prose + ops
│   ├── src/persist.rs         # open/save .plume.json (atomique) + schema_version + set_document
│   ├── src/import.rs          # import Markdown (pulldown-cmark) + .docx (zip + quick-xml)
│   ├── src/export.rs          # export Markdown + .docx (docx-rs, styles Word)
│   ├── src/main.rs
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── icons/
│
└── crates/plume-core/         # Cœur : modèle, ops, validate, apply, inverse, export
    └── src/
        ├── lib.rs             # fn ping() + ré-exports
        ├── model.rs           # Wave 1 : modèle de document (serde + ts-rs)
        └── ops.rs             # Wave 2 : Op + validate + apply + inverse (undo)
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

> **Implémenté en Wave 1** dans `crates/plume-core/src/model.rs`. Les énumérations
> sont *internally tagged* (`{"type":"Paragraph","runs":[…]}`) pour rester
> lisibles par un LLM. `Document::empty()` produit un document vide.

### Types partagés Rust ⇄ TypeScript (ts-rs)

Le modèle Rust est l'unique source de vérité. Les types TypeScript sont
**générés** par [`ts-rs`](https://github.com/Aleph-Alpha/ts-rs) dans
`src/bindings/` — ne les éditez jamais à la main. Pour les régénérer après une
modification du modèle :

```bash
cargo test -p plume-core   # les tests `export_bindings_*` réécrivent src/bindings/
```

Le front les consomme via `import type { Document } from "./bindings"`.

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

> **Implémenté en Wave 2** dans `crates/plume-core/src/ops.rs` :
> - `validate(doc, op)` — vérification pure (n'altère rien) ;
> - `apply(doc, op) -> Result<Op, OpError>` — valide, applique le reducer **pur**,
>   et **renvoie l'op inverse** prête à empiler pour l'undo. Appliquer l'inverse
>   restaure exactement l'état précédent (testé pour chaque variante).
> - `MarkPatch` utilise la *double-option* (`None` = inchangé, `Some(None)` =
>   effacé) pour distinguer ces deux cas en JSON. `ApplyMark` découpe les runs
>   sur le range de caractères puis fusionne les runs adjacents de même style.

## Boucle agent

Implémentée dans la command Tauri `chat_send` — **Claude Code local uniquement** :

```
1. prompt = consignes + OPS_HELP + document (JSON) + focus/contexte + conversation
2. spawn `claude -p --output-format stream-json --include-partial-messages
         --model <m> --effort <e>`  ; le prompt est écrit sur stdin
3. lecture NDJSON ligne par ligne :
     - deltas de texte    → event "assistant_text" (prose au fil de l'eau, jusqu'au bloc ```)
     - event `result`     → texte final fiable
4. extraction du bloc ```json {"ops":[…]}``` ; pour chaque op :
     match validate(op, &state):
       Ok  -> state = apply(op, state); push undo_stack(inverse(op)); event "op_applied" (preview live)
       Err -> op signalée à l'utilisateur (les autres s'appliquent)
5. event "assistant_done" ; l'historique (prose) est renvoyé au front
```

**Garde-fous** : aucune écriture disque par le modèle ; seules les opérations validées mutent l'état ; tout passe par `apply` ; pendant un tour, `set_document` (bascule d'onglet) est refusé (verrou `agent_busy`). Le binaire `claude` est fourni/authentifié par l'utilisateur (son abonnement) — aucune clé API.

## Export / Import

- **Export Markdown** : mapping pur du modèle (`to_markdown`).
- **Export `.docx`** : via `docx-rs`, avec de **vrais styles Word** (Title, Heading 1–6 → volet Navigation / table des matières).
- **Export PDF** : impression du webview (réutilise le renderer ; CSS `print:`).
- **Import Markdown / `.docx`** *(livré)* : `pulldown-cmark` pour le MD (titres, listes imbriquées, code, tableaux, marques) ; `.docx` lu via `zip` + `quick-xml` (titres, paragraphes, **tableaux**, listes avec niveau, gras/italique/souligné/barré, **couleur**, **hyperliens** via les relations). Disponible via **Importer**, en **glisser-déposer** sur la fenêtre, et comme **pièce de contexte** du chat (`import.rs`).
- **Import PDF** : *reporté* (extracteur lourd, texte peu structuré).

## Démarrage

Le scaffold **Wave 0** est en place : l'app se lance et le `ping` traverse webview → Tauri → `plume-core`. Depuis la **Wave 3**, le renderer (`src/render/`) affiche un document fidèlement ; depuis la **Wave 4**, le document vit côté Rust (commands `get_document` / `apply_op`) et l'édition directe (frappe, Entrée, barre d'outils) passe par le pipeline d'opérations. Depuis la **Wave 5**, un panneau de chat (`chat_send`) pilote l'édition via Claude : le binaire `claude` local est appelé **côté Rust** en streaming ; sa réponse (prose + bloc `json` d'ops) est validée puis appliquée par le **même** pipeline, avec preview live. Le chat passe **exclusivement par Claude Code local** : il délègue au binaire `claude` que l'utilisateur a lui-même installé et authentifié — **pas de clé API ni de sélecteur de fournisseur** dans l'UI (on choisit seulement **modèle** et **effort**, et on peut fournir des **documents en contexte**). ⚠️ Ce mode utilise l'auth/abonnement de l'utilisateur : router des requêtes via un abonnement est encadré par les [CGU d'Anthropic](https://www.anthropic.com/legal) (plutôt usage interactif) — à chacun de vérifier la conformité de son usage. Depuis la **Wave 6**, on ouvre/enregistre des `.plume.json` (sélecteur natif, écriture atomique côté Rust) avec **autosave** débouncé et flush à la fermeture (Ctrl/Cmd+S / +O). Depuis la **Wave 7**, on exporte en **Markdown** et **`.docx`** (mapping Rust) et en **PDF** (impression du webview, qui réutilise le renderer). La **Wave 8** ajoute le polish : undo/redo (Ctrl+Z/Y, avec coalescing de la frappe en une étape), palette de commandes (Ctrl+K) et recherche dans le document (Ctrl+F). Hors Tauri (`npm run dev` seul), l'app retombe sur la fixture en lecture seule.

### Prérequis

- **Node** ≥ 18 et **Rust** (toolchain stable).
- **Linux** uniquement : les dépendances système de Tauri 2 doivent être installées —
  `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
  (voir la [doc Tauri – prérequis Linux](https://v2.tauri.app/start/prerequisites/)).

### Installer & lancer

```bash
npm install            # dépendances front + CLI Tauri

npm run dev            # front seul (Vite, http://localhost:1420)
npm run tauri dev      # app complète (fenêtre Tauri + cœur Rust)

# Le chat délègue au binaire « claude » (Claude Code) que tu installes toi-même
# et authentifies ; choisis ensuite modèle/effort dans le panneau. Pas de clé API.
```

### Tests & qualité

```bash
cargo test                          # tous les tests Rust (cœur, ops, persistance, import)
npm test                            # tests front (vitest : réconciliation de frappe, tableaux)
cargo fmt --all                     # format Rust
cargo clippy --all -- -D warnings
npm run build                       # tsc + build Vite de production
```

> Une wave = un commit ; tests verts avant de passer à la suivante ; jamais de saut de wave.

## Feuille de route

| Wave | Livrable | Critère d'acceptation |
|---|---|---|
| ✅ **W0** | Scaffold Tauri 2 + Vite/React/TS/Tailwind ; crate `plume-core` ; command `ping` | `npm run tauri dev` ouvre une fenêtre ; `ping` répond depuis Rust |
| ✅ **W1** | Modèle + `serde` + doc vide + `ts-rs` | round-trip JSON ⇄ struct ; types TS générés |
| ✅ **W2** | `Op` + `validate` + `apply` + `inverse` (undo) | tests unitaires : insert / delete / move / setruns / applymark + inverse rejoue l'état initial |
| ✅ **W3** | Renderer React : blocks → composants DS (`src/render/`), lecture seule | la fixture (toutes variantes de blocs + marques) s'affiche fidèlement |
| ✅ **W4** | Édition directe : frappe → `SetRuns`/`ApplyMark` ; Entrée → `InsertBlock` ; Backspace → fusion ; toolbar (type de bloc, marques, lien, couleur) | toute édition clavier/souris passe par le pipeline d'ops Rust (`apply_op`) |
| ✅ **W5** | Boucle agent (`chat_send`, côté Rust) + panneau chat. *(Désormais : Claude Code local uniquement, prose + bloc `json` d'ops appliquées par le pipeline.)* | « mets le titre en gras et ajoute un paragraphe d'intro » via Claude |
| ✅ **W6** | Persistance `.plume.json` : open / save / **autosave** (I/O Rust atomique, sélecteur natif, flush à la fermeture) | fermer/rouvrir conserve tout |
| ✅ **W7** | Export **Markdown** + **`.docx`** (mapping Rust) + **PDF** (impression du webview, CSS `print:`) | les 3 exports ouvrent sans corruption |
| ✅ **W8** | Polish : undo/redo UI (Cmd+Z, **coalescing** de la frappe), palette de commandes (Ctrl+K), recherche (Ctrl+F), raccourcis | undo multi-niveaux fiable |

### Au-delà de la feuille de route (livré)

- **Chat = Claude Code local uniquement** (binaire `claude`), avec **modèle/effort**, **streaming**, **documents en contexte** + **fenêtre de contexte** (rafraîchir). Pas de clé API ni de sélecteur.
- **Multi-onglets** (`TabManager`) : un document par onglet, cache de session, garde-fou de fermeture, **verrou agent** (pas de bascule pendant un tour d'assistant).
- **Tableaux éditables** (cellules, +/− lignes & colonnes), **marques dans les cellules**, **insertion/édition d'image**.
- **Import** Markdown + `.docx`, en menu / **glisser-déposer** / pièce de contexte du chat.
- **Recherche → remplacer** (Tout remplacer).
- **Focus de sélection** pour orienter l'assistant ; **mode sombre** ; **responsive** ; **icônes** & mascotte (DS « Perch »).
- **Versionnement du format** (`schema_version`, refus d'une version plus récente).
- **Tests** : `cargo` (cœur, ops, persistance, import) + `vitest` (réconciliation de frappe, tableaux).

## Conventions de développement

- **Rust** : `cargo fmt` + `clippy -D warnings` ; reducer **pur** (aucune I/O dans `apply`).
- **Tests d'ops obligatoires** dès la Wave 2 — c'est le cœur de l'intégrité.
- **Commits** : format `wave(N): …`. Un commit par wave, tests verts.
- Le modèle Claude ne reçoit **que** l'état + les outils ; il ne voit jamais le filesystem.

## Documentation complémentaire

- [`BOOTSTRAP-plume-docs.md`](./BOOTSTRAP-plume-docs.md) — spécification complète, détails du modèle, plan de build wave par wave et première action.
- [`GUIDE-integration-claude-cli.md`](./GUIDE-integration-claude-cli.md) — guide réutilisable : brancher le CLI `claude` (Claude Code) comme backend IA d'une app « bring‑your‑own‑auth », pour d'autres apps de même nature.
- [Documentation API Anthropic](https://docs.claude.com/en/api/overview)
- [Documentation Tauri 2](https://v2.tauri.app/)
