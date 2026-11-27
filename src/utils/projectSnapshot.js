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

function arrayBuffersEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i += 1) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

/**
 * Fase 36 (veure pla): decideix si DUES instantànies d'un mateix nom (una
 * de local, una del núvol) es poden fusionar automàticament i sense risc
 * -- `localSnapshot`/`cloudSnapshot` sempre venen de
 * `readLocalProjectSnapshot`/`fetchCloudProjectSnapshotOnce`
 * respectivament, mai de dos projectes AMB UN AVANTPASSAT COMÚ CONEGUT
 * (a diferència del registre de deltes de les Fases 1-17): no hi ha manera
 * principiada de fusionar-les camp a camp sense arriscar-se a deixar
 * `editorMetadata` apuntant a camps que ja no existeixen a
 * `excelJsonData`, o viceversa (mateix risc ja documentat i acceptat a
 * "Ampliació: sincronització en viu de l'esquema i la plantilla").
 *
 * Per això la fusió automàtica es limita al ÚNIC cas sense ambigüitat
 * possible: quan les dades centrals (`excelJsonData`/`editorMetadata`/
 * `sheetInfo`/`hierarchySchema`/`excelFileBuffer`) són EXACTAMENT
 * idèntiques a totes dues bandes -- normalment perquè és, de fet, el
 * MATEIX projecte, enllaçat des d'un altre dispositiu que encara no havia
 * desat el seu `cloudProjectId` localment -- i cada document present a
 * totes dues bandes també hi coincideix (plantilla i fitxer de
 * referència). En aquest cas, l'única diferència real pot ser quins
 * DOCUMENTS existeixen a cada banda -- es resol fent-ne la unió (mai
 * pèrdua). En qualsevol altre cas, `mergeable: false` amb un `reason`
 * llegible -- la interfície ha de tornar a oferir les altres tres opcions,
 * mai aplicar una fusió parcial en silenci.
 */
export function classifyConflictMergeability(localSnapshot, cloudSnapshot) {
  const coreFieldsEqual = ['excelJsonData', 'editorMetadata', 'sheetInfo', 'hierarchySchema'].every(
    (field) => JSON.stringify(localSnapshot[field] ?? null) === JSON.stringify(cloudSnapshot[field] ?? null),
  );
  if (!coreFieldsEqual) {
    return { mergeable: false, reason: 'Les dades del projecte (full de dades, esquema, jerarquia) són diferents a cada banda.' };
  }
  if (!arrayBuffersEqual(localSnapshot.excelFileBuffer, cloudSnapshot.excelFileBuffer)) {
    return { mergeable: false, reason: 'El fitxer Excel d\'origen és diferent a cada banda.' };
  }
  const localDocNames = localSnapshot.documentsList || [];
  const cloudDocNames = cloudSnapshot.documentsList || [];
  const sharedDocNames = localDocNames.filter((d) => cloudDocNames.includes(d));
  for (const docName of sharedDocNames) {
    const localDoc = (localSnapshot.docs && localSnapshot.docs[docName]) || {};
    const cloudDoc = (cloudSnapshot.docs && cloudSnapshot.docs[docName]) || {};
    if ((localDoc.templateText || '') !== (cloudDoc.templateText || '')) {
      return { mergeable: false, reason: `El document "${docName}" té una plantilla diferent a cada banda.` };
    }
    if (!arrayBuffersEqual(localDoc.refDocBuffer, cloudDoc.refDocBuffer)) {
      return { mergeable: false, reason: `El document "${docName}" té un fitxer de referència diferent a cada banda.` };
    }
  }

  const mergedDocumentsList = [...localDocNames];
  for (const d of cloudDocNames) {
    if (!mergedDocumentsList.includes(d)) mergedDocumentsList.push(d);
  }
  const mergedDocs = {};
  for (const docName of mergedDocumentsList) {
    mergedDocs[docName] = (localSnapshot.docs && localSnapshot.docs[docName])
      || (cloudSnapshot.docs && cloudSnapshot.docs[docName])
      || { templateText: '', refDocFileName: '', refDocBuffer: null };
  }
  return {
    mergeable: true,
    mergedSnapshot: {
      excelJsonData: localSnapshot.excelJsonData,
      editorMetadata: localSnapshot.editorMetadata,
      sheetInfo: localSnapshot.sheetInfo,
      hierarchySchema: localSnapshot.hierarchySchema,
      documentsList: mergedDocumentsList,
      excelFileName: localSnapshot.excelFileName || cloudSnapshot.excelFileName,
      excelFileBuffer: localSnapshot.excelFileBuffer || cloudSnapshot.excelFileBuffer,
      docs: mergedDocs,
    },
  };
}
