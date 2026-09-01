import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'elips_test_fixture.xlsx');

async function testProjectWorkflow() {
  if (!fs.existsSync(FIXTURE_FILE)) {
    throw new Error(`Fixture no trobada a ${FIXTURE_FILE}. Executa primer: python3 tests/fixtures/generate_workbook.py`);
  }
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.text().includes('[INFO]') || msg.text().includes('[SUCCESS]') || msg.text().includes('[ERROR]')) {
      console.log(`[Browser ${msg.type()}]:`, msg.text());
    }
  });
  page.on('pageerror', err => console.log('[Browser Error]:', err.message));
  
  page.on('dialog', async dialog => {
    console.log(`[Dialog ${dialog.type()}]:`, dialog.message());
    await dialog.accept('ProjecteLicitacio');
  });
  
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));
  
  // 1. Create a new project called "ProjecteLicitacio"
  console.log('➡️ 1. Creant nou projecte ProjecteLicitacio...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const projBtn = btns.find(b => b.innerText.includes('Projecte') || b.title?.includes('Projecte'));
    if (projBtn) projBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));
  
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder*="Nou nom"], input[placeholder*="nom del projecte"]');
    if (input) {
      input.value = 'ProjecteLicitacio';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const btns = Array.from(document.querySelectorAll('.modal-overlay button'));
    const createBtn = btns.find(b => b.innerText.includes('Crear'));
    if (createBtn) createBtn.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  // 2. Upload the generated fixture workbook
  console.log('➡️ 2. Carregant la fixture generada elips_test_fixture.xlsx al projecte ProjecteLicitacio...');
  const fileInput = await page.$('input[accept*=".xlsx"]');
  await fileInput.uploadFile(FIXTURE_FILE);
  await new Promise(r => setTimeout(r, 5000));
  
  // 3. Switch to "Dades" tab
  console.log('➡️ 3. Comprovant dades a la pestanya Dades...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const dadesTab = btns.find(b => b.innerText.includes('Dades') || b.innerText.includes('Inspector'));
    if (dadesTab) dadesTab.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  const initialData = await page.evaluate(() => {
    const pName = localStorage.getItem('currentProjectName') || 'Default';
    const raw = localStorage.getItem(`${pName}:excelJsonData`);
    const parsed = raw ? JSON.parse(raw) : null;
    const inputs = Array.from(document.querySelectorAll('input, textarea')).map(i => ({
      path: i.getAttribute('data-path'),
      val: i.value
    })).filter(x => x.path);
    return {
      currentProject: pName,
      hasRawData: !!raw,
      sheets: parsed ? Object.keys(parsed) : [],
      general: parsed?.General,
      inputsOnScreen: inputs.slice(0, 10)
    };
  });
  console.log('  ✓ Dades inicials carregades:', {
    project: initialData.currentProject,
    sheets: initialData.sheets.length,
    nom_responsable: initialData.general?.nom_responsable,
    inputsCount: initialData.inputsOnScreen.length
  });

  if (!initialData.general?.nom_responsable) {
    throw new Error("ERROR: nom_responsable no s'ha carregat a General!");
  }

  // 4. Switch to project "Default" and back to "ProjecteLicitacio"
  console.log('➡️ 4. Canviant a projecte Default i tornant a ProjecteLicitacio...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const projBtn = btns.find(b => b.innerText.includes('Projecte') || b.title?.includes('Projecte'));
    if (projBtn) projBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));
  
  await page.evaluate(() => {
    const pCards = Array.from(document.querySelectorAll('.project-card, .list-item, div[style*="cursor: pointer"]'));
    const defCard = pCards.find(c => c.innerText.includes('Default'));
    const loadBtn = defCard?.querySelector('button');
    if (loadBtn) loadBtn.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  // Switch back to ProjecteLicitacio
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const projBtn = btns.find(b => b.innerText.includes('Projecte') || b.title?.includes('Projecte'));
    if (projBtn) projBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));
  
  await page.evaluate(() => {
    const pCards = Array.from(document.querySelectorAll('.project-card, .list-item, div[style*="cursor: pointer"]'));
    const licCard = pCards.find(c => c.innerText.includes('ProjecteLicitacio'));
    const loadBtn = licCard?.querySelector('button');
    if (loadBtn) loadBtn.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  // 5. Verify data is intact after switching projects
  const switchedData = await page.evaluate(() => {
    const pName = localStorage.getItem('currentProjectName') || 'Default';
    const raw = localStorage.getItem(`${pName}:excelJsonData`);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      currentProject: pName,
      nom_responsable: parsed?.General?.nom_responsable
    };
  });
  console.log('  ✓ Dades després de canviar i recarregar projecte:', switchedData);
  if (switchedData.nom_responsable !== 'Anna Puig Soler') {
    throw new Error("ERROR: Les dades s'han perdut en canviar de projecte!");
  }

  // 6. Reload browser and check persistence
  console.log('➡️ 5. Recarregant navegador completament per comprovar persistència...');
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.localStorage !== 'undefined');
  await new Promise(r => setTimeout(r, 3000));

  const reloadedData = await page.evaluate(() => {
    const pName = localStorage.getItem('currentProjectName') || 'Default';
    const raw = localStorage.getItem(`${pName}:excelJsonData`);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      currentProject: pName,
      nom_responsable: parsed?.General?.nom_responsable
    };
  });
  console.log('  ✓ Dades després de recarregar el navegador:', reloadedData);
  if (reloadedData.nom_responsable !== 'Anna Puig Soler') {
    throw new Error("ERROR: Les dades s'han perdut després del reload!");
  }

  console.log('\n🎉 TOTES LES PROVES DE CÀRREGA DE PROJECTES I PERSISTÈNCIA HAN PASSAT CORRECTAMENT!');
  await browser.close();
}

testProjectWorkflow().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
