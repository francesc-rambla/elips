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
   - [4.1 Disseny de les plantilles Jinja2 (`.md.j2`)](#41-disseny-de-les-plantilles-jinja2-mdj2)
   - [4.2 Taules transposades (`TRANSPOSED_TABLE`) i filtres per fila](#42-taules-transposades-transposed_table-i-filtres-per-fila)
   - [4.3 Configuració dels formularis i tipus de dades (`editor_metadata`)](#43-configuració-dels-formularis-i-tipus-de-dades-editor_metadata)
   - [4.4 Camps calculats (Computed), motor de fórmules i editor amb autocompletat](#44-camps-calculats-computed-motor-de-fórmules-i-editor-amb-autocompletat)
   - [4.5 Nivells intermedis de relacions aniuades (títols dinàmics, acordió i reordenació)](#45-nivells-intermedis-de-relacions-aniuades-títols-dinàmics-acordió-i-reordenació)
   - [4.6 Personalització del disseny visual dels formularis (grid, editor visual drag&drop, etiquetes i consells)](#46-personalització-del-disseny-visual-dels-formularis-grid-editor-visual-dragdrop-etiquetes-i-consells)
5. [Perfil 2: Guia per al perfil tècnic usuari de l'aplicació](#5-perfil-2-guia-per-al-perfil-tècnic-usuari-de-laplicació)
   - [5.1 Càrrega i importació de dades d'expedient](#51-càrrega-i-importació-de-dades-dexpedient)
   - [5.2 Emplenat i edició de dades des de l'aplicació web](#52-emplenat-i-edició-de-dades-des-de-laplicació-web)
   - [5.3 L'editor visual per a cel·les de text ric (Markdown + Jinja2)](#53-leditor-visual-per-a-celles-de-text-ric-markdown--jinja2)
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
3. **Avaluació dinàmica doble**: El contingut introduït als camps de text del model de dades pot contenir expressions dinàmiques Jinja2 (`{{ doc.pres.contractant }}`), que s'avaluen automàticament durant la compilació del document final.
4. **Execució 100% al navegador**: Mitjançant WebAssembly (**Pyodide** per a Python/Jinja2 i **Pandoc WASM** per a la generació Word), cap dada no viatja a servidors externs, complint les normatives més estrictes de privadesa i confidencialitat.

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

Aquest perfil s'encarrega de dissenyar l'estructura de dades, configurar els formularis d'introducció de dades, definir les fórmules calculades i redactar la plantilla base en Jinja2.

### 4.1 Disseny de les plantilles Jinja2 (`.md.j2`)
Les plantilles s'escriuen en format Markdown combinat amb la sintaxi Jinja2.

#### A. Inserció de variables directes
```markdown
# MEMÒRIA JUSTIFICATIVA DEL CONTRACTE
**Títol del contracte:** {{ doc.General.titol_informe }}  
**Expedient:** {{ doc.General.num_expedient }}  
**Òrgan de contractació:** {{ doc.General.unitat_promotora }}  
```

#### B. Bucles i recursivitat a sub-taules
```markdown
{% for part in doc.Pressupost.Partides %}
## Partida {{ loop.index }}: {{ part.nom_partida }}
*Import partida:* {{ part.import_partida | coin }}

{% for act in part.Activitats %}
### Activitat {{ loop.index }}: {{ act.descripcio }}
- Hores previstes: {{ act.hores }} h
- Preu hora: {{ act.preu_hora | coin }}
- Subtotal: {{ act.import_activitat | coin }}
{% endfor %}
{% endfor %}
```

#### C. Filtres de format i manipulació de llistes
- `{{ valor | coin }}` / `{{ valor | format_currency }}` ➔ Formata com a moneda en català (ex: `12.345,67 €`).
- `{{ valor | number(2) }}` / `{{ valor | format_number(2) }}` ➔ Formata amb separador de milers i decimals (ex: `1.234,56`).
- `{{ valor | words }}` ➔ Converteix números a lletres (ex: `3` ➔ `tres`).
- `{{ text | prefix('de ', 'd\'') }}` ➔ Afegeix apostrofació correcta segons la primera lletra.
- `{{ data | date('%d/%m/%Y') }}` ➔ Formata dates.
- `{{ text | upper }}` / `{{ text | lower }}` ➔ Majúscules / minúscules.

---

### 4.2 Taules transposades (`TRANSPOSED_TABLE`) i filtres per fila

Quan necessiteu presentar una taula on **els registres es mostren en columnes** i **els camps es mostren en files** (molt comú en desglossaments de sous, costos i comparatives), utilitzeu el comentari de control de taula transposada:

#### Sintaxi bàsica:
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

#### Paràmetres del bloc transposat:
1. `variable in llista`: Especifica la col·lecció a iterar (ex: `preu in preus` o `lot in Lots`).
2. `colHeader=camp`: Camp que s'utilitza com a títol de cada columna (ex: `colHeader=descriptor`).
3. `rows=camp1,camp2,camp3`: Llista separada per comes dels camps que s'han de representar en files.
4. **Filtres per fila**: Podeu aplicar filtres de format directament a la definició de les files:
   - `rows=preu_base|coin,hores_any|number(0),sou_minim|coin,cost_total|coin`
5. **Format Markdown net**: El motor elimina automàticament qualsevol salt de línia intern entre rengleres perquè la taula es compili de manera neta i compatible amb Pandoc i Microsoft Word.

---

### 4.3 Configuració dels formularis i tipus de dades (`editor_metadata`)

Per configurar la naturalesa de cada camp, feu clic al botó **⚙️ Configura Tipus** situat a la capçalera de qualsevol grup o full de la pestanya **Dades**.

#### Tipus de dades suportats:
1. **Text (String)**: Camp de text estàndard o àrea de text multilínia.
2. **Number (Numèric)**: Valors decimals o enters per a càlculs.
3. **Date (Data)**: Selecció de dates en format calendari (`YYYY-MM-DD`).
4. **Boolean (Lògic)**: Desplegable de cert (`True`) o fals (`False`).
5. **Select (Desplegable i Enllaços d'Objectes Foreign Key)**:
   - **Estàtic**: Llista manual d'opcions separades per comes (`opcio1, opcio2, opcio3`).
   - **Dinàmic (Vector de dades / Relació Foreign Key)**: Enllaça amb una taula existent de l'Excel, permetent seleccionar la columna per fixar el valor (`valueField`, clau primària) i la columna per visualitzar-lo (`displayField`). Permet navegació directa per propietats de l'objecte associat com `part.Lot.nom`.
   - **Selecció múltiple**: Permet escollir un o diversos valors simultàniament que es guarden com a etiquetes (*pills*).
6. **Computed (Calculat)**: Camp no editable directament que es calcula mitjançant el motor de fórmules d'elips.

---

### 4.4 Camps calculats (Computed), motor de fórmules i editor amb autocompletat

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
- **Sub-taula**: `Activitats`
- **Columna**: `import_activitat`

#### B. Fórmules personalitzades (`CUSTOM`) i Funcions Suportades
- `SI(condició; valor_cert; valor_fals)` / `IF(...)`: Condicional lògic.
- `ARRODONEIX(valor; decimals)` / `ROUND(...)`: Arrodoneix al nombre de decimals indicat.
- `ABS(valor)`: Valor absolut.
- `MIN(a; b)` / `MAX(a; b)`: Mínim o màxim.
- `CONCAT(text1; text2; ...)`: Concatena múltiples textos o valors.
- `MONEDA(valor)`: Formata un número com a moneda (`12.345,67 €`).
- `PERCENTATGE(valor)`: Formata un número com a percentatge (`21,00%`).
- `DATA_CAT(data)`: Formata dates en text català complet.
- `TEXT(valor)`: Converteix a text.
- `REMPLAÇA(text; vell; nou)`: Substitueix cadenes de text.
- `UPPER(text)` / `LOWER(text)`: Majúscules i minúscules.

#### C. Editor ampliat de fórmules amb autocompletat intel·ligent
En fer clic al botó **✏️ Amplia** al costat d'una fórmula:
- **Paleta de camps**: Cliqueu qualsevol camp de la fila o ruta global per inserir-lo.
- **Autocompletat al textarea**: Comenceu a escriure el nom d'un camp o funció (ex: `imp`, `SI`, `MONEDA`) per veure el menú emergent de suggeriments. Desplaceu-vos amb les fletxes ⬆️ / ⬇️ i premeu **Enter** o **Tab** per completar.

---

### 4.5 Nivells intermedis de relacions aniuades (títols dinàmics, acordió i reordenació)

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

### 4.6 Personalització del disseny visual dels formularis (grid, editor visual drag&drop, etiquetes i consells)

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

### 5.3 L'editor visual per a cel·les de text ric (Markdown + Jinja2)

Quan un camp requereix una redacció extensa (justificació de necessitat, criteris de solvència, etc.):
1. Feu clic a la icona d'edició (✏️) al costat del camp de text.
2. S'obrirà el modal **Editor de contingut complex (Markdown + Jinja2)**:
   - **Mode visual (WYSIWYG)**: Formatació intuïtiva (negretes, llistes, taules).
   - **Mode codi (Source)**: Edició directa de Markdown i Jinja2.
   - **Desplegable d'insígnies**: Inserció de variables del model a la posició del cursor.
   - **Previsualització en temps real**: Comprovació visual del resultat renderitzat.

---

### 5.4 Generació, previsualització i Tauler de Control (Descàrregues i Esquema)

1. **Tauler de Control integrat**:
   - **Pestanya Descàrregues**: Executa la compilació i permet baixar els documents generats en format Word (`.docx`), Markdown (`.md`) i JSON (`dades.json`).
   - **Pestanya Esquema (Navegació contextual)**:
     - *En mode Plantilla*: Mostra l'estructura de la plantilla Jinja2 amb les variables dinàmiques. En clicar un encapçalament, l'editor es posiciona a la línia corresponent.
     - *En mode Previsualització*: Mostra l'arbre jeràrquic del document ja avaluat amb totes les iteracions desplegades. En clicar, desplaça la vista fins a la secció corresponent.
2. **Exportació de l'Excel**: Podeu fer clic a **Exporta dades a Excel** per desar totes les dades introduïdes a la web en un arxiu `.xlsx` que manté intactes les fórmules i les metadades.

---

## 6. Bones pràctiques i resolució de problemes (FAQ)

### ❓ Què faig si en carregar un fitxer Excel no es veuen les fórmules o tipus configurats?
**R:** Feu clic al botó **📥 Restaura de l'Excel** situat al grup **ESTRUCTURA** de la barra d'eines de dades o dins del modal **⚙️ Configura Tipus**. L'aplicació rellegirà immediatament el full `editor_metadata` i restablirà totes les regles.

### ❓ Quin nom han de tenir les sub-taules a l'Excel?
**R:** Els fulls aniuats han de seguir la nomenclatura del camí arrel separat per punts amb el prefix `OUT_` (ex: `OUT_Pressupost.Partides` i `OUT_Pressupost.Partides.Activitats`).

### ❓ Per què un sumatori d'una sub-taula em queda a zero?
**R:** Assegureu-vos que la fórmula personalitzada de la sub-taula fill utilitza el tipus `CUSTOM` (ex: `preu * hores`) i que la funció agregadora del pare utilitza `SUM` apuntant al nom exacte de la sub-taula i de la columna de destinació.

### ❓ Com puc compartir un projecte complet amb un altre company?
**R:** Feu clic a **📦 Descarrega Projecte (ZIP)**. El fitxer descarregat conté totes les plantilles, dades, metadades i documents Word. El vostre company només haurà de pujar el fitxer ZIP a **elips** per continuar treballant exactament des del mateix punt.

---
*Documentació actualitzada per a elips v2.0 - Entorn web WASM/Pyodide de generació de contractes públics.*
