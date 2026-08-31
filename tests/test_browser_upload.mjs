import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async () => {
  console.log("Iniciant test de càrrega al navegador...");
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2', timeout: 30000 });

  await page.waitForFunction(() => {
    return document.body.innerText.includes('Motors Inicialitzats') || (window.__pyodideReady === true);
  }, { timeout: 45000 });

  console.log("Motors WASM llestos.");

  // Upload _plantilla_licitacio_elips.xlsx
  const licitacioFile = path.resolve(__dirname, '../../_plantilla_licitacio_elips.xlsx');
  const fileInput = await page.$('input[type="file"][accept*=".xlsx"]');
  if (fileInput) {
    await fileInput.uploadFile(licitacioFile);
    console.log("Fitxer enviat.");
    await new Promise(r => setTimeout(r, 1000));

    // Check if overwrite modal appeared
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.modal-overlay button'));
      const overwriteBtn = btns.find(b => b.innerText.includes('Opció B') || b.innerText.includes('sobreescriure'));
      if (overwriteBtn) overwriteBtn.click();
    });

    await new Promise(r => setTimeout(r, 5000));

    const storeData = await page.evaluate(() => {
      const store = window.__antigravity_store;
      return {
        excelJsonData: store ? store.excelJsonData : null,
        rawPythonJsonStr: store ? store.rawPythonJsonStr : null,
        excelImportInspection: store ? store.excelImportInspection : null
      };
    });

    console.log("=== BROWSER STORE DATA ===");
    if (storeData.excelJsonData) {
      console.log("General.nom_responsable:", storeData.excelJsonData.General?.nom_responsable);
      console.log("General.modalitat:", storeData.excelJsonData.General?.modalitat);
      console.log("Mesa count:", storeData.excelJsonData.Mesa?.length);
      console.log("preus count:", storeData.excelJsonData.preus?.length);
      console.log("Criteris count:", storeData.excelJsonData.Criteris?.length);
    } else {
      console.log("excelJsonData is NULL");
    }

    if (storeData.excelImportInspection) {
      console.log("Inspection OUT_General kept:", storeData.excelImportInspection.OUT_General?.kept_count);
      console.log("Inspection OUT_General discarded:", storeData.excelImportInspection.OUT_General?.discarded_count);
      console.log("Inspection OUT_preus kept:", storeData.excelImportInspection.OUT_preus?.kept_count);
    }
  }

  await browser.close();
})();
