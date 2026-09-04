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
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runE2ETests() {
  console.log("🚀 Iniciant proves End-to-End en navegador headless (Puppeteer)...");

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();

  // Capture browser logs (filter out math font warnings)
  page.on('console', msg => {
    const text = msg.text();
    if (!text.includes('metrics for') && !text.includes('LaTeX-incompatible')) {
      if (text.includes('[ERROR]') || text.includes('Error') || text.includes('Exception')) {
        console.log(`  [Browser Console ${msg.type()}]:`, text);
      }
    }
  });

  page.on('pageerror', err => {
    console.error("  [Browser Page Error]:", err.message);
  });

  // Handle prompt dialogs dynamically
  let promptVal = 'nom_organ';
  const dialogsSeen = [];
  page.on('dialog', async dialog => {
    dialogsSeen.push({ type: dialog.type(), message: dialog.message() });
    if (dialog.type() === 'prompt') {
      await dialog.accept(promptVal);
    } else if (dialog.type() === 'confirm') {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
  });

  try {
    // 1. Load application
    console.log("➡️ 1. Carregant aplicació web a http://localhost:8000/index.html...");
    await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for WASM engines to initialize
    console.log("➡️ 2. Esperant inicialització de motors WASM (Pyodide + Pandoc)...");
    await page.waitForFunction(() => {
      return document.body.innerText.includes('Motors Inicialitzats') || (window.store?.enginesReady === true);
    }, { timeout: 45000 }).catch(() => {
      console.log("  ℹ️ Continuant (comprovació DOM badge)...");
    });

    const title = await page.title();
    console.log(`  ✓ Títol de la pàgina: "${title}"`);

    // 2. Test Key/Value key addition & persistence in empty project
    console.log("➡️ 3. Test de creació d'estructura de dades des de zero (sense Excel)...");

    // Switch to Data tab
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button.tab-btn')).find(b => b.textContent.includes('Dades'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Test creating a new KV group "metadades_expedient"
    console.log("  • Creant nou grup de dades KV 'metadades_expedient'...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Crear Nou Full') || b.textContent.includes('Nou Conjunt'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(() => {
      const input = document.getElementById('newSheetNameInput');
      input.value = 'metadades_expedient';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const kindSelect = document.getElementById('newSheetKindSelect');
      if (kindSelect) {
        kindSelect.value = 'kv';
        kindSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 300));

    await page.evaluate(() => {
      const confirmBtn = document.getElementById('newSheetConfirmBtn');
      confirmBtn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Add new KV keys
    console.log("  • Afegint noves claus KV 'nom_organ' i 'pressupost_base'...");
    promptVal = 'nom_organ';
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('+ Afegeix Nova Clau'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    promptVal = 'pressupost_base';
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('+ Afegeix Nova Clau'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Set values into the new keys
    console.log("  • Assignant valors als camps creats...");
    await page.evaluate(() => {
      const organInput = document.querySelector('textarea[data-path*="nom_organ"], input[data-path*="nom_organ"]');
      if (organInput) {
        organInput.value = 'Departament de Polítiques Digitals';
        organInput.dispatchEvent(new Event('input', { bubbles: true }));
        organInput.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      const pressupostInput = document.querySelector('textarea[data-path*="pressupost_base"], input[data-path*="pressupost_base"]');
      if (pressupostInput) {
        pressupostInput.value = '150000';
        pressupostInput.dispatchEvent(new Event('input', { bubbles: true }));
        pressupostInput.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 1500));

    // Verify in localStorage
    const savedState = await page.evaluate(() => {
      const pName = localStorage.getItem('currentProjectName') || 'Default';
      const raw = localStorage.getItem(`${pName}:excelJsonData`);
      return raw ? JSON.parse(raw) : null;
    });

    if (!savedState || !savedState.metadades_expedient || savedState.metadades_expedient.nom_organ !== 'Departament de Polítiques Digitals') {
      throw new Error(`Les claus afegides no s'han desat a localStorage! Estat trobat: ${JSON.stringify(savedState)}`);
    }
    console.log("  ✓ Claus i valors desats correctament a localStorage:", savedState.metadades_expedient);

    // 3. Test persistence across page reload
    console.log("➡️ 4. Recarregant pàgina per comprovar persistència de les dades...");
    await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof window.localStorage !== 'undefined');
    await new Promise(r => setTimeout(r, 1000));

    const reloadedState = await page.evaluate(() => {
      const pName = localStorage.getItem('currentProjectName') || 'Default';
      const raw = localStorage.getItem(`${pName}:excelJsonData`);
      return raw ? JSON.parse(raw) : null;
    });

    if (!reloadedState || !reloadedState.metadades_expedient || reloadedState.metadades_expedient.nom_organ !== 'Departament de Polítiques Digitals' || String(reloadedState.metadades_expedient.pressupost_base) !== '150000') {
      throw new Error(`Persistència fallida després de recarregar la pàgina! Estat: ${JSON.stringify(reloadedState)}`);
    }
    console.log("  ✓ Persistència després de recarregar confirmada:", reloadedState.metadades_expedient);

    // 4. Test uploading the generated fixture workbook (tests/fixtures/elips_test_fixture.xlsx,
    // produced by generate_workbook.py before this suite runs)
    const fixtureFile = path.resolve(__dirname, 'fixtures', 'elips_test_fixture.xlsx');
    if (!fs.existsSync(fixtureFile)) {
      throw new Error(`Fixture no trobada a ${fixtureFile}. Executa primer: python3 tests/fixtures/generate_workbook.py`);
    }
    console.log("➡️ 5. Provant càrrega de la fixture generada elips_test_fixture.xlsx a l'aplicació...");

    // Go to Upload tab
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button.tab-btn'));
      const uploadBtn = buttons.find(b => b.textContent.includes('Fitxers') || b.textContent.includes('Carregar'));
      if (uploadBtn) uploadBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    const fileInput = await page.$('input[type="file"][accept*=".xlsx"]');
    if (!fileInput) {
      throw new Error("No s'ha trobat l'input de càrrega d'Excel (.xlsx)");
    }
    await fileInput.uploadFile(fixtureFile);
    console.log("  • Fitxer enviat a l'input file...");
    await new Promise(r => setTimeout(r, 1000));

    // If warning modal appeared, confirm overwrite (Option B)
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.modal-overlay button'));
      const overwriteBtn = btns.find(b => b.innerText.includes('Opció B') || b.innerText.includes('sobreescriure'));
      if (overwriteBtn) {
        overwriteBtn.click();
      }
    });
    await new Promise(r => setTimeout(r, 4500));

    // Switch to Data tab to inspect
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button.tab-btn'));
      const dataBtn = buttons.find(b => b.textContent.includes('Dades'));
      if (dataBtn) dataBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    const generalData = await page.evaluate(() => {
      const pName = localStorage.getItem('currentProjectName') || 'Default';
      const raw = localStorage.getItem(`${pName}:excelJsonData`);
      return raw ? JSON.parse(raw) : null;
    });

    if (generalData && generalData.General) {
      console.log("  ✓ General.nom_responsable:", JSON.stringify(generalData.General.nom_responsable));
      console.log("  ✓ General.modalitat:", JSON.stringify(generalData.General.modalitat));

      if (generalData.General.nom_responsable !== 'Anna Puig Soler') {
        throw new Error(`General.nom_responsable no és 'Anna Puig Soler', és '${generalData.General.nom_responsable}'`);
      }
      if (generalData.General.modalitat !== 'Contracte Públic') {
        throw new Error(`General.modalitat no és 'Contracte Públic', és '${generalData.General.modalitat}'`);
      }
      if (!generalData.pres || generalData.pres.parts?.length !== 2) {
        throw new Error(`pres.parts hauria de tenir 2 elements, en té ${generalData.pres?.parts?.length}`);
      }
      console.log("  ✓ Dades de General i pres.parts carregades i verificades amb èxit!");
    } else {
      throw new Error("No s'ha trobat la pestanya General després de carregar la fixture generada");
    }

    // 6. Regression (2026-09-04): "Afegeix fila" on an independent/root-level
    // tabular sheet (OUT_Mesa, from the fixture already loaded above -- 4 real
    // rows, no trailing ghost rows, no nested children) let a user add ONE row
    // but a second click did nothing further. Cause: initVisibleRows recomputed
    // its "hide trailing blank rows" heuristic on every excelJsonData
    // reassignment (including the one addTabularRow itself triggers), which
    // immediately re-hid the just-added (necessarily blank) row and left
    // addTabularRow stuck re-revealing/re-hiding that same single row forever.
    console.log("➡️ 6. Provant que 'Afegeix fila' funciona repetidament en una taula tabular independent (OUT_Mesa)...");

    const mesaLenBefore = await page.evaluate(() => window.store.excelJsonData.Mesa.length);
    for (let i = 0; i < 3; i++) {
      // Multiple "Afegeix fila" buttons exist (one per tabular sheet); find the one under the Mesa section specifically.
      const clicked = await page.evaluate(() => {
        const headers = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && el.textContent.trim() === 'Mesa');
        for (const h of headers) {
          let node = h;
          for (let i = 0; i < 8 && node; i++) {
            const btn = node.querySelector && Array.from(node.querySelectorAll('button')).find(b => b.title === 'Afegeix una nova fila a la taula');
            if (btn) { btn.click(); return true; }
            node = node.parentElement;
          }
        }
        return false;
      });
      if (!clicked) throw new Error(`No s'ha trobat el botó "Afegeix fila" per a OUT_Mesa (intent ${i + 1})`);
      await new Promise(r => setTimeout(r, 500));
    }
    const mesaLenAfter = await page.evaluate(() => window.store.excelJsonData.Mesa.length);
    const mesaRenderedRows = await page.evaluate(() => document.querySelectorAll('tr[id^="data-row-Mesa-"]').length);
    console.log(`  Mesa: ${mesaLenBefore} files -> ${mesaLenAfter} files (3 clics), ${mesaRenderedRows} files renderitzades`);
    if (mesaLenAfter !== mesaLenBefore + 3) {
      throw new Error(`3 clics a "Afegeix fila" haurien d'afegir 3 files noves (${mesaLenBefore} -> ${mesaLenBefore + 3}), però ha quedat en ${mesaLenAfter}`);
    }
    if (mesaRenderedRows !== mesaLenAfter) {
      throw new Error(`Totes les ${mesaLenAfter} files haurien d'estar renderitzades (i visibles), però només se'n renderitzen ${mesaRenderedRows}`);
    }
    console.log("  ✓ 'Afegeix fila' afegeix i mostra una fila nova cada vegada, no només la primera.");

    // 7. Regression (2026-09-04): a ROOT-level ("independent") tabular sheet
    // whose rows have a nested child table (OUT_Criteris -> OUT_Criteris.Subcriteris,
    // from the same fixture) used to render as a flat table showing only its
    // own primitive columns (id/descripcio/puntuacio) -- the nested Subcriteris
    // data was completely invisible/inaccessible. It must instead render this
    // level as key-value cards with the nested table as a terminal item,
    // exactly like NestedDataNode.vue already does for a tabular group nested
    // inside a KV parent.
    console.log("➡️ 7. Provant que una taula arrel amb relació aniuada (OUT_Criteris -> Subcriteris) es mostra com a targetes KV amb la taula filla com a ítem terminal...");
    const criterisInfo = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && el.textContent.trim() === 'Criteris');
      let container = null;
      for (const h of headers) {
        let node = h;
        for (let i = 0; i < 8 && node; i++) {
          if (node.querySelector && node.querySelector('.nested-card-item, table.inspector-table')) { container = node; break; }
          node = node.parentElement;
        }
        if (container) break;
      }
      return {
        found: !!container,
        hasCards: container ? container.querySelectorAll('.nested-card-item').length : 0,
        text: container ? container.innerText.slice(0, 600) : '',
      };
    });
    console.log('  Criteris container found:', criterisInfo.found, '| targetes:', criterisInfo.hasCards);
    if (!criterisInfo.found || criterisInfo.hasCards === 0) {
      throw new Error(`'Criteris' (amb fill 'Subcriteris') hauria de renderitzar-se com a targetes clau-valor: ${JSON.stringify(criterisInfo)}`);
    }
    if (!criterisInfo.text.includes('Subcriteris')) {
      throw new Error(`La taula filla 'Subcriteris' hauria d'aparèixer com a ítem terminal dins de cada targeta: ${JSON.stringify(criterisInfo.text)}`);
    }
    console.log("  ✓ 'Criteris' es mostra com a targetes clau-valor amb 'Subcriteris' com a taula terminal aniuada.");

    // 8. Regression (2026-09-04): adding a new column to a group whose OUT_
    // sheet is a simple cell-by-cell mirror of another sheet (via
    // `=OtherSheet!Cell` formulas) must ask the user whether to ALSO add the
    // new column to that source sheet, replicating the same formula — instead
    // of silently leaving it disconnected from the sheet that actually holds
    // the group's real data. Uses tests/fixtures/elips_mirror_test_fixture.xlsx
    // (OUT_nomconjunt mirrors nomconjunt), matching the exact scenario from
    // the bug report. This REPLACES the currently loaded project's Excel file
    // with a different, smaller one -- must run last.
    console.log("➡️ 8. Provant la detecció de mirall en afegir una nova columna (OUT_nomconjunt / nomconjunt)...");
    const mirrorFixtureFile = path.resolve(__dirname, 'fixtures', 'elips_mirror_test_fixture.xlsx');
    if (!fs.existsSync(mirrorFixtureFile)) {
      throw new Error(`Fixture no trobada a ${mirrorFixtureFile}. Executa primer: python3 tests/fixtures/generate_workbook.py`);
    }

    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button.tab-btn'));
      const uploadBtn = buttons.find(b => b.textContent.includes('Fitxers') || b.textContent.includes('Carregar'));
      if (uploadBtn) uploadBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    const mirrorFileInput = await page.$('input[type="file"][accept*=".xlsx"]');
    if (!mirrorFileInput) {
      throw new Error("No s'ha trobat l'input de càrrega d'Excel (.xlsx) per a la fixture de mirall");
    }
    await mirrorFileInput.uploadFile(mirrorFixtureFile);
    await new Promise(r => setTimeout(r, 1000));

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.modal-overlay button'));
      const overwriteBtn = btns.find(b => b.innerText.includes('Opció B') || b.innerText.includes('sobreescriure'));
      if (overwriteBtn) overwriteBtn.click();
    });
    await new Promise(r => setTimeout(r, 4500));

    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button.tab-btn'));
      const dataBtn = buttons.find(b => b.textContent.includes('Dades'));
      if (dataBtn) dataBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    // Open "Configura Tipus" for the 'nomconjunt' group.
    await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && el.textContent.trim() === 'nomconjunt');
      let btn = null;
      for (const h of headers) {
        let node = h;
        for (let i = 0; i < 6 && node; i++) {
          const candidate = node.querySelector && Array.from(node.querySelectorAll('button')).find(b => b.textContent.includes('Configura'));
          if (candidate) { btn = candidate; break; }
          node = node.parentElement;
        }
        if (btn) break;
      }
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 500));

    if (!(await page.$('.modal-overlay input.data-input[placeholder="Nom visible del grup..."]'))) {
      throw new Error("No s'ha obert el modal de configuració per a 'nomconjunt'");
    }

    dialogsSeen.length = 0;
    promptVal = 'preu';
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.modal-overlay button')).find(b => b.textContent.includes('Afegir camp/clau al grup'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 300));

    await page.evaluate(() => {
      const saveBtn = Array.from(document.querySelectorAll('.modal-overlay button')).find(b => b.textContent.trim() === 'Desa Configuració');
      if (saveBtn) saveBtn.click();
    });
    await new Promise(r => setTimeout(r, 2500));

    const mirrorConfirm = dialogsSeen.find(d => d.type === 'confirm' && d.message.includes('mirall'));
    if (!mirrorConfirm) {
      throw new Error(`No s'ha mostrat cap confirmació de mirall en afegir el camp 'preu': ${JSON.stringify(dialogsSeen)}`);
    }
    console.log("  ✓ Confirmació de mirall mostrada:", JSON.stringify(mirrorConfirm.message));

    const mirrorExcelBase64 = await page.evaluate(async () => {
      if (!window.store.excelFile) return null;
      const buf = await window.store.excelFile.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    });
    if (!mirrorExcelBase64) {
      throw new Error("No s'ha pogut recuperar el fitxer Excel resultant (window.store.excelFile) després de desar la configuració");
    }
    const resultXlsxPath = path.resolve(__dirname, '..', '.tmp_mirror_result_e2e.xlsx');
    fs.writeFileSync(resultXlsxPath, Buffer.from(mirrorExcelBase64, 'base64'));

    try {
      const pyCheck = `
import sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
src = wb["nomconjunt"]
out = wb["OUT_nomconjunt"]
assert src.cell(1, 4).value == "preu", f"Capçalera 'preu' no trobada al full font (C1={src.cell(1,4).value})"
assert out.cell(1, 4).value == "preu", f"Capçalera 'preu' no trobada al full OUT_ (C1={out.cell(1,4).value})"
assert out.cell(2, 4).value == "='nomconjunt'!D2", f"Fórmula de mirall inesperada: {out.cell(2,4).value}"
assert out.cell(3, 4).value == "='nomconjunt'!D3", f"Fórmula de mirall inesperada: {out.cell(3,4).value}"
print("MIRROR_COLUMN_VERIFIED_OK")
`;
      execFileSync('python3', ['-c', pyCheck, resultXlsxPath], { encoding: 'utf-8' });
    } finally {
      fs.unlinkSync(resultXlsxPath);
    }

    console.log("  ✓ La columna nova 'preu' s'ha afegit també al full font 'nomconjunt' (D1), enllaçada des de 'OUT_nomconjunt' (D2/D3) amb la mateixa convenció de fórmula -- verificat llegint el .xlsx resultant amb openpyxl.");

    console.log("\n🎉 TOTES LES PROVES END-TO-END HAN PASSAT AMB ÈXIT EN NAVEGADOR HEADLESS!");
  } catch (err) {
    console.error("\n❌ ERROR DURANT LES PROVES E2E:", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runE2ETests();
