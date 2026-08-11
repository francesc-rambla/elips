# 📘 Manual d'usuari d'elips (Editor de LIcitacions PúbliqueS)
**Generador de documentació i gestió d'expedients de contractació pública**

---

## 📑 Índex de continguts
1. [Introducció i filosofia d'elips](#1-introducció-i-filosofia-delips)
2. [Arquitectura del model de dades i jerarquia d'Excel](#2-arquitectura-del-model-de-dades-i-jerarquia-dexcel)
3. [Perfil 1: Guia per al perfil de configuració del model de dades i de les plantilles](#3-perfil-1-guia-per-al-perfil-de-configuració-del-model-de-dades-i-de-les-plantilles)
   - [3.1 Disseny de les plantilles Jinja2 (`.md.j2`)](#31-disseny-de-les-plantilles-jinja2-mdj2)
   - [3.2 Configuració dels formularis i tipus de dades (`editor_metadata`)](#32-configuració-dels-formularis-i-tipus-de-dades-editor_metadata)
   - [3.3 Camps calculats (Computed) i motor de fórmules personalitzades (`SI/IF`)](#33-camps-calculats-computed-i-motor-de-fórmules-personalitzades-siif)
   - [3.4 Personalització del disseny visual dels formularis (grid, etiquetes i consells)](#34-personalització-del-disseny-visual-dels-formularis-grid-etiquetes-i-consells)
4. [Perfil 2: Guia per al perfil tècnic usuari de l'aplicació](#4-perfil-2-guia-per-al-perfil-tècnic-usuari-de-laplicació)
   - [4.1 Càrrega i importació de dades d'expedient](#41-càrrega-i-importació-de-dades-dexpedient)
   - [4.2 Emplenat i edició de dades des de l'aplicació web](#42-emplenat-i-edició-de-dades-des-de-laplicació-web)
   - [4.3 L'editor visual per a cel·les de text ric (Markdown + Jinja2)](#43-leditor-visual-per-a-celles-de-text-ric-markdown--jinja2)
   - [4.4 Generació, previsualització i exportació de documents (DOCX, MD, XLSX)](#44-generació-previsualització-i-exportació-de-documents-docx-md-xlsx)
5. [Bones pràctiques i resolució de problemes (FAQ)](#5-bones-pràctiques-i-resolució-de-problemes-faq)

---

## 1. Introducció i filosofia d'elips

**elips** (*Editor de LIcitacions PúbliqueS*) és una plataforma web d'alta eficiència dissenyada per automatitzar la creació, validació i redacció de memòries justificatives, plecs de clàusules administratives i tècniques, i altres documents complexos de contractació pública.

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
3. **Avaluació dinàmica doble**: El contingut introduït als camps de text del model de dades pot contenir expressions dinàmiques Jinja2 (`{{ doc.pres.contractant }}`), que s'avaluen automàticament durant la compilació del document final.

---

## 2. Arquitectura del model de dades i jerarquia d'Excel

L'estructura de dades d'un projecte s'organitza en fulls de treball d'un llibre d'Excel (`.xlsx`), o directament a l'arbre de dades interactivament a l'aplicació.

### 📊 Tipus de fulls i prefixació `OUT_`
Per organitzar la informació i evitar interferències amb altres fulls auxiliars de l'Excel, els fulls destí de la documentació utilitzen el prefix `OUT_` seguit del camí jeràrquic puntuat:

| Nom del full a l'Excel | Nivell jeràrquic | Tipus de full | Descripció |
| :--- | :--- | :--- | :--- |
| `OUT_pres` | 1 (Arrel) | **Clau-valor (KV)** | Formulari d'un sol registre amb dades generals del contracte (títol, expedient, òrgan, etc.). |
| `OUT_pres.parts` | 2 (Sub-taula) | **Tabular (Llista)** | Llista de partides o lots del pressupost. |
| `OUT_pres.parts.activitats` | 3 (Sub-taula) | **Tabular (Llista)** | Detall d'activitats vinculades a cada partida. |
| `OUT_pres.parts.activitats.costs` | 4 (Sub-taula) | **Tabular (Llista)** | Detall de desglossament de costos unitaris. |

### 🔒 Conservació de la configuració: full `editor_metadata`
Tota la configuració de tipus de dades, opcions desplegables, fórmules i disseny visual es desa automàticament al full ocult `editor_metadata` de l'arxiu Excel (amb 16 columnes de metadades). Això garanteix que, en compartir el fitxer `.xlsx` amb altres usuaris o reimportar-lo, **tota la configuració de formularis es manté intacta**.

---

## 3. Perfil 1: Guia per al perfil de configuració del model de dades i de les plantilles

Aquest perfil s'encarrega de dissenyar l'estructura de dades, configurar els formularis d'introducció de dades, definir les fórmules calculades i redactar la plantilla base en Jinja2.

### 3.1 Disseny de les plantilles Jinja2 (`.md.j2`)
Les plantilles s'escriuen en format Markdown combinat amb la sintaxi Jinja2.

#### A. Inserció de variables directes
Per accedir a un camp del model de dades arrel:
```markdown
# MEMÒRIA JUSTIFICATIVA DEL CONTRACTE
**Títol del contracte:** {{ doc.pres.descripcio_contracte }}  
**Expedient:** {{ doc.pres.num_expedient }}  
**Òrgan de contractació:** {{ doc.pres.organ_contractacio }}  
```

#### B. Bucles i recursivitat a sub-taules
Per recórrer taules aniuades (`parts -> activitats -> costs`):
```markdown
{% for part in doc.pres.parts %}
## Partida {{ loop.index }}: {{ part.nom_partida }}
*Import partida:* {{ part.import_partida | format_currency }}

{% for act in part.activitats %}
### Activitat {{ loop.index }}: {{ act.descripcio }}
- Hores previstes: {{ act.hores }} h
- Preu hora: {{ act.preu_hora | format_currency }}
- Subtotal: {{ act.import_activitat | format_currency }}
{% endfor %}
{% endfor %}
```

#### C. Filtres de format i manipulació de llistes disponibles
elips incorpora filtres d'alta precisió en català/espanyol:
- `{{ valor | format_currency }}` ➔ Formata com a moneda (ex: `12.345,67 €`).
- `{{ valor | format_number(2) }}` ➔ Formata amb milers i decimals (ex: `1.234,56`).
- `{{ data | date('%d/%m/%Y') }}` ➔ Formata dates.
- `{{ text | upper }}` / `{{ text | lower }}` ➔ Majúscules / minúscules.

##### Filtres de llista (`sort` i `filter` / `where`):
- **Ordenació (`sort`)**:
  - `llista | sort` ➔ Ordena la llista en ordre ascendent per la primera columna.
  - `llista | sort("columna")` ➔ Ordena en ordre ascendent per `"columna"`.
  - `llista | sort("-columna")` ➔ Ordena en ordre descendent per `"columna"` (prefix `-`).
  - `llista | sort(["columna1", "-columna2"])` ➔ Ordena per múltiples columnes (ascendent per `"columna1"` i descendent per `"columna2"`).
- **Filtratge (`filter` / `where`)**:
  - `llista | filter({ "columna1": "valor1" })` ➔ Retorna només els elements on `"columna1"` sigui igual a `"valor1"`. Si el diccionari conté més claus (ex: `{ "columna1": "v1", "columna2": "v2" }`), filtra aplicant totes les condicions.

---

### 3.2 Configuració dels formularis i tipus de dades (`editor_metadata`)

Per configurar la naturalesa de cada camp, feu clic al botó **⚙️ Configura Tipus** situat a la capçalera de qualsevol grup o full de la pestanya **Dades**.

#### Tipus de dades suportats:
1. **Text (String)**: Camp de text estàndard o àrea de text multilínia.
2. **Number (Numèric)**: Valors decimals o enters per a càlculs.
3. **Date (Data)**: Selecció de dates en format calendari (`YYYY-MM-DD`).
4. **Boolean (Lògic)**: Desplegable de cert (`True`) o fals (`False`).
5. **Select (Desplegable i Enllaços d'Objectes Foreign Key)**:
   - **Estàtic**: Llista manual d'opcions separades per comes (`opcio1, opcio2, opcio3`).
   - **Dinàmic (Vector de dades / Relació Foreign Key)**: Enllaça amb una taula existent de l'Excel, permetent seleccionar la columna per fixar el valor (`valueField`, clau primària) i la columna per visualitzar-lo (`displayField`). **Navegació d'objectes enllaçats**: Quan s'assigna una dada a partir d'una sub-taula (ex: la columna `Lot` d'una partida que enllaça amb la taula `Lots`), el camp es converteix automàticament en un **objecte complet** tant per a Jinja2 com per a les fórmules calculades. Això permet referenciar directament propietats de la taula associada com `part.Lot.nom`, `part.Lot.codi` o `part.Lot.limit_pressupost`!
   - **Selecció múltiple**: Permet escollir un o diversos valors simultàniament que es guarden com a etiquetes (*pills*).
6. **Computed (Calculat)**: Camp no editable directament que es calcula mitjançant el motor de fórmules d'elips.

---

### 3.3 Camps calculats (Computed) i motor de fórmules personalitzades (`SI/IF`)

elips disposa d'un motor matemàtic i d'avaluació en **dues fases (*Bottom-Up Tree Evaluation*)** que evita valors a zero en sumatoris aniuats a múltiples nivells:

```
FASE 1 (Fórmules CUSTOM a nivell de fila)
  └── Avalua fórmules de fila com: import = preu * unitats
                                   └─► import = SI(persones > 0; persones * unitats * preu; unitats * preu)

FASE 2 (Agregacions SUM / COUNT / AVG a nivells superiors)
  └── Suma els valors ja calculats a la Fase 1 des de les sub-taules cap amunt.
```

#### A. Agregacions estàndard (`SUM`, `COUNT`, `AVG`)
Permet calcular el total d'una columna de la sub-taula fill des del nivell pare:
- **Funció**: `SUM`
- **Sub-taula**: `activitats`
- **Columna**: `import_activitat`

#### B. Fórmules personalitzades de fila (`CUSTOM`)
Permet calcular valors utilitzant expressions matemàtiques avançades amb accés a tot el model de dades:

1. **Accés a rutes globals del model de dades (Sintaxi Jinja2)**:
   - Es pot fer referència a qualsevol camp del model global escrivint la ruta puntuada (ex: `pres.pbl`, `doc.pres.pbl`, `general.pbl`, `parts[0].import` o `parts.import`).
2. **Funcions matemàtiques i condicionals incloses**:
   - `SI(condició; expressió_cert; expressió_fals)` / `IF(...)`: Condicional lògic.
   - `ARRODONEIX(valor; prec=0)` / `ROUND(valor; prec=0)`: Arrodoneix un valor numèric al nombre de decimals indicat (per defecte 0).
   - `ABS(valor)`: Retorna el valor absolut d'un número.
   - `MIN(a; b)` / `MAX(a; b)`: Retorna el valor mínim o màxim.

Exemples de fórmules vàlides:
- `SI(pres.pbl > 100000; ARRODONEIX(pres.pbl * 0.21; 2); 0)`
- `ARRODONEIX(preu * unitats; 2)`
- `ABS(import_estimat - import_real)`

#### ✏️ Editor ampliat de fórmules modal
En seleccionar la funció `CUSTOM`, feu clic al botó **✏️ Amplia** per obrir l'editor ampliat de fórmules:
- **Insígnies de camps locals i rutes globals Jinja2**: Cliqueu qualsevol insígnia local (`+ unitats`, `+ preu`) o global (`+ pres.pbl`, `+ pres.iva`) per inserir-la directament a la posició del cursor.
- **Botons d'operadors i funcions ràpides**: Botons d'accés directe per a `+`, `-`, `*`, `/`, `%`, `^`, `( )`, `SI(...)`, `ARRODONEIX(...)` i `ABS(...)`.

---

### 3.4 Personalització del disseny visual dels formularis (grid, etiquetes i consells)

elips ofereix eines avançades per dissenyar la disposició visual dels formularis d'introducció de dades:

#### A. Posició global de les etiquetes (`labelPosition`)
A la finestra de **Configuració avançada (⚙️)** de la barra superior:
- **A dalt (Superiors - Per defecte)**: Les etiquetes es col·loquen directament a dalt dels camps d'entrada en una quadrícula de targetes d'alta llegibilitat.
- **A l'esquerra**: Les etiquetes s'alineen horitzontalment a la meitat esquerra del camp.

#### B. Distribució personalitzada a la quadrícula (`Fila grid`, `Ordre` i `Omple`)
Al modal de configuració de tipus de dades (⚙️ Configura Tipus):
- **Fila grid**: Especifica a quina fila de la quadrícula ha d'aparèixer el camp (`1`, `2`, `3`...). Els camps amb la mateixa fila se situen colze a colze.
- **Ordre**: Especifica l'ordre de prioritat d'esquerra a dreta dins de la mateixa fila.
- **Omple (gridFill)**: Casella de selecció clicable. Quan està marcada, el camp s'expandeix horitzontalment (`flex-grow: 1`) fins a **absorbir tot l'espai horitzontal disponible a la fila**. Els altres camps de la mateixa fila mantenen la seva amplada compacta, mentre que el camp amb l'opció "Omple" s'ajusta de manera adaptativa.
- *Si es deixen en buit (Auto), els camps es distribueixen automàticament de manera adaptativa.*

#### C. Etiquetes i consells d'ajuda (`title`)
Quan s'assigna una **Etiqueta al formulari** personalitzada (ex: *"Descripció de l'activitat"*):
- El nom intern de la clau (`descripcio`) s'amaga de la vista principal per no recarregar la interfície.
- En passar el cursor sobre l'etiqueta, apareix automàticament un consell/hint en un emergent (`Clau de camp: descripcio`).

---

## 4. Perfil 2: Guia per al perfil tècnic usuari de l'aplicació

Aquest perfil utilitza l'aplicació per introduir les dades específiques d'un contracte/expedient i generar la documentació final.

### 4.1 Càrrega i importació de dades d'expedient
1. Obriu l'aplicació **elips** al navegador.
2. A la pestanya **Fitxers d'entrada**:
   - Arrossegueu o seleccioneu l'arxiu Excel de l'expedient (`.xlsx`).
   - Arrossegueu o seleccioneu la plantilla Markdown Jinja2 (`.md.j2`).
   - *(Opcional)* Seleccioneu un document de referència Word corporatiu (`.docx`) per aplicar els estils i logotips institucionals.

---

### 4.2 Emplenat i edició de dades des de l'aplicació web

Un cop carregat l'Excel, aneu a la pestanya **Dades**:

#### A. Navegació jeràrquica
A la columna esquerra trobareu l'arbre de seccions de l'expedient:
- **Camps generals (Clau-valor)**: Ompliu les dades del contracte a través de formularis ràpids amb etiquetes superiors.
- **Sub-taules (Tabulars)**: Afegiu, reordeneu o elimineu rengleres de partides, activitats o costos amb els botons `+ Afegeix fila` i `Eliminar`.

#### B. Identificació i protecció de camps calculats
Els camps calculats (com import total, IVA, o aplicació de fórmules) estan protegits contra edició manual i s'identifiquen clarament amb la **icona monocromàtica de calculadora** i l'etiqueta `Calculat`. Aquests valors s'actualitzen automàticament al moment en què modifiqueu qualsevol camp precursor. Per evitar confusions, la icona d'edició en llapis (✏️) s'amaga en aquests camps.

#### C. Protecció contra eliminació d'estructures de dades
Per prevenir errors accidentals d'eliminació de claus durant l'emplenat de dades, la icona de paperera (🗑️) per esborrar un camp o clau s'amaga de la vista principal del formulari i només és accessible des del modal de **⚙️ Configuració del Grup / Tipus de Dades**.

---

### 4.3 L'editor visual per a cel·les de text ric (Markdown + Jinja2)

Quan un camp requereix una redacció extensa (com la justificació de la necessitat, criteris d'adjudicació o requeriments tècnics):

1. Feu clic a la icona d'edició (✏️) situada al costat del camp de text.
2. S'obrirà el modal **Editor de contingut complex (Markdown + Jinja2)**:
   - **Mode visual (WYSIWYG)**: Permet formatar el text amb negretes, itàliques, llistes, taules i encapçalaments de manera intuïtiva.
   - **Mode codi (Source)**: Permet editar directament el codi Markdown i Jinja2 pur.
   - **Desplegable d'insígnies Jinja2**: Permet seleccionar i inserir qualsevol variable del model de dades (ex: `{{ doc.pres.num_expedient }}`) a la posició exacta del cursor.
   - **Previsualització en temps real**: Permet comprovar exactament com es renderitzarà el text abans de desar-lo.

---

### 4.4 Generació, previsualització i exportació de documents (DOCX, MD, XLSX)

Un cop completades les dades:

1. Aneu a la pestanya **Previsualització i compilació**.
2. Previsualitzeu el document generat en temps real.
3. Feu clic a **Compilar i baixar DOCX** per generar el document de Word oficial formatat segons l'estil corporatiu.
4. *(Opcional)* Feu clic a **Exporta dades a Excel** a la pestanya de Dades per guardar totes les modificacions realitzades des de la web en un nou arxiu `.xlsx` que mantindrà intacta la configuració i les fórmules.

---

## 5. Bones pràctiques i resolució de problemes (FAQ)

### ❓ Quin nom han de tenir les sub-taules a l'Excel?
**R:** Els fulls aniuats han de seguir la nomenclatura del camí arrel separat per punts amb el prefix `OUT_` (ex: `OUT_pres.parts` i `OUT_pres.parts.activitats`).

### ❓ Per què un sumatori d'una sub-taula em queda a zero?
**R:** Assegureu-vos que la fórmula personalitzada de la sub-taula fill utilitza el tipus `CUSTOM` i que la funció agregadora del pare utilitza `SUM` apuntant al nom exacte de la sub-taula i de la columna de destinació.

### ❓ Com puc compartir un model de dades configurat amb un altre departament?
**R:** Només cal que els envieu l'arxiu Excel (`.xlsx`). Com que la configuració es guarda al full ocult `editor_metadata`, ells només hauran de carregar el fitxer a **elips** i tindran tots els formularis, desplegables i fórmules a punt.

---
*Documentació actualitzada per a elips v2.0 - Entorn web WASM/Pyodide de generació de contractes públics.*
