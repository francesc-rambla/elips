/*
 * elips — Editor de LIcitacions PúbliqueS
 * Copyright (C) 2026  Francesc Rambla i Marigot
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Fase 34 (veure pla, "Fases 34-37: de 'compartir un projecte' a 'còpia de
 * seguretat de tot l'espai de treball al núvol'"): lectura/escriptura d'un
 * projecte LOCAL qualsevol -- l'ACTIU o no -- directament per les seves
 * claus `${name}:...` de `localStorage`/IndexedDB, MAI via `store.*` (que
 * només reflecteix el projecte obert ara mateix a la pestanya). Generalitza,
 * a escala de PROJECTE, el mateix patró ja provat en producció a
 * `multiDocCloudAdapter`/`documentsListCloudAdapter` (App.vue, Fase 28/29
 * reforç) -- llegir/escriure per nom explícit, no només "l'actiu" -- un
 * nivell per amunt (de "qualsevol document d'AQUEST projecte" a "qualsevol
 * projecte de l'espai de treball"), perquè una còpia de seguretat/
 * resolució de conflicte al núvol pugui operar en segon pla sense
 * pertorbar el projecte que l'usuari té obert.
 *
 * Exclou deliberadament tot el que ja queda fora de l'abast dels canals al
 * núvol (Fases 24-33): `activeDocName`/`activeTab`/`isMaximized` (estat de
 * UI, no contingut), `cloudProjectId`/`collabRealtimeSession`/
 * `collabFolderHandle:*` (bookkeeping dels altres transports), i
 * `version_history_v1` (històric de versions, 100% local, mai sincronitzat).
 *
 * `getItem`/`setItem`/`deleteItem` són injectables (per defecte
 * `getDbItem`/`saveDbItem`/`deleteDbItem`, `src/utils/db.js`) pel mateix
 * motiu que `useCollabDoc.js` ja ho fa: l'entorn de proves (happy-dom) no
 * té cap implementació real d'IndexedDB.
 */
import { getDbItem, saveDbItem, deleteDbItem } from './db.js';

function safeParseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export async function readLocalProjectSnapshot(name, { getItem = getDbItem } = {}) {
  const documentsList = safeParseJson(localStorage.getItem(`${name}:documentsList`), ['Document Principal']);
  const docs = {};
  for (const docName of documentsList) {
    const prefix = `${name}:doc:${docName}`;
    docs[docName] = {
      templateText: localStorage.getItem(`${prefix}:templateText`) || '',
      refDocFileName: localStorage.getItem(`${prefix}:refDocFileName`) || '',
      refDocBuffer: (await getItem(`${prefix}:refDocBuffer`)) || null,
    };
  }
  return {
    excelJsonData: safeParseJson(localStorage.getItem(`${name}:excelJsonData`), null),
    editorMetadata: safeParseJson(localStorage.getItem(`${name}:editorMetadata`), []),
    sheetInfo: safeParseJson(localStorage.getItem(`${name}:sheetInfo`), []),
    hierarchySchema: safeParseJson(localStorage.getItem(`${name}:hierarchySchema`), {}),
    documentsList,
    excelFileName: localStorage.getItem(`${name}:excelFileName`) || '',
    excelFileBuffer: (await getItem(`${name}:excelFileBuffer`)) || null,
    docs,
  };
}

// Mai toca `store.*`, `currentProjectName` ni `savedProjectsList` -- aquests
// només tenen sentit quan `name` esdevé el projecte ACTIU (responsabilitat
// de qui crida, reutilitzant `loadProject(name)` si cal refrescar la
// pestanya a l'instant perquè el projecte afectat resulta ser l'obert ara
// mateix).
export async function writeLocalProjectSnapshot(name, snapshot, { setItem = saveDbItem, deleteItem = deleteDbItem } = {}) {
  const documentsList = snapshot.documentsList && snapshot.documentsList.length ? snapshot.documentsList : ['Document Principal'];
  localStorage.setItem(`${name}:documentsList`, JSON.stringify(documentsList));
  if (!localStorage.getItem(`${name}:activeDocName`) || !documentsList.includes(localStorage.getItem(`${name}:activeDocName`))) {
    localStorage.setItem(`${name}:activeDocName`, documentsList[0]);
  }
  localStorage.setItem(`${name}:excelJsonData`, JSON.stringify(snapshot.excelJsonData ?? null));
  localStorage.setItem(`${name}:editorMetadata`, JSON.stringify(snapshot.editorMetadata || []));
  localStorage.setItem(`${name}:sheetInfo`, JSON.stringify(snapshot.sheetInfo || []));
  localStorage.setItem(`${name}:hierarchySchema`, JSON.stringify(snapshot.hierarchySchema || {}));
  localStorage.setItem(`${name}:excelFileName`, snapshot.excelFileName || '');
  if (snapshot.excelFileBuffer) {
    await setItem(`${name}:excelFileBuffer`, snapshot.excelFileBuffer);
  } else {
    await deleteItem(`${name}:excelFileBuffer`);
  }
  for (const docName of documentsList) {
    const docData = (snapshot.docs && snapshot.docs[docName]) || {};
    const prefix = `${name}:doc:${docName}`;
    localStorage.setItem(`${prefix}:templateText`, docData.templateText || '');
    if (docData.refDocBuffer) {
      localStorage.setItem(`${prefix}:refDocFileName`, docData.refDocFileName || '');
      await setItem(`${prefix}:refDocBuffer`, docData.refDocBuffer);
    } else {
      localStorage.removeItem(`${prefix}:refDocFileName`);
      await deleteItem(`${prefix}:refDocBuffer`);
    }
  }
}
