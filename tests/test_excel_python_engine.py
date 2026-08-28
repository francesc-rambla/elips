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
        p1_marker = "const pyCode = `"
        p1_start = js_content.find(p1_marker)
        if p1_start != -1:
            p1_start += len(p1_marker)
        else:
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
            self.assertIn(ws_out_parts.cell(1, 1).value, ("=pres.parts!A1", "='pres.parts'!A1"))
            self.assertIn(ws_out_parts.cell(1, 2).value, ("=pres.parts!B1", "='pres.parts'!B1"))

            # 4. Verificar que les fórmules complexes del full base pres.parts no s'han sobreescrit
            self.assertIn("pres.parts", wb.sheetnames)
            ws_pres_parts = wb["pres.parts"]
            formula_c2 = str(ws_pres_parts.cell(2, 3).value or "")
            self.assertTrue(formula_c2.startswith("=SUMIF"), f"La fórmula complexa a pres.parts!C2 ha sigut sobreescrita: {formula_c2}")

        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_04_licitacio_plantilla_no_cartesian_explosion(self):
        """Verifica que fitxers complexos com _plantilla_licitacio_elips.xlsx no generen duplicacions cartesianes."""
        licitacio_path = os.path.join(os.path.dirname(self.repo_root), "_plantilla_licitacio_elips.xlsx")
        if not os.path.exists(licitacio_path):
            self.skipTest("Fitxer _plantilla_licitacio_elips.xlsx no trobat.")

        parsed = self.excel_to_json(licitacio_path)
        json_str = json.dumps(parsed["data"], ensure_ascii=False)
        
        # El JSON de dades per a la plantilla complexa ha d'ocupar menys d'1 MB (evitant l'explosió d'11 MB)
        self.assertLess(len(json_str), 1024 * 1024, f"JSON de dades massa gran: {len(json_str)} bytes")

        # Comprovar que els subcriteris de la primera fila no s'han duplicat 400 vegades a cada fila
        criteris = parsed["data"].get("Criteris", [])
        self.assertGreater(len(criteris), 0)
        sub_count = len(criteris[0].get("Subcriteris", []))
        self.assertLessEqual(sub_count, 10, f"Nombre de subcriteris anòmals per a la fila 0: {sub_count}")

    def test_05_update_excel_licitacio_merged_cells(self):
        """Verifica l'exportació d'Excel per a plantilles amb cel·les fusionades (MergedCell) com General i Pressupost."""
        licitacio_path = os.path.join(os.path.dirname(self.repo_root), "_plantilla_licitacio_elips.xlsx")
        if not os.path.exists(licitacio_path):
            self.skipTest("Fitxer _plantilla_licitacio_elips.xlsx no trobat.")

        parsed = self.excel_to_json(licitacio_path)
        json_str = json.dumps(parsed["data"], ensure_ascii=False)

        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            # L'exportació no ha de llençar cap error d'AttributeError MergedCell
            orphan_count = self.update_excel_from_json(licitacio_path, json_str, tmp_path)
            self.assertIsInstance(orphan_count, int)
            self.assertTrue(os.path.exists(tmp_path))
            self.assertGreater(os.path.getsize(tmp_path), 0)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_06_licitacio_exact_preservation_diff_check(self):
        """Verifica que tots els fulls de _plantilla_licitacio_elips.xlsx es conserven idèntics sense columnes ni files esborrades."""
        licitacio_path = os.path.join(os.path.dirname(self.repo_root), "_plantilla_licitacio_elips.xlsx")
        if not os.path.exists(licitacio_path):
            self.skipTest("Fitxer _plantilla_licitacio_elips.xlsx no trobat.")

        parsed = self.excel_to_json(licitacio_path)
        json_str = json.dumps(parsed["data"], ensure_ascii=False)

        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            self.update_excel_from_json(licitacio_path, json_str, tmp_path)
            
            wb_orig = load_workbook(licitacio_path, data_only=False)
            wb_out = load_workbook(tmp_path, data_only=False)

            # Comprovar fulls clau que abans es corrompien
            for s_name in ["OUT_General", "OUT_Lots", "OUT_Mesa", "OUT_pres", "OUT_pres.parts", "OUT_pres.parts.activitats", "OUT_pres.parts.activitats.costs", "OUT_Criteris", "OUT_Criteris.Subcriteris"]:
                self.assertIn(s_name, wb_out.sheetnames)
                ws_orig = wb_orig[s_name]
                ws_out = wb_out[s_name]
                self.assertEqual(ws_orig.max_row, ws_out.max_row, f"Nombre de files diferent al full {s_name}: {ws_orig.max_row} vs {ws_out.max_row}")
                self.assertEqual(ws_orig.max_column, ws_out.max_column, f"Nombre de columnes diferent al full {s_name}: {ws_orig.max_column} vs {ws_out.max_column}")
                
                # Comprovar que la capçalera (fila 1) no s'ha esborrat
                for c in range(1, ws_orig.max_column + 1):
                    val_orig = ws_orig.cell(1, c).value
                    val_out = ws_out.cell(1, c).value
                    self.assertEqual(val_orig, val_out, f"Capçalera diferent a {s_name}!{c}1: {val_orig} vs {val_out}")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_07_clean_ghost_rows_and_clean_kv_fields(self):
        """Verifica que les files fantasma (zeros de fórmules) no s'afegeixen al model JSON i que els camps buits de KV queden com a cadena buida."""
        licitacio_path = os.path.join(os.path.dirname(self.repo_root), "_plantilla_licitacio_elips.xlsx")
        if not os.path.exists(licitacio_path):
            self.skipTest("Fitxer _plantilla_licitacio_elips.xlsx no trobat.")

        parsed = self.excel_to_json(licitacio_path)
        data = parsed["data"]

        # 1. Taula Criteris només ha de contenir els 3 criteris reals (F1, V1, F2), no 200
        criteris = data.get("Criteris", [])
        self.assertEqual(len(criteris), 3, f"S'esperaven 3 criteris reals, s'han obtingut {len(criteris)}")
        self.assertEqual(criteris[0]["id"], "F1")
        self.assertEqual(len(criteris[0].get("Subcriteris", [])), 2)

        # 2. Taula pres.parts ha d'estar buida (0 files), no 200 files de zeros
        pres = data.get("pres", {})
        self.assertEqual(len(pres.get("parts", [])), 0, f"S'esperaven 0 partides buides, s'han obtingut {len(pres.get('parts', []))}")

        # 3. Taula Lots ha d'estar buida (0 files)
        lots = data.get("Lots", [])
        self.assertEqual(len(lots), 0, f"S'esperaven 0 lots buits, s'han obtingut {len(lots)}")

        # 4. Taula Mesa ha de contenir exactament els 4 membres reals
        mesa = data.get("Mesa", [])
        self.assertEqual(len(mesa), 4, f"S'esperaven 4 membres a la Mesa, s'han obtingut {len(mesa)}")

        # 5. Camps KV buits (num_expedient, titol_informe, data_redaccio) han de ser cadenes buides '', no 0 ni '00:00:00'
        general = data.get("General", {})
        self.assertEqual(general.get("num_expedient"), "")
        self.assertEqual(general.get("titol_informe"), "")
        self.assertEqual(general.get("data_redaccio"), "")
        self.assertEqual(general.get("modalitat"), "Contracte Públic")

if __name__ == "__main__":
    unittest.main()
