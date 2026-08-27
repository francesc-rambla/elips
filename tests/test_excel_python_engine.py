import os
import sys
import unittest
import json
import tempfile
import re
from openpyxl import load_workbook, Workbook

class TestExcelPythonEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cls.js_file = os.path.join(cls.repo_root, "src", "composables", "useWasmEngines.js")
        cls.sample_excel = os.path.join(os.path.dirname(cls.repo_root), "prova_pressupost.xlsx")
        
        # Read JavaScript content
        with open(cls.js_file, "r", encoding="utf-8") as f:
            js_content = f.read()
            
        # Extract complete embedded Python code string pyCode from useWasmEngines.js
        p1_start = js_content.find("def sanitize_empty_jinja_tags")
        p1_end = js_content.find("await _pyodide.runPythonAsync(pyCode);")
        py_raw = js_content[p1_start:p1_end]
        cls.py_code = py_raw[:py_raw.rfind("`;")].strip()
        
        # Compile and execute Python code into exec_globals dictionary
        import jinja2
        from jinja2 import pass_context
        cls.exec_globals = {
            "load_workbook": load_workbook,
            "re": re,
            "json": json,
            "Environment": jinja2.Environment,
            "DebugUndefined": jinja2.DebugUndefined,
            "TemplateSyntaxError": jinja2.TemplateSyntaxError,
            "StrictUndefined": jinja2.StrictUndefined,
            "pass_context": pass_context
        }
        exec(cls.py_code, cls.exec_globals)
        
        cls.excel_to_json = staticmethod(cls.exec_globals["excel_to_json"])
        cls.update_excel_from_json = staticmethod(cls.exec_globals["update_excel_from_json"])
        cls.render_json_text = staticmethod(cls.exec_globals["render_json_text"])
        cls.render_md_two_pass_with_report = staticmethod(cls.exec_globals["render_md_two_pass_with_report"])

    def test_01_code_extraction(self):
        """Verifica que el codi Python s'ha tret correctament del Javascript de l'aplicació."""
        self.assertIn("excel_to_json", self.exec_globals)
        self.assertIn("update_excel_from_json", self.exec_globals)
        self.assertIn("render_md_two_pass_with_report", self.exec_globals)

    def test_02_excel_to_json_parsing(self):
        """Verifica el parsing d'Excel a JSON i la detecció de tipus kv i tabular."""
        if not os.path.exists(self.sample_excel):
            self.skipTest("Fitxer de mostra prova_pressupost.xlsx no trobat.")
            
        parsed = self.excel_to_json(self.sample_excel)
        self.assertIn("data", parsed)
        data = parsed["data"]
        
        # pres ha de ser a la rel de data i parts ha de ser una taula aniuada
        self.assertIn("pres", data)
        pres_data = data["pres"]
        self.assertEqual(pres_data["pressupost"], "Pressupost anual")
        self.assertIn("parts", pres_data)
        self.assertGreater(len(pres_data["parts"]), 0)
        
        # Comprovar que no s'ha afegit la clau no-identificadora 'pressupost' com a columna de parts
        first_part_row = pres_data["parts"][0]
        self.assertNotIn("pressupost", first_part_row)
        self.assertIn("id_partida", first_part_row)

    def test_03_update_excel_recursive_link_formulas_and_orfes(self):
        """Verifica l'exportació d'Excel, el seguiment recursiu de fórmules i la protecció amb full 'orfes'."""
        if not os.path.exists(self.sample_excel):
            self.skipTest("Fitxer de mostra prova_pressupost.xlsx no trobat.")

        parsed = self.excel_to_json(self.sample_excel)
        json_str = json.dumps(parsed["data"], ensure_ascii=False)

        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            orphan_count = self.update_excel_from_json(self.sample_excel, json_str, tmp_path)
            self.assertEqual(orphan_count, 9)

            wb = load_workbook(tmp_path, data_only=False)
            
            # 1. Verificar full orfes
            self.assertIn("orfes", wb.sheetnames)
            ws_orfes = wb["orfes"]
            self.assertEqual(ws_orfes.cell(1, 1).value, "Full")
            self.assertEqual(ws_orfes.cell(1, 3).value, "Fórmula Original")
            
            # Totes les fórmules del full orfes han de començar amb la cometa senzilla '
            for r in range(2, ws_orfes.max_row + 1):
                formula_val = str(ws_orfes.cell(r, 3).value or "")
                self.assertTrue(formula_val.startswith("'="), f"La fórmula a la fila {r} no comença per '=: {formula_val}")

            # 2. Verificar que OUT_pres conserva les fórmules d'enllaç simples sensa files en blanc
            self.assertIn("OUT_pres", wb.sheetnames)
            ws_out_pres = wb["OUT_pres"]
            self.assertEqual(ws_out_pres.cell(1, 1).value, "=pres!A1")
            self.assertEqual(ws_out_pres.cell(1, 2).value, "=pres!B1")
            self.assertEqual(ws_out_pres.cell(2, 1).value, "=pres!A2")

            # 3. Verificar que OUT_pres.parts conserva les fórmules d'enllaç sensa columnes en blanc
            self.assertIn("OUT_pres.parts", wb.sheetnames)
            ws_out_parts = wb["OUT_pres.parts"]
            self.assertEqual(ws_out_parts.cell(1, 1).value, "='pres.parts'!A1")
            self.assertEqual(ws_out_parts.cell(1, 2).value, "='pres.parts'!B1")

            # 4. Verificar que les fórmules complexes del full base pres.parts no s'han sobreescrit
            self.assertIn("pres.parts", wb.sheetnames)
            ws_pres_parts = wb["pres.parts"]
            formula_c2 = str(ws_pres_parts.cell(2, 3).value or "")
            self.assertTrue(formula_c2.startswith("=SUMIF"), f"La fórmula complexa a pres.parts!C2 ha sigut sobreescrita: {formula_c2}")

        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

if __name__ == "__main__":
    unittest.main()
