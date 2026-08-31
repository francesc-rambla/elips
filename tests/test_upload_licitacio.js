import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function test() {
  const browser = await puppeteer.launch({ 
    headless: 'new', 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('[Console]:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('[PageError]:', err.message));
  
  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));
  
  // Find which input accepts .xlsx
  const fileInput = await page.$('input[accept*=".xlsx"]');
  console.log('Found xlsx input:', !!fileInput);
  
  const licitacioFile = '/home/francesc/documents/md/_plantilla_licitacio_elips.xlsx';
  await fileInput.uploadFile(licitacioFile);
  console.log('Uploaded file, waiting 6s...');
  await new Promise(r => setTimeout(r, 6000));
  
  // Check if warning modal appeared
  const modalText = await page.evaluate(() => {
    const m = document.querySelector('.modal-overlay[style*="display: flex"], .modal-overlay:not([style*="display: none"])');
    return m ? m.innerText : null;
  });
  console.log('Modal text:', modalText);
  
  // If modal text contains 'sobreescriure' or 'Atenció', click Confirm button
  if (modalText) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.modal-overlay button'));
      const btn = btns.find(b => b.innerText.includes('Sobreescriure') || b.innerText.includes('Acceptar') || b.innerText.includes('Continuar') || b.innerText.includes('Importar'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 4000));
  }
  
  // Check localStorage and store data
  const data = await page.evaluate(() => {
    const pName = localStorage.getItem('currentProjectName') || 'Default';
    const raw = localStorage.getItem(`${pName}:excelJsonData`);
    return {
      pName,
      rawLength: raw ? raw.length : 0,
      parsed: raw ? JSON.parse(raw) : null
    };
  });
  
  console.log('Loaded data summary:', {
    pName: data.pName,
    rawLength: data.rawLength,
    sheets: data.parsed ? Object.keys(data.parsed) : [],
    general: data.parsed?.General
  });
  
  await browser.close();
}

test().catch(console.error);
