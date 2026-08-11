# elips — Editor de LIcitacions PúbliqueS

**elips** és una aplicació web avançada de transpilació, generació automatitzada i edició visual de documentació per a **licitacions i contractes públics** (memòries justificatives, plecs de clàusules tècniques, informes de valoració, etc.).

L'aplicació funciona **100% en l'entorn del navegador (client-side)** utilitzant WebAssembly (**Pyodide** per a l'execució de Python/Jinja2 i **Pandoc WASM** per a la conversió de formats), garantint la **màxima privacitat, seguretat i confidencialitat de les dades**, sense necessitat d'enviar cap informació a servidors externs.

---

## 📖 Manual d'usuari i guia de referència

Per a una guia detallada pas a pas sobre el funcionament de l'aplicació, consulteu el **[Manual d'usuari d'elips (`manual.md`)](../manual.md)** (disponible també a `public/manual.md`).

El manual inclou la documentació completa organitzada per perfils d'ús:
- **[Perfil 1: Guia per al perfil de configuració del model de dades i de les plantilles](../manual.md#3-perfil-1-guia-per-al-perfil-de-configuració-del-model-de-dades-i-de-les-plantilles)**: Disseny de plantilles Jinja2 (`.md.j2`), configuració de tipus de dades (`editor_metadata`), camps calculats i motor de fórmules (`SI/IF`), i distribució visual dels formularis (grid, etiquetes i consells).
- **[Perfil 2: Guia per al perfil tècnic usuari de l'aplicació](../manual.md#4-perfil-2-guia-per-al-perfil-tècnic-usuari-de-laplicació)**: Càrrega de fitxers, navegació pel model de dades, ús de l'editor visual de cel·les de text ric (Markdown + Jinja2) i compilació/exportació de documents (DOCX, MD, XLSX).

---

## 🎯 Finalitat del projecte

La finalitat d'**elips** és simplificar, automatitzar i estandarditzar la preparació de documentació administrativa i tècnica en la contractació pública:

1. **Unificació de dades i text**: Combinar dades estructurades provinents de fulls de càlcul Excel (pressupostos, llocs, activitats, indicadors, clàusules) amb plantilles de text en format Markdown/Jinja2.
2. **Edició visual bidireccional**: Proporcionar un editor visual de documents que permet a usuaris tècnics i administratius editar el contingut tant en mode HTML visual (amb arrossegar i amollar marcadors i blocs de control) com en mode codi font Markdown.
3. **Generació multiformat de qualitat corporativa**: Transpilar automàticament els documents resultants a fitxers Microsoft Word (`.docx`), Markdown (`.md`) i JSON estructurat, aplicant els darrers estils i formats de referència corporatius.
4. **Persistència i seguretat total**: Mantenir tots els projectes, fitxers Excel i plantilles desats localment en l'emmagatzematge intern del navegador (**IndexedDB** i **LocalStorage**), garantint que cap dada no es perdi en recarregar la pàgina o tancar el navegador.

---

## 📊 Model de dades d'Excel i estructura de fulls

El model de dades d'**elips** està dissenyat per interpretar l'estructura dels documents Excel i convertir-los automàticament en un objecte JSON jeràrquic accessible des de les plantilles Jinja2.

### 1. Tipus de fulls d'Excel admesos

L'aplicació reconeix automàticament dos tipus principals de fulls de càlcul:

#### A. Fulls clau-valor (`KV`)
S'utilitzen per a valors únics o generals del contracte (ex: `pres`, `contracte`, `licitacio`).
- **Format 1 (Sense capçalera)**: La Columna A conté la clau (ex: `titol_contracte`) i la Columna B conté el valor (ex: `Subministrament d'equips`).
- **Format 2 (Amb capçalera)**: Fila 1 amb capçaleres `Clau | Valor` (o `Key | Value`), i les files posteriors amb parelles clau-valor.

```text
+---------------------+-----------------------------------+
| Clau                | Valor                             |
+---------------------+-----------------------------------+
| titol               | Contracte de serveis informàtics  |
| expedient           | EXP-2026/042                      |
| import_licitacio    | 150000.00                         |
+---------------------+-----------------------------------+
```

#### B. Fulls tabulars (`Tabular`)
S'utilitzen per a estructures repetitives o conjunts de dades (ex: `parts`, `activitats`, `lots`).
- Fila 1 amb les capçaleres de les columnes (ex: `id_partida`, `nom_partida`, `import`).
- Files posteriors amb els registres individuals.

```text
+------------+------------------------+-----------+
| id_partida | partida                | import    |
+------------+------------------------+-----------+
| PA-01      | Desenvolupament Web    | 80000.00  |
| PA-02      | Manteniment i Suport   | 70000.00  |
+------------+------------------------+-----------+
```

---

### 2. Jerarquia i aniuament de fulls (`Dotted Sheet Names`)

Per representar estructures aniuades (relacions pare-fill 1 a N o N a M), **elips** utilitza una convenció de noms de fulls separats per punts:

- **`pres`**: Full clau-valor amb les dades generals del pressupost.
- **`pres.parts`** (o **`parts`**): Full tabular amb la llista de partides del pressupost.
- **`parts.activitats`** (o **`activitats`**): Full tabular amb la llista d'activitats de cada partida.

#### Enllaç automàtic al model de dades:
El parser Python (`excel_to_json`) enllaça automàticament aquestes estructures perquè es puguin consultar a Jinja2 tant des del pare com des del nivell global:

```jinja2
{# Accés directament des de l'objecte pare #}
{% for part in pres.parts %}
  - Partida: {{ part.partida }} (Import: {{ part.import | coin }})
  {% for act in part.activitats %}
    * Activitat: {{ act.nom_activitat }}
  {% endfor %}
{% endfor %}

{# O accés des del nivell global #}
{% for part in parts %}
  - {{ part.partida }}
{% endfor %}
```

---

### 3. Gestió de files buides o amb zeros (`0` / `0.00`)

En els fulls de càlcul d'Excel és habitual tenir files tabulars reserves o buides amb valors per defecte `0`, `0.00`, cadenes buides `""` o `None`.

- **Filtratge en fase de càrrega (`excel_to_json`)**:
  Per mantenir el model de dades net i eficient, en llegir el fitxer Excel **s'obvien directament aquelles files en què TOTS els valors són 0, buits, `None` o `False`**.
- **Preservació de valors individuals**:
  Si una fila té almenys un camp amb contingut real (ex: `partida = "Manteniment"`), la fila es manté al model i els seus camps individuals amb valor `0` o `False` es conserven fidelment.
- **Escriptura a Excel (`update_excel_from_json`)**:
  Quan es guarden canvis des de la interfície cap a l'Excel, l'aplicació escriu els valors començant per la primera fila disponible, eliminant o netejant automàticament les files sobrants o buides del fitxer binari `.xlsx`.

---

## 🛠️ Arquitectura tècnica

- **Frontend**: Vue 3 (Composition API, `<script setup>`), Pinia Store, Vanilla CSS3 (disseny modern glassmorphic / dark mode).
- **Processament de dades i plantilles**:
  - **Pyodide WASM**: Entorn Python 3.13 executat localment al navegador.
  - **OpenPyXL**: Lectura i modificació de fitxers de fulls de càlcul Excel `.xlsx`.
  - **Jinja2**: Motor de plantilles amb recuperació d'errors (`DebugUndefined`) i passades de compilació netes/HTML.
- **Transpilació de documents**:
  - **Pandoc WASM**: Conversió de Markdown transpilat cap a documents Microsoft Word `.docx` utilitzant documents de referència corporatius.

---

## ⚙️ Filtres Jinja2 personalitzats

L'entorn de renderitzat d'**elips** inclou filtres d'edició integrats:

| Filtre | Ús / Exemple | Resultat |
| :--- | :--- | :--- |
| `coin` | `{{ 15250.5 \| coin }}` | `15.250,50 €` |
| `number` | `{{ 15250.5 \| number }}` | `15.250,50` |
| `words` | `{{ 3 \| words }}` | `tres` |
| `prefix` | `{{ 'execució' \| prefix('de', 'd\'') }}` | `d'execució` |

---

## 💻 Desenvolupament i compilació local

Per executar o compilar el projecte localment:

```bash
# Navegar al directori de la font Vue 3
cd contractes-generator-vue

# Instal·lar dependències
npm install

# Executar en entorn de desenvolupament local
npm run dev

# Compilar el bundle de producció (Genera dist/index.html d'un sol fitxer)
npm run build
```

---

## 🔒 Privacitat i seguretat

Tots els fitxers carregats, el full de càlcul Excel, les plantilles Markdown i els documents generats es processen **exclusivament en la memòria local del navegador de l'usuari**. Cap informació ni dada confidencial no surt del dispositiu local.
