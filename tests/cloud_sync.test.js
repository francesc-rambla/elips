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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ref } from 'vue';

beforeEach(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const storage = new Map();
    globalThis.localStorage = {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, val) => storage.set(key, String(val)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear(),
    };
  }
  globalThis.localStorage.clear();
  setActivePinia(createPinia());
});

import { useWorkspaceStore } from '../src/stores/workspace.js';
import { useCloudSync } from '../src/composables/useCloudSync.js';

/**
 * Backend fals en memòria, compartit entre "clients" simulats -- mateix
 * esperit que makeFakeCollabFolder() a tests/collab_sync.test.js (un sol
 * magatzem en memòria, múltiples instàncies independents llegint-lo/
 * escrivint-lo), però aquí ENS CAL, a més, reproduir la lògica real de les
 * Regles de Seguretat de Firestore (el pla, secció "Regles de Seguretat":
 * només membres de `_access/doc.memberEmails` poden llegir/escriure res
 * del projecte, només el propietari pot actualitzar `_access/doc`) --
 * altrament els tests de "permission-denied" no demostrarien res de debò.
 *
 * `createClientFor(email)` retorna un `getDb` INJECTABLE (el segon
 * paràmetre de `useCloudSync`) que fa de "aquest usuari concret" -- totes
 * les instàncies comparteixen el mateix `docsStore`/llistes de listeners,
 * de manera que dos `useCloudSync` (dos "peers") hi convergeixen de debò.
 */
function makeFakeFirestoreBackend() {
  const docsStore = new Map(); // path -> plain object
  const docListeners = new Map(); // path -> Set<fn>
  const collectionListeners = new Map(); // collectionPath -> Set<fn>
  // `clone` ha de sobreviure un camp `Bytes` (Fase 28, un objecte amb
  // `.toUint8Array()`, mai JSON-serialitzable tal qual -- `JSON.stringify`
  // descartaria el mètode en silenci) -- el replacer/reviver el tradueix a
  // un array pla de números pel mig, i el reconstrueix com el MATEIX tipus
  // d'objecte (`{toUint8Array}`) en sortir. Transparent per a qualsevol
  // altra dada (mai hi ha cap `toUint8Array` en un valor JSON normal).
  const clone = (v) => (v === undefined ? undefined : JSON.parse(
    JSON.stringify(v, (_k, val) => (val && typeof val.toUint8Array === 'function') ? { __bytesArray: Array.from(val.toUint8Array()) } : val),
    (_k, val) => (val && Array.isArray(val.__bytesArray)) ? { toUint8Array: () => new Uint8Array(val.__bytesArray) } : val,
  ));

  function permissionDenied(message) {
    const err = new Error(message || 'Missing or insufficient permissions.');
    err.code = 'permission-denied';
    return err;
  }

  // projects/{id}/_access/doc -- separat dels canals perquè les regles el
  // tracten de manera diferent (create pel propietari, update NOMÉS pel
  // propietari, read per qualsevol membre).
  function isAccessDocPath(path) {
    const parts = path.split('/');
    return parts.length === 4 && parts[0] === 'projects' && parts[2] === '_access' && parts[3] === 'doc';
  }
  function accessPathFor(path) {
    const parts = path.split('/');
    return `projects/${parts[1]}/_access/doc`;
  }
  function isMemberOfProject(projectId, email) {
    const access = docsStore.get(`projects/${projectId}/_access/doc`);
    return !!access && !!email && access.memberEmails.includes(email);
  }
  function isMember(path, email) {
    const access = docsStore.get(accessPathFor(path));
    return !!access && !!email && access.memberEmails.includes(email);
  }
  function isOwner(path, email) {
    const access = docsStore.get(accessPathFor(path));
    return !!access && !!email && access.ownerEmail === email;
  }
  // Fase 30: `userProjects/{userEmail}/projects/{projectId}` -- mateixa
  // forma de regla real (vegeu el pla): lectura NOMÉS pel propi usuari
  // (`userEmail` = segment 1 del camí), escriptura per qualsevol membre
  // LEGÍTIM del projecte en qüestió (`projectId` = segment 3) -- mai pel
  // "camí" genèric `isMember(path, email)` de dalt, que assumeix
  // `projects/{id}/...` (aquí el projectId no és el segment 1).
  function isUserProjectsDocPath(path) {
    const parts = path.split('/');
    return parts.length === 4 && parts[0] === 'userProjects' && parts[2] === 'projects';
  }
  function isUserProjectsCollectionPath(path) {
    const parts = path.split('/');
    return parts.length === 3 && parts[0] === 'userProjects' && parts[2] === 'projects';
  }

  function notifyDoc(path) {
    const data = docsStore.get(path);
    (docListeners.get(path) || new Set()).forEach((fn) => fn({
      exists: () => docsStore.has(path),
      data: () => clone(data),
    }));
  }
  function childDocsOf(collectionPath) {
    const prefix = `${collectionPath}/`;
    const out = [];
    for (const [p, data] of docsStore.entries()) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push({ path: p, data });
    }
    return out;
  }
  function notifyCollection(collectionPath) {
    const children = childDocsOf(collectionPath);
    const snap = { forEach: (fn) => children.forEach((d) => fn({ data: () => clone(d.data), ref: { path: d.path } })) };
    (collectionListeners.get(collectionPath) || new Set()).forEach((fn) => fn(snap));
  }

  const ARRAY_UNION = 'arrayUnion';
  const ARRAY_REMOVE = 'arrayRemove';

  function createClientFor(email) {
    const mod = {
      getFirestore: () => ({ __fake: true }),
      doc: (_db, ...segs) => ({ __kind: 'doc', path: segs.join('/') }),
      collection: (_db, ...segs) => ({ __kind: 'collection', path: segs.join('/') }),

      async setDoc(ref, data) {
        if (isAccessDocPath(ref.path)) {
          const existing = docsStore.get(ref.path);
          if (!existing) {
            // create: qui escriu s'hi ha d'incloure com a propietari i membre.
            if (data.ownerEmail !== email || !data.memberEmails.includes(email)) {
              throw permissionDenied();
            }
          } else if (!isOwner(ref.path, email)) {
            throw permissionDenied();
          }
        } else if (isUserProjectsDocPath(ref.path)) {
          const projectId = ref.path.split('/')[3];
          if (!isMemberOfProject(projectId, email)) throw permissionDenied();
        } else if (!isMember(ref.path, email)) {
          throw permissionDenied();
        }
        docsStore.set(ref.path, clone(data));
        notifyDoc(ref.path);
      },

      async getDoc(ref) {
        if (isAccessDocPath(ref.path)) {
          if (docsStore.has(ref.path) && !isMember(ref.path, email)) throw permissionDenied();
        } else if (isUserProjectsDocPath(ref.path)) {
          const userEmail = ref.path.split('/')[1];
          if (userEmail !== email) throw permissionDenied();
        } else if (!isMember(ref.path, email)) {
          throw permissionDenied();
        }
        const data = docsStore.get(ref.path);
        return { exists: () => docsStore.has(ref.path), data: () => clone(data) };
      },

      async deleteDoc(ref) {
        if (isUserProjectsDocPath(ref.path)) {
          const projectId = ref.path.split('/')[3];
          if (!isMemberOfProject(projectId, email)) throw permissionDenied();
        } else if (!isMember(ref.path, email)) {
          throw permissionDenied();
        }
        docsStore.delete(ref.path);
        notifyDoc(ref.path);
      },

      async getDocs(collRef) {
        if (isUserProjectsCollectionPath(collRef.path)) {
          const userEmail = collRef.path.split('/')[1];
          if (userEmail !== email) throw permissionDenied();
        } else if (!isMember(collRef.path, email)) throw permissionDenied();
        const children = childDocsOf(collRef.path);
        return { forEach: (fn) => children.forEach((d) => fn({ data: () => clone(d.data), ref: { path: d.path } })) };
      },

      async addDoc(collRef, data) {
        if (!isMember(collRef.path, email)) throw permissionDenied();
        const id = `d${Math.random().toString(36).slice(2)}${docsStore.size}`;
        const path = `${collRef.path}/${id}`;
        docsStore.set(path, clone(data));
        notifyCollection(collRef.path);
        return { path };
      },

      async updateDoc(ref, patch) {
        if (isAccessDocPath(ref.path)) {
          if (!isOwner(ref.path, email)) throw permissionDenied();
        } else if (!isMember(ref.path, email)) {
          throw permissionDenied();
        }
        const current = docsStore.get(ref.path);
        if (!current) throw new Error(`No document to update at ${ref.path}`);
        const next = { ...current };
        for (const [k, v] of Object.entries(patch)) {
          if (v && v.__op === ARRAY_UNION) {
            const arr = Array.isArray(next[k]) ? next[k].slice() : [];
            v.values.forEach((val) => { if (!arr.includes(val)) arr.push(val); });
            next[k] = arr;
          } else if (v && v.__op === ARRAY_REMOVE) {
            const arr = Array.isArray(next[k]) ? next[k].slice() : [];
            next[k] = arr.filter((val) => !v.values.includes(val));
          } else {
            next[k] = v;
          }
        }
        docsStore.set(ref.path, next);
        notifyDoc(ref.path);
      },

      onSnapshot(ref, cb, errCb) {
        const checkAllowed = ref.__kind === 'doc'
          ? () => (isAccessDocPath(ref.path) ? (!docsStore.has(ref.path) || isMember(ref.path, email)) : isMember(ref.path, email))
          : () => isMember(ref.path, email);
        if (!checkAllowed()) {
          if (errCb) errCb(permissionDenied());
          return () => {};
        }
        if (ref.__kind === 'doc') {
          const set = docListeners.get(ref.path) || new Set();
          set.add(cb);
          docListeners.set(ref.path, set);
          const data = docsStore.get(ref.path);
          cb({ exists: () => docsStore.has(ref.path), data: () => clone(data) });
          return () => set.delete(cb);
        }
        const set = collectionListeners.get(ref.path) || new Set();
        set.add(cb);
        collectionListeners.set(ref.path, set);
        const children = childDocsOf(ref.path);
        cb({ forEach: (fn) => children.forEach((d) => fn({ data: () => clone(d.data), ref: { path: d.path } })) });
        return () => set.delete(cb);
      },

      writeBatch() {
        const ops = [];
        return {
          delete(ref) { ops.push({ type: 'delete', path: ref.path }); },
          // Fase 28: `uploadBuffer` (useCloudSync.js) escriu la meta + TOTS
          // els chunks d'un fitxer binari en un sol batch atòmic -- calia
          // `set` aquí, `writeBatch` abans només admetia `delete` (prou per
          // a la compactació de deltes, que és l'únic ús que en feien fins
          // ara els canals JSON).
          set(ref, data) { ops.push({ type: 'set', path: ref.path, data }); },
          async commit() {
            const touchedCollections = new Set();
            for (const op of ops) {
              if (op.type === 'delete') {
                docsStore.delete(op.path);
              } else {
                if (!isMember(op.path, email)) throw permissionDenied();
                docsStore.set(op.path, clone(op.data));
              }
              touchedCollections.add(op.path.slice(0, op.path.lastIndexOf('/')));
            }
            touchedCollections.forEach((c) => notifyCollection(c));
            // Qualsevol `set` sobre un document concret (p. ex. la meta
            // d'un canal de blob) també ha de notificar el seu propi
            // `onSnapshot` de DOCUMENT, no només el de la col·lecció que el
            // conté -- mateix criteri que `notifyDoc` ja fa per a `setDoc`.
            ops.filter((op) => op.type === 'set').forEach((op) => notifyDoc(op.path));
          },
        };
      },

      arrayUnion: (...values) => ({ __op: ARRAY_UNION, values }),
      arrayRemove: (...values) => ({ __op: ARRAY_REMOVE, values }),
      // Fase 28: mínim fals de `Bytes` (el tipus natiu de Firestore per a
      // binari cru) -- en producció `Bytes.fromUint8Array(arr).toUint8Array()`
      // fa anada i tornada de debò; aquí n'hi ha prou que ho faci també,
      // sense simular la codificació interna real de Firestore.
      Bytes: { fromUint8Array: (arr) => ({ toUint8Array: () => arr }) },
    };
    return async () => ({ db: { __fake: true }, mod });
  }

  return { docsStore, createClientFor };
}

function makeCloudAuth(email) {
  return { currentUser: ref(email ? { uid: email, email } : null) };
}

// El debounce de captura real per defecte és de 5s (store.config.
// cloudSyncCaptureDebounceSeconds) -- cada test que faci una edició local
// l'ha d'escurçar explícitament (CAPTURE_DEBOUNCE_SECONDS_TEST) abans de
// mutar excelJsonData, o la prova hauria d'esperar 5 segons reals per
// veure la captura. flush() espera prou temps real (per sobre d'aquest
// valor escurçat, i per a qualsevol `nextTick()` pendent de Vue) perquè
// les cadenes async d'aquest motor (onSnapshot -> recomputeAndApply ->
// nextTick, o el propi debounce) s'acabin de resoldre.
const CAPTURE_DEBOUNCE_SECONDS_TEST = 0.05;
async function flush() {
  await new Promise((r) => setTimeout(r, 120));
  await new Promise((r) => setTimeout(r, 120));
}

describe('useCloudSync (Fase 25: document d\'accés + canal de dades al núvol)', () => {
  it('activateCloudSync crea el document d\'accés amb el propietari com a únic membre i sembra el canal de dades', async () => {
    const backend = makeFakeFirestoreBackend();
    const store = useWorkspaceStore();
    store.excelJsonData = { General: { nom: 'Expedient 1' } };
    const cloudAuth = makeCloudAuth('owner@test.com');
    const cloud = useCloudSync(cloudAuth, backend.createClientFor('owner@test.com'));

    const id = await cloud.activateCloudSync('ProjecteA');
    await flush();

    expect(cloud.cloudSyncStatus.value).toBe('connected');
    expect(backend.docsStore.get(`projects/${id}/_access/doc`)).toEqual({
      ownerEmail: 'owner@test.com',
      memberEmails: ['owner@test.com'],
      projectName: 'ProjecteA',
    });
    expect(backend.docsStore.get(`projects/${id}/channels/data`).snapshot).toEqual({ General: { nom: 'Expedient 1' } });
    expect(localStorage.getItem('ProjecteA:cloudProjectId')).toBe(id);
  });

  it('un segon membre, un cop afegit pel propietari, convergeix amb canvis fets a camins diferents per totes dues bandes', async () => {
    const backend = makeFakeFirestoreBackend();
    const storeOwner = useWorkspaceStore();
    storeOwner.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    storeOwner.excelJsonData = { General: { nom: 'Expedient 1', altre: 'X' } };
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const storeMember = useWorkspaceStore();
    storeMember.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    await memberCloud.joinCloudProject('ProjecteB', id);
    await flush();

    expect(storeMember.excelJsonData).toEqual({ General: { nom: 'Expedient 1', altre: 'X' } });

    // Propietari edita un camp, membre edita un altre -- totes dues bandes
    // han de convergir, mai sobreescriure's l'una a l'altra.
    storeOwner.excelJsonData = { ...storeOwner.excelJsonData, General: { ...storeOwner.excelJsonData.General, nom: 'Expedient canviat pel propietari' } };
    await flush();
    storeMember.excelJsonData = { ...storeMember.excelJsonData, General: { ...storeMember.excelJsonData.General, altre: 'Y, canviat pel membre' } };
    await flush();

    expect(storeOwner.excelJsonData.General).toEqual({ nom: 'Expedient canviat pel propietari', altre: 'Y, canviat pel membre' });
    expect(storeMember.excelJsonData.General).toEqual({ nom: 'Expedient canviat pel propietari', altre: 'Y, canviat pel membre' });
  });

  it('joinCloudProject dona un error clar (i no toca res) quan encara no ets membre', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    setActivePinia(createPinia());
    const storeOutsider = useWorkspaceStore();
    storeOutsider.excelJsonData = { General: { nom: 'El meu propi contingut, intacte' } };
    const outsiderAuth = makeCloudAuth('fora@test.com');
    const outsiderCloud = useCloudSync(outsiderAuth, backend.createClientFor('fora@test.com'));

    await expect(outsiderCloud.joinCloudProject('ProjecteC', id)).rejects.toThrow(/encara no tens accés/i);
    expect(localStorage.getItem('ProjecteC:cloudProjectId')).toBeNull();
    expect(storeOutsider.excelJsonData).toEqual({ General: { nom: 'El meu propi contingut, intacte' } });
  });

  it('només el propietari pot afegir o treure membres -- un membre normal rep permission-denied', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();
    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    await memberCloud.joinCloudProject('ProjecteB', id);
    await flush();

    await expect(memberCloud.addProjectMember('altre@test.com')).rejects.toThrow();
    const access = backend.docsStore.get(`projects/${id}/_access/doc`);
    expect(access.memberEmails).toEqual(['owner@test.com', 'membre@test.com']);
  });

  it('isCurrentUserOwner reflecteix correctament qui és el propietari un cop vinculat', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();
    expect(ownerCloud.isCurrentUserOwner()).toBe(true);

    setActivePinia(createPinia());
    await ownerCloud.addProjectMember('membre@test.com');
    await flush();
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    await memberCloud.joinCloudProject('ProjecteB', id);
    await flush();
    expect(memberCloud.isCurrentUserOwner()).toBe(false);
  });

  it('deactivateCloudSync atura la sincronització PERÒ conserva l\'identificador desat localment (Fase 27: evita orfanar el projecte al núvol en canviar de projecte local)', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();
    expect(ownerCloud.cloudSyncStatus.value).toBe('connected');

    await ownerCloud.deactivateCloudSync();
    expect(ownerCloud.cloudSyncStatus.value).toBe('disconnected');
    expect(ownerCloud.cloudProjectId.value).toBe(null);
    // A diferència de la versió anterior a la Fase 27, aquí NO s'oblida --
    // oblidar-la de debò és acció explícita de l'usuari (handleDeactivateCloudSync
    // a App.vue), no un efecte secundari de desactivar/canviar de projecte.
    expect(localStorage.getItem('ProjecteA:cloudProjectId')).toBe(id);
  });

  it('reconnectar-se després d\'un deactivateCloudSync reutilitza el MATEIX identificador, no en crea un de nou (regressió del bug corregit a la Fase 27)', async () => {
    const backend = makeFakeFirestoreBackend();
    const store = useWorkspaceStore();
    store.excelJsonData = { General: { nom: 'Expedient 1' } };
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    // Simula canviar de projecte i tornar-hi (com fa loadProject/createNewProject
    // a App.vue): deactivateCloudSync() seguit d'una reconnexió -- mateixa
    // seqüència que tryAutoReconnectCloudSync faria en reobrir 'ProjecteA'.
    await ownerCloud.deactivateCloudSync();
    const idAfterReconnect = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    expect(idAfterReconnect).toBe(id);
    expect(ownerCloud.cloudSyncStatus.value).toBe('connected');
    // Un sol document d'accés per a 'ProjecteA' -- no se n'ha creat cap de
    // segon/orfe amb un altre UUID.
    const accessDocs = [...backend.docsStore.keys()].filter((p) => p.endsWith('/_access/doc'));
    expect(accessDocs).toEqual([`projects/${id}/_access/doc`]);
  });

  it('deactivateCloudSync puja a l\'instant una edició encara dins la finestra de debounce, en lloc de perdre-la (Fase 27)', async () => {
    const backend = makeFakeFirestoreBackend();
    const store = useWorkspaceStore();
    // Debounce llarg a propòsit (el valor real per defecte, 5s) -- la
    // prova mai l'espera: el que es verifica és que deactivateCloudSync()
    // puja l'edició DE SEGUIDA, no que calgui esperar el debounce.
    store.excelJsonData = { General: { nom: 'Expedient 1' } };
    const cloudAuth = makeCloudAuth('owner@test.com');
    const cloud = useCloudSync(cloudAuth, backend.createClientFor('owner@test.com'));
    const id = await cloud.activateCloudSync('ProjecteA');
    await flush();

    store.excelJsonData = { ...store.excelJsonData, General: { ...store.excelJsonData.General, nom: 'Editat just abans de canviar de projecte' } };
    // Deixa que el watcher (deep, flush 'pre' per defecte a Vue) programi
    // el debounce de 5s abans d'aturar -- sense aquesta espera mínima,
    // `deactivateCloudSync()` arribaria ABANS que hi hagués cap captura
    // pendent a aturar/pujar, sense provar res del que es vol verificar.
    await new Promise((r) => setTimeout(r, 100));
    await cloud.deactivateCloudSync(); // encara dins la finestra de debounce de 5s
    await flush();

    const deltasAfterStop = [...backend.docsStore.keys()].filter((p) => p.startsWith(`projects/${id}/channels/data/deltas/`));
    expect(deltasAfterStop.length).toBe(1);
    expect(backend.docsStore.get(deltasAfterStop[0]).patch).toEqual([
      { op: 'replace', path: '/General/nom', value: 'Editat just abans de canviar de projecte' },
    ]);
  });

  it('la compactació fon els deltes dins una nova base i buida la subcol·lecció, sense canviar el resultat fusionat', async () => {
    const backend = makeFakeFirestoreBackend();
    const store = useWorkspaceStore();
    store.config.cloudSyncCompactionThreshold = 2;
    store.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    store.excelJsonData = { General: { comptador: 0 } };
    const cloudAuth = makeCloudAuth('owner@test.com');
    const cloud = useCloudSync(cloudAuth, backend.createClientFor('owner@test.com'));
    const id = await cloud.activateCloudSync('ProjecteA');
    await flush();

    // Llindar de compactació = 2: el 2n i el 4t delta haurien de disparar
    // una compactació cadascun, deixant la subcol·lecció buida al final.
    store.excelJsonData = { General: { comptador: 1 } };
    await flush();
    store.excelJsonData = { General: { comptador: 2 } };
    await flush();
    store.excelJsonData = { General: { comptador: 3 } };
    await flush();
    store.excelJsonData = { General: { comptador: 4 } };
    await flush();

    expect(store.excelJsonData).toEqual({ General: { comptador: 4 } });
    const deltasLeft = [...backend.docsStore.keys()].filter((p) => p.startsWith(`projects/${id}/channels/data/deltas/`));
    expect(deltasLeft.length).toBe(0);
    expect(backend.docsStore.get(`projects/${id}/channels/data`).snapshot).toEqual({ General: { comptador: 4 } });
  });
});

describe('useCloudSync (Fase 26: canals schema/sheetInfo/hierarchySchema/template)', () => {
  it('activateCloudSync sembra els quatre canals de projecte sencer (data/schema/sheetInfo/hierarchySchema)', async () => {
    const backend = makeFakeFirestoreBackend();
    const store = useWorkspaceStore();
    store.excelJsonData = { General: { nom: 'Expedient 1' } };
    store.editorMetadata = [{ key: 'nom', type: 'text' }];
    store.sheetInfo = [{ sheet: 'General' }];
    store.hierarchySchema = { General: { kind: 'flat' } };
    const cloudAuth = makeCloudAuth('owner@test.com');
    const cloud = useCloudSync(cloudAuth, backend.createClientFor('owner@test.com'));

    const id = await cloud.activateCloudSync('ProjecteA');
    await flush();

    expect(backend.docsStore.get(`projects/${id}/channels/data`).snapshot).toEqual({ General: { nom: 'Expedient 1' } });
    expect(backend.docsStore.get(`projects/${id}/channels/schema`).snapshot).toEqual([{ key: 'nom', type: 'text' }]);
    expect(backend.docsStore.get(`projects/${id}/channels/sheetInfo`).snapshot).toEqual([{ sheet: 'General' }]);
    expect(backend.docsStore.get(`projects/${id}/channels/hierarchySchema`).snapshot).toEqual({ General: { kind: 'flat' } });
  });

  it('el canal schema convergeix entre propietari i membre igual que el de dades', async () => {
    const backend = makeFakeFirestoreBackend();
    const storeOwner = useWorkspaceStore();
    storeOwner.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    storeOwner.editorMetadata = [{ key: 'nom', type: 'text' }];
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();
    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const storeMember = useWorkspaceStore();
    storeMember.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    await memberCloud.joinCloudProject('ProjecteB', id, 'Document Principal');
    await flush();
    expect(storeMember.editorMetadata).toEqual([{ key: 'nom', type: 'text' }]);

    storeMember.editorMetadata = [...storeMember.editorMetadata, { key: 'import', type: 'number' }];
    await flush();

    expect(storeOwner.editorMetadata).toEqual([{ key: 'nom', type: 'text' }, { key: 'import', type: 'number' }]);
  });

  it('activateCloudSync sembra el canal de plantilla del document actiu', async () => {
    const backend = makeFakeFirestoreBackend();
    const store = useWorkspaceStore();
    store.templateText = 'Hola {{ nom }}';
    const cloudAuth = makeCloudAuth('owner@test.com');
    const cloud = useCloudSync(cloudAuth, backend.createClientFor('owner@test.com'));

    const id = await cloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();

    expect(backend.docsStore.get(`projects/${id}/channels/template:Document Principal`).snapshot).toEqual({ text: 'Hola {{ nom }}' });
  });

  it('un membre que s\'uneix amb el mateix document actiu rep la plantilla ja sincronitzada, i els canvis d\'ambdues bandes convergeixen', async () => {
    const backend = makeFakeFirestoreBackend();
    const storeOwner = useWorkspaceStore();
    storeOwner.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    storeOwner.templateText = 'Text original';
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();
    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const storeMember = useWorkspaceStore();
    storeMember.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    await memberCloud.joinCloudProject('ProjecteB', id, 'Document Principal');
    await flush();
    expect(storeMember.templateText).toBe('Text original');

    storeMember.templateText = 'Text canviat pel membre';
    await flush();
    expect(storeOwner.templateText).toBe('Text canviat pel membre');
  });

  it('bindCloudTemplateDocument revincula al canviar de document: sembra si és nou, rellegeix el remot si ja existia', async () => {
    const backend = makeFakeFirestoreBackend();
    const storeOwner = useWorkspaceStore();
    storeOwner.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    storeOwner.templateText = 'Contingut del document principal';
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();

    // Canvia a un document nou, mai sincronitzat abans -- com faria
    // App.vue (loadDocumentConfig ja ha carregat el seu contingut local
    // abans de revincular el canal) -- s'ha de SEMBRAR amb aquest
    // contingut, no perdre'l.
    storeOwner.templateText = 'Contingut del plec, encara no al núvol';
    await ownerCloud.bindCloudTemplateDocument('Plec de Clàusules');
    await flush();
    expect(backend.docsStore.get(`projects/${id}/channels/template:Plec de Clàusules`).snapshot).toEqual({ text: 'Contingut del plec, encara no al núvol' });
    expect(storeOwner.templateText).toBe('Contingut del plec, encara no al núvol');

    // Torna al document principal -- ja tenia base remota, s'ha de
    // RELLEGIR-LA (no re-sembrar-la amb el que hi hagi localment ara).
    await ownerCloud.bindCloudTemplateDocument('Document Principal');
    await flush();
    expect(storeOwner.templateText).toBe('Contingut del document principal');
  });
});

// Adaptador fals del fitxer Excel (Fase 28) -- mateix contracte que
// `excelFileCloudAdapter` a App.vue (`getBuffer`/`getFileName`/`setFile`),
// amb l'estat en una variable local en lloc d'IndexedDB/`store.excelFile`
// real, perquè el test en pugui llegir/mutar directament sense dependre de
// `indexedDB` (no disponible a l'entorn de Vitest).
function makeExcelFileAdapter(initialBuffer = null, initialFileName = '') {
  const state = { buffer: initialBuffer, fileName: initialFileName };
  const adapter = {
    getBuffer: async () => state.buffer,
    getFileName: () => state.fileName,
    setFile: async (buffer, fileName) => { state.buffer = buffer; state.fileName = fileName; },
  };
  return { adapter, state };
}

function bytesOf(buffer) {
  return buffer ? Array.from(new Uint8Array(buffer)) : null;
}

describe('useCloudSync (Fase 28.1: canal de fitxer binari excelFile)', () => {
  it('activateCloudSync sembra el canal excelFile, i un membre que s\'hi uneix rep els MATEIXOS bytes', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerBuffer = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer;
    const { adapter: ownerAdapter } = makeExcelFileAdapter(ownerBuffer, 'prova.xlsx');
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { excelFile: ownerAdapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    const meta = backend.docsStore.get(`projects/${id}/channels/excelFile`);
    expect(meta.fileName).toBe('prova.xlsx');
    expect(meta.fileSize).toBe(8);
    expect(meta.totalChunks).toBe(1);
    const chunk0 = backend.docsStore.get(`projects/${id}/channels/excelFile/chunks/0`);
    expect(Array.from(chunk0.data.toUint8Array())).toEqual(bytesOf(ownerBuffer));

    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const { adapter: memberAdapter, state: memberState } = makeExcelFileAdapter(null, '');
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'), { excelFile: memberAdapter });
    await memberCloud.joinCloudProject('ProjecteB', id);
    await flush();

    expect(memberState.fileName).toBe('prova.xlsx');
    expect(bytesOf(memberState.buffer)).toEqual(bytesOf(ownerBuffer));
  });

  it('captureExcelFileIfChanged repuja NOMÉS quan el contingut ha canviat de debò', async () => {
    const backend = makeFakeFirestoreBackend();
    const { adapter, state } = makeExcelFileAdapter(new Uint8Array([1, 2, 3]).buffer, 'a.xlsx');
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { excelFile: adapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();
    const metaPath = `projects/${id}/channels/excelFile`;
    const updatedAtAfterSeed = backend.docsStore.get(metaPath).updatedAt;

    // Mateix contingut -- cap repujada real (comprovat per hash contra el
    // que ja hi ha al núvol, no per cap variable cau local).
    await ownerCloud.captureExcelFileIfChanged();
    await flush();
    expect(backend.docsStore.get(metaPath).updatedAt).toBe(updatedAtAfterSeed);

    // Contingut realment diferent -- SÍ repuja, amb el hash/fitxers nous.
    state.buffer = new Uint8Array([9, 9, 9, 9, 9]).buffer;
    state.fileName = 'a-v2.xlsx';
    await ownerCloud.captureExcelFileIfChanged();
    await flush();
    const metaAfterChange = backend.docsStore.get(metaPath);
    expect(metaAfterChange.fileName).toBe('a-v2.xlsx');
    expect(metaAfterChange.updatedAt).not.toBe(updatedAtAfterSeed);
    const chunk0 = backend.docsStore.get(`${metaPath}/chunks/0`);
    expect(Array.from(chunk0.data.toUint8Array())).toEqual([9, 9, 9, 9, 9]);
  });

  it('un fitxer que supera cloudSyncMaxBinaryFileSizeMB es salta amb un avís, sense escriure cap document', async () => {
    const backend = makeFakeFirestoreBackend();
    const store = useWorkspaceStore();
    store.config.cloudSyncMaxBinaryFileSizeMB = 1 / 1024; // ~1 KiB
    const bigBuffer = new Uint8Array(2048).buffer; // 2 KiB, per sobre del límit
    const { adapter } = makeExcelFileAdapter(bigBuffer, 'gran.xlsx');
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { excelFile: adapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    expect(backend.docsStore.has(`projects/${id}/channels/excelFile`)).toBe(false);
    expect(ownerCloud.cloudActivityLog.value.some((e) => e.type === 'warning' && /gran\.xlsx/.test(e.text))).toBe(true);
  });

  it('una verificació d\'integritat incorrecta NO s\'aplica localment -- s\'espera la pròxima actualització', async () => {
    const backend = makeFakeFirestoreBackend();
    const { adapter, state } = makeExcelFileAdapter(new Uint8Array([10, 20, 30]).buffer, 'original.xlsx');
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { excelFile: adapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    // Corromp el núvol DIRECTAMENT (sense passar per uploadBuffer): un
    // chunk amb bytes arbitraris, i una meta amb un hash que NO hi coincideix
    // -- simula una lectura a mitges o una dada malmesa al servidor.
    const { db, mod } = await backend.createClientFor('owner@test.com')();
    await mod.setDoc(mod.doc(db, 'projects', id, 'channels', 'excelFile', 'chunks', '0'), {
      data: mod.Bytes.fromUint8Array(new Uint8Array([1, 1, 1])),
    });
    await mod.setDoc(mod.doc(db, 'projects', id, 'channels', 'excelFile'), {
      fileName: 'corromput.xlsx', fileSize: 3, totalChunks: 1, sha256Hex: 'deadbeef', updatedAt: new Date().toISOString(), updatedBy: 'algú',
    });
    await flush();

    // L'estat local NO s'ha tocat -- ni el nom ni els bytes han canviat.
    expect(state.fileName).toBe('original.xlsx');
    expect(bytesOf(state.buffer)).toEqual([10, 20, 30]);
    expect(ownerCloud.cloudActivityLog.value.some((e) => e.type === 'warning' && /integritat/i.test(e.text))).toBe(true);
  });
});

// Adaptador fals de `documentsList` (Fase 28.2) -- mateix contracte que
// `documentsListCloudAdapter` a App.vue (`getLocal`/`setLocal`), incloent
// la sembra de valors per defecte a `localStorage` per a qualsevol
// document nou-arribat ABANS d'actualitzar la llista local -- mateixa
// seqüència exacta (manllevada de createNewDocument) que App.vue fa servir.
// `documentsList` és un `ref` de Vue de debò a App.vue (no un camp pla) --
// la captura local depèn de la reactivitat de Vue per disparar-se en
// reassignar-lo (`watch(documentsListAdapter.getLocal, ...)`); un objecte
// pla aquí no dispararia mai cap watcher, a diferència del cas real.
function makeDocumentsListAdapter(projectNameRef, initial = ['Document Principal']) {
  const list = ref(initial);
  const adapter = {
    getLocal: () => list.value,
    setLocal: (remoteList) => {
      const pName = projectNameRef();
      const newNames = remoteList.filter((n) => !list.value.includes(n));
      newNames.forEach((cleanName) => {
        localStorage.setItem(`${pName}:doc:${cleanName}:templateText`, '');
        localStorage.setItem(`${pName}:doc:${cleanName}:templateFileName`, '');
        localStorage.setItem(`${pName}:doc:${cleanName}:templateFileSize`, '0');
        localStorage.setItem(`${pName}:doc:${cleanName}:refDocFileName`, '');
        localStorage.setItem(`${pName}:doc:${cleanName}:refDocFileSize`, '0');
      });
      list.value = remoteList;
    },
  };
  return { adapter, state: list };
}

describe('useCloudSync (Fase 28.2: canal documentsList)', () => {
  it('un membre que s\'hi uneix rep documents que mai havia vist, amb valors per defecte usables a localStorage', async () => {
    const backend = makeFakeFirestoreBackend();
    const { adapter: ownerDocsAdapter, state: ownerDocsState } = makeDocumentsListAdapter(() => 'ProjecteA', ['Document Principal', 'Plec de Clàusules']);
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { documentsList: ownerDocsAdapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();
    expect(ownerDocsState.value).toEqual(['Document Principal', 'Plec de Clàusules']);

    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const { adapter: memberDocsAdapter, state: memberDocsState } = makeDocumentsListAdapter(() => 'ProjecteB', ['Document Principal']);
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'), { documentsList: memberDocsAdapter });
    await memberCloud.joinCloudProject('ProjecteB', id);
    await flush();

    expect(memberDocsState.value).toEqual(['Document Principal', 'Plec de Clàusules']);
    // El document nou-arribat ja té valors per defecte usables -- no calen
    // claus inexistents en commutar-s'hi (mateix criteri que createNewDocument).
    expect(localStorage.getItem('ProjecteB:doc:Plec de Clàusules:templateText')).toBe('');
    expect(localStorage.getItem('ProjecteB:doc:Plec de Clàusules:refDocFileSize')).toBe('0');
  });

  it('afegir un document nou localment el propaga a l\'altra banda sense tocar els documents ja coneguts', async () => {
    const backend = makeFakeFirestoreBackend();
    useWorkspaceStore().config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    const { adapter: ownerDocsAdapter, state: ownerDocsState } = makeDocumentsListAdapter(() => 'ProjecteA', ['Document Principal']);
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { documentsList: ownerDocsAdapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    await ownerCloud.addProjectMember('membre@test.com');
    await flush();
    setActivePinia(createPinia());
    const { adapter: memberDocsAdapter, state: memberDocsState } = makeDocumentsListAdapter(() => 'ProjecteB', ['Document Principal']);
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'), { documentsList: memberDocsAdapter });
    await memberCloud.joinCloudProject('ProjecteB', id);
    await flush();

    ownerDocsState.value = [...ownerDocsState.value, 'Annex Tècnic'];
    await flush();

    expect(memberDocsState.value).toEqual(['Document Principal', 'Annex Tècnic']);
  });
});

// Adaptador fals del document de referència (Fase 28.3) -- mateix
// contracte que `refDocCloudAdapter` a App.vue, amb l'estat en una
// variable local (no cal simular `activeDocName`/IndexedDB: el canal ja
// assumeix, per construcció, que només està vinculat mentre el document
// és l'actiu).
function makeRefDocAdapter(initialBuffer = null, initialFileName = '') {
  const state = { buffer: initialBuffer, fileName: initialFileName };
  const adapter = {
    getBuffer: async () => state.buffer,
    getFileName: () => state.fileName,
    setFile: async (buffer, fileName) => { state.buffer = buffer; state.fileName = fileName; },
  };
  return { adapter, state };
}

describe('useCloudSync (Fase 28.3: canal refDoc:<docName>)', () => {
  it('activateCloudSync sembra el canal de referència del document actiu, i un membre que s\'hi uneix amb el mateix document el rep', async () => {
    const backend = makeFakeFirestoreBackend();
    const refBuffer = new Uint8Array([5, 4, 3, 2, 1]).buffer;
    const { adapter: ownerRefAdapter } = makeRefDocAdapter(refBuffer, 'referencia.docx');
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { refDoc: ownerRefAdapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();

    expect(backend.docsStore.get(`projects/${id}/channels/refDoc:Document Principal`).fileName).toBe('referencia.docx');

    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const { adapter: memberRefAdapter, state: memberRefState } = makeRefDocAdapter(null, '');
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'), { refDoc: memberRefAdapter });
    await memberCloud.joinCloudProject('ProjecteB', id, 'Document Principal');
    await flush();

    expect(memberRefState.fileName).toBe('referencia.docx');
    expect(bytesOf(memberRefState.buffer)).toEqual(bytesOf(refBuffer));
  });

  it('un document sense fitxer de referència no crea cap canal buit', async () => {
    const backend = makeFakeFirestoreBackend();
    const { adapter: ownerRefAdapter } = makeRefDocAdapter(null, '');
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { refDoc: ownerRefAdapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();

    expect(backend.docsStore.has(`projects/${id}/channels/refDoc:Document Principal`)).toBe(false);
  });

  it('bindCloudRefDocDocument revincula al canviar de document: sembra si és nou, rellegeix el remot si ja existia', async () => {
    const backend = makeFakeFirestoreBackend();
    const { adapter: ownerRefAdapter, state: ownerRefState } = makeRefDocAdapter(new Uint8Array([1, 2, 3]).buffer, 'principal.docx');
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { refDoc: ownerRefAdapter });
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();

    // Canvia a un document nou, mai sincronitzat -- com faria App.vue
    // (loadDocumentConfig ja ha carregat el contingut local abans de
    // revincular el canal) -- s'ha de SEMBRAR amb aquest contingut.
    ownerRefState.buffer = new Uint8Array([9, 8, 7]).buffer;
    ownerRefState.fileName = 'plec.docx';
    await ownerCloud.bindCloudRefDocDocument('Plec de Clàusules');
    await flush();
    expect(backend.docsStore.get(`projects/${id}/channels/refDoc:Plec de Clàusules`).fileName).toBe('plec.docx');

    // Torna al document principal -- ja tenia base remota, s'ha de
    // RELLEGIR-LA (no re-sembrar-la amb el que hi hagi localment ara).
    await ownerCloud.bindCloudRefDocDocument('Document Principal');
    await flush();
    expect(ownerRefState.fileName).toBe('principal.docx');
    expect(bytesOf(ownerRefState.buffer)).toEqual([1, 2, 3]);
  });
});

describe('useCloudSync (Fase 29: evita la fuita de listeners en canviar de projecte vinculat)', () => {
  it('unir-se a un projecte d\'una altra persona SENSE desactivar primer no deixa el projecte anterior "revertint" les dades', async () => {
    const backend = makeFakeFirestoreBackend();

    // Projecte propi de l'"owner", ja connectat.
    const storeOwner = useWorkspaceStore();
    storeOwner.excelJsonData = { marcador: 'X' };
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const idX = await ownerCloud.activateCloudSync('ProjecteX');
    await flush();
    expect(storeOwner.excelJsonData).toEqual({ marcador: 'X' });

    // Projecte d'una altra persona, amb l'owner afegit com a membre.
    setActivePinia(createPinia());
    const storeOther = useWorkspaceStore();
    storeOther.excelJsonData = { marcador: 'Y' };
    const otherAuth = makeCloudAuth('altra@test.com');
    const otherCloud = useCloudSync(otherAuth, backend.createClientFor('altra@test.com'));
    const idY = await otherCloud.activateCloudSync('ProjecteY');
    await flush();
    await otherCloud.addProjectMember('owner@test.com');
    await flush();

    // L'owner s'uneix al projecte Y SENSE haver cridat deactivateCloudSync()
    // -- exactament l'escenari reportat: un dispositiu amb sincronització
    // pròpia ja activa que s'uneix a un altre projecte.
    await ownerCloud.joinCloudProject('ProjecteB', idY, 'Document Principal');
    await flush();
    expect(storeOwner.excelJsonData).toEqual({ marcador: 'Y' });

    // Prova directa que el listener del projecte X ja no hi és: un canvi
    // fet DIRECTAMENT al canal `data` de X al servidor (sense passar per
    // ownerCloud) no hauria d'arribar mai a storeOwner -- si el listener
    // vell encara hi fos penjat, el rebria i el "revertiria".
    const { db, mod } = await backend.createClientFor('owner@test.com')();
    await mod.setDoc(mod.doc(db, 'projects', idX, 'channels', 'data'), {
      snapshot: { marcador: 'X-CANVIAT-DESPRÉS' }, updatedAt: new Date().toISOString(), updatedBy: 'algú',
    });
    await flush();

    expect(storeOwner.excelJsonData).toEqual({ marcador: 'Y' });
  });

  it('dues operacions de vinculació llançades gairebé alhora (sense esperar la primera) convergeixen a l\'última cridada, sense dades corruptes', async () => {
    // Escenari plausible (no confirmat com la causa exacta de l'usuari,
    // però real i reproduïble): signar-se pot disparar TANT el watcher de
    // reconnexió transparent (Fase 27, si aquest projecte local ja tenia
    // un `cloudProjectId` desat d'una sessió de proves anterior) COM,
    // gairebé a l'instant, un clic manual a "Uneix-te" a un ALTRE
    // projecte -- dues crides a bindToProject() sense que l'una esperi
    // l'altra. Aquest test confirma que, en aquest entorn, totes dues
    // criden a través de la mateixa cua interna (`enqueueCloudOp`) i el
    // resultat final és consistent amb la DARRERA crida -- no demostra
    // adversarialment cada possible intercalació temporal (hauria de
    // manipular els temps interns de Firestore per forçar-ho), però sí
    // que la cua no introdueix cap vol/estat inconsistent en l'ús normal.
    const backend = makeFakeFirestoreBackend();
    const storeOwner = useWorkspaceStore();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const idX = await ownerCloud.activateCloudSync('ProjecteX');
    await flush();
    await ownerCloud.deactivateCloudSync();

    setActivePinia(createPinia());
    const storeOther = useWorkspaceStore();
    storeOther.excelJsonData = { marcador: 'Y' };
    const otherAuth = makeCloudAuth('altra@test.com');
    const otherCloud = useCloudSync(otherAuth, backend.createClientFor('altra@test.com'));
    const idY = await otherCloud.activateCloudSync('ProjecteY');
    await flush();
    await otherCloud.addProjectMember('owner@test.com');
    await flush();

    setActivePinia(createPinia());
    const storeOwner2 = useWorkspaceStore();
    const ownerCloud2 = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    // Totes dues LLANÇADES alhora, SENSE esperar la primera -- la cua
    // interna (Fase 29) les ha d'executar en sèrie, en l'ordre de crida,
    // mai barrejades.
    const callA = ownerCloud2.activateCloudSync('ProjecteX');
    const callB = ownerCloud2.joinCloudProject('ProjecteY2', idY);
    await Promise.all([callA, callB]);
    await flush();

    expect(ownerCloud2.cloudProjectId.value).toBe(idY);
    expect(ownerCloud2.cloudSyncStatus.value).toBe('connected');
    expect(storeOwner2.excelJsonData).toEqual({ marcador: 'Y' });

    // Cap reversió posterior -- un canvi directe al projecte X no hauria
    // d'arribar mai (el seu listener, si l'hi hagués arribat a haver,
    // hauria quedat aturat per la serialització).
    const { db, mod } = await backend.createClientFor('owner@test.com')();
    await mod.setDoc(mod.doc(db, 'projects', idX, 'channels', 'data'), {
      snapshot: { marcador: 'X-CANVIAT-DESPRÉS' }, updatedAt: new Date().toISOString(), updatedBy: 'algú',
    });
    await flush();
    expect(storeOwner2.excelJsonData).toEqual({ marcador: 'Y' });
  });
});

// Adaptador fals de "qualsevol document per nom" (Fase 29, reforç) --
// mateix contracte que `multiDocCloudAdapter` a App.vue, amb l'estat en
// mapes en memòria en lloc de `localStorage`/IndexedDB real.
function makeMultiDocAdapter(templates = {}, refDocs = {}) {
  return {
    getTemplateText: (dName) => templates[dName] || '',
    getRefDocBuffer: async (dName) => (refDocs[dName] ? refDocs[dName].buffer : null),
    getRefDocFileName: (dName) => (refDocs[dName] ? refDocs[dName].fileName : ''),
  };
}

describe('useCloudSync (Fase 29, reforç: un document ja existent mai es re-sembra amb contingut d\'un altre dispositiu)', () => {
  it('activateCloudSync sembra el canal template/refDoc de TOTS els documents, no només l\'actiu en aquell instant', async () => {
    const backend = makeFakeFirestoreBackend();
    const storeOwner = useWorkspaceStore();
    storeOwner.templateText = 'Contingut del document principal';
    const { adapter: ownerDocsAdapter } = makeDocumentsListAdapter(() => 'ProjecteA', ['Document Principal', 'Plec de Clàusules']);
    const multiDoc = makeMultiDocAdapter(
      { 'Plec de Clàusules': 'Contingut real del plec' },
      { 'Plec de Clàusules': { buffer: new Uint8Array([9, 9, 9]).buffer, fileName: 'plec.docx' } },
    );
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { documentsList: ownerDocsAdapter, multiDoc });
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();

    // El document ACTIU ja es sembra pel camí normal.
    expect(backend.docsStore.get(`projects/${id}/channels/template:Document Principal`).snapshot).toEqual({ text: 'Contingut del document principal' });
    // El document NO actiu també ha quedat sembrat -- amb el seu PROPI
    // contingut (llegit via `multiDoc`), no amb el del document actiu.
    expect(backend.docsStore.get(`projects/${id}/channels/template:Plec de Clàusules`).snapshot).toEqual({ text: 'Contingut real del plec' });
    expect(backend.docsStore.get(`projects/${id}/channels/refDoc:Plec de Clàusules`).fileName).toBe('plec.docx');
  });

  it('un membre que s\'uneix amb un document del mateix nom, però amb contingut propi no relacionat, MAI sobreescriu el contingut ja sembrat pel propietari', async () => {
    // Reprodueix el bug real reportat: el propietari té diversos documents
    // creats abans d'activar la sincronització (només l'actiu en aquell
    // instant quedava sembrat abans d'aquest reforç); un membre s'uneix
    // tenint, per coincidència de nom ("Document Principal", el nom per
    // defecte de qualsevol projecte), un document local amb contingut
    // totalment diferent com a actiu seu.
    const backend = makeFakeFirestoreBackend();
    const storeOwner = useWorkspaceStore();
    const { adapter: ownerDocsAdapter } = makeDocumentsListAdapter(() => 'ProjecteA', ['Document Principal', 'Annex']);
    // "Document Principal" NO és l'actiu en activar-se -- el seu contingut
    // real només és conegut via `multiDoc` (equivalent al que `App.vue`
    // llegiria de `localStorage`, no de `store.templateText`, que només
    // reflecteix el document ACTIU en cada moment).
    const ownerMultiDoc = makeMultiDocAdapter({ 'Document Principal': 'Contingut que NO s\'ha de perdre' });
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'), { documentsList: ownerDocsAdapter, multiDoc: ownerMultiDoc });
    // Activa estant al document "Annex" -- "Document Principal" queda
    // sembrat NOMÉS gràcies al reforç (seedAllDocumentChannels), no pel
    // camí normal (que només cobreix el document actiu).
    storeOwner.templateText = 'Annex real';
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Annex');
    await flush();
    await ownerCloud.addProjectMember('membre@test.com');
    await flush();
    expect(backend.docsStore.get(`projects/${id}/channels/template:Document Principal`).snapshot).toEqual({ text: 'Contingut que NO s\'ha de perdre' });

    setActivePinia(createPinia());
    const storeMember = useWorkspaceStore();
    // El membre té el seu propi "Document Principal" com a actiu, amb
    // contingut totalment no relacionat.
    storeMember.templateText = 'Contingut del membre, no relacionat';
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    await memberCloud.joinCloudProject('ProjecteB', id, 'Document Principal');
    await flush();

    // El membre ha de rebre el contingut LEGÍTIM del propietari, mai el
    // seu propi "re-sembrat" per sobre.
    expect(storeMember.templateText).toBe('Contingut que NO s\'ha de perdre');
    expect(backend.docsStore.get(`projects/${id}/channels/template:Document Principal`).snapshot).toEqual({ text: 'Contingut que NO s\'ha de perdre' });

    // I si, DESPRÉS, el propietari mateix commuta a "Document Principal"
    // (el cas exacte reportat -- "desapareix en seleccionar el document"),
    // el seu contingut s'ha de mantenir intacte.
    storeOwner.templateText = 'un altre valor local momentani';
    await ownerCloud.bindCloudTemplateDocument('Document Principal');
    await flush();
    expect(storeOwner.templateText).toBe('Contingut que NO s\'ha de perdre');
  });

  it('joinCloudProject mai sembra el canal d\'un document que encara no existeix al projecte compartit', async () => {
    const backend = makeFakeFirestoreBackend();
    const storeOwner = useWorkspaceStore();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA', 'Document Principal');
    await flush();
    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const storeMember = useWorkspaceStore();
    storeMember.templateText = 'Contingut local del membre, document inexistent al núvol';
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    // El membre s'uneix tenint com a actiu un document que el projecte
    // compartit NO coneix -- mai s'ha de crear cap canal per a ell.
    await memberCloud.joinCloudProject('ProjecteB', id, 'Document Inexistent');
    await flush();

    expect(backend.docsStore.has(`projects/${id}/channels/template:Document Inexistent`)).toBe(false);
    // El contingut local del membre, no relacionat amb cap projecte
    // compartit, es manté intacte -- no s'ha enviat enlloc.
    expect(storeMember.templateText).toBe('Contingut local del membre, document inexistent al núvol');
  });
});

describe('useCloudSync (Fase 30: identitat real del projecte + índex "projectes als quals tinc accés")', () => {
  it('el propietari veu la seva pròpia entrada, pel nom real del projecte, just en activar-se', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('El Meu Projecte Real');
    await flush();

    expect(backend.docsStore.get(`projects/${id}/_access/doc`).projectName).toBe('El Meu Projecte Real');
    const mine = await ownerCloud.listMyCloudProjects();
    expect(mine).toEqual([{ projectId: id, projectName: 'El Meu Projecte Real', ownerEmail: 'owner@test.com' }]);
  });

  it('un membre acabat d\'afegir ja veu el projecte pel seu nom, ABANS fins i tot d\'unir-s\'hi', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('Projecte Compartit');
    await flush();

    await ownerCloud.addProjectMember('membre@test.com');
    await flush();

    setActivePinia(createPinia());
    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    const mine = await memberCloud.listMyCloudProjects();
    expect(mine).toEqual([{ projectId: id, projectName: 'Projecte Compartit', ownerEmail: 'owner@test.com' }]);

    // Treure'l fa desaparèixer l'entrada de seguida.
    await ownerCloud.removeProjectMember('membre@test.com');
    await flush();
    expect(await memberCloud.listMyCloudProjects()).toEqual([]);
  });

  it('un usuari NO membre rep permission-denied en llegir/escriure l\'índex d\'un altre correu', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    await ownerCloud.activateCloudSync('Projecte Privat');
    await flush();

    setActivePinia(createPinia());
    const strangerAuth = makeCloudAuth('estrany@test.com');
    // Intent directe de llegir l'índex de l'OWNER (no el seu propi) --
    // mateixa forma de regla real: només `owner@test.com` pot llegir
    // `userProjects/owner@test.com/...`.
    const { db, mod } = await backend.createClientFor('estrany@test.com')();
    await expect(mod.getDocs(mod.collection(db, 'userProjects', 'owner@test.com', 'projects'))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('un projecte vinculat ABANS d\'aquesta fase (sense projectName ni entrada a l\'índex) es repara en reconnectar-s\'hi', async () => {
    // Simula l'estat real d'un projecte que ja estava vinculat abans que
    // aquesta fase existís: `_access/doc` sense `projectName`, cap entrada
    // a `userProjects/`, i el vincle local ja present a `localStorage`
    // (mai creat via `activateCloudSync`, que és l'únic lloc que escrivia
    // totes dues coses -- i només en la branca de creació, mai en
    // reconnectar).
    const backend = makeFakeFirestoreBackend();
    const preExistingId = 'projecte-anterior-a-fase-30';
    backend.docsStore.set(`projects/${preExistingId}/_access/doc`, {
      ownerEmail: 'owner@test.com',
      memberEmails: ['owner@test.com'],
      // deliberadament sense `projectName`
    });
    localStorage.setItem('ProjecteAntic:cloudProjectId', preExistingId);

    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));

    // En absència de la reparació, aquesta reconnexió seguiria la branca
    // `existing` d'`activateCloudSync` SENSE escriure mai `projectName` ni
    // l'entrada a l'índex -- `listMyCloudProjects()` quedaria buit per
    // sempre, encara que reconnecti una i altra vegada.
    const returnedId = await ownerCloud.activateCloudSync('ProjecteAntic');
    await flush();

    expect(returnedId).toBe(preExistingId);
    expect(backend.docsStore.get(`projects/${preExistingId}/_access/doc`).projectName).toBe('ProjecteAntic');
    expect(await ownerCloud.listMyCloudProjects()).toEqual([
      { projectId: preExistingId, projectName: 'ProjecteAntic', ownerEmail: 'owner@test.com' },
    ]);
  });

  it('un MEMBRE (no propietari) d\'un projecte antic refà la seva pròpia entrada a l\'índex en reconnectar-s\'hi, sense tocar `_access/doc`', async () => {
    const backend = makeFakeFirestoreBackend();
    const preExistingId = 'projecte-antic-compartit';
    backend.docsStore.set(`projects/${preExistingId}/_access/doc`, {
      ownerEmail: 'owner@test.com',
      memberEmails: ['owner@test.com', 'membre@test.com'],
      projectName: 'Projecte Antic Compartit', // el propietari ja l'ha reparat
    });
    localStorage.setItem('CopiaDelMembre:cloudProjectId', preExistingId);

    const memberAuth = makeCloudAuth('membre@test.com');
    const memberCloud = useCloudSync(memberAuth, backend.createClientFor('membre@test.com'));
    await memberCloud.activateCloudSync('CopiaDelMembre');
    await flush();

    expect(await memberCloud.listMyCloudProjects()).toEqual([
      { projectId: preExistingId, projectName: 'Projecte Antic Compartit', ownerEmail: 'owner@test.com' },
    ]);
    // Un membre no té permís d'escriure `_access/doc` -- confirma que no
    // s'hi ha intentat tocar res (seguiria igual, però ho fem explícit).
    expect(backend.docsStore.get(`projects/${preExistingId}/_access/doc`).projectName).toBe('Projecte Antic Compartit');
  });
});

describe('useCloudSync (Fase 32: indicador de progrés durant la sincronització inicial)', () => {
  it('isApplyingInitialSync és cert mentre s\'espera la primera instantània d\'un canal, i fals un cop arribada', async () => {
    const backend = makeFakeFirestoreBackend();
    useWorkspaceStore();
    const cloudAuth = makeCloudAuth('owner@test.com');
    const baseGetDb = backend.createClientFor('owner@test.com');

    // Retarda artificialment NOMÉS el primer onSnapshot de la base del
    // canal `data`, perquè es pugui observar `isApplyingInitialSync`
    // encara cert abans que es resolgui (en el backend fals, tot el demés
    // es resol a l'instant, dins la mateixa volta síncrona).
    let releaseDelay;
    const delayPromise = new Promise((resolve) => { releaseDelay = resolve; });
    const getDb = async () => {
      const { db, mod } = await baseGetDb();
      let delayed = false;
      const wrappedMod = {
        ...mod,
        onSnapshot: (ref, cb, errCb) => {
          if (!delayed && ref.__kind === 'doc' && ref.path.endsWith('channels/data')) {
            delayed = true;
            return mod.onSnapshot(ref, async (snap) => { await delayPromise; cb(snap); }, errCb);
          }
          return mod.onSnapshot(ref, cb, errCb);
        },
      };
      return { db, mod: wrappedMod };
    };

    const cloud = useCloudSync(cloudAuth, getDb);
    expect(cloud.isApplyingInitialSync.value).toBe(false);
    const activatePromise = cloud.activateCloudSync('ProjecteA');
    await new Promise((r) => setTimeout(r, 50));
    expect(cloud.isApplyingInitialSync.value).toBe(true);
    expect(cloud.cloudSyncStatus.value).toBe('connecting');

    releaseDelay();
    await activatePromise;
    expect(cloud.isApplyingInitialSync.value).toBe(false);
    expect(cloud.cloudSyncStatus.value).toBe('connected');
  });

  it('un error en un canal durant la sincronització inicial no deixa isApplyingInitialSync encallat per sempre', async () => {
    const backend = makeFakeFirestoreBackend();
    useWorkspaceStore();
    const cloudAuth = makeCloudAuth('owner@test.com');
    const baseGetDb = backend.createClientFor('owner@test.com');
    const getDb = async () => {
      const { db, mod } = await baseGetDb();
      const wrappedMod = {
        ...mod,
        onSnapshot: (ref, cb, errCb) => {
          if (ref.__kind === 'doc' && ref.path.endsWith('channels/data')) {
            // Simula un error de xarxa en el primer intent d'escoltar
            // aquest canal concret -- la resta de canals segueixen bé.
            errCb({ message: 'simulated network error' });
            return () => {};
          }
          return mod.onSnapshot(ref, cb, errCb);
        },
      };
      return { db, mod: wrappedMod };
    };
    const cloud = useCloudSync(cloudAuth, getDb);
    await cloud.activateCloudSync('ProjecteA');
    await flush();
    expect(cloud.isApplyingInitialSync.value).toBe(false);
    expect(cloud.cloudSyncStatus.value).toBe('connected');
  });
});

describe('useCloudSync (Fase 34: seedCloudProjectFromSnapshot / fetchCloudProjectSnapshotOnce -- primitives per a un projecte no actiu)', () => {
  function makeSnapshot(overrides = {}) {
    return {
      excelJsonData: { General: { nom: 'Expedient en segon pla' } },
      editorMetadata: [{ key: 'nom', label: 'Nom' }],
      sheetInfo: [{ sheet: 'General' }],
      hierarchySchema: { General: { children: {} } },
      documentsList: ['Document Principal', 'Annex'],
      excelFileName: 'origen.xlsx',
      excelFileBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
      docs: {
        'Document Principal': { templateText: 'Plantilla principal', refDocFileName: '', refDocBuffer: null },
        Annex: { templateText: 'Plantilla annex', refDocFileName: 'ref.docx', refDocBuffer: new Uint8Array([9, 9]).buffer },
      },
      ...overrides,
    };
  }

  it('seedCloudProjectFromSnapshot crea un projecte complet al núvol SENSE passar mai per store.* -- fetchCloudProjectSnapshotOnce el rellegeix idèntic', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    // Cap crida a activateCloudSync -- aquest useCloudSync ni tan sols
    // arriba a vincular-se a cap projecte, mateix esperit que una còpia de
    // seguretat en segon pla d'un projecte que no és l'obert ara mateix.
    const cloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const snapshot = makeSnapshot();
    const id = crypto.randomUUID();

    await cloud.seedCloudProjectFromSnapshot(id, 'ProjecteEnSegonPla', snapshot);

    expect(backend.docsStore.get(`projects/${id}/_access/doc`)).toEqual({
      ownerEmail: 'owner@test.com',
      memberEmails: ['owner@test.com'],
      projectName: 'ProjecteEnSegonPla',
    });
    expect(backend.docsStore.get(`userProjects/owner@test.com/projects/${id}`)).toEqual({
      projectName: 'ProjecteEnSegonPla',
      ownerEmail: 'owner@test.com',
    });
    expect(backend.docsStore.get(`projects/${id}/channels/data`).snapshot).toEqual(snapshot.excelJsonData);
    expect(backend.docsStore.get(`projects/${id}/channels/documentsList`).snapshot).toEqual(snapshot.documentsList);
    expect(backend.docsStore.get(`projects/${id}/channels/template:Annex`).snapshot).toEqual({ text: 'Plantilla annex' });
    expect(backend.docsStore.get(`projects/${id}/channels/excelFile`).fileName).toBe('origen.xlsx');
    expect(backend.docsStore.get(`projects/${id}/channels/refDoc:Annex`).fileName).toBe('ref.docx');
    // El document SENSE fitxer de referència no ha de tenir cap canal
    // refDoc -- mateix criteri que seedInitial() ja garanteix (mai es crea
    // un canal/meta buit).
    expect(backend.docsStore.has(`projects/${id}/channels/refDoc:Document Principal`)).toBe(false);

    const reread = await cloud.fetchCloudProjectSnapshotOnce(id);
    expect(reread).toEqual(snapshot);
  });

  it('fetchCloudProjectSnapshotOnce reconstrueix l\'estat ja fusionat (base + deltes) d\'un projecte que un altre membre ha editat en viu, sense cap onSnapshot propi', async () => {
    const backend = makeFakeFirestoreBackend();
    const store = useWorkspaceStore();
    store.config.cloudSyncCaptureDebounceSeconds = CAPTURE_DEBOUNCE_SECONDS_TEST;
    store.excelJsonData = { General: { nom: 'Abans d\'editar' } };
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteViu');
    await flush();

    store.excelJsonData = { General: { nom: 'Editat en viu' } };
    await flush();

    // Un segon client, mai vinculat en viu a aquest projecte -- NOMÉS fa la
    // lectura d'un sol cop.
    setActivePinia(createPinia());
    useWorkspaceStore();
    const outsideCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const snapshot = await outsideCloud.fetchCloudProjectSnapshotOnce(id);
    expect(snapshot.excelJsonData.General.nom).toBe('Editat en viu');
  });

  it('fetchCloudProjectSnapshotOnce rebutja qui no és membre del projecte', async () => {
    const backend = makeFakeFirestoreBackend();
    const ownerAuth = makeCloudAuth('owner@test.com');
    const ownerCloud = useCloudSync(ownerAuth, backend.createClientFor('owner@test.com'));
    const id = await ownerCloud.activateCloudSync('ProjecteA');
    await flush();

    const outsiderAuth = makeCloudAuth('fora@test.com');
    const outsiderCloud = useCloudSync(outsiderAuth, backend.createClientFor('fora@test.com'));
    await expect(outsiderCloud.fetchCloudProjectSnapshotOnce(id)).rejects.toThrow();
  });
});
