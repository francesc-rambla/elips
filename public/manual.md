# 📘 Manual d'usuari d'elips (Editor de LIcitacions PúbliqueS)
**Generador de documentació i gestió d'expedients de contractació pública**

---

## 📑 Índex de continguts
1. [Introducció i filosofia d'elips](#1-introducció-i-filosofia-delips)
2. [Arquitectura del model de dades i jerarquia d'Excel](#2-arquitectura-del-model-de-dades-i-jerarquia-dexcel)
   - [2.1 Tipus de fulls i prefixació `OUT_`](#21-tipus-de-fulls-i-prefixació-out_)
   - [2.2 Conservació de la configuració: fulls ocults `editor_metadata`, `_sheet_info` i `_hierarchy_schema`](#22-conservació-de-la-configuració-fulls-ocults-editor_metadata-_sheet_info-i-_hierarchy_schema)
   - [2.3 Restauració de la configuració del model des de l'Excel (automàtica i botó manual)](#23-restauració-de-la-configuració-del-model-des-de-lexcel-automàtica-i-botó-manual)
3. [Gestió de Projectes Multi-document i Còpies de Seguretat](#3-gestió-de-projectes-multi-document-i-còpies-de-seguretat)
   - [3.1 Creació, canvi de nom i canvi de projecte actiu](#31-creació-canvi-de-nom-i-canvi-de-projecte-actiu)
   - [3.2 Gestió de múltiples documents vinculats al mateix model](#32-gestió-de-múltiples-documents-vinculats-al-mateix-model)
   - [3.3 Paquets de projecte ZIP: exportació completa i importació](#33-paquets-de-projecte-zip-exportació-completa-i-importació)
   - [3.4 Històric de versions i punts de control horaris automàtics](#34-històric-de-versions-i-punts-de-control-horaris-automàtics)
4. [Perfil 1: Guia per al perfil de configuració del model de dades i de les plantilles](#4-perfil-1-guia-per-al-perfil-de-configuració-del-model-de-dades-i-de-les-plantilles)
   - [4.1 L'editor de contingut: mode Visual i mode Codi](#41-leditor-de-contingut-mode-visual-i-mode-codi)
   - [4.2 Taules automàtiques (`DYNAMIC_TABLE` i `TRANSPOSED_TABLE`)](#42-taules-automàtiques-dynamic_table-i-transposed_table)
   - [4.3 Filtres de format Jinja2 disponibles](#43-filtres-de-format-jinja2-disponibles)
   - [4.4 Configuració dels formularis i tipus de dades (`editor_metadata`)](#44-configuració-dels-formularis-i-tipus-de-dades-editor_metadata)
   - [4.5 Camps calculats (Computed), motor de fórmules i editor amb autocompletat](#45-camps-calculats-computed-motor-de-fórmules-i-editor-amb-autocompletat)
   - [4.6 Nivells intermedis de relacions aniuades (títols dinàmics, acordió i reordenació)](#46-nivells-intermedis-de-relacions-aniuades-títols-dinàmics-acordió-i-reordenació)
   - [4.7 Personalització del disseny visual dels formularis (grid, editor visual drag&drop, etiquetes i consells)](#47-personalització-del-disseny-visual-dels-formularis-grid-editor-visual-dragdrop-etiquetes-i-consells)
5. [Perfil 2: Guia per al perfil tècnic usuari de l'aplicació](#5-perfil-2-guia-per-al-perfil-tècnic-usuari-de-laplicació)
   - [5.1 Càrrega i importació de dades d'expedient](#51-càrrega-i-importació-de-dades-dexpedient)
   - [5.2 Emplenat i edició de dades des de l'aplicació web](#52-emplenat-i-edició-de-dades-des-de-laplicació-web)
   - [5.3 Redacció de text extens en camps del model (el mateix editor de la secció 4.1)](#53-redacció-de-text-extens-en-camps-del-model-el-mateix-editor-de-la-secció-41)
   - [5.4 Generació, previsualització i Tauler de Control (Descàrregues i Esquema)](#54-generació-previsualització-i-tauler-de-control-descàrregues-i-esquema)
6. [Bones pràctiques i resolució de problemes (FAQ)](#6-bones-pràctiques-i-resolució-de-problemes-faq)

---

## 1. Introducció i filosofia d'elips

**elips** (*Editor de LIcitacions PúbliqueS*) és una plataforma web d'alta eficiència dissenyada per automatitzar la creació, validació i redacció de memòries justificatives, plecs de clàusules administratives i tècniques, informes de valoració i altres documents complexos de contractació pública.

### 💡 Concepte clau: separació entre model de dades i plantilles
A diferència dels processadors de text tradicionals, **elips** es basa en la **separació estricta entre la lògica de dades i la redacció del document**:

```
 ┌───────────────────────────┐      ┌───────────────────────────┐
 │   Model de dades (Excel)  │  ▲   │   Plantilla de text (Jinja2)│
 │  - Estructura d'expedient │  │   │   - Seccions i redacció   │
 │  - Valors, preus i fórmules│  │   │   - Condicionals i bucles  │
 └─────────────┬─────────────┘  │   └─────────────┬─────────────┘
               │                │                 │
               └─────────► ⚙️ MOTOR ELIPS ◄───────┘
                                │
                                ▼
               ┌─────────────────────────────────┐
               │ Document final (DOCX / MD / PDF)│
               └─────────────────────────────────┘
```

1. **Les plantilles de text (`.md.j2`) i l'estructura de l'Excel romanguin bastant estables**: Són dissenyades per l'equip tècnic o jurídic d'administració per a cada tipologia de contracte (serveis, subministraments, obres, etc.).
2. **El gruix del contingut s'introdueix al model de dades**: Cada expedient concret només requereix introduir o ajustar els valors corresponents als seus camps (pressupost, terminis, justificacions tècniques, taules de preus, etc.).
3. **Avaluació dinàmica doble**: El contingut introduït als camps de text del model de dades pot contenir expressions dinàmiques Jinja2 (`{{ doc.pres.contractant }}`), que s'avaluen automàticament durant la compilació del document final. Dins d'aquest text, els propis camps de la fila on viu el camp (i, amb `parent`, els de les files que la contenen) estan disponibles directament pel seu nom — vegeu l'apartat [5.3](#53-redacció-de-text-extens-en-camps-del-model-el-mateix-editor-de-la-secció-41).
4. **Execució 100% al navegador**: Mitjançant WebAssembly (**Pyodide** per a Python/Jinja2 i **Pandoc WASM** per a la generació Word), cap dada no viatja a servidors externs, complint les normatives més estrictes de privadesa i confidencialitat.
5. **Compilació tolerant a errors**: El motor de renderitzat fa dues passades sobre la plantilla; si una variable no existeix al model de dades, no s'atura la generació — la substitueix per un avís visible i continua, perquè sempre pugueu obtenir un document per revisar (vegeu [6. FAQ](#6-bones-pràctiques-i-resolució-de-problemes-faq) per interpretar aquests avisos).

---

## 2. Arquitectura del model de dades i jerarquia d'Excel

L'estructura de dades d'un projecte s'organitza en fulls de treball d'un llibre d'Excel (`.xlsx`), o directament a l'arbre de dades interactiu des de l'aplicació.

### 2.1 Tipus de fulls i prefixació `OUT_`
Per organitzar la informació i evitar interferències amb altres fulls auxiliars de l'Excel, els fulls destí de la documentació utilitzen el prefix `OUT_` seguit del camí jeràrquic puntuat:

| Nom del full a l'Excel | Nivell jeràrquic | Tipus de full | Descripció |
| :--- | :--- | :--- | :--- |
| `OUT_pres` | 1 (Arrel) | **Clau-valor (KV)** | Formulari d'un sol registre amb dades generals del contracte (títol, expedient, òrgan, etc.). |
| `OUT_pres.parts` | 2 (Sub-taula) | **Tabular (Llista)** | Llista de partides o lots del pressupost. |
| `OUT_pres.parts.activitats` | 3 (Sub-taula) | **Tabular (Llista)** | Detall d'activitats vinculades a cada partida. |
| `OUT_pres.parts.activitats.costs` | 4 (Sub-taula) | **Tabular (Llista)** | Detall de desglossament de costos unitaris. |

### 2.2 Conservació de la configuració: fulls ocults `editor_metadata`, `_sheet_info` i `_hierarchy_schema`
- **`editor_metadata`**: Tota la configuració de tipus de dades, opcions desplegables, fórmules calculades (`calcFormula`), etiquetes (`label`), disposició (`groupLayout`) i títols dinàmics (`itemTitleFormula`) es desa automàticament al full ocult `editor_metadata` del fitxer Excel.
- **`_sheet_info`**: L'estructura de jerarquies de fulls, etiquetes i tipologia (`kv` / `tabular`) es desa al full ocult `_sheet_info`.
- Aquestes metadades s'exclouen del diccionari de dades visual (`doc` / `dades`) per no contaminar la generació Jinja2, però es conserven intactes al fitxer `.xlsx`.

### 2.3 Restauració de la configuració del model des de l'Excel (automàtica i botó manual)
Quan recupereu un projecte o importeu un full Excel que conté configuració prèvia a `editor_metadata`:
1. **Restauració automàtica**: L'aplicació llegeix directament totes les regles i les aplica a l'instant als components visuals i formularis.
2. **Botó manual "📥 Restaura de l'Excel"**:
   - Situat a la barra de cinta superior (pestanya **Dades** > grup **ESTRUCTURA**).
   - Disponible també al peu de pàgina de la finestra modal **⚙️ Configura Tipus**.
   - Permet forçar la recàrrega de totes les regles de tipus, fórmules i desplegables directament des del full Excel original en qualsevol moment.

---

## 3. Gestió de Projectes Multi-document i Còpies de Seguretat

**elips** inclou un complet espai de treball per gestionar expedients complexos formats per múltiples documents que comparteixen un mateix model de dades.

### 3.1 Creació, canvi de nom i canvi de projecte actiu
A la capçalera de l'aplicació, el menú desplegable de projectes permet:
- Crear un **Nou Projecte** des de zero o a partir d'un full de càlcul.
- Canviar fàcilment entre diferents projectes desats localment al navegador.
- Reanomenar o duplicar projectes existents.

### 3.2 Gestió de múltiples documents vinculats al mateix model
Dins d'un mateix projecte (ex: `Licitació Plataforma TIC`), podeu gestionar múltiples documents amb les seves respectives plantilles Jinja2 (`.md.j2`) i fitxers de referència Word (`.docx`):
- **Memòria justificativa**
- **Plec de clàusules administratives particulars (PCAP)**
- **Plec de prescripcions tècniques (PPT)**
- **Informe tècnic de valoració / adjudicació**

Tots aquests documents comparteixen el mateix model de dades centralitzat de l'expedient. Quan canvieu de document actiu, l'aplicació carrega la seva plantilla corresponent sense perdre cap dada ni configuració del model.

### 3.3 Paquets de projecte ZIP: exportació completa i importació
Per garantir la portabilitat i la còpia de seguretat externa:
- **Exporta Paquet ZIP**: Feu clic al botó **📦 Descarrega Projecte (ZIP)** a la barra d'eines per generar un arxiu comprimit `projecte_<nom>.zip` que conté:
  - `project.json`: Manifest amb l'estructura de documents i configuració del projecte.
  - `dades_excel.json`: Còpia íntegra de les dades del model en format JSON.
  - `editor_metadata.json`: Esquema complet de tipus, regles i fórmules.
  - Fitxer binari Excel `.xlsx` associat.
  - Carpeta `documents/` amb totes les plantilles Markdown Jinja2 (`.md.j2`) i fitxers Word de referència (`.docx`).
- **Importa Paquet ZIP**: Podeu arrossegar o pujar el fitxer ZIP en qualsevol altre ordinador o navegador per restaurar el projecte al 100% a l'instant.

### 3.4 Històric de versions i punts de control horaris automàtics
Per evitar qualsevol pèrdua accidental de dades o canvis de redacció:
- **Enregistrament diferencial automàtic**: Cada vegada que modifiqueu una plantilla o el model de dades, l'aplicació desa els canvis en segon pla (amb un debounce intel·ligent).
- **Punts de control horaris automàtics**: L'aplicació crea automàticament un punt de control cada hora d'activitat.
- **Panell d'Històric de Versions (🕒)**: Podeu obrir el panell d'històric per visualitzar la cronologia de canvis, comparar diferències respecte a l'estat actual i restaurar qualsevol punt de control previ amb un sol clic.

---

## 4. Perfil 1: Guia per al perfil de configuració del model de dades i de les plantilles

Aquest perfil s'encarrega de dissenyar l'estructura de dades, configurar els formularis d'introducció de dades, definir les fórmules calculades i redactar la plantilla base.

### 4.1 L'editor de contingut: mode Visual i mode Codi

Tant la plantilla principal del document (pestanya **Plantilla**) com qualsevol camp de text extens del model de dades (vegeu [5.3](#53-redacció-de-text-extens-en-camps-del-model-el-mateix-editor-de-la-secció-41)) es redacten amb **el mateix editor de contingut**: no cal escriure Markdown ni Jinja2 a mà des de zero, encara que sempre és possible fer-ho.

L'editor té dos modes intercanviables amb els botons de la seva pròpia barra d'eines:

- **Mode Visual (WYSIWYG)**: Mostra el resultat ja formatat (negretes, títols, taules, blocs condicionals) i s'edita directament sobre aquesta vista.
- **Mode Codi**: Mostra el Markdown + Jinja2 en brut, amb números de línia i ressaltat de sintaxi.

En canviar entre els dos modes, o en tornar a obrir l'editor més tard, **el cursor i la posició d'scroll es mantenen** al mateix punt del text — no cal tornar a buscar on éreu treballant.

#### A. Inserció de variables i bucles des de la paleta lateral
La barra lateral dreta de l'editor mostra totes les variables i sub-taules disponibles a l'esquema de dades actual, organitzades per la seva ruta jeràrquica. Feu clic sobre qualsevol camp o sub-taula per inserir-lo a la posició del cursor:
- Clic sobre un camp ➔ insereix la variable (`{{ doc.General.titol_informe }}`).
- Clic sobre una sub-taula ➔ insereix l'esquelet d'un bucle `{% for %}...{% endfor %}` ja preparat per iterar-la.

#### B. Botons d'inserció de la barra d'eines
A més del format bàsic de text (negreta, cursiva, llistes, format de paràgraf H1-H6), la barra d'eines permet inserir sense escriure sintaxi Jinja2 a mà:
- **📊 Taula**: obre l'assistent de taules automàtiques — vegeu [4.2](#42-taules-automàtiques-dynamic_table-i-transposed_table).
- **∑ Fórmula**: insereix una expressió matemàtica LaTeX/KaTeX (inline o en bloc).
- **IF** / **FOR**: obren un modal per definir la condició o el bucle (variable, operador, valor de comparació) sense escriure `{% if %}`/`{% for %}` directament.
- **Caràcters especials**: guionets llargs, espais no separables i altres símbols tipogràfics.

Els blocs IF/FOR inserits d'aquesta manera es mostren al mode Visual com una capçalera amb la condició en text pla i botons contextuals per **afegir una branca ELIF/ELSE**, **canviar a mode integrat al text (Inline)** o **eliminar el bloc**. Quan un bloc queda col·lapsat (mostrant només la seva icona), useu el llapis (✏️) de la seva capçalera per editar-lo sense haver-hi d'entrar a dins primer.

#### C. Validació de variables contra l'esquema
El botó **"Comprova totes les variables i bucles"** (a sobre de la paleta lateral) analitza tota la plantilla i avisa de qualsevol variable inserida que no existeixi realment a l'esquema de dades actual — útil després de reanomenar o eliminar un camp del model.

---

### 4.2 Taules automàtiques (`DYNAMIC_TABLE` i `TRANSPOSED_TABLE`)

Les taules que s'omplen a partir d'una sub-taula del model de dades **no s'escriuen a mà**: es generen amb l'assistent del botó **📊 Taula** de la barra d'eines de l'editor.

#### A. L'assistent de taules
En obrir l'assistent, tria:
1. **La sub-taula d'origen** (ex: `pres.parts`).
2. **Quines columnes** s'hi mostren, i en quin ordre.
3. **L'orientació**:
   - **Estàndard (`DYNAMIC_TABLE`)**: una fila per registre, com una taula normal — pensada per a llistats llargs (partides, lots, membres de la mesa...).
   - **Transposada (`TRANSPOSED_TABLE`)**: una columna per registre i una fila per camp — pensada per a comparatives curtes (ex: comparar 3 perfils professionals cara a cara).
4. *(Opcional)* **Fila de totals**: afegeix una fila final amb Suma, Mitjana o Compte d'una columna numèrica.

Un cop inserida, la taula es mostra al mode Visual com una taula normal editable. Per tornar a obrir l'assistent sobre una taula ja existent (per canviar columnes, afegir-ne una que es va descartar la primera vegada, o activar la fila de totals), feu clic al seu **botó d'edició** — no cal recrear la taula des de zero.

#### B. Sintaxi subjacent (per a qui treballa en mode Codi)
Si preferiu escriure-ho directament en mode Codi, la taula estàndard es delimita així:

```markdown
<!-- DYNAMIC_TABLE_START:part in pres.parts -->
| Partida | Import |
| --- | ---: |
{% for part in pres.parts %}
| {{ part.nom_partida }} | {{ part.import | coin }} |
{% endfor %}
<!-- DYNAMIC_TABLE_END -->
```

I la taula transposada, amb els paràmetres del comentari de control:

```markdown
<!-- TRANSPOSED_TABLE_START:preu in preus;colHeader=descriptor;rows=preu_base,hores_any,sou_minim,costos_socials,cost_real,increment,cost_total,preu -->
| Dada | Responsable | Tècnic | Assistència |
| --- | :---: | :---: | :---: |
| Preu base | 0 | 0 | 0 |
| Hores any | 1690 | 1690 | 1690 |
| Sou minim anual | 28090.8 | 24969.6 | 18727.2 |
| Costos socials (32,15%) | 9031.19 | 8027.73 | 6020.79 |
| Cost real | 53031.42 | 47139.04 | 35354.28 |
| Increment | 15856.39 | 14094.57 | 10570.93 |
| Cost total | 68887.81 | 61233.61 | 45925.21 |
<!-- TRANSPOSED_TABLE_END -->
```

Paràmetres del bloc transposat:
1. `variable in llista`: Especifica la col·lecció a iterar (ex: `preu in preus` o `lot in Lots`).
2. `colHeader=camp`: Camp que s'utilitza com a títol de cada columna (ex: `colHeader=descriptor`).
3. `rows=camp1,camp2,camp3`: Llista separada per comes dels camps que s'han de representar en files.
4. **Filtres per fila**: Podeu aplicar filtres de format directament a la definició de les files:
   - `rows=preu_base|coin,hores_any|number(0),sou_minim|coin,cost_total|coin`

En tots dos casos, el motor de renderitzat s'encarrega d'eliminar automàticament els salts de línia sobrants que generarien els blocs `{% for %}`/`{% endfor %}`, perquè la taula resultant sigui sempre neta i compatible amb Pandoc i Microsoft Word — no cal afegir cap marcatge addicional per aconseguir-ho.

---

### 4.3 Filtres de format Jinja2 disponibles

Aplicables tant escrivint-los directament en mode Codi com dins l'assistent de taules (apartat 4.2.B):

- `{{ valor | coin }}` ➔ Formata com a moneda en català (ex: `12.345,67 €`).
- `{{ valor | number(2) }}` ➔ Formata amb separador de milers i decimals (ex: `1.234,56`).
- `{{ valor | percent }}` / `{{ valor | percentatge }}` ➔ Formata com a percentatge (ex: `21%`).
- `{{ valor | words }}` ➔ Converteix números a lletres (ex: `3` ➔ `tres`).
- `{{ text | prefix('de ', 'd\'') }}` ➔ Afegeix apostrofació correcta segons la primera lletra.
- `{{ llista | sort('camp') }}` ➔ Ordena una sub-taula per un camp (afegiu un `-` davant, `sort('-camp')`, per ordre descendent).
- `{{ llista | where(camp='valor') }}` / `{{ llista | filter(camp='valor') }}` ➔ Filtra els registres d'una sub-taula que compleixin la condició indicada.
- `{{ valor | cert }}` / `{{ valor is cert }}` i `{{ valor | fals }}` / `{{ valor is fals }}` ➔ Interpreten com a booleà qualsevol valor booleà d'Excel, tant si es va escriure com `TRUE`/`FALSE`, `Sí`/`No`, `1`/`0` com `Cert`/`Fals`.
- `{{ text | upper }}` / `{{ text | lower }}` ➔ Majúscules / minúscules (filtres estàndard de Jinja2).

> ⚠️ Els filtres `date` i `format_currency`/`format_number` que apareixien en versions anteriors d'aquest manual **no existeixen** al motor actual: useu `coin`/`number`/`percent` tal com es descriuen més amunt.

---

### 4.4 Configuració dels formularis i tipus de dades (`editor_metadata`)

Per configurar la naturalesa de cada camp, feu clic al botó **⚙️ Configura Tipus** situat a la capçalera de qualsevol grup o full de la pestanya **Dades**.

#### Tipus de dades suportats:
1. **Text (String)**: Camp de text estàndard o àrea de text multilínia.
2. **Number (Numèric)**: Valors decimals o enters per a càlculs.
3. **Date (Data)**: Selecció de dates en format calendari (`YYYY-MM-DD`).
4. **Boolean (Lògic)**: Desplegable de cert (`True`) o fals (`False`).
5. **Select (Desplegable i Enllaços d'Objectes Foreign Key)**:
   - **Estàtic**: Llista manual d'opcions separades per comes (`opcio1, opcio2, opcio3`).
   - **Dinàmic (Vector de dades / Relació Foreign Key)**: Enllaça amb una taula existent de l'Excel, permetent seleccionar la columna per fixar el valor (`valueField`, clau primària) i la columna per visualitzar-lo (`displayField`). Permet navegació directa per propietats de l'objecte associat com `part.Lot.nom` (vegeu també l'apartat 4.5, secció B, "Accés a les propietats d'una clau forana").
   - **Desplegable condicionat a un altre camp (filtre)**: un cop triada la taula d'origen, apareixen dos selectors addicionals: la **columna de filtre** (una columna de la taula d'origen) i el **camp d'aquest grup** el valor del qual s'ha de comparar amb aquella columna. Quan els dos estan configurats, el desplegable només mostra les files de la taula d'origen on la columna de filtre coincideix amb el valor actual d'aquell altre camp — útil per encadenar desplegables (ex: triar primer un `Lot` i que el desplegable de `Partides` només mostri les partides d'aquell lot).
   - **Selecció múltiple**: Permet escollir un o diversos valors simultàniament que es guarden com a etiquetes (*pills*).
6. **Computed (Calculat)**: Camp no editable directament que es calcula mitjançant el motor de fórmules d'elips.

---

### 4.5 Camps calculats (Computed), motor de fórmules i editor amb autocompletat

elips disposa d'un motor matemàtic i d'avaluació en **dues fases (*Bottom-Up Tree Evaluation*)**: primer calcula els valors de cada fila individual i, només després, suma o compta aquests resultats cap amunt de la jerarquia — així s'evita el problema típic dels sumatoris aniuats que queden a zero perquè s'avaluen abans que les seves files.

```
FASE 1 (Fórmules CUSTOM a nivell de fila)
  └── Avalua fórmules de fila com: import = preu * unitats
                                   └─► import = SI(persones > 0; persones * unitats * preu; unitats * preu)

FASE 2 (Agregacions SUM / COUNT / AVG a nivells superiors)
  └── Suma els valors ja calculats a la Fase 1 des de les sub-taules cap amunt.
```

#### A. Agregacions estàndard (menú "Funció" del camp calculat)
Al desplegable **Funció** d'un camp **Computed** podeu triar directament una agregació sense escriure cap fórmula, indicant la **sub-taula origen** i, si escau, la **columna** a operar:

| Opció al menú | Funció | Necessita columna? |
| :--- | :--- | :--- |
| SUMA | `SUM` | Sí |
| MITJANA | `AVERAGE` | Sí |
| RECOMPTE | `COUNT` | No (compta files) |
| MÍNIM / MÀXIM | `MIN` / `MAX` | Sí |
| SUMA CONDICIONAL | `SUMIF` | Sí (columna de criteri + columna a sumar) |
| BOOLEÀ OR / ALGUN | `OR` | Opcional |
| BOOLEÀ AND / TOTS | `AND` | Opcional |

- **SUMIF** necessita, a més de la sub-taula i la columna a sumar, una **columna de criteri** i un **valor de criteri**: escriviu el valor entre cometes per un literal (`"Obra"`) o sense cometes per referir-vos al valor d'un altre camp (`pres.tipus.nom`) — el mateix conveni que a les fórmules personalitzades (vegeu més avall).
- **OR/AND** consideren cert qualsevol valor "veritable" (`cert`, `true`, `1`, un número diferent de zero...) i fals la resta; sense columna, avaluen directament els elements de la sub-taula (útil si és una llista de booleans).

#### B. Fórmules personalitzades (`FÓRMULA` / `CUSTOM`)

Quan cap agregació estàndard s'ajusta al que voleu, trieu **FÓRMULA** al menú "Funció" i escriviu una expressió amb el mini-llenguatge propi d'elips. Aquesta és una sintaxi **independent** de Jinja2 (la de les plantilles, apartat 4.1): s'avalua sobre les dades, mai dins del document final, i els noms de funció es donen en català.

En sortir del quadre de la fórmula (tant a la casella ràpida com a l'editor ampliat "Amplia"), elips en comprova automàticament la sintaxi amb el mateix analitzador que l'avalua realment: si hi ha un error (parèntesi sense tancar, un `;` de més, una funció desconeguda...) apareix immediatament sota el quadre en vermell i queda registrat al registre d'activitat, sense necessitat de generar cap document per descobrir-ho.

**Referències a camps**
- Un nom sol (`preu`, `unitats`) es refereix sempre a una propietat de la **mateixa fila** on s'avalua la fórmula.
- Un camí amb punts (`pres.tipus_ref`, `pres.parts.import`) navega des de l'arrel de les dades: primer busca el camí dins la fila actual, després a tot l'arbre de dades.
- Si el camí travessa una **sub-taula** (una llista de files) i s'utilitza en una operació aritmètica normal (no dins una funció d'agregació), el valor es converteix automàticament en la **suma** de la columna indicada a totes les files (ex: `pres.parts.import` val el total de la columna `import` de totes les partides).
- **Accés a les propietats d'una clau forana**: si un camp és un desplegable dinàmic (Select amb relació Foreign Key, apartat 4.4) que apunta a una fila d'una altra taula, podeu navegar directament a les columnes d'aquella fila relacionada afegint-hi un punt: si el camp `partida` és un Select dinàmic cap a la taula `partides`, la fórmula `partida.descripcio` retorna la columna `descripcio` de la fila triada.
- Podeu indexar un element concret d'una sub-taula amb claudàtors: `pres.parts[0].import` (la primera fila).
- **`parent` — accés a la fila del node pare**: dins d'una estructura aniuada (una sub-taula dins d'una altra sub-taula, com `pres.parts.activitats.costs`), `parent` es refereix a la fila contenidora immediata (per a un `cost`, la seva `activitat`) i en permet llegir qualsevol camp amb un punt: `parent.nom_activitat`. `parent` té comportament recursiu: `parent.parent` és el pare del pare (la `part` que conté l'`activitat`), `parent.parent.parent` el següent nivell, i així indefinidament. A un grup de primer nivell (sense cap estructura aniuada per sobre) `parent` no té cap fila a què apuntar i la fórmula retorna buit — no dona error, però tampoc un valor útil. `parent` és una paraula reservada del minillenguatge: si algun dia una columna es diu literalment `parent`, aquest nom sempre es resol com "vés al node pare", mai com la columna.

**Operadors**
- Aritmètics: `+` `-` `*` `/` (divisió) `//` (divisió entera) `%` (mòdul) `^` o `**` (potència). `+` també concatena text quan els dos costats són cadenes.
- Comparació: `=` o `==` (igual), `<>` o `!=` (diferent), `<` `<=` `>` `>=`.
- Lògics: `and`, `or`, `not` (en minúscules exactes) combinen condicions normalment, ex: `actiu and unitats > 0`.
- Condicional a l'estil Python: `valor_cert if condició else valor_fals` (equivalent a `SI(condició; valor_cert; valor_fals)`).

**Funcions disponibles**
- `SI(condició; valor_cert; valor_fals)` / `IF(...)`: condicional lògic.
- `ARRODONEIX(valor; decimals)` / `ROUND(...)`: arrodoneix al nombre de decimals indicat.
- `ABS(valor)`: valor absolut.
- `CERT(valor)` / `FALS(valor)`: comprova si un valor és "veritable" o "fals" amb el mateix criteri tolerant que OR/AND (`cert`, `true`, `1`... compten com a cert).
- `OR(camí)` (sinònims `O`, `ANY`, `SOME`) / `AND(camí)` (sinònims `I`, `EVERY`, `ALL`): donat un camí que travessa una sub-taula, comproven si **algun** o **tots** els valors d'aquella columna són certs. Ex: `OR(pres.parts.actiu)` és cert si alguna partida té `actiu` a cert.
- `SUM(grup.taula.columna)` / `AVERAGE(grup.taula.columna)` / `AVG(...)` / `MIN(...)` / `MAX(...)`: agreguen una columna d'una sub-taula, igual que l'opció de menú equivalent, però utilitzables dins d'una fórmula més gran (ex: `ARRODONEIX(SUM(pres.parts.import) * 0.21; 2)`).
- `MIN(a; b; ...)` / `MAX(a; b; ...)`: amb dos o més valors solts (no un únic camí a una sub-taula), donen el mínim o màxim element a element.
- `COUNT(grup.taula)`: nombre de files d'una sub-taula.
- `SUMIF(grup.taula.columna_criteri; criteri; grup.taula.columna_suma)`: suma `columna_suma` només a les files on `columna_criteri` coincideix amb `criteri`. El `criteri` segueix el mateix conveni de cometes que al menú d'agregacions: **entre cometes = valor literal** (`"Obra"`), **sense cometes = referència a un altre camp** (`pres.tipus_ref`).

**Què NO fa aquest mini-llenguatge** (a diferència dels filtres Jinja2 de les plantilles): no formata monedes ni percentatges, no concatena text amb una funció `CONCAT`, ni transforma majúscules/minúscules — per a tot això, useu els [filtres Jinja2 disponibles](#43-filtres-de-format-jinja2-disponibles) directament a la plantilla. L'únic lloc on una petita variant de `CONCAT`/`MONEDA`/`ARRODONEIX`/`UPPER`/`LOWER` sí que funciona és als **títols dinàmics per fórmula** (`itemTitleFormula`, apartat 4.6), que és un mini-llenguatge encara més senzill i completament diferent, pensat només per compondre un text curt de capçalera.

**Exemples**
```
import = preu * unitats
import = SI(persones > 0; persones * unitats * preu; unitats * preu)
té_partides_actives = OR(pres.parts.actiu)
total_obra = SUMIF(pres.parts.categoria; "Obra"; pres.parts.import)
preu_unitari = partida.preu           (accés a la fila relacionada d'un Select dinàmic)
etiqueta = "Lot " + nom_lot if nom_lot != "" else "Sense lot"
```

#### C. Editor ampliat de fórmules amb autocompletat intel·ligent
En fer clic al botó **✏️ Amplia** al costat d'una fórmula:
- **Paleta de camps**: Cliqueu qualsevol camp de la fila o ruta global per inserir-lo.
- **Autocompletat al textarea**: Comenceu a escriure el nom d'un camp o funció (ex: `imp`, `SI`, `SUMIF`) per veure el menú emergent de suggeriments. Desplaceu-vos amb les fletxes ⬆️ / ⬇️ i premeu **Enter** o **Tab** per completar.

---

### 4.6 Nivells intermedis de relacions aniuades (títols dinàmics, acordió i reordenació)

A l'hora de gestionar dades aniuades complexes (ex: `Pressupost -> Partides -> Activitats -> Costos`), els nivells intermedis disposen de funcionalitats avançades:

```
┌────────────────────────────────────────────────────────────────────────┐
│ ▼ 🏷️ Partida 1: Desenvolupament Web (80.000,00 €)         [⬆️] [⬇️] [🗑️]│
├────────────────────────────────────────────────────────────────────────┤
│   [ Formulari de camps de la partida: Responsable, Termini... ]        │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │ Sub-taula Activitats (3 elements)                            │     │
│   └──────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Títols dinàmics per fórmula (`itemTitleFormula`)**:
   - Al modal de configuració del grup pare, podeu definir una fórmula per generar el títol visible de cada targeta de registre intermedi.
   - *Exemple*: `CONCAT(nom_partida; " ("; MONEDA(import_partida); ")")`
   - En canviar qualsevol valor del registre, el títol de la targeta s'actualitza a l'instant.
2. **Col·lapse tipus acordió**:
   - Feu clic a la capçalera de qualsevol targeta per plegar o desplegar el seu contingut.
   - Botons ràpids **"Desplega tot"** i **"Col·lapsa tot"** per gestionar taules amb desenes de registres amb màxima comoditat.
3. **Reordenació d'elements (⬆️ / ⬇️)**:
   - Botons de fletxa per moure qualsevol element cap amunt o cap avall dins de la llista.
   - La nova ordenació es reflecteix immediatament a l'arbre de dades i a les plantilles Jinja2.

---

### 4.7 Personalització del disseny visual dels formularis (grid, editor visual drag&drop, etiquetes i consells)

#### A. Editor Visual de Graella Drag & Drop (Visual Grid Editor)
Al modal **⚙️ Configura Tipus**, feu clic a **🎨 Dissenyador Visual de Quadrícula**:
- Permet arrossegar i amollar camps per definir la seva posició exacta per files i columnes sense necessitat d'introduir números manuals de fila.

#### B. Distribució personalitzada a la quadrícula (`Fila grid`, `Ordre` i `Omple`)
- **Fila grid**: Especifica la fila on se situa el camp (`1`, `2`, `3`...). Els camps amb el mateix número de fila es col·loquen de costat.
- **Ordre**: Ordre d'esquerra a dreta dins de la fila.
- **Omple (gridFill)**: Casella que fa que el camp absorbeixi tot l'espai horitzontal restant de la fila (`flex-grow: 1`).

#### C. Etiquetes i consells d'ajuda
- En assignar una **Etiqueta al formulari**, el nom tècnic de la clau s'amaga de la vista principal i es mostra com a consell emergent (*tooltip*) en passar el cursor sobre l'etiqueta.

---

## 5. Perfil 2: Guia per al perfil tècnic usuari de l'aplicació

Aquest perfil utilitza l'aplicació per introduir les dades específiques d'un contracte/expedient i generar la documentació final.

### 5.1 Càrrega i importació de dades d'expedient
1. Obriu l'aplicació **elips** al navegador.
2. A la pestanya **Fitxers d'entrada**:
   - Arrossegueu o seleccioneu l'arxiu Excel de l'expedient (`.xlsx`).
   - Arrossegueu o seleccioneu la plantilla Markdown Jinja2 (`.md.j2`).
   - *(Opcional)* Seleccioneu un document de referència Word corporatiu (`.docx`) per aplicar els estils i logotips institucionals.
   - *O directament importeu un paquet complet `projecte_<nom>.zip`.*

---

### 5.2 Emplenat i edició de dades des de l'aplicació web

A la pestanya **Dades**:
- **Camps generals (Clau-valor)**: Ompliu les dades del contracte a través de formularis ràpids organitzats per blocs.
- **Sub-taules (Tabulars)**: Afegiu files amb `+ Afegeix fila`, reordeneu-les amb les fletxes ⬆️ / ⬇️ o plegueu-les amb l'acordió.
- **Camps calculats**: Estan protegits contra escriptura accidental, identificats amb la icona de calculadora i s'actualitzen automàticament en temps real quan modifiqueu qualsevol camp relacionat.

---

### 5.3 Redacció de text extens en camps del model (el mateix editor de la secció 4.1)

Quan un camp del model requereix una redacció extensa (justificació de necessitat, criteris de solvència, etc.):
1. Feu clic a la icona d'edició (✏️) al costat del camp de text.
2. S'obrirà un modal amb **exactament el mateix editor de contingut descrit a l'apartat [4.1](#41-leditor-de-contingut-mode-visual-i-mode-codi)** (mode Visual/Codi, paleta de variables, assistent de taules, blocs IF/FOR), aquesta vegada centrat només en aquest camp concret.
3. La **previsualització en temps real** us permet comprovar el resultat renderitzat abans de tancar el modal.

No hi ha cap diferència d'editor entre redactar la plantilla principal del document i redactar un camp de text del model: totes dues coses fan servir el mateix editor. Hi ha, però, una diferència en **quines variables hi ha disponibles**:

- A la **plantilla principal**, un bucle `{% for part in pres.parts %}` deixa `part` visible a dins seu de manera normal (l'abast lèxic habitual de Jinja2), inclosos els bucles aniuats: `{% for activitat in part.activitats %}` hi funciona directament.
- Dins del **text d'un camp concret** (p. ex. el camp de notes d'una partida), no hi ha cap variable de bucle equivalent, perquè aquest text s'avalua sol, fora de qualsevol `{% for %}` de la plantilla principal. Per això, dins d'aquest text, **els propis camps de la fila (aquesta partida) estan disponibles directament pel seu nom**, exactament igual que a les fórmules personalitzades (apartat 4.5.B): si la partida té una sub-taula `activitats`, el text del seu propi camp "Notes" pot escriure `{% for a in activitats %}...{% endfor %}` sense necessitat de fixar cap índex, i el resultat serà sempre "les activitats d'aquesta partida concreta" — no cal (ni funciona) escriure `part.activitats` ni `pres.parts[0].activitats` aquí. També hi teniu accessible `parent` (i `parent.parent`, recursivament) per pujar a la fila contenidora, amb el mateix comportament que a les fórmules.

---

### 5.4 Generació, previsualització i Tauler de Control (Descàrregues i Esquema)

1. **Tauler de Control integrat**:
   - **Pestanya Descàrregues**: Executa la compilació i permet baixar els documents generats en format Word (`.docx`), Markdown (`.md`) i JSON (`dades.json`).
   - **Pestanya Esquema (Navegació contextual)**:
     - *En mode Plantilla*: Mostra l'estructura de la plantilla Jinja2 amb les variables dinàmiques. En clicar un encapçalament, l'editor es posiciona a la línia corresponent.
     - *En mode Previsualització*: Mostra l'arbre jeràrquic del document ja avaluat amb totes les iteracions desplegades. En clicar, desplaça la vista fins a la secció corresponent.
2. **Panell "Incidències i Validacions de la Plantilla"**: Sota el Tauler de Control, aquest panell llista qualsevol variable que el motor no hagi pogut resoldre durant la darrera generació (vegeu la nota de tolerància a errors de l'apartat 1 i la pregunta corresponent a l'apartat [6. FAQ](#6-bones-pràctiques-i-resolució-de-problemes-faq)). Si no hi ha cap incidència, ho indica explícitament amb una marca verda.
3. **Exportació de l'Excel**: Podeu fer clic a **Exporta dades a Excel** per desar totes les dades introduïdes a la web en un arxiu `.xlsx` que manté intactes les fórmules i les metadades.

---

## 6. Bones pràctiques i resolució de problemes (FAQ)

### ❓ Què faig si en carregar un fitxer Excel no es veuen les fórmules o tipus configurats?
**R:** Feu clic al botó **📥 Restaura de l'Excel** situat al grup **ESTRUCTURA** de la barra d'eines de dades o dins del modal **⚙️ Configura Tipus**. L'aplicació rellegirà immediatament el full `editor_metadata` i restablirà totes les regles.

### ❓ Quin nom han de tenir les sub-taules a l'Excel?
**R:** Els fulls aniuats han de seguir la nomenclatura del camí arrel separat per punts amb el prefix `OUT_` (ex: `OUT_Pressupost.Partides` i `OUT_Pressupost.Partides.Activitats`).

### ❓ Per què un sumatori d'una sub-taula em queda a zero?
**R:** Assegureu-vos que la fórmula personalitzada de la sub-taula fill utilitza el tipus `CUSTOM` (ex: `preu * hores`) i que la funció agregadora del pare utilitza `SUM` apuntant al nom exacte de la sub-taula i de la columna de destinació.

### ❓ Què vol dir l'avís "Variable Indefinida Detectada" al panell d'incidències?
**R:** El motor de renderitzat no s'atura mai encara que una variable de la plantilla no existeixi al model de dades: la substitueix per un valor visible (`<<nom_variable: sense dades>>`) i continua generant la resta del document, perquè sempre pugueu obtenir un esborrany per revisar. L'avís indica exactament la línia de la plantilla i el nom de la variable que cal corregir — normalment perquè s'ha reanomenat o eliminat un camp del model sense actualitzar la plantilla (useu el botó "Comprova totes les variables" de l'apartat [4.1.C](#41-leditor-de-contingut-mode-visual-i-mode-codi) per detectar-ho abans de generar).

### ❓ Com puc compartir un projecte complet amb un altre company?
**R:** Feu clic a **📦 Descarrega Projecte (ZIP)**. El fitxer descarregat conté totes les plantilles, dades, metadades i documents Word. El vostre company només haurà de pujar el fitxer ZIP a **elips** per continuar treballant exactament des del mateix punt.

### ❓ Què vol dir la icona vermella 🔴 "Error en desar" al costat del botó Desa?
**R:** elips desa el projecte i el document actiu a l'espai d'emmagatzematge local del navegador (`localStorage`), que té una mida limitada compartida entre **tots** els vostres projectes desats (normalment uns 5-10 MB per navegador). Si aquest espai s'esgota — típicament perquè s'han acumulat diversos projectes amb models grans — el desat (tant l'automàtic com el manual amb el botó **Desa**) no es pot completar, i la icona 🔴 substitueix l'habitual 🟢/🟠/🔵 fins que torneu a desar amb èxit. Els canvis d'aquesta sessió **no estan desats** mentre la icona sigui vermella. Consulteu el registre d'activitat per al detall de l'error, i esborreu algun projecte que ja no necessiteu des de **⚙️ Gestiona Projectes** per alliberar espai; torneu-ho a provar amb el botó **Desa** un cop fet.

---
*Documentació actualitzada per a elips v2.0 - Entorn web WASM/Pyodide de generació de contractes públics.*
