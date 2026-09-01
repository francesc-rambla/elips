// Builds a self-contained project ZIP fixture (project.json manifest +
// generated .xlsx + a .md.j2 template) in the exact shape App.vue's
// importProjectZip() expects, so e2e tests can exercise the full
// "gestió de projectes ZIP" flow without depending on any external,
// untracked, or machine-specific file.
//
// Run after generate_workbook.py has produced elips_test_fixture.xlsx:
//   python3 tests/fixtures/generate_workbook.py
//   node tests/fixtures/generate_project_zip.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_NAME = 'ElipsTestProject';
export const DOC_NAME = 'Document Principal';
export const EXCEL_FILE_NAME = 'elips_test_fixture.xlsx';
export const ZIP_PATH = path.join(__dirname, 'elips_test_project.zip');

export async function buildProjectZip() {
  const excelPath = path.join(__dirname, EXCEL_FILE_NAME);
  const templatePath = path.join(__dirname, 'sample_template.md.j2');

  if (!fs.existsSync(excelPath)) {
    throw new Error(`Fixture Excel no trobada a ${excelPath}. Executa primer generate_workbook.py.`);
  }

  const zip = new JSZip();
  const manifest = {
    projectName: PROJECT_NAME,
    activeDocName: DOC_NAME,
    documentsList: [DOC_NAME],
    excelFileName: EXCEL_FILE_NAME,
    created: new Date().toISOString(),
  };
  zip.file('project.json', JSON.stringify(manifest, null, 2));
  zip.file(EXCEL_FILE_NAME, fs.readFileSync(excelPath));
  zip.folder('documents').file(`${DOC_NAME}.md.j2`, fs.readFileSync(templatePath, 'utf-8'));

  const content = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(ZIP_PATH, content);
  return ZIP_PATH;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildProjectZip().then((p) => console.log(`Paquet ZIP de projecte generat: ${p}`));
}
