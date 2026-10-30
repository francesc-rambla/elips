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
 * Fase 10 del pla "Alternativa complementària: sessió en viu amb WebRTC +
 * Yjs" -- prova de concepte del canal `template` en temps real de debò
 * (no sondeig), funcionant a qualsevol navegador amb WebRTC, no només
 * Chrome/Edge com la carpeta de col·laboració (useCollabFolder.js/
 * useCollabSync.js). És additiu: pot coexistir amb la carpeta sense
 * coordinar-s'hi, perquè totes dues vies acaben escrivint a
 * store.templateText amb el mateix flag `store.collabApplyingRemoteTemplate`
 * que TemplateEditor.vue ja sap interpretar (preserva l'historial de
 * desfer, mostra l'avís de fusió remota de la Fase 9) -- zero canvis a
 * TemplateEditor.vue calen per a aquest canal nou.
 *
 * A diferència del canal `template` de useCollabSync.js (última-escriptura-
 * guanya sobre tot el text, via `computeDataPatch({text:...})`), aquí es
 * fa servir `Y.Text`, que dona fusió real caràcter a caràcter entre
 * participants connectats alhora.
 *
 * `yjs`/`y-webrtc` es carreguen de manera diferida (import() dinàmic),
 * només en iniciar una sessió, seguint el mateix criteri que
 * useWasmEngines.js aplica a Pyodide: no augmentar el pes del paquet
 * inicial per a qui no usi mai aquesta funcionalitat.
 *
 * El nom de sala és l'únic control d'accés del servidor de senyalització
 * públic (hi viatja en clar) -- ha de ser un identificador aleatori, mai el
 * nom humà del projecte -- i la contrasenya és obligatòria perquè y-webrtc
 * xifri els payloads abans d'enviar-los, de manera que ni el servidor de
 * senyalització els pugui llegir.
 *
 * Fase 11: presència/participants via el protocol d'Awareness de Yjs, ja
 * integrat a `WebrtcProvider` (`provider.awareness`) -- no calen fitxers
 * `collab_presence_*.json` com useCollabSync.js. `currentRoomId`/
 * `currentPassword` queden exposats perquè qui inicia la sessió els pugui
 * mostrar/compartir (CollabPanel.vue), ja que no hi ha cap mecanisme de
 * distribució implícit com triar la mateixa carpeta OneDrive.
 *
 * Fase 11.1: comprovació de sala/projecte en unir-se. Una sala WebRTC no té
 * cap vincle amb un projecte concret -- si algú s'uneix a una sala que
 * pertany a un altre projecte que el que té obert, el pont de la plantilla
 * (attachTemplateBridge) sobreescriuria en silenci `store.templateText` amb
 * el contingut d'aquell altre projecte. Per evitar-ho, qui INICIA una
 * sessió ('start') publica el nom del seu projecte al Y.Map compartit
 * `meta`; qui s'hi UNEIX ('join') espera aquest valor (waitForRemoteProjectName)
 * i el compara (checkProjectMatch) abans d'adjuntar cap pont -- si no
 * coincideix amb el projecte obert localment, es llança un error (mateix
 * camí que qualsevol altre error de connexió) i la sessió es tanca sense
 * haver tocat mai `store.templateText`. Com que `elips` identifica els
 * projectes pel seu nom (no hi ha cap identificador estable addicional,
 * veure createNewProject/importProjectZip a App.vue), es fa servir
 * directament aquest nom com a identitat de projecte.
 *
 * Fase 11.2: un projecte té diversos DOCUMENTS (memòria justificativa, plec
 * de prescripcions...), cadascun amb la seva pròpia `templateText` pròpia
 * (`App.vue`'s `activeDocName`/`loadDocumentConfig`/`switchActiveDocument`
 * -- `store.templateText` és només el del document actiu en cada moment).
 * La primera versió d'aquesta fase lligava la sincronització a "el que
 * estigui obert en cada moment" (un sol `Y.Text` fix per sessió) -- fràgil:
 * canviar de document localment mentre la sessió és oberta faria que el
 * pont barregés contingut de documents diferents. En lloc d'això, el
 * mateix Y.Doc/sala (un per PROJECTE) allotja un `Y.Text` independent per
 * document, anomenat `template:<docName>` (`templateYTextName`) -- el nom
 * del propi Y.Text ja indica de quin document és cada operació ("delta"),
 * sense necessitat de cap camp addicional. `bindDocument(docName)` és qui
 * (re)vincula el pont (`attachTemplateBridge`) al `Y.Text` del document que
 * toqui; `startRealtimeSession` hi crida en connectar, i
 * `switchRealtimeDocument(docName)` (cridat des de `switchActiveDocument` a
 * App.vue) hi torna a cridar cada cop que l'usuari canvia de document
 * SENSE desconnectar la sessió -- mateix `WebrtcProvider`/sala, només
 * canvia a quin `Y.Text` del document es parla. Cada participant pot anar
 * per un document diferent del mateix projecte simultàniament, sense
 * interferir-se: l'Awareness inclou `docName` perquè la llista de
 * participants mostri en quin document és cadascú.
 *
 * Fase 11.3: llista de servidors de senyalització configurable (trobat en
 * ús real: el públic fixat per defecte, wss://y-webrtc-eu.fly.dev, pot
 * respondre 503 -- sense SLA, és un risc ja documentat al pla, no un bug).
 * `store.config.collabSignalingServers` (array `{url, label}`, editable des
 * de SettingsModal.vue, llavor `KNOWN_SIGNALING_SERVERS`) i
 * `store.config.collabPreferredSignalingServer` (URL o buit). En connectar,
 * `findWorkingSignalingServer` sonda cada candidat amb un WebSocket cru
 * (`probeSignalingServer`) ABANS de crear el `WebrtcProvider`: si hi ha un
 * preferit i falla, pregunta (via `confirm()`) abans de provar la resta;
 * sense preferit, les prova totes seguides sense preguntar. El servidor que
 * respon queda exposat a `currentSignalingServer` perquè CollabPanel.vue el
 * mostri al costat de la Sala i la Contrasenya.
 *
 * Fases 12/13: canals `schema` (`editorMetadata`) i `data` (`excelJsonData`)
 * com a mirall de transport -- NO una estructura Yjs niada real (massa
 * invasiu, vegeu el pla). A diferència del canal `template` (Y.Text, fusió
 * caràcter a caràcter), aquí un únic `Y.Map` compartit (`jsonChannels`)
 * només guarda l'última instantània plana coneguda de cada camp, sota les
 * claus `'schema'`/`'data'`. Es reutilitzen tal qual `computeMetaPatch`/
 * `computeDataPatch` (`src/utils/dataPatch.js`, les mateixes que
 * `useCollabSync.js` fa servir per al transport de carpeta) -- però només
 * per DETECTAR si hi ha hagut un canvi real (evita soroll i bucles), no per
 * aplicar-lo: `setLocal` sempre rep la instantània sencera, és a dir, es
 * manté conscientment la fusió última-escriptura-guanya sobre tot el valor
 * (no per camí JSON com als deltes de la carpeta) -- un canvi de transport,
 * no de semàntica. A diferència del canal `template`, aquests dos són
 * d'abast de PROJECTE, no de document: s'adjunten un únic cop en connectar
 * (`startRealtimeSession`), no es revinculen en canviar de document.
 *
 * Com que és el mateix camp de l'store (`store.excelJsonData`/
 * `editorMetadata`) que ja observa `useCollabSync.js` (transport de
 * carpeta), un canvi arribat per WebRTC es repropaga de manera natural cap
 * a la carpeta compartida si totes dues vies estan connectades alhora (i
 * viceversa) -- és el comportament previst, no un efecte advers: cada
 * transport té el seu propi flag `applyingRemote` intern (no compartit),
 * així que cap d'ells confon un canvi aplicat per l'altre amb un bucle
 * infinit propi (verificat explícitament, veure
 * tests/collab_realtime.test.js, "dual transport").
 *
 * Fase 14: sol·licitud i transferència del ZIP sencer del projecte, pel
 * mateix Y.Doc/sala (cap canal nou), per a qui s'uneix sense tenir-ne cap
 * còpia local (`classifyProjectMismatch` retorna `'not-local'`) -- en lloc
 * de tancar la connexió com als altres casos de desajust (Fase 11.1), es
 * queda connectat sense vincular cap canal de document/esquema/dades
 * (`sessionStatus === 'awaiting-project'`) i deixa que
 * `requestAndImportProject()` ho demani a qualsevol altre participant ja
 * connectat amb el projecte correcte (`attachProjectTransferResponder`,
 * adjuntat automàticament per a tothom que es connecta normalment, no
 * només "qui ha iniciat"). El ZIP viatja en trossos de 16 KiB
 * (`chunkBytes`/`PROJECT_TRANSFER_CHUNK_SIZE`), cadascun en la seva pròpia
 * transacció Yjs perquè es tradueixi en un missatge WebRTC separat (y-webrtc
 * no fragmenta els missatges pel seu compte). Un cop importat
 * (`importProjectZip`, el mateix callback que ja fa servir "Carrega des de
 * carpeta"), `requestAndImportProject()` desconnecta netament -- qui l'ha
 * cridada (App.vue) ha de tornar a iniciar la connexió normal amb les
 * dades ja actualitzades del projecte acabat d'importar.
 *
 * Fase 15: reconnexió transparent -- vegeu App.vue (`tryAutoReconnectRealtime`),
 * cap canvi en aquest fitxer més enllà de ser-hi cridat amb `mode: 'start'`
 * (que ja salta tota l'espera/validació de la Fase 11.1).
 *
 * Fase 16: el `Y.Doc` passa de ser efímer (`new Y.Doc()` a cada
 * `startRealtimeSession`, destruït a `teardown()`) a PERSISTENT per
 * projecte (`useCollabDoc.js`, IndexedDB) -- viu mentre el projecte estigui
 * obert en aquesta pestanya, estigui o no connectada cap sessió en viu.
 * Això dona al canal `template` fusió CRDT real també ENTRE desconnexions
 * (no només mentre dos peers són en línia alhora): les edicions fetes
 * sense sessió activa ara es graven igualment com a operacions Y.Text
 * reals, i es sincronitzen soles la propera vegada que hi hagi una
 * connexió -- cap lògica de fusió nova, és el cas d'ús natural de Yjs.
 *
 * Per fer-ho possible, `teardown()` es divideix en dues operacions de
 * granularitat diferent:
 * - `disconnectNetwork()`: només xarxa (`provider`, Awareness, el
 *   responedor de transferència de projecte) -- NO toca `ydoc` ni cap
 *   pont de document (`stopLocalWatch`/`stopSchemaChannel`/`stopDataChannel`).
 *   És la que fa servir `stopRealtimeSession()` (desconnexió manual o
 *   intent de reconnexió fallit, Fase 15): el `Y.Doc` i el pont de
 *   plantilla continuen vius i capturant edicions locals.
 * - `teardownDoc()`/`closeRealtimeForProject()`: tanca TOT, incloent-hi el
 *   `Y.Doc` (amb un darrer flush a IndexedDB abans de destruir-lo, vegeu
 *   `closeProjectDoc`, `useCollabDoc.js`) -- només quan el PROJECTE mateix
 *   canvia o es tanca (cridat des d'App.vue en `loadProject`/
 *   `createNewProject`, substituint l'antiga crida condicional a
 *   `stopRealtimeSession()`: ara cal cridar-ho SEMPRE en canviar de
 *   projecte, no només quan `sessionStatus === 'connected'`, perquè un
 *   `Y.Doc` pot estar capturant en silenci encara que l'estat mostri
 *   `'disconnected'`).
 *
 * `resumeOfflineCapture(projectName, docName)` (nova, exposada) permet
 * capturar edicions de plantilla SENSE cap connexió de xarxa -- cridada
 * des d'App.vue en obrir un projecte (abans que `tryAutoReconnectRealtime`
 * intenti connectar-hi). Comprova primer, sense carregar `yjs`
 * (`hasPersistedProjectDoc`), si aquest projecte ha fet servir la sessió
 * en viu alguna vegada -- si no, és un no-op complet (cap cost per a qui
 * no fa servir aquesta funcionalitat, preservant l'import diferit de `yjs`
 * de la Fase 10).
 *
 * El seguiment de concurrència `if (ydoc !== thisYdoc) return` (detectar
 * que `stopRealtimeSession()` ha corregut durant una espera asíncrona) ja
 * no funciona amb un `ydoc` reutilitzat entre sessions -- se substitueix
 * per un comptador `sessionToken` incrementat a cada `stopRealtimeSession`/
 * `closeRealtimeForProject`, capturat com `myToken` a l'inici de cada
 * operació asíncrona i comprovat (`sessionToken !== myToken`) després de
 * cada `await`.
 */

import { ref, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { getOrCreateUserId, getDisplayNameOrFallback } from './useCollabIdentity';
import { KNOWN_SIGNALING_SERVERS } from '../utils/collabSignalingServers';
import { computeDataPatch, computeMetaPatch } from '../utils/dataPatch';
import { getOrCreateProjectDoc, closeProjectDoc, hasPersistedProjectDoc } from './useCollabDoc';

export { KNOWN_SIGNALING_SERVERS };

/** Genera un identificador de sala i una contrasenya nous, per a qui inicia
 * una sessió en viu i els ha de compartir (fora de banda) amb la resta. */
export function generateSessionCredentials() {
  return {
    roomId: `elips-${crypto.randomUUID()}`,
    password: crypto.randomUUID(),
  };
}

/** Converteix un reemplaçament sencer de cadena (oldStr -> newStr) en el
 * mínim parell esborra/insereix posicional que Y.Text necessita, per
 * aprofitar la fusió caràcter a caràcter en lloc de substituir tot el text
 * a cada edició local (que fora última-escriptura-guanya disfressada). */
export function applyStringDiffToYText(ytext, oldStr, newStr) {
  if (oldStr === newStr) return;
  const maxPrefix = Math.min(oldStr.length, newStr.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldStr[prefix] === newStr[prefix]) prefix++;
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (oldEnd > prefix && newEnd > prefix && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const deleteLen = oldEnd - prefix;
  const insertText = newStr.slice(prefix, newEnd);
  if (deleteLen > 0) ytext.delete(prefix, deleteLen);
  if (insertText.length > 0) ytext.insert(prefix, insertText);
}

/** Normalitza la llista de servidors de senyalització (array de cadenes
 * `ws(s)://...` o d'objectes `{url, label}`, tal com pot venir de
 * `store.config.collabSignalingServers` o d'una crida de prova amb una
 * sola URL) a sempre `{url, label}` -- descarta entrades sense `url`. */
export function normalizeSignalingServers(servers) {
  return (servers || [])
    .map((s) => (typeof s === 'string' ? { url: s, label: s } : s))
    .filter((s) => s && s.url);
}

/** Comprova si un servidor de senyalització respon obrint-hi un WebSocket
 * cru (sense cap lògica de y-webrtc) -- és la mateixa comprovació que
 * trobar un codi 503 al handshake (servidor caigut/adormit) detecta
 * directament, en lloc d'esperar fins que `waitForRemoteProjectName`
 * expiri sense cap pista de la causa real. */
export function probeSignalingServer(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* ja tancat o mai obert */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(url);
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

/** Tria quin servidor de senyalització fer servir d'entre la llista
 * configurada: si hi ha un preferit, el prova primer; si falla, avisa
 * l'usuari (via `confirmFn`, per defecte el `confirm()` natiu del navegador
 * -- mateix idioma que `deleteDocument`/`createNewProject` a App.vue) i
 * només si accepta es proven la resta EN ORDRE (no totes alhora). Sense cap
 * preferit, es proven totes seqüencialment sense preguntar res. Retorna la
 * URL que ha respost, o `null` si cap ho ha fet (o l'usuari ha declinat
 * continuar). `probeFn`/`confirmFn` són injectables perquè es puguin provar
 * sense WebSockets ni diàlegs reals -- veure tests/collab_realtime.test.js. */
export async function findWorkingSignalingServer(servers, preferredUrl, probeFn = probeSignalingServer, confirmFn = (msg) => confirm(msg)) {
  const urls = normalizeSignalingServers(servers).map((s) => s.url);
  if (preferredUrl && urls.includes(preferredUrl)) {
    if (await probeFn(preferredUrl)) return preferredUrl;
    const rest = urls.filter((u) => u !== preferredUrl);
    if (rest.length === 0) return null;
    const keepTrying = confirmFn(`El servidor de senyalització preferit (${preferredUrl}) no respon. Vols provar la resta de servidors configurats?`);
    if (!keepTrying) return null;
    for (const url of rest) {
      if (await probeFn(url)) return url;
    }
    return null;
  }
  for (const url of urls) {
    if (await probeFn(url)) return url;
  }
  return null;
}

/** Nom del `Y.Text` compartit per a un document concret dins del Y.Doc d'una
 * sessió (un Y.Doc per sessió/sala = un projecte; un Y.Text per document
 * del projecte) -- extret com a funció perquè `startRealtimeSession` i
 * `switchRealtimeDocument` hi facin servir sempre el mateix criteri. */
export function templateYTextName(docName) {
  return `template:${docName}`;
}

/** Espera que la contrapart publiqui el nom del projecte al Y.Map `meta`
 * compartit (qui INICIA la sessió ja l'hi escriu abans de connectar el
 * provider, vegeu startRealtimeSession) -- amb un límit de temps, perquè si
 * mai arriba (problema de connexió P2P/ICE, el mateix risc ja documentat al
 * pla per a la sincronització real) no ens quedem esperant indefinidament.
 * Extreta com a funció independent perquè es pugui provar amb un Y.Map en
 * memòria, sense cap WebrtcProvider real. */
export function waitForRemoteProjectName(ymeta, timeoutMs) {
  const existing = ymeta.get('projectName');
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ymeta.unobserve(observer);
      resolve(value || null);
    };
    const observer = () => {
      const name = ymeta.get('projectName');
      if (name) finish(name);
    };
    ymeta.observe(observer);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Classifica si una sessió a la qual algú s'uneix coincideix amb el
 * projecte que té obert localment -- `'match'` (tot correcte), `'no-remote-
 * name'` (mai ha arribat el nom remot), `'saved-not-open'` (el té desat
 * però no és el projecte obert) o `'not-local'` (no en té cap còpia).
 * Extreta com a funció pura independent de `checkProjectMatch` (Fase 14,
 * transferència del ZIP) perquè `startRealtimeSession` pugui reaccionar
 * diferent al cas `'not-local'` -- oferir sol·licitar el projecte en lloc
 * de limitar-se a avisar-ho -- sense que `checkProjectMatch` hagi de
 * deixar de retornar el missatge de text que ja fan servir els tests. */
export function classifyProjectMismatch(remoteProjectName, localProjectName, savedProjectNames) {
  if (!remoteProjectName) return 'no-remote-name';
  if (remoteProjectName === localProjectName) return 'match';
  if ((savedProjectNames || []).includes(remoteProjectName)) return 'saved-not-open';
  return 'not-local';
}

/** Decideix si una sessió a la qual algú s'uneix coincideix amb el projecte
 * que té obert localment, i si no, quin dels tres missatges d'error cal
 * mostrar -- retorna `null` quan tot és correcte. Extreta com a funció pura
 * perquè els quatre casos es puguin provar sense cap Y.Doc/WebrtcProvider.
 * Embolcall prim sobre `classifyProjectMismatch` -- mateix contracte de
 * cadena que abans, cap test existent es toca. */
export function checkProjectMatch(remoteProjectName, localProjectName, savedProjectNames) {
  switch (classifyProjectMismatch(remoteProjectName, localProjectName, savedProjectNames)) {
    case 'match':
      return null;
    case 'no-remote-name':
      return "No s'ha pogut confirmar a quin projecte pertany aquesta sessió (pot ser un problema de connexió). Torna-ho a provar.";
    case 'saved-not-open':
      return `Aquesta sessió és del projecte "${remoteProjectName}", que tens desat però no obert. Obre'l des de "Gestiona Projectes" i torna a connectar-t'hi.`;
    default:
      return `Aquesta sessió és del projecte "${remoteProjectName}", que no tens al teu entorn local. Demana a qui ha iniciat la sessió el fitxer del projecte (collab_project.zip) i importa'l (pestanya Pujar -> "Restableix o Importa Projecte Sencer") abans de connectar-t'hi.`;
  }
}

/** Mida de cada tros binari de la transferència del ZIP del projecte
 * (Fase 14) -- 16 KiB, la mida clàssicament segura per a un sol missatge
 * de qualsevol implementació de canal de dades WebRTC (y-webrtc/simple-peer
 * no fragmenten els missatges pel seu compte, vegeu el pla). */
export const PROJECT_TRANSFER_CHUNK_SIZE = 16384;

/** Parteix un `Uint8Array` en trossos de com a màxim `chunkSize` bytes
 * (còpies independents, no vistes sobre el buffer original) -- cada tros
 * s'envia en la seva pròpia transacció Yjs (`attachProjectTransferResponder`)
 * perquè es tradueixi en un missatge WebRTC separat. */
export function chunkBytes(bytes, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks;
}

/** Inversa de `chunkBytes`: reconstrueix un `Uint8Array` a partir dels
 * trossos rebuts, en l'ordre en què s'ha donat l'array. */
export function concatChunks(chunks) {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Respon automàticament, des de QUALSEVOL participant ja connectat
 * normalment (no només "qui ha iniciat" la sessió), a una sol·licitud del
 * ZIP sencer del projecte (Fase 14) publicada per algú que s'hi ha unit
 * sense tenir-ne cap còpia local. Protocol sobre `transferMap`
 * (`ydoc.getMap('projectTransfer')`) i `chunksArray`
 * (`ydoc.getArray('projectTransferChunks')`):
 *
 * - `request: {requestedBy, requestedAt}` -- publicat per qui el demana
 *   (`requestProjectTransfer`).
 * - `responder: {claimedBy, claimedAt}` -- qui respon el reclama, amb una
 *   petita espera de gràcia abans (mateix idioma que la protecció de
 *   sembra ja usada al canal `template`/`jsonChannels`, per reduir -- no
 *   eliminar del tot -- que dos participants amb el projecte correcte
 *   reclamin la mateixa sol·licitud alhora) i una segona comprovació just
 *   abans de començar a enviar, per si la carrera l'ha perdut mentrestant.
 * - `manifest: {totalChunks, totalBytes, zipFileName}` -- publicat just
 *   abans dels trossos, perquè qui ho demana sàpiga quants n'espera.
 *
 * No cal `localOrigin`: aquesta funció només escriu dins el Y.Doc (mai
 * `store.*` directament), no hi ha cap bucle local-remot a evitar aquí.
 * Retorna una funció per desconnectar (atura l'observer; no toca el Y.Doc).
 */
export function attachProjectTransferResponder(ydoc, transferMap, chunksArray, { myUserId, buildProjectZipBlob, chunkSize = PROJECT_TRANSFER_CHUNK_SIZE, claimDelayMs } = {}) {
  let stopped = false;
  let handledRequestAt = null;

  async function maybeRespond() {
    if (stopped) return;
    const request = transferMap.get('request');
    if (!request || request.requestedBy === myUserId) return;
    if (handledRequestAt === request.requestedAt) return; // ja gestionada (per mi)
    if (transferMap.get('responder')) return; // algú altre ja se n'ocupa

    handledRequestAt = request.requestedAt;
    await new Promise((resolve) => setTimeout(resolve, claimDelayMs ?? (300 + Math.random() * 400)));
    if (stopped) return;
    // Potser algú altre ja ho ha reclamat durant l'espera, o la sol·licitud
    // ha canviat (p. ex. s'ha tornat a demanar de nou).
    if (transferMap.get('responder') || transferMap.get('request')?.requestedAt !== request.requestedAt) return;

    ydoc.transact(() => {
      transferMap.set('responder', { claimedBy: myUserId, claimedAt: Date.now() });
    });

    // Confirmació addicional que la pròpia reclamació ha "guanyat" -- si un
    // altre responedor l'ha reclamat gairebé alhora, Yjs ja haurà resolt
    // quin dels dos guanya pel seu rellotge intern en aquest punt.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (stopped) return;
    const settled = transferMap.get('responder');
    if (!settled || settled.claimedBy !== myUserId) return; // algú altre ha guanyat la carrera

    const blob = await buildProjectZipBlob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = chunkBytes(bytes, chunkSize);

    // Neteja qualsevol tros que un reclamant perdedor pugui haver arribat a
    // enviar abans de perdre la carrera -- redueix (no elimina del tot) el
    // risc de contingut barrejat en una doble reclamació.
    ydoc.transact(() => { chunksArray.delete(0, chunksArray.length); });
    ydoc.transact(() => {
      transferMap.set('manifest', { totalChunks: chunks.length, totalBytes: bytes.length, zipFileName: 'collab_project.zip' });
    });
    for (const chunk of chunks) {
      if (stopped) return;
      ydoc.transact(() => { chunksArray.push([chunk]); });
    }
  }

  const observer = () => { maybeRespond(); };
  transferMap.observe(observer);
  maybeRespond(); // per si la sol·licitud ja hi era en adjuntar-se

  return () => {
    stopped = true;
    transferMap.unobserve(observer);
  };
}

/**
 * Demana el ZIP sencer del projecte a qualsevol altre participant ja
 * connectat (Fase 14) -- publica la sol·licitud, espera el manifest i tots
 * els trossos, i resol amb els bytes reconstruïts. Si el reclamant
 * "guanyador" canvia a mig camí (doble reclamació), reinicia el seguiment
 * contra el nou -- mateix esperit que la resta de proteccions de carrera
 * d'aquesta funcionalitat. `onProgress({receivedChunks, totalChunks})` és
 * opcional, perquè la interfície pugui mostrar una barra de progrés.
 */
export function requestProjectTransfer(ydoc, transferMap, chunksArray, { myUserId, timeoutMs = 60000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let currentClaimant = null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transferMap.unobserve(onTransferMapChange);
      chunksArray.unobserve(onChunksChange);
      fn();
    };

    function checkProgress() {
      const responder = transferMap.get('responder');
      const manifest = transferMap.get('manifest');
      if (responder && responder.claimedBy !== currentClaimant) {
        currentClaimant = responder.claimedBy; // el reclamant ha canviat -- segueix el nou
      }
      if (!manifest) {
        if (onProgress) onProgress({ receivedChunks: 0, totalChunks: 0 });
        return;
      }
      const received = Math.min(chunksArray.length, manifest.totalChunks);
      if (onProgress) onProgress({ receivedChunks: received, totalChunks: manifest.totalChunks });
      if (received >= manifest.totalChunks) {
        const bytes = concatChunks(chunksArray.slice(0, manifest.totalChunks));
        finish(() => resolve({ bytes, zipFileName: manifest.zipFileName }));
      }
    }

    const onTransferMapChange = () => checkProgress();
    const onChunksChange = () => checkProgress();
    transferMap.observe(onTransferMapChange);
    chunksArray.observe(onChunksChange);

    const timer = setTimeout(() => {
      finish(() => reject(new Error("Ningú ha respost a la sol·licitud del projecte a temps. Torna-ho a provar.")));
    }, timeoutMs);

    ydoc.transact(() => {
      chunksArray.delete(0, chunksArray.length);
      transferMap.delete('responder');
      transferMap.delete('manifest');
      transferMap.set('request', { requestedBy: myUserId, requestedAt: Date.now() });
    });

    checkProgress();
  });
}

/** Converteix el mapa d'estats bruts de l'Awareness de Yjs (clientId ->
 * {user: {userId, displayName, docName}}) en la llista de participants que
 * CollabPanel.vue mostra -- extret com a funció pura perquè es pugui
 * provar directament, sense necessitat d'un WebrtcProvider real
 * (`statesMap` pot ser qualsevol `Map`, no cal que vingui de Yjs). `docName`
 * (Fase 11.2) és opcional -- no tots els estats l'han de portar -- i indica
 * en quin document d'aquest projecte és aquell participant ara mateix. */
export function mapAwarenessStatesToPeers(statesMap, selfClientId) {
  const peers = [];
  statesMap.forEach((state, clientId) => {
    const user = state?.user;
    if (!user) return;
    peers.push({
      userId: user.userId || String(clientId),
      displayName: user.displayName || 'Algú',
      isSelf: clientId === selfClientId,
      docName: user.docName,
    });
  });
  return peers;
}

/**
 * Connecta `store.templateText` a un `Y.Text` ja creat: repropaga les
 * edicions locals cap al Y.Text (com a diff posicional, no reemplaçament
 * sencer) i les fusions remotes cap a `store.templateText` (mateix flag
 * `store.collabApplyingRemoteTemplate` que ja interpreta TemplateEditor.vue).
 * Extret com a peça independent del transport (`WebrtcProvider`) perquè es
 * pugui provar amb dos `Y.Doc` en memòria sincronitzats directament via
 * `Y.applyUpdate`, sense xarxa real -- veure tests/collab_realtime.test.js.
 *
 * Retorna una funció per desconnectar (atura el watcher; no toca el Y.Doc).
 */
export function attachTemplateBridge(ydoc, ytext, store, localOrigin) {
  const observer = (event) => {
    if (event.transaction.origin === localOrigin) return; // eco de la pròpia escriptura
    const merged = ytext.toString();
    if (merged === store.templateText) return;
    store.collabApplyingRemoteTemplate = true;
    store.templateText = merged;
    nextTick(() => {
      store.collabApplyingRemoteTemplate = false;
    });
  };
  ytext.observe(observer);

  const stopWatch = watch(() => store.templateText, (newVal) => {
    if (store.collabApplyingRemoteTemplate) return; // és el nostre propi merge remot acabat d'aplicar
    const current = ytext.toString();
    if (current === (newVal || '')) return;
    ydoc.transact(() => {
      applyStringDiffToYText(ytext, current, newVal || '');
    }, localOrigin);
  });

  return () => {
    ytext.unobserve(observer);
    stopWatch();
  };
}

/**
 * Pont de transport per a un canal d'"instantània JSON completa" (Fases
 * 12/13: `schema`/`editorMetadata` o `data`/`excelJsonData`) -- a diferència
 * d'attachTemplateBridge (Y.Text, fusió caràcter a caràcter), aquí `ymap`
 * només guarda l'última instantània plana coneguda sota `key`. Reutilitza
 * `computePatch` (`computeMetaPatch`/`computeDataPatch`) NOMÉS per detectar
 * si hi ha hagut un canvi real -- `setLocal` sempre rep la instantània
 * sencera, és última-escriptura-guanya sobre tot el valor, no una fusió per
 * camí JSON. `localOrigin` distingeix els propis canvis (eco), mateix criteri
 * que attachTemplateBridge.
 *
 * Com que la sembra inicial és un reemplaçament de valor sencer (no una
 * inserció posicional com a Y.Text), dos participants connectant-se gairebé
 * alhora NO poden duplicar contingut (al contrari que el canal `template`):
 * com a molt, un dels dos valors "guanya" segons el rellotge intern de Yjs
 * -- per això no cal cap espera de gràcia aleatòria aquí, n'hi ha prou de
 * comprovar l'estat ja present en adjuntar-se.
 *
 * Asíncrona perquè la reconciliació inicial (si el valor remot ja hi era en
 * adjuntar-se) pot necessitar un `nextTick()` abans de considerar el canal
 * llest -- mateix idioma que bindDocument() per al canal `template`.
 * Retorna una funció per desconnectar (atura l'observer i el watcher local;
 * no toca el Y.Doc).
 */
export async function attachJsonChannelBridge(ydoc, ymap, key, { getLocal, setLocal, computePatch }, localOrigin, debounceMs = 1500) {
  const remoteVal = ymap.get(key);
  if (remoteVal === undefined) {
    const localVal = getLocal();
    if (localVal !== null && localVal !== undefined) {
      ydoc.transact(() => {
        if (ymap.get(key) === undefined) ymap.set(key, JSON.parse(JSON.stringify(localVal)));
      }, localOrigin);
    }
  } else if (computePatch(getLocal(), remoteVal)) {
    setLocal(remoteVal);
    await nextTick();
  }

  let applyingRemote = false;
  let debounceTimer = null;

  const observer = (event) => {
    if (event.transaction.origin === localOrigin) return; // eco de la pròpia escriptura
    const incoming = ymap.get(key);
    if (incoming === undefined) return;
    if (!computePatch(getLocal(), incoming)) return;
    applyingRemote = true;
    setLocal(incoming);
    nextTick(() => {
      applyingRemote = false;
    });
  };
  ymap.observe(observer);

  const captureLocalChange = () => {
    if (applyingRemote) return; // és el nostre propi merge remot acabat d'aplicar
    const current = ymap.get(key);
    const newVal = getLocal();
    if (!computePatch(current, newVal)) return;
    ydoc.transact(() => {
      ymap.set(key, JSON.parse(JSON.stringify(newVal)));
    }, localOrigin);
  };

  const stopWatch = watch(getLocal, () => {
    if (applyingRemote) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(captureLocalChange, debounceMs);
  }, { deep: true });

  return () => {
    clearTimeout(debounceTimer);
    ymap.unobserve(observer);
    stopWatch();
  };
}

/**
 * `buildProjectZipBlob`/`importProjectZip` (Fase 14): callbacks injectats
 * des d'App.vue -- mateix patró que `useCollabSync(collabFolder, () =>
 * buildProjectZipBlob())` ja fa servir. Permeten respondre a una
 * sol·licitud del ZIP del projecte (`attachProjectTransferResponder`) i
 * importar-lo un cop rebut (`requestAndImportProject`) sense que aquest
 * fitxer hagi de conèixer App.vue. Opcionals perquè cap altre ús
 * d'aquesta funció (p. ex. tests existents que la criden sense arguments)
 * es trenqui -- si no es passen, aquesta funcionalitat concreta
 * simplement no està disponible (no respon a sol·licituds, i sol·licitar
 * llança un error clar).
 */
export function useCollabRealtime(buildProjectZipBlob, importProjectZip) {
  const store = useWorkspaceStore();

  const sessionStatus = ref('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'awaiting-project' | 'receiving-project' | 'error'
  const lastRealtimeError = ref(null);
  // Nom del projecte de la sessió a la qual algú s'ha unit sense tenir-ne
  // cap còpia local (Fase 14) -- només té sentit mentre `sessionStatus ===
  // 'awaiting-project'`. CollabPanel.vue el mostra al botó de sol·licitud.
  const pendingProjectName = ref('');
  // Progrés de la recepció del ZIP del projecte (Fase 14) -- `null` quan no
  // n'hi ha cap en curs, `{receivedChunks, totalChunks}` mentre
  // `sessionStatus === 'receiving-project'`.
  const transferProgress = ref(null);
  // La sala/contrasenya ACTUALS (no les que algú podria passar a
  // startRealtimeSession() la propera vegada) -- CollabPanel.vue les mostra
  // perquè qui ha iniciat la sessió les pugui compartir fora de banda amb
  // la resta, ja que (a diferència de triar la mateixa carpeta OneDrive) no
  // hi ha cap mecanisme de distribució implícit.
  const currentRoomId = ref('');
  const currentPassword = ref('');
  // Llista de participants connectats, derivada del protocol d'Awareness de
  // Yjs (integrat a WebrtcProvider -- no cal cap fitxer de presència com
  // useCollabSync.js). Mateixa forma que useCollabSync.js's connectedPeers
  // perquè CollabPanel.vue en pugui reutilitzar el mateix bloc de marcatge.
  const connectedPeers = ref([]);
  // Document (d'aquest mateix projecte) al qual està vinculat el pont de
  // plantilla ara mateix -- vegeu bindDocument() més avall (Fase 11.2).
  const currentDocName = ref('');
  // Servidor de senyalització que ha respost i s'està fent servir ara
  // mateix (Fase 11.3) -- CollabPanel.vue el mostra al costat de la Sala i
  // la Contrasenya, perquè qui ha iniciat/s'ha unit a la sessió sàpiga
  // exactament per on hi passa (útil si cal diagnosticar-ho més endavant).
  const currentSignalingServer = ref('');

  let ydoc = null;
  let ytext = null;
  let provider = null;
  let stopLocalWatch = null;
  let stopSchemaChannel = null;
  let stopDataChannel = null;
  let stopProjectTransferResponder = null;
  let awarenessChangeHandler = null;
  let boundDocName = null;
  // Nom del projecte al qual pertany el `ydoc` actualment carregat (Fase
  // 16) -- `null` si no n'hi ha cap. Permet detectar, de manera defensiva,
  // si algú ha intentat connectar/capturar per a un projecte diferent del
  // que ja té el doc carregat sense haver-lo tancat abans.
  let currentProjectNameForDoc = null;
  // Incrementat a cada stopRealtimeSession()/closeRealtimeForProject()
  // (Fase 16) -- substitueix el vell seguiment `ydoc !== thisYdoc` (ja no
  // funciona amb un ydoc reutilitzat entre sessions): cada operació
  // asíncrona en captura el valor com `myToken` a l'inici i comprova
  // `sessionToken !== myToken` després de cada `await` per detectar que
  // una desconnexió/tancament ha corregut mentrestant.
  let sessionToken = 0;
  // Marca les transaccions pròpies perquè l'observer de ytext les pugui
  // distingir de canvis arribats d'altres participants (mateix propòsit que
  // la bandera isApplyingRemote del motor de useCollabSync.js, però aquí
  // expressada com a origen de transacció Yjs en lloc d'una bandera externa).
  const localOrigin = Symbol('elips-collab-realtime-local');

  function updatePeerListFromAwareness() {
    if (!provider) return;
    connectedPeers.value = mapAwarenessStatesToPeers(provider.awareness.getStates(), provider.awareness.clientID);
  }

  function publishAwarenessUser() {
    if (!provider) return;
    provider.awareness.setLocalStateField('user', {
      userId: getOrCreateUserId(),
      displayName: getDisplayNameOrFallback(),
      docName: currentDocName.value,
    });
  }

  // (Re)vincula el pont de plantilla (attachTemplateBridge) al Y.Text propi
  // del document `docName` dins el Y.Doc/sala actual -- cridada tant en
  // connectar (per al document actiu d'aquell moment) com cada cop que
  // l'usuari canvia de document localment sense desconnectar la sessió
  // (switchRealtimeDocument), com des de resumeOfflineCapture() (Fase 16,
  // sense cap connexió de xarxa). Assumeix que qui crida ja ha carregat el
  // contingut de `docName` a store.templateText abans de cridar-la (mateix
  // ordre que App.vue's switchActiveDocument ja segueix amb
  // loadDocumentConfig). Idempotent: si ja estava vinculat a aquest mateix
  // document (p. ex. resumeOfflineCapture ja ho havia fet abans que
  // startRealtimeSession s'hi reconnectés), no fa res -- evita desmuntar i
  // tornar a muntar el pont a cada connexió/reconnexió sense cap motiu.
  async function bindDocument(docName, { preferLocal = false } = {}) {
    if (boundDocName === docName && stopLocalWatch) {
      currentDocName.value = docName;
      return;
    }
    const myToken = sessionToken;
    if (stopLocalWatch) {
      stopLocalWatch();
      stopLocalWatch = null;
    }
    ytext = ydoc.getText(templateYTextName(docName));
    if (ytext.length === 0 && store.templateText) {
      ydoc.transact(() => {
        if (ytext.length === 0) ytext.insert(0, store.templateText);
      }, localOrigin);
    } else if (ytext.toString() !== store.templateText) {
      if (preferLocal) {
        // resumeOfflineCapture() (Fase 16): no hi ha cap connexió de xarxa
        // activa en aquest punt, així que un desajust aquí NOMÉS pot venir
        // del propi retard del debounce de persistència (useCollabDoc.js,
        // getOrCreateProjectDoc) respecte a l'última edició local (que SÍ
        // ja és a store.templateText, desada de seguida i sense debounce
        // per la via ordinària de localStorage) -- mai d'un peer remot, que
        // encara no existeix. Cal fer avançar `ytext` amb el contingut
        // local (com a operacions Yjs reals, via applyStringDiffToYText,
        // no un reemplaçament sencer), no al revés: si ho féssim al revés
        // (com fa la branca de sota per a una connexió de xarxa real),
        // l'edició local més recent es perdria en obrir el projecte.
        ydoc.transact(() => {
          applyStringDiffToYText(ytext, ytext.toString(), store.templateText || '');
        }, localOrigin);
      } else {
        // El contingut remot d'aquest document ja hi era (sincronitzat abans
        // de vincular-s'hi -- vist en viu durant la verificació d'aquesta
        // mateixa funcionalitat, en connexions locals molt ràpides) ABANS
        // d'existir cap observer que hi reaccioni: attachTemplateBridge només
        // reacciona a canvis FUTURS del Y.Text, no al seu contingut ja
        // present en adjuntar-se. Cal aplicar-lo ara, amb el mateix idioma
        // que faria l'observer.
        store.collabApplyingRemoteTemplate = true;
        store.templateText = ytext.toString();
        await nextTick();
        store.collabApplyingRemoteTemplate = false;
      }
    }
    if (sessionToken !== myToken) return; // una desconnexió/tancament ha corregut durant el nextTick
    stopLocalWatch = attachTemplateBridge(ydoc, ytext, store, localOrigin);
    boundDocName = docName;
    currentDocName.value = docName;
  }

  // Només xarxa -- NO toca ydoc ni cap pont de document (Fase 16: han de
  // sobreviure a una simple desconnexió, vegeu el doc comment de dalt del
  // fitxer). Segura de cridar encara que no hi hagi cap connexió activa.
  function disconnectNetwork() {
    if (stopProjectTransferResponder) {
      stopProjectTransferResponder();
      stopProjectTransferResponder = null;
    }
    if (provider) {
      if (awarenessChangeHandler) {
        provider.awareness.off('change', awarenessChangeHandler);
        awarenessChangeHandler = null;
      }
      provider.destroy();
      provider = null;
    }
    currentSignalingServer.value = '';
    connectedPeers.value = [];
    currentRoomId.value = '';
    currentPassword.value = '';
    pendingProjectName.value = '';
    transferProgress.value = null;
  }

  // Tanca els ponts de document i allibera el Y.Doc persistent d'aquest
  // projecte (Fase 16, amb un darrer flush a IndexedDB -- closeProjectDoc,
  // useCollabDoc.js). NOMÉS en canviar/tancar de projecte
  // (closeRealtimeForProject) -- mai en una simple desconnexió de xarxa.
  async function teardownDoc() {
    if (stopLocalWatch) {
      stopLocalWatch();
      stopLocalWatch = null;
    }
    if (stopSchemaChannel) {
      stopSchemaChannel();
      stopSchemaChannel = null;
    }
    if (stopDataChannel) {
      stopDataChannel();
      stopDataChannel = null;
    }
    if (currentProjectNameForDoc) {
      await closeProjectDoc(currentProjectNameForDoc);
    }
    ydoc = null;
    ytext = null;
    boundDocName = null;
    currentDocName.value = '';
    currentProjectNameForDoc = null;
  }

  async function startRealtimeSession({ roomId, password, signaling, mode, projectName, savedProjectNames, docName }) {
    if (!roomId || !password) {
      throw new Error("Calen un identificador de sala i una contrasenya per iniciar una sessió en viu.");
    }
    if (sessionStatus.value === 'connected' || sessionStatus.value === 'connecting' || sessionStatus.value === 'awaiting-project') {
      stopRealtimeSession();
    }
    // Capturat DESPRÉS de l'stopRealtimeSession() de dalt (que ja incrementa
    // sessionToken ell mateix) -- així sempre queda amb el valor més fresc,
    // encara que aquesta crida arribi just després d'una altra en curs.
    const myToken = ++sessionToken;
    sessionStatus.value = 'connecting';
    lastRealtimeError.value = null;
    currentSignalingServer.value = '';
    try {
      const [Y, { WebrtcProvider }] = await Promise.all([
        import('yjs'),
        import('y-webrtc'),
      ]);
      if (sessionToken !== myToken) return;

      // Comprova QUIN servidor de senyalització de la llista configurada
      // respon de debò ABANS de crear cap provider -- detecta directament
      // un servidor caigut/adormit (p. ex. un 503 al handshake, el cas real
      // que ens ha portat fins aquí) en lloc de confondre'l més avall amb
      // "la contrapart no hi és" (waitForRemoteProjectName). Si hi ha un
      // preferit configurat i falla, es pregunta abans de provar la resta
      // (findWorkingSignalingServer); sense preferit, es proven totes
      // seqüencialment sense preguntar.
      const workingServer = await findWorkingSignalingServer(
        signaling || store.config.collabSignalingServers || KNOWN_SIGNALING_SERVERS,
        store.config.collabPreferredSignalingServer || '',
      );
      if (!workingServer) {
        throw new Error("No s'ha pogut connectar a cap servidor de senyalització de la llista configurada (Configuració -> Sessió en viu). Comprova la connexió o afegeix-ne un altre.");
      }
      if (sessionToken !== myToken) return;
      currentSignalingServer.value = workingServer;

      // Fase 16: el Y.Doc és persistent PER PROJECTE (useCollabDoc.js), no
      // efímer per sessió -- es reutilitza si ja estava carregat (p. ex.
      // per resumeOfflineCapture, o una connexió anterior en aquesta
      // mateixa pestanya) en lloc de llençar-lo en desconnectar. Si ja hi
      // havia un doc carregat per a un ALTRE projecte sense tancar (no
      // hauria de passar si App.vue sempre crida closeRealtimeForProject()
      // en canviar de projecte, però es protegeix igualment), es tanca
      // primer.
      if (currentProjectNameForDoc && projectName && currentProjectNameForDoc !== projectName) {
        await teardownDoc();
        if (sessionToken !== myToken) return;
      }
      ydoc = projectName ? await getOrCreateProjectDoc(Y, projectName) : new Y.Doc();
      if (projectName) currentProjectNameForDoc = projectName;
      if (sessionToken !== myToken) return;
      const ymeta = ydoc.getMap('meta');

      // Qui inicia la sessió publica el nom del seu projecte de seguida
      // (operació local, no cal esperar el provider) perquè qui s'hi uneixi
      // més tard el pugui llegir i comprovar que coincideix amb el seu.
      // NOTA: és el PROJECTE qui identifica la sala/Y.Doc -- el document
      // actiu (docName) no cal publicar-lo enlloc per validar-lo, ja que
      // cada document té el seu propi Y.Text (templateYTextName) dins el
      // mateix Y.Doc i no hi ha cap manera de "barrejar-se" amb un altre.
      if (mode === 'start' && projectName) {
        ymeta.set('projectName', projectName);
      }

      provider = new WebrtcProvider(roomId, ydoc, {
        signaling: [workingServer],
        password,
      });

      // Y.Map/Y.Array compartits per a la sol·licitud/transferència del ZIP
      // del projecte (Fase 14) -- creats sempre, encara que aquest peer no
      // acabi ni demanant ni responent mai res, perquè hi hagi d'haver
      // alguna cosa a observar des del principi en tots dos costats. Es
      // buiden a cada sessió NOVA (Fase 16: amb un Y.Doc persistent, un
      // estat de transferència d'una sessió molt anterior ja no té sentit
      // -- requestProjectTransfer ja els buida igualment abans de sembrar
      // una sol·licitud nova, això és només per higiene general).
      const transferMap = ydoc.getMap('projectTransfer');
      const transferChunks = ydoc.getArray('projectTransferChunks');
      ydoc.transact(() => {
        transferMap.clear();
        transferChunks.delete(0, transferChunks.length);
      }, localOrigin);

      // Qui s'uneix a una sessió existent comprova, abans de tocar res, que
      // la sala pertany al projecte que té obert -- si no, es llança un
      // error (mateix camí que qualsevol altre error de connexió, vegeu el
      // catch de més avall) i la sessió es tanca sense haver adjuntat mai
      // attachTemplateBridge, és a dir, sense haver tocat store.templateText.
      // El límit és generós (15s) perquè, un cop confirmat que el servidor
      // de senyalització respon, el que queda per resoldre's és la
      // negociació ICE P2P real -- sense TURN gratuït, pot trigar uns
      // segons més que un simple handshake WebSocket.
      if (mode === 'join' && projectName) {
        const remoteProjectName = await waitForRemoteProjectName(ymeta, 15000);
        if (sessionToken !== myToken) return; // stopRealtimeSession()/closeRealtimeForProject() ha corregut mentrestant
        const classification = classifyProjectMismatch(remoteProjectName, projectName, savedProjectNames);
        if (classification === 'not-local') {
          // Fase 14: en lloc de tancar la connexió com als altres dos casos
          // de desajust, ens hi quedem connectats (sense vincular CAP canal
          // de document/esquema/dades -- evita exactament el risc que la
          // Fase 11.1 ja tancava: no toca store.* d'un projecte que no hi
          // pertany) perquè l'usuari pugui sol·licitar el ZIP a qui ja hi
          // sigui (`requestAndImportProject`).
          pendingProjectName.value = remoteProjectName;
          sessionStatus.value = 'awaiting-project';
          return;
        }
        const mismatchError = checkProjectMatch(remoteProjectName, projectName, savedProjectNames);
        if (mismatchError) throw new Error(mismatchError);
      }

      // Espera petita (aleatoritzada, per reduir -- no eliminar del tot --
      // la col·lisió) abans de vincular el document actiu, per donar temps
      // a sincronitzar-se amb algú que ja hi fos. Sense aquesta espera, dos
      // participants connectant-se gairebé alhora amb el MATEIX text local
      // (p. ex. el mateix document carregat per tots dos) inserteixen cada
      // un la seva pròpia còpia en un Y.Text encara buit i no connectat:
      // Yjs no deduplica per contingut, són dues insercions concurrents
      // genuïnes, i el resultat és el text duplicat, no un no-op. Només cal
      // aquí (connexió inicial) -- un canvi de document posterior
      // (switchRealtimeDocument) ja parteix d'una sessió sincronitzada.
      await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 400));
      if (sessionToken !== myToken) return;

      // Canals `schema`/`data` (Fases 12/13): abast de PROJECTE, no de
      // document -- s'adjunten un únic cop aquí, no es revinculen en
      // canviar de document (a diferència del canal `template`). Mateix
      // ordre que useCollabSync.js aplica al seu cicle de sondeig: esquema
      // -> plantilla -> dades, perquè quan el canal de dades dispara
      // evaluateComputedFields (via DataInspector.vue), l'esquema local ja
      // reflecteix l'últim estat remot.
      const yjson = ydoc.getMap('jsonChannels');
      const debounceMs = (store.config.collabCaptureDebounceSeconds || 5) * 1000;
      stopSchemaChannel = await attachJsonChannelBridge(ydoc, yjson, 'schema', {
        getLocal: () => store.editorMetadata,
        setLocal: (v) => { store.editorMetadata = v; },
        computePatch: computeMetaPatch,
      }, localOrigin, debounceMs);
      if (sessionToken !== myToken) return;

      await bindDocument(docName || 'Document Principal');
      if (sessionToken !== myToken) return;

      stopDataChannel = await attachJsonChannelBridge(ydoc, yjson, 'data', {
        getLocal: () => store.excelJsonData,
        setLocal: (v) => { store.excelJsonData = v; },
        computePatch: computeDataPatch,
      }, localOrigin, debounceMs);
      if (sessionToken !== myToken) return;

      // Fase 14: qualsevol participant ja connectat normalment (amb el
      // projecte correcte) pot respondre si algú més s'hi uneix sense
      // tenir-ne cap còpia local -- no només "qui ha iniciat" la sessió.
      // No-op si no s'han injectat els callbacks (p. ex. en tests que
      // criden useCollabRealtime() sense arguments).
      if (buildProjectZipBlob) {
        stopProjectTransferResponder = attachProjectTransferResponder(ydoc, transferMap, transferChunks, {
          myUserId: getOrCreateUserId(),
          buildProjectZipBlob,
        });
      }

      publishAwarenessUser();
      awarenessChangeHandler = () => updatePeerListFromAwareness();
      provider.awareness.on('change', awarenessChangeHandler);
      updatePeerListFromAwareness();

      currentRoomId.value = roomId;
      currentPassword.value = password;
      sessionStatus.value = 'connected';
    } catch (err) {
      // Fase 16: només desconnecta la xarxa -- el Y.Doc (i el pont de
      // plantilla, si ja s'havia arribat a vincular) ha de sobreviure a un
      // intent de connexió/reconnexió fallit, perquè les edicions locals
      // fetes mentrestant no es perdin (vegeu el doc comment de dalt del
      // fitxer).
      disconnectNetwork();
      lastRealtimeError.value = err?.message || String(err);
      sessionStatus.value = 'error';
      throw err;
    }
  }

  // Cridada des d'App.vue's switchActiveDocument quan l'usuari canvia de
  // document localment -- connectat o no (Fase 16: n'hi ha prou que hi
  // hagi un Y.Doc carregat per a aquest projecte, ja sigui perquè hi ha una
  // sessió en viu activa o perquè només s'està capturant en silenci,
  // resumeOfflineCapture). NO desconnecta ni reconnecta la xarxa (mateix
  // WebrtcProvider/sala si n'hi ha), només revincula el pont al Y.Text del
  // nou document i, si hi ha una sessió en viu, actualitza la pròpia
  // Awareness perquè la resta vegi en quin document s'ha passat a
  // treballar. No-op si no hi ha cap doc carregat o si ja és el document
  // vinculat (evita treball doble si es crida per error dues vegades amb
  // el mateix valor).
  async function switchRealtimeDocument(docName) {
    if (!ydoc || !docName || docName === boundDocName) return;
    // Sense provider (encara desconnectat, només capturant en silenci), un
    // desajust ytext/store només pot venir del propi retard del debounce de
    // persistència -- mateix raonament que resumeOfflineCapture().
    await bindDocument(docName, { preferLocal: !provider });
    if (provider) publishAwarenessUser();
  }

  // Desconnexió manual (o un intent de reconnexió fallit, vegeu el catch de
  // startRealtimeSession) -- NOMÉS xarxa (Fase 16): el Y.Doc i el pont de
  // plantilla sobreviuen, perquè les edicions locals fetes sense sessió
  // activa no es perdin i es puguin sincronitzar la propera vegada.
  function stopRealtimeSession() {
    sessionToken++;
    disconnectNetwork();
    sessionStatus.value = 'disconnected';
  }

  // Tanca TOT per a aquest projecte -- xarxa + el Y.Doc persistent (Fase
  // 16, amb el seu darrer flush a IndexedDB). Cridada des d'App.vue EN
  // CANVIAR/TANCAR DE PROJECTE (loadProject/createNewProject), de manera
  // INCONDICIONAL (no només quan sessionStatus === 'connected': un Y.Doc
  // pot estar capturant en silenci encara que la xarxa estigui
  // desconnectada) -- substitueix l'antiga crida condicional a
  // stopRealtimeSession() en aquests dos punts.
  async function closeRealtimeForProject() {
    sessionToken++;
    disconnectNetwork();
    await teardownDoc();
    sessionStatus.value = 'disconnected';
  }

  // Capturar edicions de plantilla SENSE cap connexió de xarxa (Fase 16) --
  // cridada des d'App.vue en obrir un projecte, abans que
  // tryAutoReconnectRealtime (Fase 15) intenti connectar-hi. Comprova
  // primer, SENSE carregar yjs (hasPersistedProjectDoc), si aquest projecte
  // ha fet servir la sessió en viu alguna vegada -- si no, és un no-op
  // complet (cap cost per a qui no fa servir mai aquesta funcionalitat,
  // preservant l'import diferit de yjs de la Fase 10). Si una connexió de
  // debò s'inicia després (startRealtimeSession), reutilitza el mateix doc
  // i detecta que el document ja està vinculat (bindDocument és idempotent)
  // -- no hi ha cap feina duplicada ni cap interrupció del bucle de captura.
  async function resumeOfflineCapture(projectName, docName) {
    if (!projectName || !docName) return;
    if (sessionStatus.value !== 'disconnected') return; // ja hi ha una sessió en marxa
    if (currentProjectNameForDoc === projectName && boundDocName === docName) return; // ja capturant
    const has = await hasPersistedProjectDoc(projectName);
    if (!has) return;
    const myToken = sessionToken;
    const [Y] = await Promise.all([import('yjs')]);
    if (sessionToken !== myToken) return;
    if (currentProjectNameForDoc && currentProjectNameForDoc !== projectName) {
      await teardownDoc();
      if (sessionToken !== myToken) return;
    }
    ydoc = await getOrCreateProjectDoc(Y, projectName);
    if (sessionToken !== myToken) return;
    currentProjectNameForDoc = projectName;
    await bindDocument(docName, { preferLocal: true });
  }

  // Cridada des de CollabPanel.vue (botó "Sol·licita el projecte ara")
  // quan `sessionStatus === 'awaiting-project'` (Fase 14): demana el ZIP a
  // qualsevol altre participant ja connectat amb el projecte correcte,
  // l'importa amb el callback injectat, i desconnecta netament -- qui ha
  // cridat aquesta funció (App.vue) ha de tornar a iniciar la connexió
  // normal amb les dades ja actualitzades del projecte acabat d'importar
  // (aquest fitxer no té accés als refs de projecte/document d'App.vue).
  async function requestAndImportProject() {
    if (sessionStatus.value !== 'awaiting-project' || !ydoc) {
      throw new Error("No hi ha cap sol·licitud de projecte pendent.");
    }
    if (!buildProjectZipBlob || !importProjectZip) {
      throw new Error("Aquesta funcionalitat no està disponible.");
    }
    sessionStatus.value = 'receiving-project';
    transferProgress.value = { receivedChunks: 0, totalChunks: 0 };
    try {
      const { bytes, zipFileName } = await requestProjectTransfer(
        ydoc, ydoc.getMap('projectTransfer'), ydoc.getArray('projectTransferChunks'),
        {
          myUserId: getOrCreateUserId(),
          onProgress: (p) => { transferProgress.value = p; },
        },
      );
      const file = new File([bytes], zipFileName, { type: 'application/zip' });
      await importProjectZip(file);
      // El projecte actiu canvia (importProjectZip reassigna
      // currentProjectName.value a App.vue) -- el doc que teníem carregat
      // (per al projecte "equivocat" original, el que encara no teníem)
      // queda orfe: tanca'l del tot (Fase 16). Qui ha cridat aquesta
      // funció tornarà a connectar amb el projecte correcte, que carregarà
      // el seu propi doc persistent de zero.
      await closeRealtimeForProject();
    } catch (err) {
      disconnectNetwork();
      lastRealtimeError.value = err?.message || String(err);
      sessionStatus.value = 'error';
      throw err;
    }
  }

  return {
    sessionStatus,
    lastRealtimeError,
    currentRoomId,
    currentPassword,
    currentDocName,
    currentSignalingServer,
    pendingProjectName,
    transferProgress,
    connectedPeers,
    startRealtimeSession,
    switchRealtimeDocument,
    stopRealtimeSession,
    closeRealtimeForProject,
    resumeOfflineCapture,
    requestAndImportProject,
  };
}
