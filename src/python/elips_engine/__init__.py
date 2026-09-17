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

"""elips_engine: the app's Python data/document engine, as a normal,
importable Python package -- works standalone (e.g. a future server, or a
plain `python -c "import elips_engine"`) with zero elips-specific glue, and
is loaded into Pyodide's virtual filesystem for the client-side build (see
src/composables/useWasmEngines.js for that bootstrap). Was previously a
single 3800+-line src/python/engine.py file executed as one text blob;
split into modules by functional area (Excel I/O, mirror-pattern detection,
Jinja2 template recovery/filters/rendering, FK hydration, the calculated-
fields mini-language) so it reads and tests like ordinary Python.

The names re-exported here are this package's public API -- every one of
them is called directly from JS (via `_pyodide.globals.get(name)` or a bare
name in an inline `runPythonAsync` script) once this package's names are
brought into Pyodide's global namespace with `from elips_engine import *`.
"""

import os  # noqa: F401 -- kept as a real, importable `os` reference so a
# test suite (or any other caller) can `mock.patch.object(elips_engine.os.path,
# 'exists', ...)` to fake `/work/in.json` during render_md_two_pass_with_report;
# os.path is a process-wide singleton, so patching it through this reference
# affects every module in the package regardless of which one calls it.

from .excel_io import (
    excel_to_json,
    update_excel_from_json,
    update_excel_hierarchy,
    create_default_workbook_from_json,
)
from .mirror_pattern import analyze_mirror_pattern, apply_mirror_column
from .calc_fields import evaluate_custom_formula, evaluate_computed_fields
from .template_render import (
    render_md_two_pass_with_report,
    validate_template_syntax,
    render_json_text,
    render_expression_preview,
)

__all__ = [
    'excel_to_json',
    'update_excel_from_json',
    'update_excel_hierarchy',
    'create_default_workbook_from_json',
    'analyze_mirror_pattern',
    'apply_mirror_column',
    'evaluate_custom_formula',
    'evaluate_computed_fields',
    'render_md_two_pass_with_report',
    'validate_template_syntax',
    'render_json_text',
    'render_expression_preview',
]
