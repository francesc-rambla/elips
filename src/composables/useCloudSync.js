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
 * Autorització: cada projecte al núvol té el seu propi document d'accés
 * `projects/{id}/_access/doc` ({ownerEmail, memberEmails}), que les Regles
 * de Seguretat de Firestore comproven per a TOTA la resta del contingut
 * del projecte -- vegeu el pla per al text complet de les regles. Només
 * el propietari pot afegir/treure membres; conèixer l'identificador d'un
 * projecte, per si sol, no dona accés a res.
 */
import { ref, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';
import { computeDataPatch, computeMetaPatch, applyDataPatch } from '../utils/dataPatch.js';
import { getOrCreateUserId, getDisplayNameOrFallback } from './useCollabIdentity.js';
import { getFirebaseApp } from './useCloudAuth.js';

const ACTIVITY_LOG_MAX = 20;
const DEFAULT_COMPACTION_THRESHOLD = 200;

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
    // pollCycle() ja garanteix per a la carpeta compartida.
    const sorted = [...deltaDocs].sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return String(a.userId).localeCompare(String(b.userId));
    });
    let merged = JSON.parse(JSON.stringify(baseline));
    for (const entry of sorted) {
      if (entry.patch && entry.patch.length > 0) {
        merged = applyDataPatch(merged, entry.patch);
      }
    }
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
    maybeCompact(merged, sorted.length);
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
    }, (err) => logEvent(`Error de sincronització al núvol (${channelKey}): ${err.message}`, 'error'));
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

  function stopListening() {
    if (unsubBase) { unsubBase(); unsubBase = null; }
    if (unsubDeltas) { unsubDeltas(); unsubDeltas = null; }
    cancelPendingCapture();
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
  };
}

/**
 * `cloudAuth`: l'objecte retornat per useCloudAuth() -- aquest composable
 * només hi llegeix `currentUser`, mai en gestiona la sessió ell mateix.
 * `getDb`: injectable, per defecte `defaultGetFirestoreModule` (producció,
 * Firestore real diferit); els tests hi passen un Firestore fals en
 * memòria sense tocar res més d'aquesta funció.
 */
export function useCloudSync(cloudAuth, getDb = defaultGetFirestoreModule) {
  const store = useWorkspaceStore();

  // 'disabled' (ningú ha iniciat sessió al núvol) | 'disconnected' (sessió
  // iniciada, cap projecte al núvol vinculat a AQUEST projecte local) |
  // 'connecting' | 'connected' | 'error'.
  const cloudSyncStatus = ref(cloudAuth.currentUser.value ? 'disconnected' : 'disabled');
  const cloudProjectId = ref(null);
  const lastCloudSyncError = ref(null);
  const cloudActivityLog = ref([]);
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
  const channels = [dataChannel, schemaChannel, sheetInfoChannel, hierarchySchemaChannel];

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
  async function attachTemplateChannel(docName) {
    const channel = makeTemplateChannel(docName);
    templateChannel = channel;
    boundTemplateDocName = docName;
    const { db, mod } = await getDb();
    const baseRef = mod.doc(db, 'projects', cloudProjectId.value, 'channels', `template:${docName}`);
    const baseSnap = await mod.getDoc(baseRef);
    if (!baseSnap.exists()) {
      await channel.seedInitial();
    }
    await channel.startListening();
  }

  function detachTemplateChannel() {
    if (templateChannel) {
      templateChannel.stopListening();
      templateChannel = null;
    }
    boundTemplateDocName = null;
  }

  // Cridada des d'App.vue exactament als mateixos tres punts on ja es crida
  // `switchRealtimeDocument` (Fase 11.2): canviar de document actiu,
  // crear-ne un de nou, i el fallback a "Document Principal" en
  // esborrar-ne un. No-op si encara no hi ha sincronització connectada --
  // `bindToProject` ja vincula el document que toqui en connectar.
  async function bindCloudTemplateDocument(docName) {
    if (!docName || boundTemplateDocName === docName) return;
    detachTemplateChannel();
    if (cloudSyncStatus.value !== 'connected') return;
    await attachTemplateChannel(docName);
  }

  function accessDocRef(db, mod) {
    return mod.doc(db, 'projects', cloudProjectId.value, '_access', 'doc');
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

  async function bindToProject(projectName, id, { seed, docName } = { seed: false, docName: null }) {
    cloudSyncStatus.value = 'connecting';
    cloudProjectId.value = id;
    try {
      if (seed) {
        await Promise.all(channels.map((c) => c.seedInitial()));
      }
      await startAccessListener();
      await Promise.all(channels.map((c) => c.startListening()));
      if (docName) {
        await attachTemplateChannel(docName);
      }
      localStorage.setItem(`${projectName}:cloudProjectId`, id);
      cloudSyncStatus.value = 'connected';
    } catch (e) {
      cloudProjectId.value = null;
      cloudSyncStatus.value = 'error';
      lastCloudSyncError.value = e.message;
      throw e;
    }
  }

  async function activateCloudSync(projectName, docName) {
    if (!cloudAuth.currentUser.value) {
      throw new Error('Cal iniciar sessió al núvol abans d\'activar la sincronització.');
    }
    const existing = localStorage.getItem(`${projectName}:cloudProjectId`);
    if (existing) {
      await bindToProject(projectName, existing, { seed: false, docName });
      return existing;
    }
    const email = normalizeEmail(cloudAuth.currentUser.value.email);
    const id = crypto.randomUUID();
    const { db, mod } = await getDb();
    await mod.setDoc(mod.doc(db, 'projects', id, '_access', 'doc'), {
      ownerEmail: email,
      memberEmails: [email],
    });
    cloudProjectId.value = id;
    await bindToProject(projectName, id, { seed: true, docName });
    logCloudEvent("S'ha activat la sincronització al núvol per a aquest projecte.", 'success');
    return id;
  }

  async function joinCloudProject(projectName, id, docName) {
    if (!cloudAuth.currentUser.value) {
      throw new Error('Cal iniciar sessió al núvol abans d\'unir-te a un projecte.');
    }
    const cleanId = String(id || '').trim();
    if (!cleanId) throw new Error("Cal indicar l'identificador del projecte al núvol.");
    const { db, mod } = await getDb();
    try {
      const snap = await mod.getDoc(mod.doc(db, 'projects', cleanId, '_access', 'doc'));
      if (!snap.exists()) {
        throw new Error('Aquest identificador de projecte al núvol no existeix.');
      }
    } catch (e) {
      if (e.code === 'permission-denied') {
        throw new Error("Encara no tens accés a aquest projecte -- demana al propietari que t'hi afegeixi des de \"Gestiona l'accés\" i torna-ho a provar.");
      }
      throw e;
    }
    await bindToProject(projectName, cleanId, { seed: false, docName });
    logCloudEvent("T'has unit a un projecte al núvol -- s'està aplicant el seu contingut.", 'success');
  }

  function deactivateCloudSync(projectName) {
    channels.forEach((c) => c.stopListening());
    detachTemplateChannel();
    stopAccessListener();
    cloudProjectId.value = null;
    cloudSyncStatus.value = cloudAuth.currentUser.value ? 'disconnected' : 'disabled';
    if (projectName) localStorage.removeItem(`${projectName}:cloudProjectId`);
  }

  async function addProjectMember(email) {
    const clean = normalizeEmail(email);
    if (!clean) return;
    const { db, mod } = await getDb();
    try {
      await mod.updateDoc(accessDocRef(db, mod), { memberEmails: mod.arrayUnion(clean) });
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
      channels.forEach((c) => c.stopListening());
      detachTemplateChannel();
      stopAccessListener();
      cloudProjectId.value = null;
      cloudSyncStatus.value = 'disabled';
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
    projectAccess,
    isCurrentUserOwner,
    activateCloudSync,
    joinCloudProject,
    deactivateCloudSync,
    addProjectMember,
    removeProjectMember,
    bindCloudTemplateDocument,
  };
}
