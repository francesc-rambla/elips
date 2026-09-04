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

// Exercises the visual editor rewrite (markdown-it + turndown based compiler,
// Markdown-as-priority clipboard model) against the real app in a real
// browser: rendering, tab-switch round-trip stability, pasting rich HTML
// (converted to Markdown, never kept as HTML), and copying (source text on
// the clipboard, not styled HTML).
//
// Note: DataInspector.vue also mounts its own (normally hidden) TemplateEditor
// instance for cell editing, so the page always has *two* ".editor-textarea"
// elements/tab-switcher button pairs. Everything below scopes to the visible
// one (offsetParent !== null) — the main template editor — to avoid
// accidentally driving the hidden cell-mode instance instead.
async function testVisualEditor() {
  console.log('🚀 Testing Visual Editor (Markdown/Jinja2 <-> HTML compiler rewrite)...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('LaTeX')) {
      console.log('  [Console Error]:', msg.text());
    }
  });
  let hadPageError = false;
  page.on('pageerror', (err) => { hadPageError = true; console.log('  [Page Error]:', err.message); });

  await page.goto('http://localhost:8000/index.html', { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1500));

  await page.evaluate(() => {
    window.__visualEditorTest = {
      canvas: () => Array.from(document.querySelectorAll('.editor-textarea[contenteditable="true"]')).find((el) => el.offsetParent !== null),
      clickTab: (label) => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => b.offsetParent !== null && b.textContent.trim() === label);
        if (!btn) throw new Error(`Botó de pestanya "${label}" no trobat (visible)`);
        btn.click();
      },
    };
  });

  // Inject data + a template with a for-loop, a var chip, bold text and a
  // nested list, and switch to the Template tab / Visual sub-tab.
  console.log('➡️ 1. Carregant dades i plantilla d\'exemple, obrint l\'editor visual...');
  await page.evaluate(() => {
    window.store.excelJsonData = {
      pres: { parts: [{ nom: 'Equips', import: 45000 }, { nom: 'Portàtils', import: 30000 }] },
    };
    window.store.templateText = [
      '# Memòria',
      '',
      'Un text amb **negreta** i una llista:',
      '',
      '- U',
      '  - U.1',
      '- Dos',
      '',
      '{% for part in pres.parts %}',
      '- {{ part.nom }}: {{ part.import }}',
      '{% endfor %}',
      '',
    ].join('\n');
    window.store.activeTab = 'template';
  });
  await new Promise((r) => setTimeout(r, 800));

  const rendered = await page.evaluate(() => window.__visualEditorTest.canvas()?.innerHTML || null);
  if (!rendered) throw new Error('No s\'ha trobat el canvas visible de l\'editor visual');
  if (!rendered.includes('<strong>negreta</strong>')) throw new Error('La negreta no s\'ha renderitzat: ' + rendered);
  if ((rendered.match(/<ul>/g) || []).length < 2) throw new Error('La llista aniuada no té 2 nivells de <ul>: ' + rendered);
  if (!rendered.includes('class="jinja-block"') || !rendered.includes('data-type="for"')) {
    throw new Error('El bloc {% for %} no s\'ha renderitzat com a jinja-block: ' + rendered);
  }
  if (!rendered.includes('class="j-var-chip"') || !rendered.includes('data-raw="part.nom"')) {
    throw new Error('El xip de variable part.nom no s\'ha renderitzat: ' + rendered);
  }
  console.log('  ✓ Capçalera, negreta, llista aniuada, bloc for i xip de variable renderitzats correctament.');

  // Round-trip: switch to Code, back to Visual, verify source text is intact
  // (this is exactly the scenario fix #1 from earlier today protects: tab
  // switches must not corrupt or lose content).
  console.log('➡️ 2. Verificant estabilitat del cicle Visual -> Codi -> Visual...');
  await page.evaluate(() => window.__visualEditorTest.clickTab('Codi'));
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => window.__visualEditorTest.clickTab('Visual'));
  await new Promise((r) => setTimeout(r, 300));

  const textAfterRoundtrip = await page.evaluate(() => window.store.templateText);
  if (!textAfterRoundtrip.includes('{% for part in pres.parts %}') || !textAfterRoundtrip.includes('**negreta**')) {
    throw new Error('El text font s\'ha corromput després del cicle Visual->Codi->Visual: ' + textAfterRoundtrip);
  }
  console.log('  ✓ El text font es manté intacte després de canviar de pestanya diverses vegades.');

  // Paste: simulate pasting Word-like HTML (bold + nested list) via a
  // synthetic ClipboardEvent, and verify it lands in the source as clean
  // Markdown — never as raw HTML inside editorText/templateText.
  console.log('➡️ 3. Simulant enganxar HTML tipus Word (negreta + llista aniuada)...');
  await page.evaluate(() => {
    const canvas = window.__visualEditorTest.canvas();
    canvas.focus();
    const range = document.createRange();
    range.selectNodeContents(canvas);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const dt = new DataTransfer();
    dt.setData('text/html', '<p>Text enganxat amb <strong>fort</strong>.</p><ul><li>A<ul><li>A1</li></ul></li></ul>');
    dt.setData('text/plain', 'Text enganxat amb fort.');
    const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    canvas.dispatchEvent(pasteEvent);
  });
  await new Promise((r) => setTimeout(r, 500));

  const textAfterPaste = await page.evaluate(() => window.store.templateText);
  if (!textAfterPaste.includes('**fort**')) throw new Error('El text enganxat no s\'ha convertit a Markdown (negreta): ' + textAfterPaste);
  if (textAfterPaste.includes('<p>') || textAfterPaste.includes('<ul>') || textAfterPaste.includes('<strong>')) {
    throw new Error('S\'ha filtrat HTML cru dins del text font en enganxar: ' + textAfterPaste);
  }
  console.log('  ✓ El HTML enganxat s\'ha convertit a Markdown net, sense HTML cru dins del text font.');

  // Copy: select the rendered var chip's surrounding text and verify the
  // clipboard receives Markdown/Jinja2 source, not HTML.
  console.log('➡️ 4. Verificant que copiar des del canvas posa codi font (no HTML) al porta-retalls...');
  const copiedText = await page.evaluate(() => {
    const canvas = window.__visualEditorTest.canvas();
    const chip = canvas.querySelector('.j-var-chip[data-raw="part.nom"]');
    if (!chip) return null;
    const range = document.createRange();
    range.selectNode(chip);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const dt = new DataTransfer();
    const copyEvent = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: dt });
    canvas.dispatchEvent(copyEvent);
    return dt.getData('text/plain');
  });
  if (copiedText !== '{{ part.nom }}') {
    throw new Error(`Copiar el xip hauria de posar "{{ part.nom }}" al porta-retalls, s'ha obtingut: ${JSON.stringify(copiedText)}`);
  }
  console.log('  ✓ Copiar des del canvas posa el codi font Markdown/Jinja2 al porta-retalls:', JSON.stringify(copiedText));

  // Regression: DataInspector.vue's cell-text editor modal embeds this same
  // TemplateEditor (isCellMode), which can itself open an inner modal (e.g.
  // the table config modal). Escape used to close BOTH at once (both
  // components listened for it on `window`, and nothing stopped
  // propagation), discarding whatever the user had just typed; the outer
  // modal also never asked before discarding unsaved edits on its own.
  console.log('➡️ 5. Esc dins un modal aniuat (editor de cel·la -> modal de Taula) només tanca el superior, i demana confirmació si hi ha canvis...');
  const dialogs = [];
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });

  await page.evaluate(() => {
    window.store.excelJsonData = { General: { descripcio: 'Text inicial' } };
    window.store.editorMetadata = [{ group: 'General', element: 'descripcio', type: 'Text' }];
    window.store.activeTab = 'data';
  });
  await new Promise((r) => setTimeout(r, 500));

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.title === 'Edició complexa en Markdown + Jinja2');
    if (!btn) throw new Error('Botó d\'edició de cel·la no trobat');
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  await page.evaluate(() => {
    const canvas = Array.from(document.querySelectorAll('.editor-textarea[contenteditable="true"]')).find((el) => el.offsetParent !== null);
    canvas.focus();
    document.execCommand('insertText', false, ' MODIFICAT');
  });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.title === "Insereix taula automàtica des de l'Excel" && b.offsetParent !== null);
    if (!btn) throw new Error('Botó Taula no trobat');
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  const visibleModalCount = () => document.querySelectorAll('.modal-overlay').length
    - Array.from(document.querySelectorAll('.modal-overlay')).filter((o) => getComputedStyle(o).display === 'none').length;

  const countBeforeEscape = await page.evaluate(visibleModalCount);
  if (countBeforeEscape !== 2) throw new Error(`Esperava 2 modals oberts (cel·la + taula), n'hi ha ${countBeforeEscape}`);

  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 300));
  const stateAfterFirstEscape = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('.modal-overlay')).filter((o) => getComputedStyle(o).display !== 'none');
    return { count: visible.length, hasEditor: visible.some((m) => !!m.querySelector('.editor-textarea')) };
  });
  if (stateAfterFirstEscape.count !== 1 || !stateAfterFirstEscape.hasEditor) {
    throw new Error('El primer Esc hauria d\'haver tancat només el modal de Taula, deixant el de cel·la obert amb els canvis: ' + JSON.stringify(stateAfterFirstEscape));
  }
  console.log('  ✓ El primer Esc només tanca el modal de Taula (el superior).');

  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 300));
  if (dialogs.length !== 1) throw new Error('Esperava un diàleg de confirmació abans de descartar canvis pendents, n\'hi ha ' + dialogs.length);
  const countAfterDismiss = await page.evaluate(visibleModalCount);
  if (countAfterDismiss !== 1) throw new Error('El modal de cel·la s\'ha tancat tot i haver cancel·lat la confirmació');
  console.log('  ✓ Amb canvis pendents, Esc demana confirmació abans de tancar; en cancel·lar-la, el modal roman obert.');

  if (hadPageError) throw new Error('S\'ha produït un error de pàgina no capturat durant aquesta prova.');

  await browser.close();
  console.log('🎉 TOTES LES PROVES DE L\'EDITOR VISUAL HAN PASSAT AMB ÈXIT!');
}

testVisualEditor().catch((err) => {
  console.error('❌ ERROR EN PROVES:', err);
  process.exit(1);
});
