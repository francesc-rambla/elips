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
 */

import { ref, watch, nextTick } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { getOrCreateUserId, getDisplayNameOrFallback } from './useCollabIdentity';

const DEFAULT_SIGNALING_SERVERS = ['wss://y-webrtc-eu.fly.dev'];

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

/** Decideix si una sessió a la qual algú s'uneix coincideix amb el projecte
 * que té obert localment, i si no, quin dels dos missatges d'error cal
 * mostrar -- retorna `null` quan tot és correcte. Extreta com a funció pura
 * perquè els tres casos es puguin provar sense cap Y.Doc/WebrtcProvider. */
export function checkProjectMatch(remoteProjectName, localProjectName, savedProjectNames) {
  if (!remoteProjectName) {
    return "No s'ha pogut confirmar a quin projecte pertany aquesta sessió (pot ser un problema de connexió). Torna-ho a provar.";
  }
  if (remoteProjectName === localProjectName) return null;
  if ((savedProjectNames || []).includes(remoteProjectName)) {
    return `Aquesta sessió és del projecte "${remoteProjectName}", que tens desat però no obert. Obre'l des de "Gestiona Projectes" i torna a connectar-t'hi.`;
  }
  return `Aquesta sessió és del projecte "${remoteProjectName}", que no tens al teu entorn local. Demana a qui ha iniciat la sessió el fitxer del projecte (collab_project.zip) i importa'l (pestanya Pujar -> "Restableix o Importa Projecte Sencer") abans de connectar-t'hi.`;
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

export function useCollabRealtime() {
  const store = useWorkspaceStore();

  const sessionStatus = ref('disconnected'); // 'disconnected' | 'connecting' | 'connected' | 'error'
  const lastRealtimeError = ref(null);
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

  let ydoc = null;
  let ytext = null;
  let provider = null;
  let stopLocalWatch = null;
  let awarenessChangeHandler = null;
  let boundDocName = null;
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
  // (switchRealtimeDocument). Assumeix que qui crida ja ha carregat el
  // contingut de `docName` a store.templateText abans de cridar-la (mateix
  // ordre que App.vue's switchActiveDocument ja segueix amb
  // loadDocumentConfig).
  async function bindDocument(docName) {
    const thisYdoc = ydoc;
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
    if (ydoc !== thisYdoc) return; // stopRealtimeSession() ha corregut durant el nextTick
    stopLocalWatch = attachTemplateBridge(ydoc, ytext, store, localOrigin);
    boundDocName = docName;
    currentDocName.value = docName;
  }

  function teardown() {
    if (stopLocalWatch) {
      stopLocalWatch();
      stopLocalWatch = null;
    }
    if (provider) {
      if (awarenessChangeHandler) {
        provider.awareness.off('change', awarenessChangeHandler);
        awarenessChangeHandler = null;
      }
      provider.destroy();
      provider = null;
    }
    if (ydoc) {
      ydoc.destroy();
      ydoc = null;
    }
    ytext = null;
    boundDocName = null;
    currentDocName.value = '';
    connectedPeers.value = [];
    currentRoomId.value = '';
    currentPassword.value = '';
  }

  async function startRealtimeSession({ roomId, password, signaling, mode, projectName, savedProjectNames, docName }) {
    if (!roomId || !password) {
      throw new Error("Calen un identificador de sala i una contrasenya per iniciar una sessió en viu.");
    }
    if (sessionStatus.value === 'connected' || sessionStatus.value === 'connecting') {
      stopRealtimeSession();
    }
    sessionStatus.value = 'connecting';
    lastRealtimeError.value = null;
    try {
      const [Y, { WebrtcProvider }] = await Promise.all([
        import('yjs'),
        import('y-webrtc'),
      ]);

      ydoc = new Y.Doc();
      const ymeta = ydoc.getMap('meta');
      const thisYdoc = ydoc; // per detectar un stopRealtimeSession() concurrent durant l'espera de més avall

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
        signaling: signaling || DEFAULT_SIGNALING_SERVERS,
        password,
      });

      // Qui s'uneix a una sessió existent comprova, abans de tocar res, que
      // la sala pertany al projecte que té obert -- si no, es llança un
      // error (mateix camí que qualsevol altre error de connexió, vegeu el
      // catch de més avall) i la sessió es tanca sense haver adjuntat mai
      // attachTemplateBridge, és a dir, sense haver tocat store.templateText.
      if (mode === 'join' && projectName) {
        const remoteProjectName = await waitForRemoteProjectName(ymeta, 6000);
        if (ydoc !== thisYdoc) return; // stopRealtimeSession() ha corregut mentrestant
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
      if (ydoc !== thisYdoc) return; // stopRealtimeSession() ha corregut mentrestant

      await bindDocument(docName || 'Document Principal');
      if (ydoc !== thisYdoc) return;

      publishAwarenessUser();
      awarenessChangeHandler = () => updatePeerListFromAwareness();
      provider.awareness.on('change', awarenessChangeHandler);
      updatePeerListFromAwareness();

      currentRoomId.value = roomId;
      currentPassword.value = password;
      sessionStatus.value = 'connected';
    } catch (err) {
      teardown();
      lastRealtimeError.value = err?.message || String(err);
      sessionStatus.value = 'error';
      throw err;
    }
  }

  // Cridada des d'App.vue's switchActiveDocument quan l'usuari canvia de
  // document localment AMB la sessió en viu oberta -- NO desconnecta ni
  // reconnecta (mateix WebrtcProvider/sala), només revincula el pont al
  // Y.Text del nou document i actualitza la pròpia Awareness perquè la
  // resta vegi en quin document s'ha passat a treballar. No-op si no hi ha
  // sessió activa o si ja és el document vinculat (evita treball doble si
  // es crida per error dues vegades amb el mateix valor).
  async function switchRealtimeDocument(docName) {
    if (sessionStatus.value !== 'connected' || !ydoc || !docName || docName === boundDocName) return;
    await bindDocument(docName);
    publishAwarenessUser();
  }

  function stopRealtimeSession() {
    teardown();
    sessionStatus.value = 'disconnected';
  }

  return {
    sessionStatus,
    lastRealtimeError,
    currentRoomId,
    currentPassword,
    currentDocName,
    connectedPeers,
    startRealtimeSession,
    switchRealtimeDocument,
    stopRealtimeSession,
  };
}
