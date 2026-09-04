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

import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testNestedFeatures() {
  console.log("🚀 Testing Nested Intermediate Features (Title Formula, Accordion, Reordering)...");
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('LaTeX')) {
      console.log('  [Console Error]:', msg.text());
    }
  });

  page.on('dialog', async dialog => {
    await dialog.accept();
  });

  // Navigate to app and clear session for clean test
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1500));

  // Switch to Dades tab
  await page.evaluate(() => {
    window.store.activeTab = 'data';
    const btn = Array.from(document.querySelectorAll('.office-tab-btn, .tab-btn')).find(b => b.textContent.includes('Dades'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  // Set data on window.store directly
  await page.evaluate(() => {
    const data = {
      pres: {
        parts: [
          {
            titol: 'Part A - Desenvolupament',
            import: '50000',
            // Regression fixture for the '_group_label' leak bug (2026-09-04):
            // an internal bookkeeping key ending up on the item itself, the
            // way it would if it had round-tripped through a group-title save.
            _group_label: 'Parts',
            activitats: [
              { desc: 'Backend', preu: 30000 },
              { desc: 'Frontend', preu: 20000 }
            ]
          },
          {
            titol: 'Part B - Disseny i QA',
            import: '25000',
            _group_label: 'Parts',
            activitats: [
              { desc: 'UI/UX', preu: 15000 },
              { desc: 'Testing', preu: 10000 }
            ]
          }
        ]
      },
      editor_metadata: [
        {
          group: 'parts',
          element: '_group_label',
          isGroupHeader: true,
          label: 'Parts del Pressupost',
          itemTitleFormula: 'CONCAT(titol; " ("; MONEDA(import); ")")'
        }
      ]
    };

    window.store.excelFileName = 'pressupost.xlsx';
    window.store.editorMetadata = data.editor_metadata;
    window.store.excelJsonData = data;
    // sheetInfo is what makes 'pres.parts' selectable as a parent in the
    // "Nou Conjunt" (new sheet/group) modal used by step 8 below.
    window.store.sheetInfo = [
      { raw_name: 'OUT_pres', prefix: 'OUT_', clean_name: 'pres', parent_path: '', full_path: 'pres', kind: 'kv', headers: [], parent_ref_key: '', child_ref_key: '' },
      { raw_name: 'OUT_pres.parts', prefix: 'OUT_', clean_name: 'pres.parts', parent_path: 'pres', full_path: 'pres.parts', kind: 'tabular', headers: ['titol', 'import'], parent_ref_key: '', child_ref_key: '' },
    ];
    window.store.activeTab = 'data';
    if (window.store.dataActions?.setViewMode) {
      window.store.dataActions.setViewMode('complete');
    }
  });
  await new Promise(r => setTimeout(r, 1000));

  // Open the 'pres' group accordion in complete mode or select it
  await page.evaluate(() => {
    window.store.activeTab = 'data';
    const presHeader = Array.from(document.querySelectorAll('.accordion-header')).find(h => h.textContent.includes('pres'));
    if (presHeader) presHeader.click();
  });
  await new Promise(r => setTimeout(r, 500));

  // 1. Verify Title Formula
  console.log("➡️ 1. Verificant Títol amb Fórmula CONCAT(titol; ' ('; MONEDA(import); ')')...");
  const cardHeadersText = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('.nested-card-header strong'));
    return headers.map(h => h.textContent.trim());
  });

  console.log("  Headers trobats:", cardHeadersText);
  if (!cardHeadersText.some(t => t.includes('Part A - Desenvolupament') && t.includes('50.000,00 €'))) {
    throw new Error(`La fórmula del títol no s'ha avaluat correctament! Trobats: ${JSON.stringify(cardHeadersText)}`);
  }
  console.log("  ✓ Títol calculat correctament amb moneda localitzada:", cardHeadersText[0]);

  // 1b. Regression: an internal '_group_label' key present on an item (as it
  // would be if it had leaked in via a group-title save) must never render as
  // a regular field in that item's own form — it is a hidden/internal key,
  // like other underscore-prefixed keys.
  console.log("➡️ 1b. Verificant que '_group_label' no es renderitza com a camp normal...");
  const firstCardFieldsText = await page.evaluate(() => {
    const firstCard = document.querySelector('.nested-card-item');
    const bodyDiv = firstCard?.querySelector('div[style*="padding-top"]');
    return bodyDiv ? bodyDiv.innerText : (firstCard ? firstCard.innerText : '');
  });
  if (firstCardFieldsText.includes('_group_label') || firstCardFieldsText.includes('Parts del Pressupost')) {
    throw new Error(`La clau interna '_group_label' s'ha renderitzat com un camp normal! Contingut: ${JSON.stringify(firstCardFieldsText)}`);
  }
  console.log("  ✓ '_group_label' es manté ocult del formulari de l'element.");

  // 2. Verify Accordion Collapse / Expand
  console.log("➡️ 2. Verificant Col·lapse / Desplegament Acordió...");
  
  // Click first card header to collapse
  await page.evaluate(() => {
    const firstHeader = document.querySelector('.nested-card-header');
    if (firstHeader) firstHeader.click();
  });
  await new Promise(r => setTimeout(r, 300));

  const isCollapsed = await page.evaluate(() => {
    const firstCard = document.querySelector('.nested-card-item');
    const bodyDiv = firstCard?.querySelector('div[style*="padding-top"]');
    return bodyDiv ? bodyDiv.style.display === 'none' : false;
  });

  if (!isCollapsed) {
    throw new Error("L'element 1 hauria d'estar col·lapsat (display: none)");
  }
  console.log("  ✓ Element 1 col·lapsat correctament!");

  // Click "Desplega tot" and verify every card is actually expanded
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Desplega tot'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  const allExpanded = await page.evaluate(() => {
    const bodies = Array.from(document.querySelectorAll('.nested-card-item > div[style*="padding-top"]'));
    return bodies.length > 0 && bodies.every(b => b.style.display !== 'none');
  });
  if (!allExpanded) {
    throw new Error("'Desplega tot' hauria d'expandir totes les targetes");
  }

  // Click "Col·lapsa tot" and verify every card is actually collapsed
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Col·lapsa tot'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  const allCollapsed = await page.evaluate(() => {
    const bodies = Array.from(document.querySelectorAll('.nested-card-item > div[style*="padding-top"]'));
    return bodies.length > 0 && bodies.every(b => b.style.display === 'none');
  });
  if (!allCollapsed) {
    throw new Error("'Col·lapsa tot' hauria de col·lapsar totes les targetes");
  }
  console.log("  ✓ 'Desplega tot' i 'Col·lapsa tot' commuten realment la visibilitat de totes les targetes.");

  // Expand again before the reordering step below
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Desplega tot'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  // 3. Verify Reordering (Move Down on Item 1)
  console.log("➡️ 3. Verificant Reordenació (Desplaça avall de l'element 1)...");
  
  await page.evaluate(() => {
    const firstCard = document.querySelector('.nested-card-item');
    const moveDownBtn = firstCard ? firstCard.querySelector('button[title="Desplaça avall"]') : null;
    if (moveDownBtn) moveDownBtn.click();
  });
  await new Promise(r => setTimeout(r, 800));

  const reorderedHeadersText = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('.nested-card-header strong'));
    return headers.map(h => h.textContent.trim());
  });

  console.log("  Headers després de moure avall:", reorderedHeadersText);
  if (!reorderedHeadersText[0].includes('Part B - Disseny i QA') || !reorderedHeadersText[1].includes('Part A - Desenvolupament')) {
    throw new Error(`L'ordre dels elements no s'ha invertit correctament! Trobats: ${JSON.stringify(reorderedHeadersText)}`);
  }
  console.log("  ✓ Reordenació verificada: Part B ha passat a la posició 1 i Part A a la posició 2!");

  // 4. Regression: collapse state must stay attached to the right card
  // across duplicate/delete, not drift to whatever ends up at that index.
  console.log("➡️ 4. Verificant que l'estat de col·lapse no es desalinea en duplicar/eliminar...");

  // Order is now [Part B, Part A]. Collapse card 0 (Part B).
  await page.evaluate(() => {
    const header = document.querySelector('.nested-card-header');
    if (header) header.click();
  });
  await new Promise(r => setTimeout(r, 300));

  // Duplicate card 1 (Part A) -> [Part B(collapsed), Part A, Part A_copia]
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.nested-card-item'));
    const dupBtn = cards[1]?.querySelector('button[title="Duplica aquest element i totes les branques aniuades"]');
    if (dupBtn) dupBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  let states = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.nested-card-item')).map(card => {
      const body = card.querySelector('div[style*="padding-top"]');
      const title = card.querySelector('.nested-card-header strong')?.textContent.trim() || '';
      return { title, collapsed: body ? body.style.display === 'none' : false };
    });
  });
  if (states.length !== 3 || !states[0].collapsed || states[1].collapsed || states[2].collapsed) {
    throw new Error(`Estat de col·lapse incorrecte després de duplicar: ${JSON.stringify(states)}`);
  }
  console.log("  ✓ Després de duplicar, només la targeta 0 (Part B) segueix col·lapsada:", states.map(s => s.title));

  // Delete card 1 (the original, un-collapsed "Part A") -> [Part B(collapsed), Part A_copia]
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.nested-card-item'));
    const delBtn = cards[1]?.querySelector('button[title="Elimina element"]');
    if (delBtn) delBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  states = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.nested-card-item')).map(card => {
      const body = card.querySelector('div[style*="padding-top"]');
      const title = card.querySelector('.nested-card-header strong')?.textContent.trim() || '';
      return { title, collapsed: body ? body.style.display === 'none' : false };
    });
  });
  if (states.length !== 2 || !states[0].collapsed || states[1].collapsed) {
    throw new Error(`Estat de col·lapse incorrecte després d'eliminar: ${JSON.stringify(states)}`);
  }
  console.log("  ✓ Després d'eliminar, la targeta 0 (Part B) segueix sent l'única col·lapsada:", states.map(s => s.title));

  // Verify persistence in localStorage
  const savedExcelData = await page.evaluate(() => {
    const pName = localStorage.getItem('currentProjectName') || 'Default';
    const raw = localStorage.getItem(`${pName}:excelJsonData`);
    return raw ? JSON.parse(raw) : null;
  });

  if (savedExcelData.pres.parts[0].titol !== 'Part B - Disseny i QA') {
    throw new Error(`La reordenació no s'ha desat a localStorage! Estat: ${JSON.stringify(savedExcelData.pres.parts)}`);
  }
  console.log("  ✓ Nova ordenació persistida a localStorage correctament!");

  // 5. Regression: field labels configured on a nested group (2+ levels deep,
  // e.g. pres.parts) must be saved under the FULL dotted group path, not the
  // short local key, or the app can never find them again (editor_metadata
  // sheet in Excel/ZIP, formula/select lookups, etc).
  console.log("➡️ 5. Verificant que les etiquetes de camp d'un grup aniuat es desen amb la ruta completa del grup...");

  await page.evaluate(() => {
    const btn = document.querySelector('button[title="Configura tipus de dades i disposició per a aquest grup"]');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  const labelInputExists = await page.evaluate(() => !!document.querySelector('.modal-overlay input.data-input[placeholder="Etiqueta visible..."]'));
  if (!labelInputExists) {
    throw new Error("No s'ha trobat el modal de configuració del grup aniuat 'pres.parts'");
  }

  await page.evaluate(() => {
    const input = document.querySelector('.modal-overlay input.data-input[placeholder="Etiqueta visible..."]');
    input.value = 'Etiqueta de regressió';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 200));

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.modal-overlay button'));
    const saveBtn = btns.find(b => /desa|guardar|save/i.test(b.textContent));
    if (saveBtn) saveBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  const groupCheck = await page.evaluate(() => {
    const meta = window.store.editorMetadata || [];
    return {
      hasFullPathEntry: meta.some(m => m.group === 'pres.parts' && m.label === 'Etiqueta de regressió'),
      hasShortKeyEntry: meta.some(m => m.group === 'parts')
    };
  });

  if (!groupCheck.hasFullPathEntry) {
    throw new Error(`L'etiqueta no s'ha desat sota el grup complet 'pres.parts': ${JSON.stringify(groupCheck)}`);
  }
  if (groupCheck.hasShortKeyEntry) {
    throw new Error(`S'han desat entrades de metadades sota la clau curta 'parts' en lloc de la ruta completa: ${JSON.stringify(groupCheck)}`);
  }
  console.log("  ✓ L'etiqueta del grup aniuat s'ha desat correctament sota 'pres.parts'.");

  // 6. Regression: calculated fields (row-level CUSTOM formula + a SUM
  // aggregation) must evaluate correctly through the real Pyodide bridge
  // (evaluate_computed_fields in src/python/engine.py), not just in an
  // isolated Python unit test. This exact scenario — a field literally named
  // "import" (Catalan for "amount", very common in this domain) — is what
  // caught a real bug during development: an overly broad security
  // blocklist rejected any formula containing the word "import".
  console.log("➡️ 6. Verificant que els camps calculats (fórmula CUSTOM + agregació SUM) s'avaluen via Pyodide...");

  const calcSetup = await page.evaluate(() => {
    const parts = window.store.excelJsonData.pres.parts;
    parts.forEach(p => { p.preu_amb_iva = null; });
    window.store.excelJsonData.pres.total_pressupost = null;
    window.store.editorMetadata.push(
      { group: 'pres.parts', element: 'preu_amb_iva', type: 'Computed', calcFormula: 'ARRODONEIX(import * 1.21; 2)' },
      { group: 'pres', element: 'total_pressupost', type: 'Computed', calcFn: 'SUM', calcVector: 'parts', calcTargetCol: 'import' }
    );
    const expectedTotal = parts.reduce((sum, p) => sum + Number(p.import), 0);
    const expectedPerPart = parts.map(p => Math.round(Number(p.import) * 1.21 * 100) / 100);
    // Reassign to trigger DataInspector's deep watcher -> evaluateComputedFields.
    window.store.excelJsonData = JSON.parse(JSON.stringify(window.store.excelJsonData));
    return { expectedTotal, expectedPerPart };
  });
  await new Promise(r => setTimeout(r, 1500));

  const calcResult = await page.evaluate(() => {
    const p = window.store.excelJsonData.pres;
    return {
      perPart: p.parts.map(x => x.preu_amb_iva),
      total: p.total_pressupost,
    };
  });

  console.log("  Esperat:", calcSetup, "  Obtingut:", calcResult);
  if (JSON.stringify(calcResult.perPart) !== JSON.stringify(calcSetup.expectedPerPart)) {
    throw new Error(`La fórmula CUSTOM per fila no ha donat el resultat esperat: ${JSON.stringify(calcResult.perPart)} vs ${JSON.stringify(calcSetup.expectedPerPart)}`);
  }
  if (calcResult.total !== calcSetup.expectedTotal) {
    throw new Error(`L'agregació SUM no ha donat el resultat esperat: ${calcResult.total} vs ${calcSetup.expectedTotal}`);
  }
  console.log("  ✓ Els camps calculats s'han avaluat correctament a través del pont Pyodide (Python).");

  // 7. Regression: configuring a sub-table nested two levels deep (here,
  // "activitats" inside a specific "parts" row) must save the config under
  // the SHARED schema-level group ("pres.parts.activitats"), not a group forked
  // per row index ("parts.0.activitats") — which would silently apply the
  // configuration to only the first row's sub-table and never to the rest,
  // even though every row shares the exact same column structure.
  console.log("➡️ 7. Verificant que la configuració d'una taula aniuada de 2n nivell s'aplica a totes les files, no només a la primera...");

  const nestedGearInfo = await page.evaluate(() => {
    const gears = Array.from(document.querySelectorAll('button[title="Configura tipus de dades i disposició per a aquest grup"]'));
    return gears.map((g, i) => {
      const heading = g.closest('.nested-hierarchy-container')?.querySelector('h5')?.textContent.trim() || '';
      return { i, heading };
    });
  });
  const activitatsGearIndex = nestedGearInfo.findIndex(x => x.heading.toLowerCase().includes('activitats'));
  if (activitatsGearIndex === -1) {
    throw new Error(`No s'ha trobat cap botó de configuració per a 'activitats': ${JSON.stringify(nestedGearInfo)}`);
  }

  await page.evaluate((idx) => {
    const gears = Array.from(document.querySelectorAll('button[title="Configura tipus de dades i disposició per a aquest grup"]'));
    gears[idx].click();
  }, activitatsGearIndex);
  await new Promise(r => setTimeout(r, 500));

  const nestedModalVisible = await page.evaluate(() => !!document.querySelector('.modal-overlay input.data-input[placeholder="Etiqueta visible..."]'));
  if (!nestedModalVisible) {
    throw new Error("No s'ha obert el modal de configuració per a 'activitats'");
  }

  await page.evaluate(() => {
    const input = document.querySelector('.modal-overlay input.data-input[placeholder="Etiqueta visible..."]');
    input.value = 'Etiqueta activitat compartida';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 200));

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.modal-overlay button'));
    const saveBtn = btns.find(b => /desa|guardar|save/i.test(b.textContent));
    if (saveBtn) saveBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));

  const nestedGroupCheck = await page.evaluate(() => {
    const meta = window.store.editorMetadata || [];
    return {
      hasSharedGroup: meta.some(m => m.group === 'pres.parts.activitats' && m.label === 'Etiqueta activitat compartida'),
      hasRowIndexedGroup: meta.some(m => /^pres\.parts\.\d+\.activitats$/.test(m.group || '')),
      allGroups: [...new Set(meta.map(m => m.group))],
    };
  });

  console.log("  Grups de metadades resultants:", nestedGroupCheck.allGroups);
  if (!nestedGroupCheck.hasSharedGroup) {
    throw new Error(`La configuració no s'ha desat sota el grup compartit 'pres.parts.activitats': ${JSON.stringify(nestedGroupCheck)}`);
  }
  if (nestedGroupCheck.hasRowIndexedGroup) {
    throw new Error(`La configuració s'ha desat sota un grup indexat per fila (p.ex. 'parts.0.activitats') en lloc del grup compartit: ${JSON.stringify(nestedGroupCheck)}`);
  }
  console.log("  ✓ La configuració de la sub-taula aniuada s'aplica a totes les files (grup compartit 'pres.parts.activitats').");

  // 8. Regression (2026-09-04, refined 2026-09-04 per Francesc's follow-up):
  // configuring an EXISTING nested sub-table works (steps above already
  // prove this for 'activitats'), but creating a BRAND NEW one from scratch
  // and then configuring its fields used to have no visible effect at all
  // (the columns never appeared anywhere with zero rows). The FIRST fix for
  // that seeded a fake row just so the columns had "somewhere to live" — but
  // Francesc pointed out that is architecturally backwards: a group's column
  // DEFINITION must live in editor_metadata itself, independent of whether
  // any data rows exist, so a freshly configured table with 0 rows must
  // still know its own columns AND keep showing 0 rows (no phantom row).
  console.log("➡️ 8. Verificant que crear una taula aniuada NOVA i configurar-hi camps sí que persisteix (sense fila fantasma)...");

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Nou Conjunt'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));
  await page.type('#newSheetNameInput', 'detalls');
  await page.select('#newSheetKindSelect', 'sub_table');
  await new Promise(r => setTimeout(r, 200));
  await page.select('#newSheetParentSelect', 'pres.parts');
  await new Promise(r => setTimeout(r, 200));
  await page.click('#newSheetConfirmBtn');
  await new Promise(r => setTimeout(r, 800));

  const afterCreate = await page.evaluate(() => JSON.parse(JSON.stringify(window.store.excelJsonData.pres.parts)));
  if (!afterCreate.every(p => Array.isArray(p.detalls) && p.detalls.length === 0)) {
    throw new Error(`La nova sub-taula 'detalls' no s'ha creat buida a cada fila de 'parts': ${JSON.stringify(afterCreate)}`);
  }

  // Open "Configura Tipus" for the freshly created (still empty) 'detalls' sub-table.
  await page.evaluate(() => {
    const gears = Array.from(document.querySelectorAll('button[title="Configura tipus de dades i disposició per a aquest grup"]'));
    const target = gears.find(g => (g.closest('.nested-hierarchy-container')?.querySelector('h5')?.textContent || '').includes('detalls'));
    if (target) target.click();
  });
  await new Promise(r => setTimeout(r, 500));

  // Answer the two "new field name" prompts triggered by the modal's own
  // "Afegir camp/clau al grup" button (a plain window.prompt()), then save.
  const fieldNames = ['concepte', 'preu'];
  page.removeAllListeners('dialog');
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt' && fieldNames.length > 0) {
      await dialog.accept(fieldNames.shift());
    } else {
      await dialog.accept();
    }
  });

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.modal-overlay button')).find(b => b.textContent.includes('Afegir camp/clau al grup'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.modal-overlay button')).find(b => b.textContent.includes('Afegir camp/clau al grup'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  await page.evaluate(() => {
    const saveBtn = Array.from(document.querySelectorAll('.modal-overlay button')).find(b => b.textContent.trim() === 'Desa Configuració');
    if (saveBtn) saveBtn.click();
  });
  await new Promise(r => setTimeout(r, 800));

  // The structure must NOT depend on data: 'detalls' stays EMPTY on every
  // row (no phantom row fabricated just so the columns exist somewhere).
  const afterConfig = await page.evaluate(() => JSON.parse(JSON.stringify(window.store.excelJsonData.pres.parts)));
  console.log("  'detalls' a cada fila de 'parts' després de configurar:", JSON.stringify(afterConfig.map(p => p.detalls)));
  if (!afterConfig.every(p => Array.isArray(p.detalls) && p.detalls.length === 0)) {
    throw new Error(`'detalls' hauria de continuar buida a totes les files (sense fila fantasma): ${JSON.stringify(afterConfig)}`);
  }

  const detallsSectionText = await page.evaluate(() => {
    const containers = Array.from(document.querySelectorAll('.nested-hierarchy-container'));
    const target = containers.find(c => (c.querySelector('h5')?.textContent || '').includes('detalls'));
    return target ? target.innerText : '';
  });
  if (!detallsSectionText.includes('(0 registres)')) {
    throw new Error(`La secció 'detalls' hauria de continuar mostrant 0 registres: ${JSON.stringify(detallsSectionText)}`);
  }

  // Reopening "Configura Tipus" must show the fields already configured,
  // proving the schema survives independently of the (still empty) data.
  await page.evaluate(() => {
    const gears = Array.from(document.querySelectorAll('button[title="Configura tipus de dades i disposició per a aquest grup"]'));
    const target = gears.find(g => (g.closest('.nested-hierarchy-container')?.querySelector('h5')?.textContent || '').includes('detalls'));
    if (target) target.click();
  });
  await new Promise(r => setTimeout(r, 500));
  // Several modals in this component share the ".modal-overlay" class (the
  // group-config one, the "move element" one, ...); target the group-config
  // modal specifically via its own group-label input, as elsewhere in this
  // file, rather than the first ".modal-overlay" found in the DOM.
  const reopenedModalHasFields = await page.evaluate(() => {
    const groupLabelInput = document.querySelector('.modal-overlay input.data-input[placeholder="Nom visible del grup..."]');
    const modal = groupLabelInput ? groupLabelInput.closest('.modal-content') : null;
    return !!modal && modal.innerText.includes('concepte') && modal.innerText.includes('preu');
  });
  if (!reopenedModalHasFields) {
    throw new Error("En reobrir 'Configura Tipus' per a 'detalls' no es mostren els camps ja configurats (concepte/preu)");
  }
  await page.evaluate(() => {
    const closeBtn = Array.from(document.querySelectorAll('.modal-overlay .modal-header button')).find(b => b.textContent.includes('×'));
    if (closeBtn) closeBtn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  // Clicking "Afegeix detalls" must create a row shaped by the CONFIGURED
  // fields, not a generic 'valor' fallback (which is what effectiveFields
  // falls back to when it has no schema/data to derive columns from).
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.title || '').includes('Afegeix detalls'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 500));
  const afterAddRow = await page.evaluate(() => JSON.parse(JSON.stringify(window.store.excelJsonData.pres.parts)));
  const rowsWithData = afterAddRow.filter(p => p.detalls.length > 0);
  if (rowsWithData.length !== 1 || !('concepte' in rowsWithData[0].detalls[0]) || !('preu' in rowsWithData[0].detalls[0])) {
    throw new Error(`La fila afegida a 'detalls' no té els camps configurats (concepte/preu): ${JSON.stringify(afterAddRow)}`);
  }
  console.log("  ✓ La configuració d'una taula aniuada NOVA persisteix (0 registres, sense fila fantasma) i la fila afegida després usa els camps configurats.");

  await browser.close();
  console.log("🎉 TOTES LES PROVES DE TÍTOL PER FÓRMULA, ACORDIÓ, REORDENACIÓ, ETIQUETES ANIUADES, CAMPS CALCULATS, CONFIGURACIÓ COMPARTIDA I TAULA NOVA HAN PASSAT AMB ÈXIT!");
}

testNestedFeatures().catch(err => {
  console.error("❌ ERROR EN PROVES:", err);
  process.exit(1);
});