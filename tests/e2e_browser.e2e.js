import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
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
  page.on('dialog', async dialog => {
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

    console.log("\n🎉 TOTES LES PROVES END-TO-END HAN PASSAT AMB ÈXIT EN NAVEGADOR HEADLESS!");
  } catch (err) {
    console.error("\n❌ ERROR DURANT LES PROVES E2E:", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runE2ETests();
