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
            activitats: [
              { desc: 'Backend', preu: 30000 },
              { desc: 'Frontend', preu: 20000 }
            ]
          },
          {
            titol: 'Part B - Disseny i QA',
            import: '25000',
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

  await browser.close();
  console.log("🎉 TOTES LES PROVES DE TÍTOL PER FÓRMULA, ACORDIÓ, REORDENACIÓ I ETIQUETES ANIUADES HAN PASSAT AMB ÈXIT!");
}

testNestedFeatures().catch(err => {
  console.error("❌ ERROR EN PROVES:", err);
  process.exit(1);
});
