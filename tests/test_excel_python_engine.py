# elips — Editor de LIcitacions PúbliqueS
# Copyright (C) 2026  Francesc Rambla i Marigot
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""Tests the Python data engine (the elips_engine package under src/python/)
that elips runs inside Pyodide, driving it through a synthetic fixture
workbook generated on the fly
by tests/fixtures/generate_workbook.py rather than an external, untracked
.xlsx file. The fixture exercises the app's documented feature set: header-less
and headered KV sheets, a 4-level nested tabular hierarchy (matched both by
the implicit id-column heuristic and by an explicit _hierarchy_metadata
foreign key), ghost-row filtering without cartesian explosion across
unrelated parents, ghost/merged-cell round-trip export, complex-formula
orphan preservation, and the two-pass Jinja2 rendering pipeline with several
custom filters.
"""
import os
import sys
import json
import shutil
import tempfile
import unittest
from unittest import mock

from openpyxl import load_workbook, Workbook

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES_DIR = os.path.join(REPO_ROOT, "tests", "fixtures")
sys.path.insert(0, FIXTURES_DIR)
import generate_workbook  # noqa: E402


def _load_engine_module():
    """Imports the real elips_engine package from src/python/ (a normal,
    plain Python package -- see its __init__.py docstring) exactly as it
    ships: this is the same set of files Vite bundles via `?raw` imports and
    writes into Pyodide's virtual filesystem, so testing it directly here
    tests real production code, not a copy."""
    python_dir = os.path.join(REPO_ROOT, "src", "python")
    if python_dir not in sys.path:
        sys.path.insert(0, python_dir)
    import elips_engine
    return elips_engine


class TestExcelPythonEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = _load_engine_module()
        cls.tmp_dir = tempfile.mkdtemp(prefix="elips_test_")
        cls.fixture_path = os.path.join(cls.tmp_dir, "elips_test_fixture.xlsx")
        generate_workbook.build_workbook().save(cls.fixture_path)
        cls.template_path = os.path.join(FIXTURES_DIR, "sample_template.md.j2")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp_dir, ignore_errors=True)

    def test_01_engine_module_exposes_expected_api(self):
        """El mòdul extret ha d'exposar les funcions públiques que fa servir la resta de l'app."""
        for name in ("excel_to_json", "update_excel_from_json", "render_json_text", "render_md_two_pass_with_report"):
            self.assertTrue(hasattr(self.engine, name), f"'{name}' no exposat pel motor Python")

    def test_02_kv_sheets_header_less_and_headered_with_empty_field_cleanup(self):
        """Fulls KV sense capçalera (General) i amb capçalera Clau|Valor (pres); els camps buits queden com a ''."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]

        general = data["General"]
        self.assertEqual(general["titol_contracte"], "Subministrament d'equips informàtics")
        self.assertEqual(general["modalitat"], "Contracte Públic")
        self.assertEqual(general["nom_responsable"], "Anna Puig Soler")
        self.assertEqual(general["num_expedient"], "")
        self.assertEqual(general["data_redaccio"], "")

        pres = data["pres"]
        self.assertEqual(pres["pressupost"], "Pressupost anual")
        self.assertEqual(pres["anualitat"], 2026)

    def test_02b_static_select_options_parsed_as_a_list_not_a_joined_string(self):
        """Regressió: la cel·la 'options' d'un Select estàtic es desa com a text unit per comes
        (', '.join(...), a update_excel_from_json), però el model en viu sempre l'espera com a
        array (saveGroupConfig a useGroupMetadata.js) -- sense dividir-la en llegir l'Excel,
        qualsevol projecte recarregat (o copiat via 'Enganxa Config' des d'un que ho estigués)
        es quedava amb un desplegable buit, ja que tot el codi de renderitzat comprova
        Array.isArray(meta.options)."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]
        meta = next(m for m in data["editor_metadata"] if m["group"] == "General" and m["element"] == "modalitat")
        self.assertEqual(meta["options"], ["Contracte Públic", "Contracte Privat"])

        # Un Select estàtic sense cap opció configurada ha de quedar com a array buit, no com
        # a cadena buida -- mateix comportament que el model en viu (saveGroupConfig) per a un
        # camp Select recentment creat.
        codi_meta = next(m for m in data["editor_metadata"] if m["group"] == "General" and m["element"] == "codi")
        self.assertEqual(codi_meta["options"], [])

    def test_02c_group_view_config_survives_an_excel_round_trip(self):
        """Regressió: la configuració de vista taula/formulari d'un grup (viewMode/visibleColumns,
        desada al registre de capçalera '_group_label' per saveGroupConfig) no estava a la llista
        de columnes que update_excel_from_json escriu al full editor_metadata -- es perdia
        silenciosament en qualsevol reimportació des de l'Excel (inclosa la que fa la importació
        d'un ZIP amb un .xlsx empaquetat)."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]
        data["editor_metadata"].append({
            "group": "pres.parts",
            "element": "_group_label",
            "isGroupHeader": True,
            "viewMode": "table",
            "visibleColumns": ["id_partida", "nom_partida"],
        })

        out_path = os.path.join(self.tmp_dir, "view_config_roundtrip.xlsx")
        self.engine.update_excel_from_json(self.fixture_path, json.dumps(data), out_path)

        reparsed = self.engine.excel_to_json(out_path)["data"]
        header = next(m for m in reparsed["editor_metadata"]
                      if m.get("group") == "pres.parts" and m.get("element") == "_group_label")
        self.assertEqual(header["viewMode"], "table")
        self.assertEqual(header["visibleColumns"], ["id_partida", "nom_partida"])

    def test_03_four_level_nested_hierarchy_incl_explicit_foreign_key(self):
        """pres -> pres.parts -> pres.parts.activitats -> pres.parts.activitats.rec (aquest darrer enllaçat
        per clau forana explícita declarada a _hierarchy_metadata, no per coincidència de nom de columna)."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]
        parts = data["pres"]["parts"]
        self.assertEqual(len(parts), 2)

        part1 = next(p for p in parts if p["id_partida"] == "PART-01")
        part2 = next(p for p in parts if p["id_partida"] == "PART-02")
        self.assertEqual(len(part1["activitats"]), 2)
        self.assertEqual(len(part2["activitats"]), 1)

        act1 = next(a for a in part1["activitats"] if a["id_activitat"] == "ACT-01")
        self.assertEqual(len(act1["rec"]), 1)
        self.assertEqual(act1["rec"][0]["recurs"], "Tècnic instal·lador")
        self.assertEqual(act1["rec"][0]["unitats"], 2)

        # Regressió: un cop una fila filla ja s'ha aniuat sota el seu pare
        # correcte (per coincidència de nom -- id_partida -- o per clau
        # forana explícita -- activitat_ref/id_activitat), la seva pròpia
        # còpia d'aquesta columna de relació ja no es desa al model intern:
        # és redundant amb la posició a l'arbre i es podia desincronitzar
        # (editant-la a mà, o movent la fila a un altre pare sense
        # actualitzar-la) sense que res ho detectés.
        self.assertNotIn("id_partida", act1)
        self.assertNotIn("activitat_ref", act1["rec"][0])

    def test_03b_strip_hierarchy_ref_keys_migrates_already_saved_data(self):
        """strip_hierarchy_ref_keys neteja un projecte ja desat (abans d'aquest canvi) que encara arrossega
        aquestes còpies redundants -- incloent-hi el cas d'una clau d'avantpassat (no del pare immediat)
        filtrada fins a un net net (p.ex. id_partida arribant fins a 'rec', dos nivells per sota de 'parts')."""
        data = {
            "pres": {
                "parts": [{
                    "id_partida": "PART-01",
                    "activitats": [{
                        "id_activitat": "ACT-01",
                        "id_partida": "PART-01",  # còpia redundant (bug ja corregit a excel_to_json)
                        "rec": [{
                            "recurs": "Tècnic",
                            "activitat_ref": "ACT-01",  # còpia redundant del pare immediat
                            "id_partida": "PART-01",    # còpia redundant d'un avantpassat (2 nivells)
                        }]
                    }]
                }]
            }
        }
        schema = {
            "pres": {"ref_key": None, "children": {
                "parts": {"ref_key": None, "children": {
                    "activitats": {"ref_key": "id_partida", "children": {
                        "rec": {"ref_key": "activitat_ref", "children": {}}
                    }}
                }}
            }}
        }
        result = json.loads(self.engine.strip_hierarchy_ref_keys(json.dumps(data), json.dumps(schema)))
        act = result["pres"]["parts"][0]["activitats"][0]
        self.assertNotIn("id_partida", act)
        self.assertEqual(act["id_activitat"], "ACT-01", "la pròpia identitat de l'activitat no s'ha de tocar")
        rec = act["rec"][0]
        self.assertNotIn("activitat_ref", rec)
        self.assertNotIn("id_partida", rec, "una clau d'avantpassat (no només la del pare immediat) també s'ha d'eliminar")
        self.assertEqual(rec["recurs"], "Tècnic")

        # Idempotent: aplicar-ho sobre dades ja netes no fa res ni falla.
        twice = json.loads(self.engine.strip_hierarchy_ref_keys(json.dumps(result), json.dumps(schema)))
        self.assertEqual(twice, result)

    def test_04_ghost_rows_filtered_without_cartesian_explosion(self):
        """Les files completament buides/zero (típiques de fórmules no resoltes) es descarten, i els fills
        d'una taula plana compartida (Subcriteris) es reparteixen pel pare correcte sense duplicar-se."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]

        criteris = data["Criteris"]
        self.assertEqual(len(criteris), 3, "Les 2 files fantasma d'OUT_Criteris s'haurien d'haver descartat")

        f1 = next(c for c in criteris if c["id"] == "F1")
        v1 = next(c for c in criteris if c["id"] == "V1")
        f2 = next(c for c in criteris if c["id"] == "F2")
        self.assertEqual(len(f1["Subcriteris"]), 2)
        self.assertEqual(len(v1["Subcriteris"]), 0)
        self.assertEqual(len(f2["Subcriteris"]), 1)
        self.assertEqual(f2["Subcriteris"][0]["subid"], "F2a")

        self.assertEqual(data["Lots"], [], "OUT_Lots només conté files fantasma: ha de quedar buit")
        self.assertEqual(len(data["Mesa"]), 4)

    def test_05_update_excel_preserves_complex_formulas_as_orphans(self):
        """Les fórmules complexes (no-enllaç) mai es sobreescriuen: el nou valor es desvia al full 'orfes'."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]
        json_str = json.dumps(data, ensure_ascii=False)
        out_path = os.path.join(self.tmp_dir, "roundtrip_orphans.xlsx")

        orphan_count = self.engine.update_excel_from_json(self.fixture_path, json_str, out_path)
        self.assertEqual(orphan_count, 2, "Les 2 fórmules complexes de cost_amb_iva han de generar un orfe cada una")

        wb_out = load_workbook(out_path, data_only=False)
        self.assertIn("orfes", wb_out.sheetnames)
        ws_orfes = wb_out["orfes"]
        self.assertEqual(ws_orfes.cell(1, 1).value, "Full")
        self.assertEqual(ws_orfes.cell(1, 3).value, "Fórmula Original")
        for r in range(2, ws_orfes.max_row + 1):
            formula_val = str(ws_orfes.cell(r, 3).value or "")
            self.assertTrue(formula_val.startswith("'="), f"La fórmula orfe a la fila {r} no comença per '=: {formula_val}")

        ws_parts = wb_out["OUT_pres.parts"]
        self.assertEqual(ws_parts.cell(2, 4).value, "=C2*1.21", "La fórmula complexa no s'ha de sobreescriure")
        self.assertEqual(ws_parts.cell(2, 5).value, "=OUT_pres!B2", "L'enllaç simple s'ha de conservar intacte")

    def test_06_update_excel_leaves_untouched_sheets_byte_identical(self):
        """Un full tabular sense cap fila real (OUT_Lots) no es regenera: es deixa exactament com estava."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]
        json_str = json.dumps(data, ensure_ascii=False)
        out_path = os.path.join(self.tmp_dir, "roundtrip_untouched.xlsx")
        self.engine.update_excel_from_json(self.fixture_path, json_str, out_path)

        wb_orig = load_workbook(self.fixture_path, data_only=False)
        wb_out = load_workbook(out_path, data_only=False)
        ws_orig, ws_out = wb_orig["OUT_Lots"], wb_out["OUT_Lots"]
        self.assertEqual(ws_orig.max_row, ws_out.max_row)
        self.assertEqual(ws_orig.max_column, ws_out.max_column)
        for r in range(1, ws_orig.max_row + 1):
            for c in range(1, ws_orig.max_column + 1):
                self.assertEqual(ws_orig.cell(r, c).value, ws_out.cell(r, c).value)

    def test_07_update_excel_with_merged_cells_does_not_crash(self):
        """L'exportació sobre un full amb cel·les fusionades (OUT_Mesa, C3:C4) no ha de llançar AttributeError."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]
        json_str = json.dumps(data, ensure_ascii=False)
        out_path = os.path.join(self.tmp_dir, "roundtrip_merged.xlsx")

        orphan_count = self.engine.update_excel_from_json(self.fixture_path, json_str, out_path)
        self.assertIsInstance(orphan_count, int)
        self.assertTrue(os.path.exists(out_path))
        self.assertGreater(os.path.getsize(out_path), 0)

    def test_08_two_pass_jinja2_render_with_custom_filters_and_recovery(self):
        """Renderitza la plantilla de mostra (bucles aniuats, filtres coin/percent/words/number/prefix) i
        comprova que una variable no definida no trenca la generació (recuperació amb DebugUndefined)."""
        result = json.loads(self.engine.render_md_two_pass_with_report(self.fixture_path, self.template_path))
        self.assertTrue(result["success"], result.get("traceback"))

        md = result["markdown"]
        self.assertIn("Subministrament d'equips informàtics", md)
        self.assertIn("125.000,50", md)  # filtre 'coin'
        self.assertIn("21%", md)  # filtre 'percent'
        self.assertIn("12,00 hores", md)  # filtre 'number'
        self.assertIn("quaranta-cinc mil euros", md)  # filtre 'words'
        self.assertIn("com a President", md)  # filtre 'prefix'
        self.assertIn("Instal·lació d'equips", md)
        self.assertIn("Desplegament de programari", md)

        # La variable inexistent del final de la plantilla no ha de trencar el renderitzat
        self.assertGreater(len(result["issues"]), 0, "El motor hauria de reportar la variable indefinida com a incidència")

    def test_09_calculated_field_inside_tabular_loop_renders(self):
        """Un camp calculat (virtual, no és una columna real de l'Excel) present a l'estat viu
        (/work/in.json, equivalent a store.excelJsonData amb evaluateComputedFields ja aplicat) s'ha
        de veure reflectit en renderitzar una plantilla que itera sobre la taula que el conté."""
        data = self.engine.excel_to_json(self.fixture_path)["data"]
        for part in data["pres"]["parts"]:
            part["iva_calculat"] = round(part["import"] * 0.21, 2)
        live_json_str = json.dumps(data, ensure_ascii=False)

        loop_template_path = os.path.join(self.tmp_dir, "loop_template.md.j2")
        with open(loop_template_path, "w", encoding="utf-8") as f:
            f.write("{% for part in pres.parts %}\n- {{ part.nom_partida }}: IVA calculat = {{ part.iva_calculat }}\n{% endfor %}\n")

        live_json_path = os.path.join(self.tmp_dir, "in.json")
        with open(live_json_path, "w", encoding="utf-8") as f:
            f.write(live_json_str)

        real_exists = os.path.exists
        real_open = open

        def fake_exists(path):
            return True if path == '/work/in.json' else real_exists(path)

        def fake_open(path, *args, **kwargs):
            return real_open(live_json_path, *args, **kwargs) if path == '/work/in.json' else real_open(path, *args, **kwargs)

        with mock.patch.object(self.engine.os.path, 'exists', side_effect=fake_exists), \
             mock.patch('builtins.open', side_effect=fake_open):
            result = json.loads(self.engine.render_md_two_pass_with_report(self.fixture_path, loop_template_path))

        self.assertTrue(result["success"], result.get("traceback"))
        md = result["markdown"]
        self.assertIn("Equips de sobretaula: IVA calculat = 9450.0", md)
        self.assertIn("Portàtils: IVA calculat = 6300.0", md)
        self.assertNotIn("iva_calculat", md, "El placeholder de recuperació indica que el camp calculat no s'ha trobat")

    def test_10_evaluate_custom_formula_mini_language(self):
        """Verifica el llenguatge de fórmules CUSTOM (SI/ARRODONEIX/CERT/FALS) que abans
        s'executava al navegador amb new Function() i ara corre dins de Pyodide."""
        ecf = self.engine.evaluate_custom_formula

        row = {"import": 100, "unitats": 3, "persones": 2, "actiu": True}

        # "import" (Catalan per "import/quantia") és un nom de camp legítim i molt
        # habitual en aquest domini: no s'ha de confondre mai amb la paraula clau
        # Python "import" (regressió real detectada i corregida durant aquesta fase).
        self.assertEqual(ecf("ARRODONEIX(import * 0.21; 2)", row), 21.0)
        self.assertEqual(ecf("import * unitats", row), 300)

        self.assertEqual(
            ecf("SI(persones > 0; persones * unitats * import; unitats * import)", row),
            600,
        )
        self.assertEqual(ecf('SI(actiu; "Sí"; "No")', row), "Sí")

        # Un enter (30) no s'ha de convertir en float (30.0) en travessar Python/JSON:
        # coherent amb com JS serialitza sempre com a "30", no "30.0".
        r = ecf("import * 3", {"import": 10})
        self.assertEqual(r, 30)
        self.assertIsInstance(r, int)

        # Una fórmula trencada no ha de petar mai: cau al valor ja present al camp.
        r = ecf("aquest_camp_no_existeix + 1", {"aquest_camp_no_existeix_backup": 5})
        self.assertEqual(r, 0)

    def test_11_evaluate_custom_formula_blocks_sandbox_escape(self):
        """La substitució de new Function() per un eval() Python restringit s'ha de mantenir
        tancada als intents habituals d'escapar del sandbox (accés a dunders / __import__)."""
        ecf = self.engine.evaluate_custom_formula
        self.assertEqual(ecf("().__class__.__bases__[0].__subclasses__()", {}), 0)
        self.assertEqual(ecf("__import__('os').system('echo pwned')", {}), 0)

    def test_12_evaluate_computed_fields_custom_and_aggregation(self):
        """Verifica el motor complet (evaluate_computed_fields): una fórmula CUSTOM per
        fila i una agregació SUM sobre la mateixa taula, tal com fa servir l'aplicació."""
        data = {
            "pres": {
                "anualitat": 2026,
                "parts": [
                    {"id": "A", "import": 100, "iva": None},
                    {"id": "B", "import": 200, "iva": None},
                ],
                "total": None,
            }
        }
        metadata = [
            {"group": "pres.parts", "element": "iva", "type": "Computed", "calcFormula": "ARRODONEIX(import * 0.21; 2)"},
            {"group": "pres", "element": "total", "type": "Computed", "calcFn": "SUM", "calcVector": "parts", "calcTargetCol": "import"},
        ]
        result = json.loads(self.engine.evaluate_computed_fields(json.dumps(data), json.dumps(metadata)))
        self.assertTrue(result["success"])
        parts = result["data"]["pres"]["parts"]
        self.assertEqual(parts[0]["iva"], 21.0)
        self.assertEqual(parts[1]["iva"], 42.0)
        self.assertEqual(result["data"]["pres"]["total"], 300)

    def test_13_trim_blocks_avoids_blank_lines_between_loop_rows(self):
        """trim_blocks/lstrip_blocks=True (the Jinja2 Environment config in engine.py) must
        strip a block tag's own trailing newline -- otherwise every {% for %}/{% endfor %}
        (and {% if %}/{% endif %}) leaves a blank line behind in the rendered output, which
        breaks a Markdown table generated by looping over its rows (a blank line ends a
        table) and adds unwanted spacing around conditionally-included paragraphs."""
        table_template_path = os.path.join(self.tmp_dir, "table_template.md.j2")
        with open(table_template_path, "w", encoding="utf-8") as f:
            f.write(
                "| Partida | Import |\n"
                "| --- | ---: |\n"
                "{% for part in pres.parts %}\n"
                "| {{ part.nom_partida }} | {{ part.import }} |\n"
                "{% endfor %}\n"
                "{% if pres.parts %}\n"
                "Hi ha partides.\n"
                "{% endif %}\n"
            )
        result = json.loads(self.engine.render_md_two_pass_with_report(self.fixture_path, table_template_path))
        self.assertTrue(result["success"], result.get("traceback"))
        md = result["markdown"]

        self.assertNotIn('\n\n', md.strip(), "Una línia en blanc enmig trencaria la taula Markdown: " + repr(md))
        lines = [l for l in md.splitlines() if l.strip()]
        table_lines, rest_lines = lines[:-1], lines[-1:]
        self.assertTrue(all(l.startswith('|') for l in table_lines), md)
        self.assertEqual(rest_lines, ['Hi ha partides.'])

    def test_14_trim_blocks_does_not_collapse_transposed_table_rows(self):
        """Regressió: l'arranjament de trim_blocks del test anterior beneficia les etiquetes
        {% for %}/{% endfor %} soles a la seva línia (DYNAMIC_TABLE), però una TRANSPOSED_TABLE
        col·loca el seu bucle {% for %}...{% endfor %} en línia, al final de cada fila amb
        contingut real -- si trim_blocks també li mengés el salt de línia final, totes les files
        quedarien enganxades en una sola línia. protect_inline_trailing_block_tags ha de detectar
        aquest cas i preservar el salt de línia només per aquestes etiquetes."""
        table_template_path = os.path.join(self.tmp_dir, "transposed_table_template.md.j2")
        with open(table_template_path, "w", encoding="utf-8") as f:
            f.write(
                "<!-- TRANSPOSED_TABLE_START -->\n"
                "| Partida | {% for part in pres.parts %}{{ part.nom_partida }} | {% endfor %}\n"
                "| Import | {% for part in pres.parts %}{{ part.import }} | {% endfor %}\n"
                "<!-- TRANSPOSED_TABLE_END -->\n"
            )
        result = json.loads(self.engine.render_md_two_pass_with_report(self.fixture_path, table_template_path))
        self.assertTrue(result["success"], result.get("traceback"))
        md = result["markdown"]

        lines = [l for l in md.splitlines() if l.strip()]
        row_lines = [l for l in lines if l.startswith('|')]
        self.assertEqual(len(row_lines), 2, "Cada fila transposada ha d'ocupar la seva pròpia línia: " + repr(md))
        self.assertTrue(row_lines[0].startswith('| Partida |'), row_lines[0])
        self.assertTrue(row_lines[1].startswith('| Import |'), row_lines[1])
        self.assertIn("Equips de sobretaula", row_lines[0])
        self.assertIn("Portàtils", row_lines[0])

    def test_15_dynamic_select_foreign_key_exposes_other_columns_of_matched_row(self):
        """Regressió: un camp Select/dynamic (clau forana) ha de continuar imprimint-se com a
        valor escalar pla (General.codi -> 'A1', ja funcionava) però TAMBÉ ha d'exposar les
        altres columnes de la fila coincident de la taula referenciada (General.codi.import,
        General.codi.nom), en AMBDUES passades del renderitzat (Word/markdown net i
        previsualització HTML amb enllaços). Abans de la correcció, _hydrate_foreign_keys mai
        s'executava perquè comprovava l'existència de 'editor_metadata' dins de l'arbre de dades
        DESPRÉS que aquest ja n'hagués estat eliminat (doc.pop('editor_metadata', ...)), de manera
        que el camp es quedava com un str pla i .import fallava amb 'no such element'."""
        template_path = os.path.join(self.tmp_dir, "fk_template.md.j2")
        with open(template_path, "w", encoding="utf-8") as f:
            f.write("Codi: {{ General.codi }} | Nom: {{ General.codi.nom }} | Import: {{ General.codi.import }}\n")

        result = json.loads(self.engine.render_md_two_pass_with_report(self.fixture_path, template_path))
        self.assertTrue(result["success"], result.get("traceback"))
        self.assertEqual(result["issues"], [], "No hi hauria d'haver cap incidència de clau no definida")

        md = result["markdown"]
        self.assertIn("Codi: A1", md)
        self.assertIn("Nom: Article U", md)
        self.assertIn("Import: 100", md)

        html = result["htmlMarkdown"]
        self.assertIn("Codi: <a", html)
        self.assertIn(">A1</a>", html)
        self.assertIn("Nom: <a", html)
        self.assertIn(">Article U</a>", html)
        self.assertIn("Import: <a", html)
        self.assertIn(">100</a>", html)
        # No enllaços <a> aniuats (bug secundari: TrackedDict.__str__ re-embolicava
        # el valor escalar de 'Codi', que ja portava el seu propi enllaç, dins d'un segon
        # enllaç, generant <a ...><a ...>A1</a></a>).
        codi_segment = html.split("Codi: ", 1)[1].split(" | Nom:", 1)[0]
        self.assertEqual(codi_segment.count("<a "), 1, "Enllaç HTML aniuat detectat: " + codi_segment)

    def test_16_mirror_pattern_detected_and_new_column_replicated_to_source(self):
        """analyze_mirror_pattern/apply_mirror_column: quan un full OUT_ existent és un mirall
        cel-a-cel d'un altre full (totes les cel·les existents són fórmules =full!cel·la que
        apunten a UN sol full font, una columna OUT_ per columna font, amb el mateix desplaçament
        de fila), s'ha de detectar correctament i, en aplicar-lo, la nova columna s'ha d'afegir
        TANT al full font (capçalera) com al full OUT_ (com a fórmula que hi apunta), replicant
        exactament la mateixa convenció -- en lloc de deixar la nova columna òrfena/desconnectada
        del full que realment conté les dades (bug reportat: OUT_nomconjunt mirall de 'nomconjunt')."""
        wb = Workbook()
        ws = wb.active
        ws.title = "nomconjunt"
        ws.append(["nom", "descripcio"])
        ws.append(["Article U", "Descripció U"])
        ws.append(["Article Dos", "Descripció Dos"])

        ws_out = wb.create_sheet("OUT_nomconjunt")
        ws_out.append(["nom", "descripcio"])
        ws_out.append(["=nomconjunt!A2", "=nomconjunt!B2"])
        ws_out.append(["=nomconjunt!A3", "=nomconjunt!B3"])

        mirror_path = os.path.join(self.tmp_dir, "mirror.xlsx")
        wb.save(mirror_path)

        analysis = json.loads(self.engine.analyze_mirror_pattern(mirror_path, "nomconjunt"))
        self.assertTrue(analysis["is_mirror"], analysis)
        self.assertEqual(analysis["source_sheet"], "nomconjunt")
        self.assertEqual(analysis["row_offset"], 0)
        self.assertEqual(analysis["next_source_col"], "C")

        applied_path = os.path.join(self.tmp_dir, "mirror_applied.xlsx")
        apply_result = json.loads(self.engine.apply_mirror_column(mirror_path, "nomconjunt", "preu", applied_path))
        self.assertTrue(apply_result["applied"], apply_result)

        wb_check = load_workbook(applied_path)
        self.assertEqual(wb_check["nomconjunt"].cell(1, 3).value, "preu")
        self.assertEqual(wb_check["OUT_nomconjunt"].cell(1, 3).value, "preu")
        self.assertEqual(wb_check["OUT_nomconjunt"].cell(2, 3).value, "='nomconjunt'!C2")
        self.assertEqual(wb_check["OUT_nomconjunt"].cell(3, 3).value, "='nomconjunt'!C3")

        # A value written through the mirror formula must land in the SOURCE
        # sheet, not overwrite the OUT_ sheet's formula (write_cell_value's
        # existing link-chain traversal, exercised end-to-end here).
        data = self.engine.excel_to_json(applied_path)["data"]
        data["nomconjunt"][0]["preu"] = "123"
        roundtrip_path = os.path.join(self.tmp_dir, "mirror_roundtrip.xlsx")
        self.engine.update_excel_from_json(applied_path, json.dumps(data), roundtrip_path)
        wb_rt = load_workbook(roundtrip_path)
        self.assertEqual(wb_rt["nomconjunt"].cell(2, 3).value, 123)
        self.assertEqual(wb_rt["OUT_nomconjunt"].cell(2, 3).value, "='nomconjunt'!C2")

    def test_17_mirror_pattern_rejects_ambiguous_or_mixed_patterns(self):
        """analyze_mirror_pattern ha de NEGAR-SE (is_mirror: false) a proposar una replicació
        automàtica quan el patró no és net i inequívoc: columnes que apunten a fulls font
        diferents, o una cel·la que no és una fórmula simple d'enllaç -- en aquests casos
        l'usuari ha d'afegir la columna manualment al full de càlcul."""
        wb_mixed = Workbook()
        ws = wb_mixed.active
        ws.title = "font_a"
        ws.append(["x"])
        ws.append(["1"])
        ws_b = wb_mixed.create_sheet("font_b")
        ws_b.append(["y"])
        ws_b.append(["2"])
        ws_mixed_out = wb_mixed.create_sheet("OUT_barreja")
        ws_mixed_out.append(["colx", "coly"])
        ws_mixed_out.append(["=font_a!A2", "=font_b!A2"])
        mixed_path = os.path.join(self.tmp_dir, "mixed.xlsx")
        wb_mixed.save(mixed_path)

        mixed_result = json.loads(self.engine.analyze_mirror_pattern(mixed_path, "barreja"))
        self.assertFalse(mixed_result["is_mirror"])
        self.assertEqual(mixed_result["reason"], "multiple_or_no_source_sheets")

        wb_plain = Workbook()
        ws = wb_plain.active
        ws.title = "font_c"
        ws.append(["x"])
        ws.append(["1"])
        ws_plain_out = wb_plain.create_sheet("OUT_plana")
        ws_plain_out.append(["colx"])
        ws_plain_out.append(["=font_c!A2"])
        ws_plain_out.append(["un valor literal, no una fórmula"])
        plain_path = os.path.join(self.tmp_dir, "plain.xlsx")
        wb_plain.save(plain_path)

        plain_result = json.loads(self.engine.analyze_mirror_pattern(plain_path, "plana"))
        self.assertFalse(plain_result["is_mirror"])
        self.assertEqual(plain_result["reason"], "non_formula_or_complex_cell")

        # A sheet with no formulas at all (the ordinary case) is not a mirror
        # either, but for a completely different, unremarkable reason -- this
        # is what should stay silent in the app rather than warn the user.
        wb_ordinary = Workbook()
        ws = wb_ordinary.active
        ws.title = "OUT_normal"
        ws.append(["a", "b"])
        ws.append(["1", "2"])
        ordinary_path = os.path.join(self.tmp_dir, "ordinary.xlsx")
        wb_ordinary.save(ordinary_path)
        ordinary_result = json.loads(self.engine.analyze_mirror_pattern(ordinary_path, "normal"))
        self.assertFalse(ordinary_result["is_mirror"])
        self.assertEqual(ordinary_result["reason"], "no_formulas_found")

    def test_18_validate_template_syntax_accepts_well_formed_templates(self):
        """validate_template_syntax ha d'acceptar (valid: True) plantilles ben formades,
        incloent-hi bucles/condicionals aniuats, for-else, i macro/set."""
        good_templates = [
            "Text pla sense cap tag Jinja2.",
            "{% for part in pres.parts %}\n- {{ part.nom }}\n{% endfor %}",
            "{% if a > 0 %}\nPositiu\n{% elif a == 0 %}\nZero\n{% else %}\nNegatiu\n{% endif %}",
            "{% for x in a %}\n{{ x }}\n{% else %}\nLlista buida\n{% endfor %}",
            "{% macro taula(files, columnes=3) %}\nContingut\n{% endmacro %}",
            "{% set resultat %}\nCapturat\n{% endset %}",
            "{% set total = pres.parts | length %}",
            "{% for part in pres.parts %}{% if part.import > 0 %}{{ part.nom }}{% endif %}{% endfor %}",
        ]
        for tpl in good_templates:
            result = json.loads(self.engine.validate_template_syntax(tpl))
            self.assertTrue(result["valid"], f"S'esperava vàlid per a: {tpl!r}, error: {result.get('error')}")
            self.assertIsNone(result["error"])

    def test_19_validate_template_syntax_rejects_mismatched_and_malformed_templates(self):
        """validate_template_syntax ha de detectar (valid: False, amb línia i missatge) exactament
        els casos que l'usuari ha reportat com a problemàtics al canvas visual: un {% for %} tancat
        amb {% endif %}, i altres construccions Jinja2 sintàcticament invàlides."""
        bad_templates = [
            "{% for part in pres.parts %}\n- {{ part.nom }}\n{% endif %}",  # tipus incorrecte
            "{% if a %}\nText sense tancar",  # sense tancar
            "{% for x in a %}\n{{ x }}\n{% elif b %}\nNo vàlid\n{% endfor %}",  # for no té elif
            "{{ a + }}",  # expressió mal formada
        ]
        for tpl in bad_templates:
            result = json.loads(self.engine.validate_template_syntax(tpl))
            self.assertFalse(result["valid"], f"S'esperava invàlid per a: {tpl!r}")
            self.assertIsNotNone(result["error"])
            self.assertIsInstance(result["error"]["message"], str)
            self.assertGreater(len(result["error"]["message"]), 0)

    def test_20_evaluate_custom_formula_or_and_with_resolvable_path(self):
        """Regressió: OR(path)/AND(path) han de funcionar quan `path` és també un camp
        resoluble -- abans, el bucle de substitució de tokens de evaluate_custom_formula
        trobava el path DINS les cometes que _cef_transform_or_and ja havia generat
        (__or("path")) i el substituïa allà mateix, corrompent la crida i fent que
        sempre retornés False. Cobert per l'emmascarament de literals entre cometes."""
        ecf = self.engine.evaluate_custom_formula
        data = {"pres": {"parts": [
            {"id": "A", "actiu": True},
            {"id": "B", "actiu": False},
            {"id": "C", "actiu": True},
        ]}}
        self.assertEqual(ecf("OR(pres.parts.actiu)", data), True)
        self.assertEqual(ecf("AND(pres.parts.actiu)", data), False)

    def test_21_evaluate_custom_formula_min_max_elementwise(self):
        """Regressió: MIN(a; b)/MAX(a; b) estaven documentades a l'autocompletat però mai
        havien tingut la transformació necessària -- sempre retornaven 0."""
        ecf = self.engine.evaluate_custom_formula
        self.assertEqual(ecf("MIN(5; 2)", {}), 2)
        self.assertEqual(ecf("MAX(5; 2)", {}), 5)
        self.assertEqual(ecf("MIN(unitats; 10)", {"unitats": 3}), 3)

    def test_22_evaluate_custom_formula_aggregation_functions(self):
        """SUM/AVERAGE/COUNT/MIN/MAX(grup.taula[.columna]) dins d'una fórmula han de
        donar el mateix resultat que el tipus de camp calculat d'agregació equivalent."""
        ecf = self.engine.evaluate_custom_formula
        data = {"pres": {"parts": [
            {"id": "A", "categoria": "Obra", "import": 100},
            {"id": "B", "categoria": "Servei", "import": 200},
            {"id": "C", "categoria": "Obra", "import": 50},
        ], "tipus_ref": "Obra"}}

        self.assertEqual(ecf("SUM(pres.parts.import)", data), 350)
        self.assertAlmostEqual(ecf("AVERAGE(pres.parts.import)", data), 350 / 3, places=4)
        self.assertEqual(ecf("COUNT(pres.parts)", data), 3)
        self.assertEqual(ecf("MIN(pres.parts.import)", data), 50)
        self.assertEqual(ecf("MAX(pres.parts.import)", data), 200)

        # Ús combinat amb la resta del mini-llenguatge (ARRODONEIX sobre un SUM).
        self.assertEqual(ecf("ARRODONEIX(SUM(pres.parts.import) * 0.21; 2)", data), 73.5)

    def test_23_evaluate_custom_formula_sumif(self):
        """SUMIF(critPath; criteri; sumPath): el criteri és literal si va entre cometes,
        o la referència a un altre camp si no en porta (conveni indicat per l'usuari)."""
        ecf = self.engine.evaluate_custom_formula
        data = {"pres": {"parts": [
            {"id": "A", "categoria": "Obra", "import": 100},
            {"id": "B", "categoria": "Servei", "import": 200},
            {"id": "C", "categoria": "Obra", "import": 50},
        ], "tipus_ref": "Obra"}}

        # Criteri literal (entre cometes).
        self.assertEqual(ecf('SUMIF(pres.parts.categoria; "Obra"; pres.parts.import)', data), 150)
        self.assertEqual(ecf('SUMIF(pres.parts.categoria; "Servei"; pres.parts.import)', data), 200)
        self.assertEqual(ecf('SUMIF(pres.parts.categoria; "Inexistent"; pres.parts.import)', data), 0)

        # Criteri com a referència a un altre camp (sense cometes).
        self.assertEqual(ecf('SUMIF(pres.parts.categoria; pres.tipus_ref; pres.parts.import)', data), 150)

    def test_24_evaluate_computed_fields_sumif_aggregation(self):
        """SUMIF com a tipus de camp calculat (calcFn), a través del motor complet
        evaluate_computed_fields -- mateix comportament que la funció de fórmula."""
        data = {"pres": {
            "parts": [
                {"id": "A", "categoria": "Obra", "import": 100},
                {"id": "B", "categoria": "Servei", "import": 200},
                {"id": "C", "categoria": "Obra", "import": 50},
            ],
            "total_obra": None,
        }}
        metadata = [{
            "group": "pres", "element": "total_obra", "type": "Computed", "calcFn": "SUMIF",
            "calcVector": "parts", "calcTargetCol": "import",
            "calcCriteriaCol": "categoria", "calcCriteriaValue": '"Obra"',
        }]
        result = json.loads(self.engine.evaluate_computed_fields(json.dumps(data), json.dumps(metadata)))
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["pres"]["total_obra"], 150)

    def test_25_custom_formula_fk_dot_access_table_nested_in_kv_group(self):
        """Regressió: escriure `partida.descripcio` en una fórmula CUSTOM ha de navegar fins a la
        fila relacionada encara que la taula d'origen (partides) estigui aniuada dins d'un grup
        clau-valor (pressupost), no només quan és una taula de primer nivell -- el fallback de clau
        forana escalar dins _cef_get_nested_value abans només mirava claus de primer nivell."""
        ecf = self.engine.evaluate_custom_formula
        data = {"pressupost": {
            "partida": "P1",
            "partides": [
                {"id": "P1", "lot": "L1", "descripcio": "Partida 1"},
                {"id": "P2", "lot": "L2", "descripcio": "Partida 2"},
            ],
        }}
        row = data["pressupost"]
        self.assertEqual(ecf("partida.descripcio", row, data), "Partida 1")
        self.assertEqual(ecf("partida.lot", row, data), "L1")

    def test_26_document_generation_hydrates_fk_table_nested_in_kv_group(self):
        """Regressió equivalent al test anterior però pel pipeline REAL de generació de documents
        (render_md_two_pass_with_report / _hydrate_foreign_keys), que és una implementació Python
        separada de evaluate_custom_formula i tenia el mateix bug (cerca de vectorPath no
        recursiva)."""
        live_data = {
            "pressupost": {
                "anualitat": 2026,
                "partida": "P1",
                "partides": [
                    {"id": "P1", "lot": "L1", "descripcio": "Partida 1"},
                    {"id": "P2", "lot": "L2", "descripcio": "Partida 2"},
                ],
            },
            "editor_metadata": [
                {"group": "pressupost", "element": "partida", "type": "Select", "sourceType": "dynamic",
                 "vectorPath": "partides", "displayField": "descripcio", "valueField": "id"},
            ],
        }
        live_json_str = json.dumps(live_data, ensure_ascii=False)

        fk_template_path = os.path.join(self.tmp_dir, "fk_template.md.j2")
        with open(fk_template_path, "w", encoding="utf-8") as f:
            f.write("Partida triada: {{ pressupost.partida.descripcio }} (lot {{ pressupost.partida.lot }})\n")

        live_json_path = os.path.join(self.tmp_dir, "in_fk.json")
        with open(live_json_path, "w", encoding="utf-8") as f:
            f.write(live_json_str)

        real_exists = os.path.exists
        real_open = open

        def fake_exists(path):
            return True if path == '/work/in.json' else real_exists(path)

        def fake_open(path, *args, **kwargs):
            return real_open(live_json_path, *args, **kwargs) if path == '/work/in.json' else real_open(path, *args, **kwargs)

        with mock.patch.object(self.engine.os.path, 'exists', side_effect=fake_exists), \
             mock.patch('builtins.open', side_effect=fake_open):
            result = json.loads(self.engine.render_md_two_pass_with_report(self.fixture_path, fk_template_path))

        self.assertTrue(result["success"], result.get("traceback"))
        md = result["markdown"]
        self.assertIn("Partida triada: Partida 1 (lot L1)", md)
        self.assertNotIn("Clau no definida", md, "El marcador de recuperació indica que la FK no s'ha resolt")

    def test_27_evaluate_computed_fields_hydrated_fk_column_name_collision(self):
        """Regressió: un cop `item` (Select dinàmic) ja s'ha hidratat a un objecte amb les columnes
        de la fila relacionada, run_custom_pass/run_agg_pass recorren aquest objecte com si fos un
        subgrup més -- però com que no és una llista, hereten el group_hint del pare sense canviar-lo,
        de manera que si la fila relacionada té una columna amb el MATEIX nom que un camp calculat
        del grup pare (aquí, "preu" existeix tant a `prova` com a `cataleg.items`), la fórmula
        `item.preu` s'avaluava una segona vegada contra l'objecte hidratat mateix (on `item` no
        existeix) i sobreescrivia el resultat correcte amb 0."""
        data = {
            "cataleg": {"items": [
                {"id": "I1", "preu": 25, "descripcio": "Item 1"},
                {"id": "I2", "preu": 40, "descripcio": "Item 2"},
            ]},
            # `item` ja ve hidratat (com el deixaria hydrateModelWithForeignKeys en viu abans de
            # cridar Python) per aïllar el bug de run_custom_pass en si, sense dependre'n.
            "prova": {
                "item": {"id": "I1", "preu": 25, "descripcio": "Item 1", "_default_val": "I1", "value": "I1", "val": "I1"},
                "preu": 0,
                "unitats": 2,
            },
        }
        metadata = [
            {"group": "prova", "element": "item", "type": "Select", "sourceType": "dynamic",
             "vectorPath": "items", "displayField": "descripcio", "valueField": "id"},
            {"group": "prova", "element": "preu", "type": "Computed", "isCalculated": True,
             "sourceType": "computed", "calcFn": "CUSTOM", "calcFormula": "item.preu"},
        ]
        result = json.loads(self.engine.evaluate_computed_fields(json.dumps(data), json.dumps(metadata)))
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["prova"]["preu"], 25)
        # La fila de referència no s'ha d'haver tocat en el procés.
        self.assertEqual(result["data"]["cataleg"]["items"][0]["preu"], 25)
        self.assertEqual(result["data"]["prova"]["item"]["preu"], 25)

    def test_28_formula_comparisons_and_ternary(self):
        """El parser AST ha de suportar comparacions (amb els àlies `=`/`<>`),
        l'operador `^` com a potència, i el ternari a l'estil Python
        `a if cond else b` (a més del SI/IF ja existent)."""
        ecf = self.engine.evaluate_custom_formula
        self.assertEqual(ecf("unitats = 3", {"unitats": 3}), True)
        self.assertEqual(ecf("unitats <> 3", {"unitats": 3}), False)
        self.assertEqual(ecf("2 ^ 3", {}), 8)
        self.assertEqual(ecf('"Sí" if unitats > 2 else "No"', {"unitats": 3}), "Sí")
        self.assertEqual(ecf('"Sí" if unitats > 2 else "No"', {"unitats": 1}), "No")

    def test_29_formula_bare_and_or_not(self):
        """`and`/`or`/`not` (minúscules, exactes) funcionen com a operadors
        booleans normals -- distints de les funcions OR(...)/AND(...) amb
        majúscules, que consumeixen un camí com a vector."""
        ecf = self.engine.evaluate_custom_formula
        self.assertEqual(ecf("actiu and unitats > 0", {"actiu": True, "unitats": 3}), True)
        self.assertEqual(ecf("actiu and unitats > 0", {"actiu": True, "unitats": 0}), False)
        self.assertEqual(ecf("not actiu", {"actiu": False}), True)
        self.assertEqual(ecf("actiu or fals_camp", {"actiu": False, "fals_camp": True}), True)

    def test_30_formula_string_concat_and_index(self):
        """Concatenació de text amb `+` i accés amb índex `taula[0].camp`."""
        ecf = self.engine.evaluate_custom_formula
        # (una cadena amb aparença numèrica com "1" es convertiria a número en
        # resoldre's -- mateix comportament, ja preexistent, que el motor antic.)
        self.assertEqual(ecf('"Lot " + lot', {"lot": "A"}), "Lot A")
        data = {"pres": {"parts": [{"id": "A"}, {"id": "B"}]}}
        self.assertEqual(ecf("pres.parts[0].id", data), "A")
        self.assertEqual(ecf("pres.parts[1].id", data), "B")

    def test_31_validate_custom_formula_syntax(self):
        """validate_custom_formula_syntax analitza sense avaluar, igual que
        validate_template_syntax per a plantilles Jinja2."""
        vcf = self.engine.validate_custom_formula_syntax
        ok = json.loads(vcf("SI(unitats > 0; preu * unitats; 0)"))
        self.assertTrue(ok["valid"])
        self.assertIsNone(ok["error"])
        bad = json.loads(vcf("SI(unitats > 0; preu * unitats"))
        self.assertFalse(bad["valid"])
        self.assertIsNotNone(bad["error"])


if __name__ == "__main__":
    unittest.main()
