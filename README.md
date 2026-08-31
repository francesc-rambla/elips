# elips — Editor de LIcitacions PúbliqueS

**elips** és una aplicació web avançada de transpilació, generació automatitzada i edició visual de documentació per a **licitacions i contractes públics** (memòries justificatives, plecs de clàusules administratives i tècniques, informes de valoració, etc.).

L'aplicació funciona **100% en l'entorn del navegador (client-side)** utilitzant WebAssembly (**Pyodide** per a l'execució de Python/Jinja2 i **Pandoc WASM** per a la conversió de formats), garantint la **màxima privacitat, seguretat i confidencialitat de les dades**, sense necessitat d'enviar cap informació a servidors externs.

---

## 📖 Manual d'usuari i guia de referència

Per a una guia detallada pas a pas sobre el funcionament de l'aplicació, consulteu el **[Manual d'usuari d'elips (`manual.md`)](../manual.md)** (disponible també a `public/manual.md`).

El manual inclou la documentació completa organitzada per perfils d'ús:
- **[Perfil 1: Guia per al perfil de configuració del model de dades i de les plantilles](../manual.md#4-perfil-1-guia-per-al-perfil-de-configuració-del-model-de-dades-i-de-les-plantilles)**: Disseny de plantilles Jinja2 (`.md.j2`), taules transposades (`TRANSPOSED_TABLE`), configuració de tipus de dades (`editor_metadata`), camps calculats i motor de fórmules amb autocompletat, nivells intermedis amb títols dinàmics i acordió, i disseny visual dels formularis (editor de graella visual drag & drop).
- **[Perfil 2: Guia per al perfil tècnic usuari de l'aplicació](../manual.md#5-perfil-2-guia-per-al-perfil-tècnic-usuari-de-laplicació)**: Gestió de projectes multi-document, exportació/importació de paquets ZIP, històric de versions i punts de control horaris automàtics, restauració del model des de l'Excel, ús de l'editor visual de cel·les de text ric (Markdown + Jinja2) i compilació/exportació de documents (DOCX, MD, XLSX).

---

## 🎯 Característiques principals

1. **Gestió de projectes multi-document i paquets ZIP**:
   - Creació i gestió de múltiples documents (ex: Memòria Justificativa, PCAP, PPT) associats a un únic model de dades centralitzat.
   - Exportació i importació de paquets comprimits `projecte_<nom>.zip` que encapsulen dades JSON, metadades d'edició, full Excel `.xlsx`, plantilles `.md.j2` i plantilles Word `.docx`.

2. **Històric de versions i còpies horàries automàtiques**:
   - Enregistrament diferencial automàtic de canvis tant a la plantilla com a les dades.
   - Punts de control horaris automàtics en segon pla per protegir el treball davant de tancaments accidentals.
   - Panell d'inspecció i comparació de versions amb restauració immediata a qualsevol punt anterior.

3. **Sincronització i restauració del model de dades des de l'Excel**:
   - Extracció automàtica de les metadades de camps, tipus, regles i fórmules des dels fulls ocults `editor_metadata`, `_sheet_info` i `_hierarchy_schema`.
   - Botó d'acció directa **"📥 Restaura de l'Excel"** tant al Ribbon superior com a la finestra de configuració de tipus per forçar la sincronització de l'esquema.

4. **Nivells intermedis en estructures aniuades**:
   - **Títols dinàmics per fórmula**: Encapçalaments personalitzats per a cada targeta (ex: `CONCAT(nom_partida; " ("; MONEDA(import); ")")`).
   - **Acordió plegable**: Gestió àgil de llistes extenses amb botons "Desplega tot" i "Col·lapsa tot".
   - **Reordenació d'elements**: Fletxes de navegació vertical ⬆️ / ⬇️ per canviar l'ordre dels registres a l'instant.

5. **Taules transposades (`TRANSPOSED_TABLE`)**:
   - Comentari de control per renderitzar taules amb registres en columnes i camps en files (ideal per a taules salarials i comparatives).
   - Suport per a filtres de format per fila (`| coin`, `| number(2)`).
   - Generació Markdown neta i sense salts de línia sobrers.

6. **Editor visual de graella (Drag & Drop) i editor de fórmules amb autocompletat**:
   - Dissenyador visual per organitzar camps en columnes i files arrossegant i amollant.
   - Editor de fórmules amb menú emergent d'autocompletat per a camps de fila, rutes globals i funcions matemàtiques/lògiques (`SI`, `ARRODONEIX`, `CONCAT`, `MONEDA`, etc.).

---

## 📊 Model de dades d'Excel i estructura de fulls

El model de dades d'**elips** està dissenyat per interpretar l'estructura dels documents Excel i convertir-los automàticament en un objecte JSON jeràrquic accessible des de les plantilles Jinja2.

### 1. Tipus de fulls d'Excel admesos

#### A. Fulls clau-valor (`KV`)
S'utilitzen per a valors únics o generals del contracte (ex: `General`, `pres`, `licitacio`).
- **Format 1 (Sense capçalera)**: La Columna A conté la clau (ex: `titol_contracte`) i la Columna B conté el valor (ex: `Subministrament d'equips`).
- **Format 2 (Amb capçalera)**: Fila 1 amb capçaleres `Clau | Valor` (o `Key | Value`), i les files posteriors amb parelles clau-valor.

#### B. Fulls tabulars (`Tabular`)
S'utilitzen per a estructures repetitives o conjunts de dades (ex: `Parts`, `Activitats`, `Lots`).
- Fila 1 amb les capçaleres de les columnes (ex: `id_partida`, `nom_partida`, `import`).
- Files posteriors amb els registres individuals.

---

### 2. Jerarquia i aniuament de fulls (`Dotted Sheet Names`)

Per representar estructures aniuades (relacions pare-fill 1 a N o N a M), **elips** utilitza una convenció de noms de fulls separats per punts:

- **`OUT_pres`**: Full clau-valor amb les dades generals del pressupost.
- **`OUT_pres.parts`**: Full tabular amb la llista de partides del pressupost.
- **`OUT_pres.parts.activitats`**: Full tabular amb la llista d'activitats de cada partida.

---

## 🛠️ Arquitectura tècnica

- **Frontend**: Vue 3 (Composition API, `<script setup>`), Pinia Store, Vanilla CSS3 (disseny modern glassmorphic / dark mode).
- **Processament de dades i plantilles**:
  - **Pyodide WASM**: Entorn Python 3.13 executat localment al navegador.
  - **OpenPyXL**: Lectura i modificació de fitxers de fulls de càlcul Excel `.xlsx`.
  - **Jinja2**: Motor de plantilles amb recuperació d'errors (`DebugUndefined`) i avaluació dinàmica doble.
- **Transpilació de documents**:
  - **Pandoc WASM**: Conversió de Markdown transpilat cap a documents Microsoft Word `.docx` utilitzant documents de referència corporatius.

---

## ⚙️ Filtres Jinja2 personalitzats

| Filtre | Ús / Exemple | Resultat |
| :--- | :--- | :--- |
| `coin` / `format_currency` | `{{ 15250.5 \| coin }}` | `15.250,50 €` |
| `number` / `format_number(2)` | `{{ 15250.5 \| number }}` | `15.250,50` |
| `words` | `{{ 3 \| words }}` | `tres` |
| `prefix` | `{{ 'execució' \| prefix('de ', 'd\'') }}` | `d'execució` |
| `date` | `{{ '2026-08-31' \| date('%d/%m/%Y') }}` | `31/08/2026` |

---

## 💻 Desenvolupament i compilació local

```bash
# Navegar al directori de la font Vue 3
cd contractes-generator-vue

# Instal·lar dependències
npm install

# Executar en entorn de desenvolupament local
npm run dev

# Executar conjunt de proves (Python, Vitest, E2E Puppeteer)
npm run test

# Compilar el bundle de producció (Genera dist/index.html d'un sol fitxer)
npm run build
```

---

## 🔒 Privacitat i seguretat

Tots els fitxers carregats, el full de càlcul Excel, les plantilles Markdown i els documents generats es processen **exclusivament en la memòria local del navegador de l'usuari**. Cap informació ni dada confidencial no surt del dispositiu local.
