import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

(async () => {
  console.log("🚀 Iniciant Test de Recuperació de Projecte ZIP ('projecte_DonaTIC.zip') i Còpia Horària...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  page.on('dialog', async dialog => {
    console.log(`  [DIALOG] ${dialog.type()}: "${dialog.message()}"`);
    await dialog.accept();
  });

  page.on('console', msg => {
    const txt = msg.text();
    if (!txt.includes('LaTeX') && !txt.includes('metrics')) {
      // console.log(`  [LOG] ${txt}`);
    }
  });

  // 1. Load application
  await page.goto("http://localhost:8000/index.html", { waitUntil: "networkidle2" });
  await new Promise(r => setTimeout(r, 2000));

  // 2. Clear previous session state for clean test
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle2" });
  await new Promise(r => setTimeout(r, 2000));

  console.log("➡️ 1. Important paquet ZIP '/home/francesc/documents/md/projecte_DonaTIC.zip'...");
  const zipInput = await page.$('input[type="file"][accept*=".zip"]');
  if (!zipInput) {
    throw new Error("No s'ha trobat l'input per carregar fitxers ZIP.");
  }
  await zipInput.uploadFile("/home/francesc/documents/md/projecte_DonaTIC.zip");

  // Wait until engines are ready and excelJsonData has parsed the DonaTIC project data
  console.log("  • Esperant que es completi el parseig de l'Excel i la restauració del projecte...");
  await page.waitForFunction(() => {
    return window.store?.excelJsonData?.General?.nom_responsable && 
           window.store.excelJsonData.General.nom_responsable.length > 0 && 
           window.store?.templateFileName && 
           window.store.templateFileName.includes('Memòria');
  }, { timeout: 45000 });
  await new Promise(r => setTimeout(r, 1000));

  // 3. Inspect loaded store state
  const projectState = await page.evaluate(() => {
    const store = window.store;
    const general = JSON.parse(JSON.stringify(store?.excelJsonData?.General || {}));
    const objecte = JSON.parse(JSON.stringify(store?.excelJsonData?.Objecte || {}));
    return {
      currentProjectName: localStorage.getItem('currentProjectName'),
      activeDocName: localStorage.getItem('DonaTIC:activeDocName'),
      documentsList: JSON.parse(localStorage.getItem('DonaTIC:documentsList') || '[]'),
      excelFileName: store?.excelFileName,
      generalNomResponsable: general.nom_responsable,
      generalModalitat: general.modalitat,
      generalData: general,
      objecteTitle: objecte.objecte,
      objecteData: objecte,
      templateFileName: store?.templateFileName,
      templateTextSnippet: store?.templateText?.slice(0, 150),
      editorMetadataCount: store?.editorMetadata?.length || 0,
      sheetInfoCount: store?.sheetInfo?.length || 0,
      hasHistory: !!(localStorage.getItem('DonaTIC:version_history_v1'))
    };
  });

  console.log("  • Nom del projecte actiu:", projectState.currentProjectName);
  console.log("  • Document actiu:", projectState.activeDocName);
  console.log("  • Documents del projecte:", projectState.documentsList);
  console.log("  • Nom responsable:", projectState.generalData?.nom_responsable);
  console.log("  • Modalitat:", projectState.generalData?.modalitat);
  console.log("  • Objecte:", projectState.objecteData?.objecte?.slice(0, 80));
  console.log("  • Fitxer de plantilla carregat:", projectState.templateFileName);
  console.log("  • Regles de metadades del model (editor_metadata):", projectState.editorMetadataCount);
  console.log("  • Estructures de pestanyes (_sheet_info):", projectState.sheetInfoCount);

  if (projectState.currentProjectName !== 'DonaTIC') {
    throw new Error(`El nom del projecte hauria de ser 'DonaTIC', però és '${projectState.currentProjectName}'`);
  }
  if (!projectState.generalData?.nom_responsable || !projectState.generalData.nom_responsable.includes("Mónica")) {
    throw new Error(`General.nom_responsable no s'ha recuperat correctament: '${projectState.generalData?.nom_responsable}'`);
  }
  if (!projectState.objecteData?.objecte || !projectState.objecteData.objecte.includes("DonaTIC")) {
    throw new Error(`Objecte.objecte no s'ha recuperat correctament: '${projectState.objecteData?.objecte}'`);
  }
  if (!projectState.templateFileName || !projectState.templateFileName.includes("Memòria")) {
    throw new Error(`La plantilla no s'ha restaurat correctament: '${projectState.templateFileName}'`);
  }
  if (projectState.editorMetadataCount === 0) {
    throw new Error("Les metadades del model (editor_metadata) no s'han recuperat des del full de càlcul!");
  }
  if (projectState.sheetInfoCount === 0) {
    throw new Error("L'estructura de pestanyes (_sheet_info) no s'ha recuperat des del full de càlcul!");
  }

  console.log("  ✓ Dades de l'Excel, metadades del model i plantilla recuperades al 100%!");

  // Prova de restauració explícita de configuració des de l'Excel
  console.log("➡️ Provant acció explícita de restauració de configuració des de l'Excel...");
  const restoreRes = await page.evaluate(async () => {
    try {
      if (typeof window.__restoreConfigFromExcel === 'function') {
        const r = await window.__restoreConfigFromExcel();
        return { success: r };
      }
      if (typeof window.store?.dataActions?.restoreConfigFromExcel === 'function') {
        const r = await window.store.dataActions.restoreConfigFromExcel();
        return { success: r };
      }
      return { success: false, reason: 'no function' };
    } catch (e) {
      return { success: false, error: e.message, stack: e.stack };
    }
  });
  console.log("  • Resultat de restoreConfigFromExcel:", restoreRes);
  if (!restoreRes.success) {
    throw new Error(`L'acció restoreConfigFromExcel ha fallat: ${JSON.stringify(restoreRes)}`);
  }
  console.log("  ✓ Acció 'Restaura de l'Excel' executada i verificada amb èxit!");

  // 4. Test rendering the restored template
  console.log("➡️ 2. Verificant generació de document Markdown a partir de les dades restaurades...");
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Genera Document"));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 4000));

  const renderState = await page.evaluate(() => {
    const store = window.store;
    return {
      renderedLength: store?.renderedMarkdown?.length || 0,
      previewSnippet: store?.renderedMarkdown?.slice(0, 200),
      issuesCount: store?.issues?.length || 0
    };
  });

  console.log("  • Longitud del Markdown generat:", renderState.renderedLength);
  console.log("  • Snippet del document:", renderState.previewSnippet?.replace(/\n/g, ' '));
  if (renderState.renderedLength < 1000) {
    throw new Error(`El Markdown generat és massa curt o ha fallat: ${renderState.renderedLength} caràcters.`);
  }
  console.log("  ✓ Document Jinja2 generat amb èxit!");

  // 5. Test Version History & Hourly Snapshot
  console.log("➡️ 3. Verificant sistema d'històric i còpies horàries automàtiques...");
  const historyCheck = await page.evaluate(() => {
    const raw = localStorage.getItem('DonaTIC:version_history_v1');
    const list = raw ? JSON.parse(raw) : [];
    return {
      count: list.length,
      firstSnap: list[0] ? { type: list[0].type, note: list[0].note, time: list[0].displayTime } : null
    };
  });

  console.log("  • Nombre de punts de control a l'històric:", historyCheck.count);
  console.log("  • Primer punt de control:", historyCheck.firstSnap);
  if (historyCheck.count === 0) {
    throw new Error("L'històric de versions no s'ha inicialitzat.");
  }
  console.log("  ✓ Històric de versions i snapshots actius!");

  console.log("🎉 TOTES LES PROVES DE RECUPERACIÓ I CÒPIA DE SEGURETAT HAN PASSAT AMB ÈXIT!");
  await browser.close();
})();
