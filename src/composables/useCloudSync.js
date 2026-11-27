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
 * Sincronització al núvol (Fases 25-26 -- veure .claude/plans/
 * unified-nibbling-adleman.md): tercer transport de col·laboració,
 * additiu als altres dos (carpeta compartida, useCollabSync.js; sessió en
 * viu WebRTC, useCollabRealtime.js). A diferència d'aquells dos, aquest
 * NO necessita que ningú més estigui connectat alhora -- Firestore és la
 * base de dades duradora que fa de "algú sempre hi és".
 *
 * Reutilitza LITERALMENT el mateix patró "base + deltes per usuari,
 * reconstruït (ts, userId) des de zero" que useCollabSync.js ja prova en
 * producció per a la carpeta compartida (createDocChannel) -- només canvia
 * ON viuen la base i els deltes (Firestore, no fitxers), i que Firestore
 * EMPENY els canvis (`onSnapshot`) en lloc de necessitar sondeig.
 *
 * Abast (Fase 26): `data` (excelJsonData), `schema` (editorMetadata),
 * `sheetInfo`, `hierarchySchema` -- abast de PROJECTE sencer, sempre
 * actius mentre hi ha sincronització connectada -- i `template:<docName>`
 * -- abast de DOCUMENT, un sol canal vinculat a la vegada (el del document
 * actiu), revinculat en canviar de document, mateix criteri que
 * `bindDocument`/`switchRealtimeDocument` ja fan servir per al pont WebRTC.
 *
 * Fase 28: afegeix `excelFile` (28.1) i `refDoc:<docName>` (28.3), canals
 * de FITXER BINARI sencer via `createCloudBlobChannel` -- última
 * escriptura guanya sobre TOT el fitxer (comparat per hash SHA-256), mai
 * un pedaç JSON com els canals de dalt -- i `documentsList` (28.2), un
 * sisè canal JSON fix que tanca la llacuna que, sense ell, deixaria
 * `refDoc:<docName>` inabastable per a qui mai ha vist cap document més
 * enllà de "Document Principal". `refDoc:<docName>` segueix exactament el
 * mateix cicle de vida que `template:<docName>` (un sol canal "vinculat" a
 * la vegada, el del document actiu).
 *
 * Autorització: cada projecte al núvol té el seu propi document d'accés
 * `projects/{id}/_access/doc` ({ownerEmail, memberEmails}), que les Regles
 * de Seguretat de Firestore comproven per a TOTA la resta del contingut
 * del projecte -- vegeu el pla per al text complet de les regles. Només
 * el propietari pot afegir/treure membres; conèixer l'identificador d'un
 * projecte, per si sol, no dona accés a res.
 */
import { ref, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { computeDataPatch, computeMetaPatch, applyDataPatch, mergeChannelFromDocs } from '../utils/dataPatch.js';
import { getOrCreateUserId, getDisplayNameOrFallback } from './useCollabIdentity.js';
import { getFirebaseApp } from './useCloudAuth.js';
// `chunkBytes`/`concatChunks` (Fase 14) ja són funcions pures reutilitzables
// tal qual -- no depenen de WebRTC/Yjs, només trossegen/reconstrueixen un
// `Uint8Array`. Aquí serveixen per repartir un fitxer binari en documents
// Firestore d'un MiB (Fase 28), en lloc de missatges WebRTC de 16 KiB.
import { chunkBytes, concatChunks } from './useCollabRealtime.js';

const ACTIVITY_LOG_MAX = 20;
const DEFAULT_COMPACTION_THRESHOLD = 200;
const DEFAULT_MAX_BINARY_FILE_SIZE_MB = 10;
// 900 KiB -- marge ampli sota l'1 MiB per document de Firestore (camp
// `Bytes` + camps de metadades + sobrecàrrega pròpia de Firestore
// inclosos), mai cal fragmentar-ho més fi com la Fase 14 (16 KiB) perquè
// aquí no hi ha cap canal de dades WebRTC de per mig.
const BLOB_CHUNK_SIZE = 900 * 1024;

// Hash hexadecimal SHA-256 d'un ArrayBuffer/Uint8Array -- Web Crypto API,
// disponible nativament en qualsevol context segur (https/localhost), cap
// dependència nova. Serveix per decidir si un fitxer ha canviat de debò
// (evita repujar/reaplicar contingut idèntic) i per verificar la
// integritat d'un fitxer reconstruït a partir dels seus trossos.
async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Normalitzat sempre igual (minúscules, sense espais) perquè la comparació
// client-side ("ets el propietari?") coincideixi amb `request.auth.token.email`
// (que Firebase ja dona en minúscules) -- la font de veritat real segueix
// sent la regla de seguretat del servidor, això només evita que la
// interfície mostri un estat erroni per una diferència de majúscules.
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Carregador per defecte (producció): `firebase/firestore` diferit, mateix
// patró que `getFirebaseApp()`/`getAuthModule()` a useCloudAuth.js.
// `useCloudSync()` l'accepta com a segon paràmetre INJECTABLE (no el crida
// directament des de dins de `createCloudChannel`/la resta del cos) perquè
// els tests (tests/cloud_sync.test.js) hi puguin passar un Firestore fals
// en memòria -- mateix esperit que useCollabSync.js rebent `collabFolder`
// per paràmetre en lloc d'importar-lo com a singleton intern.
let firestorePromise = null;
function defaultGetFirestoreModule() {
  if (!firestorePromise) {
    firestorePromise = Promise.all([getFirebaseApp(), import('firebase/firestore')]).then(([app, mod]) => ({
      db: mod.getFirestore(app),
      mod,
    }));
  }
  return firestorePromise;
}

/**
 * Un sol canal sincronitzat -- `data`, `schema`, `sheetInfo`,
 * `hierarchySchema` i `template:<docName>` (Fase 26) hi instancien tots
 * aquesta mateixa factoria, sense cap canvi. Document base a
 * `projects/{id}/channels/{channelKey}`, deltes a la subcol·lecció
 * `.../deltas` -- mateix criteri d'ordenació determinista (ts, userId) que
 * `createDocChannel` (useCollabSync.js) i `attachDeltaLogChannel`
 * (useCollabRealtime.js, Fase 17) ja fan servir.
 */
/**
 * `wrap`/`unwrap` (per defecte, identitat): mateix mecanisme que
 * `createDocChannel` (useCollabSync.js) -- el canal `template` embolcalla
 * el text pla com `{text: ...}` perquè `computeDataPatch`/`applyDataPatch`
 * (pensats per a objectes) puguin diferenciar/aplicar-hi patches; la base
 * ES DESA i ES LLEGEIX sempre en forma EMBOLCALLADA (consistent amb els
 * patches, que també s'hi calculen embolcallats), i només es desembolcalla
 * en el moment de `setLocal`.
 */
function createCloudChannel({ channelKey, getDb, cloudProjectIdRef, getLocal, setLocal, wrap = (v) => v, unwrap = (v) => v, computePatch, mergeMessage, compactMessage, logEvent, compactionThreshold }) {
  const isApplyingRemote = ref(false);
  const lastMergedState = ref(null);

  let baseline = null; // null fins que el primer onSnapshot de la base arribi
  let deltaDocs = []; // [{id, userId, displayName, ts, patch}]
  let unsubBase = null;
  let unsubDeltas = null;
  let debounceTimer = null;
  let compacting = false;

  function setApplyingRemote(v) { isApplyingRemote.value = v; }

  // Fase 32: deixa saber a `bindToProjectNow` quan aquest canal concret ja
  // ha rebut com a mínim la seva primera instantània remota (base), perquè
  // pugui mostrar un indicador de progrés mentre ho espera -- recreat a
  // cada `startListening()` (no només un sol cop per instància de canal,
  // que es reutilitza entre vinculacions successives al llarg de la vida
  // de la pestanya). Resolt també en cas d'error (mai deixa `bindToProjectNow`
  // penjat per sempre per un sol canal que falla -- l'error ja es registra
  // per separat via `logEvent`).
  let resolveFirstSnapshot = null;
  let firstSnapshotPromise = null;
  function resetFirstSnapshotGate() {
    firstSnapshotPromise = new Promise((resolve) => { resolveFirstSnapshot = resolve; });
  }
  function markFirstSnapshotReceived() {
    if (resolveFirstSnapshot) {
      const resolve = resolveFirstSnapshot;
      resolveFirstSnapshot = null;
      resolve();
    }
  }
  resetFirstSnapshotGate();

  function channelRefs(db, mod) {
    const projectId = cloudProjectIdRef.value;
    return {
      base: mod.doc(db, 'projects', projectId, 'channels', channelKey),
      deltas: mod.collection(db, 'projects', projectId, 'channels', channelKey, 'deltas'),
    };
  }

  function recomputeAndApply() {
    if (baseline === null) return;
    // SEMPRE reconstruït des de zero (base + totes les entrades conegudes,
    // en ordre determinista), mai incrementalment -- mateix invariant que
    // pollCycle() ja garanteix per a la carpeta compartida. Fórmula extreta
    // a `mergeChannelFromDocs` (Fase 34, `src/utils/dataPatch.js`) perquè
    // també la pugui reutilitzar una lectura d'un sol cop (sense
    // `onSnapshot`) d'un projecte que no s'escolta en viu.
    const merged = mergeChannelFromDocs(baseline, deltaDocs);
    if (JSON.stringify(merged) !== JSON.stringify(lastMergedState.value)) {
      setApplyingRemote(true);
      setLocal(unwrap(merged));
      nextTick().then(() => {
        setApplyingRemote(false);
        // Rellegit via getLocal() (no `merged`) després de nextTick, pel
        // mateix motiu que pollCycle(): un recàlcul de camps (p. ex.
        // evaluateComputedFields) pot haver tornat a mutar l'store durant
        // aquest mateix flush.
        lastMergedState.value = JSON.parse(JSON.stringify(wrap(getLocal())));
        logEvent(mergeMessage, 'info');
      });
    }
    // `merged` (no `lastMergedState.value`) -- aquesta crida pot ser
    // REENTRANT dins la mateixa volta síncrona que una captura local en
    // curs (p. ex. l'`onSnapshot` de `deltas` es dispara dins el propi
    // `addDoc` d'aquest mateix client, abans que `captureLocalChange`
    // n'hagi pogut actualitzar `lastMergedState`) -- en aquest instant
    // `lastMergedState.value` pot estar desactualitzat, mentre que
    // `merged` ÉS, per construcció, l'estat fusionat correcte d'aquest
    // cicle. Compactar amb el valor desactualitzat perdria l'edició que
    // encara no s'hagués reflectit a `lastMergedState`.
    maybeCompact(merged, deltaDocs.length);
  }

  async function maybeCompact(merged, deltaCount) {
    const threshold = (typeof compactionThreshold === 'function' ? compactionThreshold() : compactionThreshold) || DEFAULT_COMPACTION_THRESHOLD;
    if (compacting || deltaCount < threshold) return;
    compacting = true;
    try {
      const { db, mod } = await getDb();
      const { base, deltas } = channelRefs(db, mod);
      await mod.setDoc(base, { snapshot: merged, updatedAt: new Date().toISOString(), updatedBy: getOrCreateUserId() });
      const snap = await mod.getDocs(deltas);
      const refsToDelete = [];
      snap.forEach((d) => refsToDelete.push(d.ref));
      for (let i = 0; i < refsToDelete.length; i += 450) {
        const batch = mod.writeBatch(db);
        refsToDelete.slice(i, i + 450).forEach((ref) => batch.delete(ref));
        await batch.commit();
      }
      logEvent(compactMessage, 'info');
    } catch (e) {
      logEvent(`Error en compactar la sincronització al núvol (${channelKey}): ${e.message}`, 'warning');
    } finally {
      compacting = false;
    }
  }

  // Escrit en activar/crear el projecte -- la base inicial és l'estat
  // actual de l'store, cap delta encara.
  async function seedInitial() {
    const { db, mod } = await getDb();
    const { base } = channelRefs(db, mod);
    const local = wrap(getLocal());
    await mod.setDoc(base, { snapshot: local, updatedAt: new Date().toISOString(), updatedBy: getOrCreateUserId() });
    baseline = JSON.parse(JSON.stringify(local));
    deltaDocs = [];
    lastMergedState.value = JSON.parse(JSON.stringify(local));
  }

  // `onSnapshot` dona sempre una primera crida immediata amb l'estat ja
  // conegut (de la memòria cau o del servidor) -- no cal cap lectura
  // (`getDoc`/`getDocs`) prèvia i separada, a diferència del sondeig de la
  // carpeta compartida, que no té cap equivalent "empès".
  async function startListening() {
    resetFirstSnapshotGate();
    const { db, mod } = await getDb();
    const { base, deltas } = channelRefs(db, mod);
    unsubBase = mod.onSnapshot(base, (snap) => {
      if (snap.exists()) {
        baseline = snap.data().snapshot;
      } else if (baseline === null) {
        // Cap base encara (p. ex. un projecte activat abans que aquest
        // canal existís, Fase 26) -- s'autosembra amb el contingut local
        // actual, mateix efecte que si aquest client n'hagués estat el
        // primer a activar la sincronització. Escriptura best-effort: si
        // falla (p. ex. un altre membre ja l'ha sembrat mentrestant), el
        // pròxim `onSnapshot` real ja la corregirà.
        baseline = wrap(getLocal());
        lastMergedState.value = JSON.parse(JSON.stringify(baseline));
        mod.setDoc(base, { snapshot: baseline, updatedAt: new Date().toISOString(), updatedBy: getOrCreateUserId() })
          .catch((e) => logEvent(`Error en sembrar el canal al núvol (${channelKey}): ${e.message}`, 'warning'));
      }
      recomputeAndApply();
      markFirstSnapshotReceived();
    }, (err) => {
      logEvent(`Error de sincronització al núvol (${channelKey}): ${err.message}`, 'error');
      markFirstSnapshotReceived();
    });
    unsubDeltas = mod.onSnapshot(deltas, (snap) => {
      deltaDocs = [];
      snap.forEach((d) => deltaDocs.push(d.data()));
      recomputeAndApply();
    }, (err) => logEvent(`Error de sincronització al núvol (${channelKey}): ${err.message}`, 'error'));
  }

  async function captureLocalChange() {
    if (isApplyingRemote.value) return;
    const patch = computePatch(lastMergedState.value, wrap(getLocal()));
    if (!patch) return;
    try {
      const { db, mod } = await getDb();
      const { deltas } = channelRefs(db, mod);
      await mod.addDoc(deltas, {
        userId: getOrCreateUserId(),
        displayName: getDisplayNameOrFallback(),
        ts: new Date().toISOString(),
        patch,
      });
      // Actualitzat a l'instant (no esperant el proper onSnapshot propi,
      // que de totes maneres arribarà, però més tard) perquè aquest client
      // no es re-diferenciï contra la seva pròpia escriptura acabada de fer.
      lastMergedState.value = JSON.parse(JSON.stringify(wrap(getLocal())));
    } catch (e) {
      logEvent(`Error en desar un canvi al núvol (${channelKey}): ${e.message}`, 'error');
    }
  }

  function scheduleCaptureOnChange(debounceMs) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(captureLocalChange, debounceMs);
  }
  function cancelPendingCapture() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Fase 27: si hi havia una captura local pendent (dins la finestra de
  // debounce) en aturar el canal -- p. ex. en canviar de projecte just
  // després d'editar -- es puja ARA MATEIX, en lloc de només cancel·lar-la i
  // perdre-la. Cal ESPERAR-LA (no només llançar-la): `captureLocalChange`
  // llegeix `cloudProjectIdRef.value` (compartit, mateix ref, per TOTS els
  // canals) via `channelRefs()` -- si el crida qui ens ha aturat (p. ex.
  // `deactivateCloudSync`) i tot seguit posa aquest ref a `null` ABANS que
  // la part asíncrona de `captureLocalChange` l'arribi a llegir, la pujada
  // apunta a `projects/null/...` i falla amb `permission-denied`. Confirmat
  // amb un test que reproduïa exactament aquesta carrera -- per això
  // `stopListening` ara és `async` i QUI LA CRIDA l'ha d'esperar abans de
  // tocar `cloudProjectId`.
  async function stopListening() {
    const hadPendingCapture = !!debounceTimer;
    cancelPendingCapture();
    if (hadPendingCapture) {
      try {
        await captureLocalChange();
      } catch (e) {
        logEvent(`Error en desar l'últim canvi local abans d'aturar la sincronització (${channelKey}): ${e.message}`, 'warning');
      }
    }
    if (unsubBase) { unsubBase(); unsubBase = null; }
    if (unsubDeltas) { unsubDeltas(); unsubDeltas = null; }
    baseline = null;
    deltaDocs = [];
    lastMergedState.value = null;
  }

  return {
    channelKey,
    isApplyingRemote,
    lastMergedState,
    seedInitial,
    startListening,
    stopListening,
    scheduleCaptureOnChange,
    cancelPendingCapture,
    getFirstSnapshotPromise: () => firstSnapshotPromise,
  };
}

/**
 * Canal per a UN fitxer BINARI sencer (Fase 28) -- `excelFile` (abast de
 * projecte) i, més endavant, `refDoc:<docName>` (abast de document,
 * mateix cicle de vida que `template:<docName>`). A diferència de
 * `createCloudChannel` (pensat per a diferències de camp JSON), un fitxer
 * binari es reemplaça SENCER, última escriptura guanya -- exactament el
 * mateix criteri que `collab_project.zip`/`refDocFile` ja reben avui a la
 * carpeta compartida i a WebRTC (mai es "diferencien" tampoc allà). Per
 * això NO reutilitza `computePatch`/`applyDataPatch`: compara per HASH
 * (SHA-256) l'estat local contra el remot, sense cap registre de deltes.
 *
 * Disposició a Firestore: `projects/{id}/channels/{channelKey}` (meta:
 * `{fileName, fileSize, totalChunks, sha256Hex, updatedAt, updatedBy}`) +
 * la subcol·lecció germana `.../chunks/{index}` (`{data: Bytes}`,
 * `index` = '0', '1', ... -- mai es llegeix l'ordre implícit de Firestore,
 * que no és numèric per a IDs de text; es parseja `index` explícitament a
 * cada lectura).
 *
 * `getLocalBuffer`/`getLocalFileName`/`setLocal` (injectats des d'App.vue,
 * vegeu `useCloudSync`): aquest canal no toca MAI IndexedDB/`localStorage`
 * directament (seguint el mateix criteri que `createCloudChannel`, que
 * només toca `store.*`) -- la persistència entre recàrregues de pàgina és
 * responsabilitat de qui injecta `setLocal`.
 */
function createCloudBlobChannel({ channelKey, getDb, cloudProjectIdRef, getLocalBuffer, getLocalFileName, setLocal, logEvent, maxFileSizeBytes }) {
  let unsubMeta = null;

  // Fase 32: mateix idioma que `createCloudChannel` -- vegeu el seu comentari.
  let resolveFirstSnapshot = null;
  let firstSnapshotPromise = null;
  function resetFirstSnapshotGate() {
    firstSnapshotPromise = new Promise((resolve) => { resolveFirstSnapshot = resolve; });
  }
  function markFirstSnapshotReceived() {
    if (resolveFirstSnapshot) {
      const resolve = resolveFirstSnapshot;
      resolveFirstSnapshot = null;
      resolve();
    }
  }
  resetFirstSnapshotGate();

  function channelRefs(db, mod) {
    const projectId = cloudProjectIdRef.value;
    return {
      meta: mod.doc(db, 'projects', projectId, 'channels', channelKey),
      chunks: mod.collection(db, 'projects', projectId, 'channels', channelKey, 'chunks'),
      chunkDoc: (i) => mod.doc(db, 'projects', projectId, 'channels', channelKey, 'chunks', String(i)),
    };
  }

  function maxBytes() {
    return (typeof maxFileSizeBytes === 'function' ? maxFileSizeBytes() : maxFileSizeBytes) || (DEFAULT_MAX_BINARY_FILE_SIZE_MB * 1024 * 1024);
  }

  // Puja `buffer` sencer: substitueix la meta + TOTS els chunks en un SOL
  // `writeBatch` atòmic -- cap lector hi pot veure mai un estat a mig
  // escriure (a diferència d'escriure cada chunk per separat). Si la nova
  // versió té MENYS trossos que l'anterior, els sobrants -- s'esborren
  // dins el MATEIX batch (mateix escombratge que `maybeCompact` ja fa per
  // als deltes).
  async function uploadBuffer(buffer, fileName, hash, db, mod) {
    const limit = maxBytes();
    if (buffer.byteLength > limit) {
      logEvent(`El fitxer "${fileName}" (${(buffer.byteLength / 1048576).toFixed(1)} MiB) supera el límit de sincronització al núvol (${(limit / 1048576).toFixed(0)} MiB) -- fes servir la carpeta compartida o una sessió en viu per compartir-lo.`, 'warning');
      return;
    }
    const { meta, chunks, chunkDoc } = channelRefs(db, mod);
    const parts = chunkBytes(new Uint8Array(buffer), BLOB_CHUNK_SIZE);
    const existingSnap = await mod.getDocs(chunks);
    const staleRefs = [];
    existingSnap.forEach((d) => {
      const idx = parseInt(d.ref.path.split('/').pop(), 10);
      if (Number.isNaN(idx) || idx >= parts.length) staleRefs.push(d.ref);
    });
    const batch = mod.writeBatch(db);
    batch.set(meta, {
      fileName,
      fileSize: buffer.byteLength,
      totalChunks: parts.length,
      sha256Hex: hash,
      updatedAt: new Date().toISOString(),
      updatedBy: getOrCreateUserId(),
    });
    parts.forEach((chunk, i) => {
      batch.set(chunkDoc(i), { data: mod.Bytes.fromUint8Array(chunk) });
    });
    staleRefs.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  // Llegeix tots els chunks declarats per `meta`, els reconstrueix EN
  // ORDRE NUMÈRIC explícit (mai l'ordre implícit de `getDocs`, que no és
  // garantit i, fins i tot si ho fos, seria lexicogràfic -- '10' abans de
  // '2' -- no numèric), en verifica l'`sha256Hex` reconstruït contra el
  // declarat (si no coincideix, o falta algun chunk, s'espera al pròxim
  // `onSnapshot` en lloc d'aplicar dades a mitges) i aplica `setLocal`.
  async function fetchAndApply(meta) {
    const { db, mod } = await getDb();
    const { chunks } = channelRefs(db, mod);
    const snap = await mod.getDocs(chunks);
    const ordered = new Array(meta.totalChunks);
    snap.forEach((d) => {
      const idx = parseInt(d.ref.path.split('/').pop(), 10);
      if (!Number.isNaN(idx) && idx < meta.totalChunks) {
        ordered[idx] = d.data().data.toUint8Array();
      }
    });
    if (ordered.some((c) => !c)) {
      logEvent(`Dades incompletes en rebre "${meta.fileName}" des del núvol -- s'esperarà la pròxima actualització.`, 'warning');
      return;
    }
    const bytes = concatChunks(ordered);
    const hash = await sha256Hex(bytes);
    if (hash !== meta.sha256Hex) {
      logEvent(`La verificació d'integritat de "${meta.fileName}" no coincideix -- s'esperarà la pròxima actualització.`, 'warning');
      return;
    }
    await setLocal(bytes.buffer, meta.fileName);
    logEvent(`S'ha rebut una versió actualitzada de "${meta.fileName}" des de la sincronització al núvol.`, 'info');
  }

  // Escrit en activar/crear el projecte -- no-op si no hi ha cap fitxer
  // local (p. ex. un document sense cap fitxer de referència): mai es crea
  // cap canal/meta buit.
  async function seedInitial() {
    const buffer = await getLocalBuffer();
    if (!buffer) return;
    const fileName = getLocalFileName();
    const hash = await sha256Hex(buffer);
    const { db, mod } = await getDb();
    await uploadBuffer(buffer, fileName, hash, db, mod);
  }

  // `onSnapshot` sobre el document meta -- compara sempre contra l'estat
  // LOCAL real en aquest instant (mai una variable cau pròpia, el mateix
  // tipus de carrera ja trobat i corregit a la Fase 27): si el hash remot
  // coincideix amb el hash de l'estat local actual (inclòs el cas "és el
  // meu propi eco, acabo de pujar-ho jo mateix"), no cal fer res.
  async function startListening() {
    resetFirstSnapshotGate();
    const { db, mod } = await getDb();
    const { meta } = channelRefs(db, mod);
    unsubMeta = mod.onSnapshot(meta, async (snap) => {
      try {
        if (!snap.exists()) return; // cap fitxer remot encara -- res a baixar
        const remoteData = snap.data();
        const localBuffer = await getLocalBuffer();
        const localHash = localBuffer ? await sha256Hex(localBuffer) : null;
        if (remoteData.sha256Hex === localHash) return;
        await fetchAndApply(remoteData);
      } finally {
        markFirstSnapshotReceived();
      }
    }, (err) => {
      logEvent(`Error de sincronització al núvol (${channelKey}): ${err.message}`, 'error');
      markFirstSnapshotReceived();
    });
  }

  // Cridada EXPLÍCITAMENT (mai per un watcher reactiu de bytes -- un
  // fitxer binari no es "tecleja", es reemplaça sencer en punts discrets i
  // coneguts) des d'App.vue, després que la seva pròpia escriptura local ja
  // hagi passat. Compara sempre contra l'estat REMOT real llegit ara
  // mateix (mai una variable cau local) pel mateix motiu que
  // `startListening` -- evita repujar contingut que ja hi és.
  async function captureIfChanged() {
    const buffer = await getLocalBuffer();
    if (!buffer) return; // res a pujar -- l'eliminació del fitxer remot no es gestiona aquí (Fase 28.1)
    const fileName = getLocalFileName();
    const hash = await sha256Hex(buffer);
    const { db, mod } = await getDb();
    const { meta } = channelRefs(db, mod);
    const snap = await mod.getDoc(meta);
    if (snap.exists() && snap.data().sha256Hex === hash) return;
    await uploadBuffer(buffer, fileName, hash, db, mod);
  }

  function stopListening() {
    if (unsubMeta) { unsubMeta(); unsubMeta = null; }
  }

  return {
    channelKey,
    seedInitial,
    startListening,
    stopListening,
    captureIfChanged,
    getFirstSnapshotPromise: () => firstSnapshotPromise,
  };
}

/**
 * `cloudAuth`: l'objecte retornat per useCloudAuth() -- aquest composable
 * només hi llegeix `currentUser`, mai en gestiona la sessió ell mateix.
 * `getDb`: injectable, per defecte `defaultGetFirestoreModule` (producció,
 * Firestore real diferit); els tests hi passen un Firestore fals en
 * memòria sense tocar res més d'aquesta funció.
 * `externalAdapters` (Fase 28, opcional): `{ excelFile: { getBuffer,
 * getFileName, setFile }, refDoc: { getBuffer, getFileName, setFile },
 * documentsList: { getLocal, setLocal } }` -- injectats des d'App.vue, que
 * és qui té accés a `saveBinaryFile`/`currentProjectName`/`documentsList`
 * (aquest ref viu a App.vue, no a l'store de Pinia) per persistir el que
 * es rep a IndexedDB/`localStorage` (aquest mòdul no en toca mai res
 * directament, seguint el mateix criteri que els canals JSON, que només
 * toquen `store.*`). Qualsevol adaptador no passat queda inert (mai puja
 * ni aplica res) -- cap crida existent es trenca.
 */
export function useCloudSync(cloudAuth, getDb = defaultGetFirestoreModule, externalAdapters = {}) {
  const store = useWorkspaceStore();
  const excelFileAdapter = externalAdapters.excelFile || {
    getBuffer: async () => null,
    getFileName: () => '',
    setFile: async () => {},
  };
  const refDocAdapter = externalAdapters.refDoc || {
    getBuffer: async () => null,
    getFileName: () => '',
    setFile: async () => {},
  };
  const documentsListAdapter = externalAdapters.documentsList || {
    getLocal: () => [],
    setLocal: () => {},
  };
  const multiDocAdapter = externalAdapters.multiDoc || {
    getTemplateText: () => '',
    getRefDocBuffer: async () => null,
    getRefDocFileName: () => '',
  };

  // 'disabled' (ningú ha iniciat sessió al núvol) | 'disconnected' (sessió
  // iniciada, cap projecte al núvol vinculat a AQUEST projecte local) |
  // 'connecting' | 'connected' | 'error'.
  const cloudSyncStatus = ref(cloudAuth.currentUser.value ? 'disconnected' : 'disabled');
  const cloudProjectId = ref(null);
  const lastCloudSyncError = ref(null);
  const cloudActivityLog = ref([]);
  // Fase 32: cert mentre `bindToProjectNow` espera que CADA canal rebi com
  // a mínim la seva primera instantània remota -- `CollabPanel.vue` el fa
  // servir per mostrar "Sincronitzant..." en lloc de deixar un activar/
  // unir-se que triga uns segons (o més, en una connexió lenta) semblar
  // que ha fallat en silenci.
  const isApplyingInitialSync = ref(false);
  // {ownerEmail, memberEmails: string[]} | null -- mantingut en viu amb el
  // seu propi onSnapshot mentre hi ha un projecte vinculat, perquè
  // CollabPanel.vue pugui mostrar/gestionar els membres de seguida.
  const projectAccess = ref(null);
  let unsubAccess = null;

  function logCloudEvent(text, type = 'info') {
    store.addLog(text, type);
    cloudActivityLog.value.unshift({ time: new Date().toLocaleTimeString(), text, type });
    if (cloudActivityLog.value.length > ACTIVITY_LOG_MAX) {
      cloudActivityLog.value.length = ACTIVITY_LOG_MAX;
    }
  }

  const dataChannel = createCloudChannel({
    channelKey: 'data',
    getDb,
    cloudProjectIdRef: cloudProjectId,
    getLocal: () => store.excelJsonData,
    setLocal: (v) => { store.excelJsonData = v; },
    computePatch: computeDataPatch,
    compactionThreshold: () => store.config.cloudSyncCompactionThreshold,
    mergeMessage: "S'han incorporat canvis d'altres persones des de la sincronització al núvol.",
    compactMessage: "S'ha compactat la sincronització al núvol (nova base comuna, dades).",
    logEvent: logCloudEvent,
  });
  const schemaChannel = createCloudChannel({
    channelKey: 'schema',
    getDb,
    cloudProjectIdRef: cloudProjectId,
    getLocal: () => store.editorMetadata,
    setLocal: (v) => { store.editorMetadata = v; },
    computePatch: computeMetaPatch,
    compactionThreshold: () => store.config.cloudSyncCompactionThreshold,
    mergeMessage: "S'han incorporat canvis a l'esquema de dades des de la sincronització al núvol.",
    compactMessage: "S'ha compactat la sincronització al núvol (nova base comuna, esquema de dades).",
    logEvent: logCloudEvent,
  });
  const sheetInfoChannel = createCloudChannel({
    channelKey: 'sheetInfo',
    getDb,
    cloudProjectIdRef: cloudProjectId,
    getLocal: () => store.sheetInfo,
    setLocal: (v) => { store.sheetInfo = v; },
    computePatch: computeMetaPatch,
    compactionThreshold: () => store.config.cloudSyncCompactionThreshold,
    mergeMessage: "S'han incorporat canvis a la informació dels fulls des de la sincronització al núvol.",
    compactMessage: "S'ha compactat la sincronització al núvol (nova base comuna, informació dels fulls).",
    logEvent: logCloudEvent,
  });
  const hierarchySchemaChannel = createCloudChannel({
    channelKey: 'hierarchySchema',
    getDb,
    cloudProjectIdRef: cloudProjectId,
    getLocal: () => store.hierarchySchema,
    setLocal: (v) => { store.hierarchySchema = v; },
    computePatch: computeDataPatch,
    compactionThreshold: () => store.config.cloudSyncCompactionThreshold,
    mergeMessage: "S'han incorporat canvis a l'esquema jeràrquic des de la sincronització al núvol.",
    compactMessage: "S'ha compactat la sincronització al núvol (nova base comuna, esquema jeràrquic).",
    logEvent: logCloudEvent,
  });
  // Canal `documentsList` (Fase 28.2) -- un array de cadenes, reutilitza
  // `createCloudChannel` TAL QUAL (`computeMetaPatch` ja és la forma
  // correcta per a arrays). `getLocal`/`setLocal` venen de
  // `documentsListAdapter` (injectat des d'App.vue) perquè `documentsList`
  // és un `ref` propi d'App.vue, no un camp de l'store de Pinia -- aquest
  // mòdul no en toca mai `localStorage` directament (mateix criteri que
  // `excelFileAdapter`). Tanca la llacuna trobada en planificar aquesta
  // fase: sense sincronitzar-ho, un membre que mai ha intercanviat cap ZIP
  // només veuria "Document Principal", sense manera d'arribar mai a cap
  // altre document ni, per tant, al seu canal `refDoc:<docName>` (28.3).
  const documentsListChannel = createCloudChannel({
    channelKey: 'documentsList',
    getDb,
    cloudProjectIdRef: cloudProjectId,
    getLocal: documentsListAdapter.getLocal,
    setLocal: documentsListAdapter.setLocal,
    computePatch: computeMetaPatch,
    compactionThreshold: () => store.config.cloudSyncCompactionThreshold,
    mergeMessage: "S'han incorporat nous documents al projecte des de la sincronització al núvol.",
    compactMessage: "S'ha compactat la sincronització al núvol (nova base comuna, llista de documents).",
    logEvent: logCloudEvent,
  });
  const channels = [dataChannel, schemaChannel, sheetInfoChannel, hierarchySchemaChannel, documentsListChannel];

  // Canal binari `excelFile` (Fase 28) -- abast de PROJECTE sencer, sempre
  // actiu mentre hi ha sincronització connectada, mateix criteri que els
  // quatre canals JSON de dalt. Mantingut en una llista PRÒPIA
  // (`blobChannels`), no barrejat dins `channels`, perquè la seva forma
  // (`seedInitial`/`startListening`/`stopListening`/`captureIfChanged`, SENSE
  // `isApplyingRemote`/`lastMergedState`/`scheduleCaptureOnChange`) és
  // diferent de la dels canals JSON.
  const excelFileChannel = createCloudBlobChannel({
    channelKey: 'excelFile',
    getDb,
    cloudProjectIdRef: cloudProjectId,
    getLocalBuffer: excelFileAdapter.getBuffer,
    getLocalFileName: excelFileAdapter.getFileName,
    setLocal: excelFileAdapter.setFile,
    logEvent: logCloudEvent,
    maxFileSizeBytes: () => (store.config.cloudSyncMaxBinaryFileSizeMB || DEFAULT_MAX_BINARY_FILE_SIZE_MB) * 1024 * 1024,
  });
  const blobChannels = [excelFileChannel];

  // Cridada des d'App.vue després que el fitxer Excel local ja s'hagi
  // substituït i persistit (processExcelFile/bindExcelAsTemplateOnly/
  // importProjectZip) -- no-op silenciós si no hi ha sincronització
  // connectada.
  async function captureExcelFileIfChanged() {
    if (cloudSyncStatus.value !== 'connected') return;
    await excelFileChannel.captureIfChanged();
  }

  // Canal `template:<docName>` (Fase 26): a diferència dels quatre d'amunt
  // (sempre vius, abast de PROJECTE sencer), `templateText` és nomÉs el
  // del document ACTIU en cada moment (la resta es persisteix a
  // `localStorage`, `${pName}:doc:${dName}:templateText`, vegeu App.vue) --
  // per això aquí NOMÉS es manté un sol canal "vinculat" a la vegada,
  // mateix criteri que `bindDocument`/`switchRealtimeDocument` ja fan per
  // al pont WebRTC (Fase 11.2/16): revincular en lloc de mantenir N canals
  // simultanis per a tots els documents del projecte.
  let templateChannel = null;
  let boundTemplateDocName = null;

  function makeTemplateChannel(docName) {
    return createCloudChannel({
      channelKey: `template:${docName}`,
      getDb,
      cloudProjectIdRef: cloudProjectId,
      getLocal: () => store.templateText,
      setLocal: (v) => { store.templateText = v; },
      // Mateix criteri que el canal `template` de la carpeta compartida
      // (Fase 8): `templateText` és un text pla, embolcallat com
      // `{text: ...}` (base inclosa, no només els patches) perquè
      // computeDataPatch/applyDataPatch (pensats per a objectes) hi
      // puguin diferenciar/aplicar un únic patch "replace" de tot el text
      // en cada canvi -- reutilitzant la mateixa canonada JSON-patch en
      // lloc d'un diff de text caràcter a caràcter.
      wrap: (v) => ({ text: v || '' }),
      unwrap: (v) => v?.text || '',
      computePatch: computeDataPatch,
      compactionThreshold: () => store.config.cloudSyncCompactionThreshold,
      mergeMessage: `S'han incorporat canvis a la plantilla del document "${docName}" des de la sincronització al núvol.`,
      compactMessage: `S'ha compactat la sincronització al núvol (plantilla "${docName}").`,
      logEvent: logCloudEvent,
    });
  }

  // Comprova si ja hi ha una base remota per a aquest document abans de
  // decidir si cal sembrar-la (primer cop que ALGÚ sincronitza aquest
  // document concret) o només escoltar-la (ja existia, p. ex. un altre
  // membre ja l'havia creat, o el propi usuari hi torna més tard) --
  // mateix idioma de reconciliació que `bindDocument` (useCollabRealtime.js)
  // ja fa servir per al Y.Text del document.
  // `allowSeed` (Fase 29, reforç): `false` NOMÉS quan es crida des de
  // `joinCloudProject` -- un dispositiu que s'uneix a un projecte no té mai
  // autoritat per crear/sembrar el canal d'un document que encara no
  // existeix al núvol (seria, per construcció, contingut seu propi no
  // relacionat, p. ex. el "Document Principal" d'un altre projecte seu
  // anterior que coincideix de nom). En aquest cas es queda sense vincular
  // cap canal -- l'usuari el vincularà correctament en commutar a un
  // document que sí existeixi de debò al projecte compartit (vegeu
  // `seedAllDocumentChannels`, que garanteix que tot document ja existent
  // en activar-se la sincronització ja té el seu canal sembrat pel
  // propietari abans que ningú més s'hi pugui unir).
  async function attachTemplateChannel(docName, { allowSeed = true } = {}) {
    const { db, mod } = await getDb();
    const baseRef = mod.doc(db, 'projects', cloudProjectId.value, 'channels', `template:${docName}`);
    const baseSnap = await mod.getDoc(baseRef);
    if (!baseSnap.exists() && !allowSeed) return;
    const channel = makeTemplateChannel(docName);
    templateChannel = channel;
    boundTemplateDocName = docName;
    if (!baseSnap.exists()) {
      await channel.seedInitial();
    }
    await channel.startListening();
  }

  // `async` pel mateix motiu que `stopListening` (Fase 27, vegeu el seu
  // comentari): qui la crida ha d'esperar que la captura pendent (si n'hi
  // havia) s'hagi pujat abans de continuar tocant `cloudProjectId`.
  //
  // `templateChannel = null` es fa ABANS (de manera síncrona, no després
  // d'esperar `stopListening()`) perquè, mentre s'espera, el watcher de
  // `store.templateText` (més avall) pot disparar-se entremig -- si encara
  // veiés `templateChannel` apuntant al canal vell (ja aturat), hi
  // programaria una captura NOVA sobre un canal mort amb `lastMergedState`
  // buidat, que calcularia un pedaç incorrecte i el pujaria al canal vell
  // (p. ex. el d'un document del qual ja s'ha desvinculat) -- confirmat amb
  // un test que reproduïa exactament aquesta carrera en canviar de document
  // dues vegades seguides.
  async function detachTemplateChannel() {
    const channel = templateChannel;
    templateChannel = null;
    boundTemplateDocName = null;
    if (channel) {
      await channel.stopListening();
    }
  }

  // Cridada des d'App.vue exactament als mateixos tres punts on ja es crida
  // `switchRealtimeDocument` (Fase 11.2): canviar de document actiu,
  // crear-ne un de nou, i el fallback a "Document Principal" en
  // esborrar-ne un. No-op si encara no hi ha sincronització connectada --
  // `bindToProject` ja vincula el document que toqui en connectar.
  async function bindCloudTemplateDocument(docName) {
    if (!docName || boundTemplateDocName === docName) return;
    await detachTemplateChannel();
    if (cloudSyncStatus.value !== 'connected') return;
    await attachTemplateChannel(docName);
  }

  // Canal binari `refDoc:<docName>` (Fase 28.3) -- mateix cicle de vida
  // EXACTE que `template:<docName>` de dalt (un sol canal "vinculat" a la
  // vegada, el del document actiu, revinculat en canviar de document), però
  // amb `createCloudBlobChannel` en lloc de `createCloudChannel` perquè un
  // document de referència és un fitxer binari, no text amb pedaços JSON.
  // `refDocAdapter` (NO una factoria per `docName`) ja n'hi ha prou: per
  // construcció, aquest canal només està vinculat MENTRE `docName` és
  // l'actiu -- `getBuffer`/`setFile` sempre operen sobre
  // `store.refDocFile`/`activeDocName.value`, exactament igual que
  // `getLocal: () => store.templateText` del canal de plantilla no necessita
  // tampoc cap paràmetre `docName` propi.
  let refDocChannel = null;
  let boundRefDocDocName = null;

  function makeRefDocChannel(docName) {
    return createCloudBlobChannel({
      channelKey: `refDoc:${docName}`,
      getDb,
      cloudProjectIdRef: cloudProjectId,
      getLocalBuffer: refDocAdapter.getBuffer,
      getLocalFileName: refDocAdapter.getFileName,
      setLocal: refDocAdapter.setFile,
      logEvent: logCloudEvent,
      maxFileSizeBytes: () => (store.config.cloudSyncMaxBinaryFileSizeMB || DEFAULT_MAX_BINARY_FILE_SIZE_MB) * 1024 * 1024,
    });
  }

  // Mateixa comprovació d'existència que `attachTemplateChannel`: si ja hi
  // ha una base remota per a aquest document (algú més ja hi havia sincronitzat
  // la seva referència), només s'escolta; si no, se sembra des del contingut
  // local (no-op dins `seedInitial` si el document no té cap fitxer de
  // referència -- mai es crea cap canal/meta buit).
  // `allowSeed`: mateix criteri que `attachTemplateChannel` -- vegeu el seu
  // comentari.
  async function attachRefDocChannel(docName, { allowSeed = true } = {}) {
    const { db, mod } = await getDb();
    const metaRef = mod.doc(db, 'projects', cloudProjectId.value, 'channels', `refDoc:${docName}`);
    const metaSnap = await mod.getDoc(metaRef);
    if (!metaSnap.exists() && !allowSeed) return;
    const channel = makeRefDocChannel(docName);
    refDocChannel = channel;
    boundRefDocDocName = docName;
    if (!metaSnap.exists()) {
      await channel.seedInitial();
    }
    await channel.startListening();
  }

  function detachRefDocChannel() {
    if (refDocChannel) {
      refDocChannel.stopListening();
      refDocChannel = null;
    }
    boundRefDocDocName = null;
  }

  // Cridada des d'App.vue exactament als mateixos tres punts que
  // `bindCloudTemplateDocument` -- canviar de document actiu, crear-ne un
  // de nou, i el fallback a "Document Principal" en esborrar-ne un.
  async function bindCloudRefDocDocument(docName) {
    if (!docName || boundRefDocDocName === docName) return;
    detachRefDocChannel();
    if (cloudSyncStatus.value !== 'connected') return;
    await attachRefDocChannel(docName);
  }

  // Cridada des d'App.vue (onRefDocLoaded), després que la seva pròpia
  // escriptura local ja hagi passat -- opera sobre el canal que estigui
  // vinculat ARA MATEIX (sempre el del document actiu, per construcció),
  // mateix criteri que el watcher de captura de `templateText` de més
  // avall per al canal dinàmic de plantilla.
  async function captureRefDocIfChanged() {
    if (cloudSyncStatus.value !== 'connected' || !refDocChannel) return;
    await refDocChannel.captureIfChanged();
  }

  function accessDocRef(db, mod) {
    return mod.doc(db, 'projects', cloudProjectId.value, '_access', 'doc');
  }

  // Fase 30: índex invers `userProjects/{correu}/projects/{id}` -- permet
  // a CADA membre (no només el propietari) saber, pel seu nom real, a
  // quins projectes al núvol té accés ABANS fins i tot d'unir-s'hi mai
  // (`listMyCloudProjects()`). Escrit per `activateCloudSync` (el
  // propietari, per a ell mateix) i per `addProjectMember`/
  // `removeProjectMember` (el propietari, per a l'ALTRE membre que
  // afegeix/treu -- autoritzat per la regla de seguretat perquè qui ho
  // crida ja és `isMember(projectId)` d'aquest mateix projecte).
  async function writeUserProjectIndexEntry(memberEmail, projectId, projectName, ownerEmail) {
    const { db, mod } = await getDb();
    await mod.setDoc(mod.doc(db, 'userProjects', memberEmail, 'projects', projectId), {
      projectName,
      ownerEmail,
    });
  }

  async function removeUserProjectIndexEntry(memberEmail, projectId) {
    const { db, mod } = await getDb();
    await mod.deleteDoc(mod.doc(db, 'userProjects', memberEmail, 'projects', projectId));
  }

  // Exposada des del composable -- llegeix NOMÉS l'espai de noms del propi
  // usuari (`userProjects/{el-seu-correu}/projects`), mai el d'un altre
  // (les regles de seguretat ho impedirien de totes maneres). Cridada des
  // de `CollabPanel.vue` per mostrar la llista "Projectes als quals tens
  // accés" (Fase 31).
  async function listMyCloudProjects() {
    if (!cloudAuth.currentUser.value) return [];
    const email = normalizeEmail(cloudAuth.currentUser.value.email);
    const { db, mod } = await getDb();
    const snap = await mod.getDocs(mod.collection(db, 'userProjects', email, 'projects'));
    const out = [];
    snap.forEach((d) => out.push({ projectId: d.ref.path.split('/').pop(), ...d.data() }));
    return out;
  }

  async function startAccessListener() {
    const { db, mod } = await getDb();
    unsubAccess = mod.onSnapshot(accessDocRef(db, mod), (snap) => {
      projectAccess.value = snap.exists() ? snap.data() : null;
    }, (err) => logCloudEvent(`Error en llegir l'accés al projecte del núvol: ${err.message}`, 'error'));
  }

  function stopAccessListener() {
    if (unsubAccess) { unsubAccess(); unsubAccess = null; }
    projectAccess.value = null;
  }

  function isCurrentUserOwner() {
    const email = normalizeEmail(cloudAuth.currentUser.value?.email);
    return !!email && !!projectAccess.value && normalizeEmail(projectAccess.value.ownerEmail) === email;
  }

  // Fase 29: abans de vincular-se a CAP projecte (sigui activar-ne un de
  // propi o unir-se al d'una altra persona), cal assegurar-se que no hi
  // quedi res d'una vinculació ANTERIOR encara actiu. Sense això, un
  // dispositiu que ja tingués la seva pròpia sincronització connectada i
  // que tot seguit s'unís a un ALTRE projecte deixava els listeners VELLS
  // penjats (mai es cridava el seu `unsub...()`, només es reassignaven
  // les variables), encara reaccionant al projecte ANTERIOR i competint
  // amb els nous sobre el MATEIX estat intern compartit de cada canal
  // (`baseline`/`deltaDocs`/`lastMergedState`) -- depenent de l'ordre
  // d'arribada dels `onSnapshot`, el contingut final podia "revertir"
  // silenciosament al del projecte anterior. Bug confirmat en ús real
  // (vegeu el pla, Fase 29) -- `teardownChannels()` és la mateixa
  // seqüència que `deactivateCloudSync()` ja fa servir, sense tocar
  // `localStorage` (oblidar la credencial és sempre decisió d'una capa
  // per sobre).
  async function teardownChannels() {
    await Promise.all([...channels, ...blobChannels].map((c) => c.stopListening()));
    await detachTemplateChannel();
    detachRefDocChannel();
    stopAccessListener();
    cloudProjectId.value = null;
  }

  // Fase 29: `bindToProject`/`deactivateCloudSync`/el watcher de tancament
  // de sessió poden ser cridats des de MÉS D'UN camí alhora sense que
  // l'usuari hagi fet doble clic en res -- p. ex. signar-se just en obrir
  // el panell de col·laboració dispara TANT el watcher de
  // `cloudCurrentUser` (que intenta una reconnexió transparent, Fase 27,
  // si aquest projecte local ja tenia un `cloudProjectId` desat d'una
  // sessió de proves anterior) COM, gairebé a l'instant, un clic manual a
  // "Uneix-te" a un projecte DIFERENT. Com que `cloudProjectId` és un únic
  // ref COMPARTIT per tots els canals (llegit a `channelRefs()` en cada
  // operació, no capturat un sol cop), dues d'aquestes operacions EN CURS
  // alhora es trepitgen l'una a l'altra -- `teardownChannels()` per si sol
  // no basta si totes dues criden abans que l'altra hagi acabat. Aquesta
  // cua serialitza TOTES les operacions que toquen la vinculació al
  // núvol -- mai se'n solapen dues, siguin quin sigui el seu origen.
  let cloudOpQueue = Promise.resolve();
  function enqueueCloudOp(fn) {
    const run = cloudOpQueue.then(fn);
    // Encadenat perquè la PRÒXIMA operació esperi aquesta, tant si acaba bé
    // com si falla -- un error en una no ha de bloquejar-ne cap de
    // posterior.
    cloudOpQueue = run.catch(() => {});
    return run;
  }

  function bindToProject(projectName, id, opts = { seed: false, docName: null }) {
    return enqueueCloudOp(() => bindToProjectNow(projectName, id, opts));
  }

  async function bindToProjectNow(projectName, id, { seed, docName } = { seed: false, docName: null }) {
    await teardownChannels();
    cloudSyncStatus.value = 'connecting';
    cloudProjectId.value = id;
    isApplyingInitialSync.value = true;
    try {
      if (seed) {
        await Promise.all([...channels, ...blobChannels].map((c) => c.seedInitial()));
      }
      await startAccessListener();
      await Promise.all([...channels, ...blobChannels].map((c) => c.startListening()));
      if (docName) {
        // `allowSeed: seed` (Fase 29, reforç) -- vegeu el comentari
        // d'`attachTemplateChannel`: en unir-se (`seed === false`) mai es
        // sembra el canal d'un document que encara no existeix al núvol.
        await attachTemplateChannel(docName, { allowSeed: seed });
        await attachRefDocChannel(docName, { allowSeed: seed });
      }
      // Fase 32: espera que CADA canal (fix + de blob + el de
      // document/referència dinàmics, si s'han arribat a vincular) hagi
      // rebut com a mínim la seva primera instantània remota abans de
      // donar la vinculació per completada -- així `cloudSyncStatus`
      // nomÉs arriba a 'connected' quan el contingut ja hi és de debò, no
      // abans (evita el "no se m'informa del progrés" -- la UI ja sap,
      // via `isApplyingInitialSync`, que encara s'està esperant).
      const firstSnapshotWaits = [...channels, ...blobChannels].map((c) => c.getFirstSnapshotPromise());
      if (templateChannel) firstSnapshotWaits.push(templateChannel.getFirstSnapshotPromise());
      if (refDocChannel) firstSnapshotWaits.push(refDocChannel.getFirstSnapshotPromise());
      await Promise.all(firstSnapshotWaits);
      localStorage.setItem(`${projectName}:cloudProjectId`, id);
      cloudSyncStatus.value = 'connected';
    } catch (e) {
      cloudProjectId.value = null;
      cloudSyncStatus.value = 'error';
      lastCloudSyncError.value = e.message;
      throw e;
    } finally {
      isApplyingInitialSync.value = false;
    }
  }

  // Fase 29 (reforç): sembra el canal template/refDoc de TOTS els
  // documents del projecte EXCEPTE `skipDocName` (ja sembrat/vinculat per
  // `attachTemplateChannel`/`attachRefDocChannel` dins `bindToProjectNow`)
  // -- cridada NOMÉS en activar la sincronització per primer cop (mai en
  // reconnectar a un projecte ja existent ni en unir-s'hi), perquè cap
  // altre membre que s'hi uneixi més tard pugui arribar a ser qui sembra
  // per primer cop el canal d'un document que ja existia en aquest
  // projecte -- vegeu el comentari d'`attachTemplateChannel`. Escriptura
  // directa (no instancia els canals complets ni els deixa escoltant --
  // només calia UN cop, el document no és l'actiu i per tant no necessita
  // cap vinculació en viu ara mateix).
  async function seedAllDocumentChannels(skipDocName) {
    const docNames = documentsListAdapter.getLocal() || [];
    const { db, mod } = await getDb();
    for (const dName of docNames) {
      if (dName === skipDocName) continue;
      const tplRef = mod.doc(db, 'projects', cloudProjectId.value, 'channels', `template:${dName}`);
      const tplSnap = await mod.getDoc(tplRef);
      if (!tplSnap.exists()) {
        const text = multiDocAdapter.getTemplateText(dName);
        await mod.setDoc(tplRef, { snapshot: { text: text || '' }, updatedAt: new Date().toISOString(), updatedBy: getOrCreateUserId() });
      }
      const refDocMetaRef = mod.doc(db, 'projects', cloudProjectId.value, 'channels', `refDoc:${dName}`);
      const refDocSnap = await mod.getDoc(refDocMetaRef);
      if (!refDocSnap.exists()) {
        const buffer = await multiDocAdapter.getRefDocBuffer(dName);
        if (buffer) {
          const fileName = multiDocAdapter.getRefDocFileName(dName);
          const tmpChannel = createCloudBlobChannel({
            channelKey: `refDoc:${dName}`,
            getDb,
            cloudProjectIdRef: cloudProjectId,
            getLocalBuffer: async () => buffer,
            getLocalFileName: () => fileName,
            setLocal: async () => {},
            logEvent: logCloudEvent,
            maxFileSizeBytes: () => (store.config.cloudSyncMaxBinaryFileSizeMB || DEFAULT_MAX_BINARY_FILE_SIZE_MB) * 1024 * 1024,
          });
          await tmpChannel.seedInitial();
        }
      }
    }
  }

  // Fase 34 (veure pla, "Fases 34-37"): primitiva D'UN SOL COP (sense
  // `onSnapshot`, sense vincular res en viu) per crear un projecte al núvol
  // SENCER a partir d'una instantània arbitrària -- a diferència
  // d'`activateCloudSync`/`bindToProject` (acoblats a `store.*`, pensats
  // per al projecte ACTIU), aquí `snapshot` pot venir de QUALSEVOL projecte
  // local, actiu o no (vegeu `readLocalProjectSnapshot`,
  // `src/utils/projectSnapshot.js`). Mateix patró que `seedAllDocumentChannels`
  // (instàncies llençadores dels canals, només `seedInitial()`, mai
  // `startListening()` -- no cal, ningú edita aquest projecte ara mateix).
  // `projectName` és un paràmetre PROPI (no el nom del projecte local) --
  // en una còpia de seguretat ordinària coincideixen, però en resoldre un
  // conflicte amb l'opció "crea'n un de nou amb un altre nom" (Fase 36) no
  // cal canviar el nom LOCAL, només el que es desa a `_access/doc`.
  async function seedCloudProjectFromSnapshot(projectId, projectName, snapshot) {
    const email = normalizeEmail(cloudAuth.currentUser.value.email);
    const { db, mod } = await getDb();
    await mod.setDoc(mod.doc(db, 'projects', projectId, '_access', 'doc'), {
      ownerEmail: email,
      memberEmails: [email],
      projectName,
    });
    await writeUserProjectIndexEntry(email, projectId, projectName, email);

    const projectIdRef = ref(projectId);
    const maxFileSizeBytes = () => (store.config.cloudSyncMaxBinaryFileSizeMB || DEFAULT_MAX_BINARY_FILE_SIZE_MB) * 1024 * 1024;
    const jsonChannelSpecs = [
      { channelKey: 'data', getLocal: () => snapshot.excelJsonData, computePatch: computeDataPatch },
      { channelKey: 'schema', getLocal: () => snapshot.editorMetadata, computePatch: computeMetaPatch },
      { channelKey: 'sheetInfo', getLocal: () => snapshot.sheetInfo, computePatch: computeMetaPatch },
      { channelKey: 'hierarchySchema', getLocal: () => snapshot.hierarchySchema, computePatch: computeDataPatch },
      { channelKey: 'documentsList', getLocal: () => snapshot.documentsList, computePatch: computeMetaPatch },
    ];
    await Promise.all(jsonChannelSpecs.map((spec) => createCloudChannel({
      ...spec,
      getDb,
      cloudProjectIdRef: projectIdRef,
      setLocal: () => {},
      logEvent: logCloudEvent,
    }).seedInitial()));

    if (snapshot.excelFileBuffer) {
      await createCloudBlobChannel({
        channelKey: 'excelFile',
        getDb,
        cloudProjectIdRef: projectIdRef,
        getLocalBuffer: async () => snapshot.excelFileBuffer,
        getLocalFileName: () => snapshot.excelFileName,
        setLocal: async () => {},
        logEvent: logCloudEvent,
        maxFileSizeBytes,
      }).seedInitial();
    }

    for (const docName of (snapshot.documentsList || [])) {
      const docData = (snapshot.docs && snapshot.docs[docName]) || null;
      if (!docData) continue;
      await createCloudChannel({
        channelKey: `template:${docName}`,
        getDb,
        cloudProjectIdRef: projectIdRef,
        getLocal: () => docData.templateText || '',
        setLocal: () => {},
        wrap: (v) => ({ text: v || '' }),
        unwrap: (v) => v?.text || '',
        computePatch: computeDataPatch,
        logEvent: logCloudEvent,
      }).seedInitial();
      if (docData.refDocBuffer) {
        await createCloudBlobChannel({
          channelKey: `refDoc:${docName}`,
          getDb,
          cloudProjectIdRef: projectIdRef,
          getLocalBuffer: async () => docData.refDocBuffer,
          getLocalFileName: () => docData.refDocFileName,
          setLocal: async () => {},
          logEvent: logCloudEvent,
          maxFileSizeBytes,
        }).seedInitial();
      }
    }
    return projectId;
  }

  // Fase 34: la inversa de lectura -- reconstrueix l'estat MERGED actual
  // (base + deltes, mateixa fórmula que `recomputeAndApply`) de TOTS els
  // canals d'un projecte al núvol, D'UN SOL COP (sense `onSnapshot`), per a
  // un projecte que no s'escolta en viu. Qui ho crida ha de ser membre
  // d'aquest projecte -- igual que a la resta de l'arxiu, una manca
  // d'accés es tradueix en `permission-denied` (mai capturat aquí).
  async function fetchCloudProjectSnapshotOnce(projectId) {
    const { db, mod } = await getDb();
    async function readJsonChannel(channelKey, unwrap = (v) => v) {
      const baseSnap = await mod.getDoc(mod.doc(db, 'projects', projectId, 'channels', channelKey));
      if (!baseSnap.exists()) return null;
      const deltasSnap = await mod.getDocs(mod.collection(db, 'projects', projectId, 'channels', channelKey, 'deltas'));
      const deltaDocs = [];
      deltasSnap.forEach((d) => deltaDocs.push(d.data()));
      return unwrap(mergeChannelFromDocs(baseSnap.data().snapshot, deltaDocs));
    }
    async function readBlobChannel(channelKey) {
      const metaSnap = await mod.getDoc(mod.doc(db, 'projects', projectId, 'channels', channelKey));
      if (!metaSnap.exists()) return null;
      const meta = metaSnap.data();
      const chunksSnap = await mod.getDocs(mod.collection(db, 'projects', projectId, 'channels', channelKey, 'chunks'));
      const ordered = new Array(meta.totalChunks);
      chunksSnap.forEach((d) => {
        const idx = parseInt(d.ref.path.split('/').pop(), 10);
        if (!Number.isNaN(idx) && idx < meta.totalChunks) ordered[idx] = d.data().data.toUint8Array();
      });
      if (ordered.some((c) => !c)) return null; // incomplet -- tractat com absent en aquesta lectura d'un sol cop
      const bytes = concatChunks(ordered);
      const hash = await sha256Hex(bytes);
      if (hash !== meta.sha256Hex) return null; // integritat incorrecta -- mateix criteri que fetchAndApply
      return { buffer: bytes.buffer, fileName: meta.fileName };
    }

    const [excelJsonData, editorMetadata, sheetInfo, hierarchySchema, documentsList] = await Promise.all([
      readJsonChannel('data'),
      readJsonChannel('schema'),
      readJsonChannel('sheetInfo'),
      readJsonChannel('hierarchySchema'),
      readJsonChannel('documentsList'),
    ]);
    const excelFile = await readBlobChannel('excelFile');
    const docs = {};
    for (const docName of (documentsList || [])) {
      const templateText = await readJsonChannel(`template:${docName}`, (v) => v?.text || '');
      const refDoc = await readBlobChannel(`refDoc:${docName}`);
      docs[docName] = {
        templateText: templateText || '',
        refDocBuffer: refDoc ? refDoc.buffer : null,
        refDocFileName: refDoc ? refDoc.fileName : '',
      };
    }
    return {
      excelJsonData,
      editorMetadata: editorMetadata || [],
      sheetInfo: sheetInfo || [],
      hierarchySchema: hierarchySchema || {},
      documentsList: documentsList || [],
      excelFileBuffer: excelFile ? excelFile.buffer : null,
      excelFileName: excelFile ? excelFile.fileName : '',
      docs,
    };
  }

  // Fase 30, reforç: un projecte vinculat ABANS que aquesta fase existís té
  // un `_access/doc` sense `projectName` i cap entrada pròpia a
  // `userProjects/` -- totes dues només s'escrivien en CREAR el projecte
  // (branca nova, més avall), mai en RECONNECTAR-s'hi (branca `existing`,
  // l'únic camí que seguirà sempre un projecte ja vinculat d'una sessió
  // anterior) -- sense això, el projecte reconnecta i sincronitza
  // perfectament, però queda invisible per sempre a "Projectes als quals
  // tens accés", fins i tot per al seu propi propietari. Es repara aquí,
  // de manera "best-effort" i idempotent, cada vegada que es reconnecta --
  // sense cap migració separada. Només el propietari pot escriure
  // `_access/doc` (regla de seguretat), així que la manca de `projectName`
  // només es corregeix quan és ELL qui reconnecta; qualsevol membre
  // (propietari o no) sempre pot refer la SEVA PRÒPIA entrada a
  // `userProjects/`.
  async function backfillUserProjectIndex(projectId, email, localProjectName) {
    try {
      const { db, mod } = await getDb();
      const accessSnap = await mod.getDoc(mod.doc(db, 'projects', projectId, '_access', 'doc'));
      if (!accessSnap.exists()) return;
      const data = accessSnap.data();
      const canonicalName = data.projectName || localProjectName;
      if (!data.projectName && data.ownerEmail === email) {
        await mod.updateDoc(mod.doc(db, 'projects', projectId, '_access', 'doc'), { projectName: canonicalName });
      }
      await writeUserProjectIndexEntry(email, projectId, canonicalName, data.ownerEmail);
    } catch (e) {
      // Best-effort -- mai bloqueja la reconnexió normal si falla (p. ex.
      // una regla de seguretat vella encara no actualitzada en algun entorn).
    }
  }

  async function activateCloudSync(projectName, docName) {
    if (!cloudAuth.currentUser.value) {
      throw new Error('Cal iniciar sessió al núvol abans d\'activar la sincronització.');
    }
    const email = normalizeEmail(cloudAuth.currentUser.value.email);
    const existing = localStorage.getItem(`${projectName}:cloudProjectId`);
    if (existing) {
      await bindToProject(projectName, existing, { seed: false, docName });
      await backfillUserProjectIndex(existing, email, projectName);
      return existing;
    }
    const id = crypto.randomUUID();
    const { db, mod } = await getDb();
    // Fase 30: `projectName` -- el nom LOCAL del projecte en aquest
    // instant -- queda desat al propi document d'accés com a nom CANÒNIC i
    // permanent d'aquest projecte al núvol, independent de com cada membre
    // anomeni la seva pròpia còpia local més endavant (necessari perquè
    // `listMyCloudProjects()` pugui mostrar-lo pel seu nom real).
    await mod.setDoc(mod.doc(db, 'projects', id, '_access', 'doc'), {
      ownerEmail: email,
      memberEmails: [email],
      projectName,
    });
    await writeUserProjectIndexEntry(email, id, projectName, email);
    // `cloudProjectId.value` no cal fixar-lo aquí -- `bindToProject` ja ho
    // fa com el seu propi primer pas (després de `teardownChannels()`,
    // Fase 29); fixar-lo abans només seria sobreescrit de seguida.
    await bindToProject(projectName, id, { seed: true, docName });
    await seedAllDocumentChannels(docName);
    logCloudEvent("S'ha activat la sincronització al núvol per a aquest projecte.", 'success');
    return id;
  }

  // Fase 31: factoritzada fora de `joinCloudProject` perquè App.vue l'ha de
  // poder cridar ABANS de decidir quin nom donar al projecte LOCAL nou que
  // es crearà (mai se sobreescriu el que ja tinguis obert, vegeu el pla) --
  // cal conèixer el `projectName` REAL del projecte al núvol (Fase 30)
  // abans de triar aquest nom, no després. Mateixa comprovació
  // d'existència/accés que abans, ara reutilitzada per totes dues vies.
  async function getCloudProjectInfo(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId) throw new Error("Cal indicar l'identificador del projecte al núvol.");
    const { db, mod } = await getDb();
    try {
      const snap = await mod.getDoc(mod.doc(db, 'projects', cleanId, '_access', 'doc'));
      if (!snap.exists()) {
        throw new Error('Aquest identificador de projecte al núvol no existeix.');
      }
      return { projectId: cleanId, ...snap.data() };
    } catch (e) {
      if (e.code === 'permission-denied') {
        throw new Error("Encara no tens accés a aquest projecte -- demana al propietari que t'hi afegeixi des de \"Gestiona l'accés\" i torna-ho a provar.");
      }
      throw e;
    }
  }

  async function joinCloudProject(projectName, id, docName) {
    if (!cloudAuth.currentUser.value) {
      throw new Error('Cal iniciar sessió al núvol abans d\'unir-te a un projecte.');
    }
    const info = await getCloudProjectInfo(id);
    await bindToProject(projectName, info.projectId, { seed: false, docName });
    logCloudEvent("T'has unit a un projecte al núvol -- s'està aplicant el seu contingut.", 'success');
  }

  // Fase 27: NO oblida l'identificador desat a `localStorage` -- aquesta
  // funció també és la que crida App.vue en CANVIAR de projecte (abans
  // oblidava la vinculació cada cop, orfanant-la: la pròxima vegada que
  // s'obrís el mateix projecte local, `activateCloudSync` ja no trobaria
  // cap `existing` i en crearia un de NOU, duplicant el projecte al núvol
  // en lloc de reconnectar-se al mateix). Oblidar-lo de debò és una acció
  // explícita i diferent (el botó "Desactiva" de CollabPanel.vue,
  // `handleDeactivateCloudSync` a App.vue) -- mateix criteri que
  // `closeRealtimeForProject()` (canvi de projecte, preserva la credencial)
  // davant `handleStopRealtimeSession()` (desconnexió manual, l'oblida) ja
  // estableix per a la sessió en viu, Fase 15/16.
  function deactivateCloudSync() {
    // Es posa a 'disconnected'/'disabled' IMMEDIATAMENT, SÍNCRONAMENT,
    // abans d'encuar res (Fase 27, mantingut a la Fase 29): els
    // `watchChannelCapture`/el watcher de `templateText` comproven
    // `cloudSyncStatus.value !== 'connected'` abans de programar CAP
    // captura nova -- si això s'ajornés fins que la cua hi arribés, un
    // d'aquests watchers podria disparar-se durant l'espera i programar
    // una captura nova sobre un canal que està a punt d'aturar-se. NO
    // afecta el flush de la captura JA pendent de dins `teardownChannels`
    // (es dispara directament des de `stopListening`, no passa per aquest
    // senyalador). L'aturada real dels canals SÍ s'encua (Fase 29): si
    // hi ha una vinculació en curs, es deixa acabar abans d'aturar-la,
    // mai interromput a mig fer.
    cloudSyncStatus.value = cloudAuth.currentUser.value ? 'disconnected' : 'disabled';
    return enqueueCloudOp(() => teardownChannels());
  }

  async function addProjectMember(email) {
    const clean = normalizeEmail(email);
    if (!clean) return;
    const { db, mod } = await getDb();
    try {
      await mod.updateDoc(accessDocRef(db, mod), { memberEmails: mod.arrayUnion(clean) });
      // Fase 30: escriu l'índex invers del membre ACABAT D'AFEGIR -- és el
      // que li permet veure aquest projecte pel seu nom real a
      // `listMyCloudProjects()` abans fins i tot d'unir-s'hi mai.
      // `projectAccess.value` ja està en viu (startAccessListener) i, a
      // partir d'aquesta mateixa fase, inclou `projectName`.
      await writeUserProjectIndexEntry(clean, cloudProjectId.value, projectAccess.value?.projectName, projectAccess.value?.ownerEmail);
      logCloudEvent(`S'ha afegit ${clean} com a membre d'aquest projecte al núvol.`, 'success');
    } catch (e) {
      logCloudEvent(`Error en afegir ${clean}: ${e.message}`, 'error');
      throw e;
    }
  }

  async function removeProjectMember(email) {
    const clean = normalizeEmail(email);
    if (!clean) return;
    const { db, mod } = await getDb();
    try {
      await mod.updateDoc(accessDocRef(db, mod), { memberEmails: mod.arrayRemove(clean) });
      await removeUserProjectIndexEntry(clean, cloudProjectId.value);
      logCloudEvent(`S'ha tret ${clean} com a membre d'aquest projecte al núvol.`, 'success');
    } catch (e) {
      logCloudEvent(`Error en treure ${clean}: ${e.message}`, 'error');
      throw e;
    }
  }

  // Si es tanca la sessió del núvol mentre hi ha un projecte vinculat, les
  // regles de seguretat deixaran de concedir accés de seguida (ja no hi ha
  // `request.auth`) -- més net aturar-ho explícitament que esperar que
  // cada listener falli pel seu compte. NO toca `localStorage`: un inici
  // de sessió posterior pot tornar a vincular-s'hi manualment (la
  // reconnexió transparent en carregar la pàgina és la Fase 27).
  watch(cloudAuth.currentUser, (user) => {
    if (!user) {
      // Mateix criteri que deactivateCloudSync() -- cloudSyncStatus
      // síncron de seguida, l'aturada real dels canals encuada (Fase 29)
      // -- vegeu els seus comentaris.
      cloudSyncStatus.value = 'disabled';
      enqueueCloudOp(() => teardownChannels());
    } else if (cloudSyncStatus.value === 'disabled') {
      cloudSyncStatus.value = 'disconnected';
    }
  });

  // Watcher de captura local per a cada canal fix -- mateix idioma que
  // startCollabSync() a useCollabSync.js (comprovat des de FORA de
  // captureLocalChange, abans que el debounce dispari, perquè un canvi
  // causat per una fusió remota en curs no quedi mai ni tan sols
  // programat).
  function watchChannelCapture(getter, channel) {
    watch(getter, () => {
      if (cloudSyncStatus.value !== 'connected' || channel.isApplyingRemote.value) return;
      const delaySec = store.config.cloudSyncCaptureDebounceSeconds || 5;
      channel.scheduleCaptureOnChange(delaySec * 1000);
    }, { deep: true });
  }
  watchChannelCapture(() => store.excelJsonData, dataChannel);
  watchChannelCapture(() => store.editorMetadata, schemaChannel);
  watchChannelCapture(() => store.sheetInfo, sheetInfoChannel);
  watchChannelCapture(() => store.hierarchySchema, hierarchySchemaChannel);
  watchChannelCapture(documentsListAdapter.getLocal, documentsListChannel);

  // El canal de plantilla és dinàmic (`templateChannel`, revinculat per
  // `bindCloudTemplateDocument`) -- no es pot fer servir `watchChannelCapture`
  // (que tanca sobre un canal fix) perquè cal llegir la variable `let`
  // MÉS ACTUALITZADA en el moment de l'esdeveniment, no la d'ara mateix.
  watch(() => store.templateText, () => {
    if (cloudSyncStatus.value !== 'connected' || !templateChannel || templateChannel.isApplyingRemote.value) return;
    const delaySec = store.config.cloudSyncCaptureDebounceSeconds || 5;
    templateChannel.scheduleCaptureOnChange(delaySec * 1000);
  });

  return {
    cloudSyncStatus,
    cloudProjectId,
    lastCloudSyncError,
    cloudActivityLog,
    isApplyingInitialSync,
    projectAccess,
    isCurrentUserOwner,
    activateCloudSync,
    getCloudProjectInfo,
    joinCloudProject,
    deactivateCloudSync,
    addProjectMember,
    removeProjectMember,
    listMyCloudProjects,
    seedCloudProjectFromSnapshot,
    fetchCloudProjectSnapshotOnce,
    bindCloudTemplateDocument,
    captureExcelFileIfChanged,
    bindCloudRefDocDocument,
    captureRefDocIfChanged,
  };
}
