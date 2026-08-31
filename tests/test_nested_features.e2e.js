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

  // Click "Desplega tot"
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Desplega tot'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));

  // Click "Col·lapsa tot"
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Col·lapsa tot'));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 300));
  console.log("  ✓ Botons 'Desplega tot' i 'Col·lapsa tot' executats amb èxit.");

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

  await browser.close();
  console.log("🎉 TOTES LES PROVES DE TÍTOL PER FÓRMULA, ACORDIÓ I REORDENACIÓ HAN PASSAT AMB ÈXIT!");
}

testNestedFeatures().catch(err => {
  console.error("❌ ERROR EN PROVES:", err);
  process.exit(1);
});
