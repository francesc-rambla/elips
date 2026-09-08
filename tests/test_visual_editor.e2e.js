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

// Exercises the Visual tab as of Phase A of its CodeMirror-based rewrite
// (see /home/frambla/.claude/plans/unified-nibbling-adleman.md): a second
// CodeMirror 6 EditorView over the exact same editorText as the Codi tab,
// not a contenteditable canvas compiled from/reconstructed via HTML. As of
// this phase the Visual tab shows plain (syntax-highlighted) source text —
// no chip/block widgets yet, those land in later phases (B: plain
// Markdown styling, C: variable chips, D: Jinja blocks, E: set/math, F:
// tables, G: metadata/special chars) and should extend, not replace, the
// checks below.
//
// This file used to test rich HTML rendering (bold/list/jinja-block/
// var-chip), an HTML-to-Markdown paste conversion, and a chip-aware copy —
// all specific to the old contenteditable canvas, which no longer exists.
// Those are deliberately not re-tested here; they'll come back scoped to
// whichever phase reintroduces each capability.
//
// Note: DataInspector.vue also mounts its own (normally hidden) TemplateEditor
// instance for cell editing, so the page always has *two* CodeMirror Visual
// containers/tab-switcher button pairs. Everything below scopes to the visible
// one (offsetParent !== null) — the main template editor — to avoid
// accidentally driving the hidden cell-mode instance instead.
async function testVisualEditor() {
  console.log('🚀 Testing Visual Editor (Phase A: CodeMirror-based rewrite, plain text)...');
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
  // Under CPU/memory pressure, WASM (Pyodide+Pandoc) init -- which the
  // Visual tab's own mount doesn't strictly depend on, but which competes
  // for the same main thread -- can take far longer than any fixed sleep;
  // wait for a real readiness signal instead (same convention
  // e2e_browser.e2e.js already uses).
  await page.waitForFunction(() => window.store?.enginesReady === true, { timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.code-editor-wrapper .cm-content')).some((el) => el.offsetParent !== null), { timeout: 20000 }).catch(() => {});

  await page.evaluate(() => {
    window.__visualEditorTest = {
      // The Visual tab's CodeMirror content DOM (the visible, main-editor
      // instance — see the note above about the hidden cell-mode twin).
      visualContent: () => Array.from(document.querySelectorAll('.code-editor-wrapper .cm-content')).find((el) => el.offsetParent !== null),
      clickTab: (label) => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => b.offsetParent !== null && b.textContent.trim() === label);
        if (!btn) throw new Error(`Botó de pestanya "${label}" no trobat (visible)`);
        btn.click();
      },
    };
  });

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

  const visualText = await page.evaluate(() => window.__visualEditorTest.visualContent()?.textContent || null);
  if (!visualText) throw new Error('No s\'ha trobat el contenidor visible de CodeMirror a la pestanya Visual');
  // Since Phase D, "{% for ... %}" no longer appears literally in the
  // rendered DOM's textContent -- its whole line is replaced by a
  // .j-block-head widget (see the plan's block-widget design), same as
  // "{{ ... }}" chips since Phase C. The underlying document/editorText
  // (checked below via window.store.templateText, never the rendered DOM)
  // is what must never lose that raw text.
  if (!visualText.includes('**negreta**')) {
    throw new Error('El text font no es mostra correctament a la pestanya Visual: ' + visualText);
  }
  const hasForBlockWidget = await page.evaluate(() => !!window.__visualEditorTest.visualContent()?.querySelector('.j-block-head-for'));
  if (!hasForBlockWidget) throw new Error('El bloc "{% for %}" no s\'ha renderitzat com a widget a la pestanya Visual');
  console.log('  ✓ La pestanya Visual mostra el text font (CodeMirror) i el bloc FOR com a widget, sense errors.');

  // Round-trip: switch to Code, back to Visual, verify source text is intact
  // (this is exactly Phase A's own acceptance criterion: tab switches must
  // never corrupt or lose content, now that both tabs share one text
  // buffer instead of reconstructing Markdown from edited HTML).
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

  // Typing directly into the Visual tab must land in the shared source
  // exactly, same as the Codi tab -- there's no separate HTML
  // representation to keep in sync anymore.
  console.log('➡️ 3. Escriure directament a la pestanya Visual actualitza el text font...');
  await page.evaluate(() => window.__visualEditorTest.clickTab('Visual'));
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => window.__visualEditorTest.visualContent().focus());
  await page.keyboard.press('End');
  await page.keyboard.type('{{ afegit_des_de_visual }}');
  await new Promise((r) => setTimeout(r, 300));
  const textAfterTyping = await page.evaluate(() => window.store.templateText);
  if (!textAfterTyping.includes('{{ afegit_des_de_visual }}')) {
    throw new Error('El text escrit a la pestanya Visual no s\'ha reflectit al text font: ' + textAfterTyping);
  }
  console.log('  ✓ Escriure a Visual actualitza editorText/store.templateText correctament.');

  // Undo across a tab switch: the undo/redo history is shared regardless
  // of which tab produced an edit (useEditHistory.js).
  console.log('➡️ 4. Desfer després d\'escriure a Visual i canviar a Codi...');
  await page.evaluate(() => window.__visualEditorTest.clickTab('Codi'));
  await new Promise((r) => setTimeout(r, 300));
  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 300));
  const textAfterUndo = await page.evaluate(() => window.store.templateText);
  if (textAfterUndo.includes('{{ afegit_des_de_visual }}')) {
    throw new Error('Ctrl+Z des de la pestanya Codi no ha desfet el text escrit prèviament a Visual: ' + textAfterUndo);
  }
  console.log('  ✓ Ctrl+Z desfà un canvi fet a Visual encara que ara s\'estigui a la pestanya Codi.');

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
    const content = Array.from(document.querySelectorAll('.code-editor-wrapper .cm-content')).find((el) => el.offsetParent !== null);
    content.focus();
  });
  await page.keyboard.press('End');
  await page.keyboard.type(' MODIFICAT');
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
    return { count: visible.length, hasEditor: visible.some((m) => !!m.querySelector('.code-editor-wrapper')) };
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
