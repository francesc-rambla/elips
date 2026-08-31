import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.text().includes('ERROR') || msg.text().includes('Python')) {
      console.log('[Browser Console]:', msg.type(), msg.text());
    }
  });
  page.on('pageerror', err => console.log('[Browser PageError]:', err.message));
  
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));
  
  // Go to Upload tab
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const uploadTab = btns.find(b => b.innerText.includes('Pujada') || b.innerText.includes('Fitxers') || b.innerText.includes('Inici'));
    if (uploadTab) uploadTab.click();
  });
  await new Promise(r => setTimeout(r, 500));
  
  // Find Excel file input
  const licitacioFile = path.resolve(__dirname, '../../../_plantilla_licitacio_elips.xlsx');
  const fileInputs = await page.$$('input[type="file"]');
  console.log('Found file inputs:', fileInputs.length);
  
  if (fileInputs.length > 0) {
    await fileInputs[0].uploadFile(licitacioFile);
    console.log('Uploaded _plantilla_licitacio_elips.xlsx...');
    await new Promise(r => setTimeout(r, 5000));
  }
  
  // Check if import modal appeared or if it auto-imported
  const modalVisible = await page.evaluate(() => {
    const modal = document.querySelector('.modal-overlay');
    return modal ? modal.style.display !== 'none' : false;
  });
  console.log('Import modal visible:', modalVisible);
  
  if (modalVisible) {
    console.log('Confirming import modal...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.modal-overlay button'));
      const confirmBtn = btns.find(b => b.innerText.includes('Importar') || b.innerText.includes('Continuar') || b.innerText.includes('Acceptar'));
      if (confirmBtn) confirmBtn.click();
    });
    await new Promise(r => setTimeout(r, 5000));
  }
  
  // Go to Data tab (Dades / Inspector)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const dadesTab = btns.find(b => b.innerText.includes('Dades') || b.innerText.includes('Inspector'));
    if (dadesTab) dadesTab.click();
  });
  await new Promise(r => setTimeout(r, 1000));
  
  // Inspect Store and DOM state
  const state = await page.evaluate(() => {
    const pName = localStorage.getItem('currentProjectName') || 'Default';
    const raw = localStorage.getItem(`${pName}:excelJsonData`);
    const parsed = raw ? JSON.parse(raw) : null;
    const accordions = Array.from(document.querySelectorAll('.accordion-item, .card, .sheet-card')).map(a => a.innerText.split('\n')[0]);
    const inputs = Array.from(document.querySelectorAll('input, textarea')).map(i => ({ 
      path: i.getAttribute('data-path') || i.name || i.placeholder, 
      val: i.value 
    })).filter(x => x.val);
    
    return {
      currentProject: pName,
      hasRawData: !!raw,
      sheetsInParsed: parsed ? Object.keys(parsed) : [],
      generalNomResponsable: parsed?.General?.nom_responsable,
      accordionsOnScreen: accordions,
      nonEmptyInputsOnScreen: inputs.slice(0, 15)
    };
  });
  
  console.log('Result state:', JSON.stringify(state, null, 2));
  
  await browser.close();
}

run().catch(console.error);
