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
 * Llista preconfigurada de servidors de senyalització públics coneguts per
 * a la sessió en viu WebRTC (useCollabRealtime.js, Fase 11.3) -- en un
 * fitxer propi, sense cap altra importació, perquè tant workspace.js (valor
 * per defecte de `config.collabSignalingServers`) com useCollabRealtime.js
 * (sonda/restabliment) la puguin importar sense crear una dependència
 * circular entre tots dos (useCollabRealtime.js ja importa
 * useWorkspaceStore de stores/workspace.js).
 *
 * Només hi consta `signaling.yjs.dev`, l'únic servidor que el propi paquet
 * y-webrtc documenta com a per defecte. Se n'han descartat explícitament
 * dos altres, trobats durant les proves d'aquesta funcionalitat:
 * - `wss://y-webrtc-eu.fly.dev` -- NO és cap dels servidors oficials de
 *   y-webrtc (no apareix a la seva documentació), i en ús real ha respost
 *   503 (sobrecarregat/adormit) -- una font menys fiable que l'oficial,
 *   sense cap avantatge real sobre aquesta.
 * - `wss://y-webrtc-signaling-eu/us.herokuapp.com` -- els altres servidors
 *   de demostració històrics de y-webrtc, confirmats morts permanentment
 *   (Heroku va eliminar els dynos gratuïts el 2022; ara retornen HTTP 404,
 *   l'aplicació ja no existeix).
 * Com que cap servidor gratuït de tercers té SLA, aquesta llista és només
 * un punt de partida -- l'usuari en pot afegir/treure des de la
 * configuració (p. ex. un servidor propi exposat amb Cloudflare Tunnel).
 */
export const KNOWN_SIGNALING_SERVERS = [
  { url: 'wss://signaling.yjs.dev', label: 'signaling.yjs.dev (oficial de y-webrtc, comunitat)' },
];
