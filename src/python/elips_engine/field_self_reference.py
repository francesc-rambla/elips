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

"""Pre-renders a field's OWN embedded Jinja2 content (the "Avaluació
dinàmica doble" feature documented in manual.md 1.3: a text field's stored
value may itself contain `{{ }}`/`{% %}`, evaluated during document
generation) against a context scoped to the ROW that field lives on --
its own sibling fields available as bare names (shadowing same-named global
sheets, exactly like the CUSTOM formula mini-language's row-first lookup;
see formula/evaluator.py's module docstring), plus `parent`/`parent.parent`
for the nested-table ancestor chain, mirroring that same mini-language's
`parent` reserved word.

Without this, a field's embedded template only ever saw the SAME global,
row-less context as render_md_two_pass_with_report's own second pass (the
flattened, already-rendered output string re-parsed once more): a loop like
`{% for activitat in activitats %}` had no way to mean "this row's own
activitats" and had to hardcode a global index instead (`pres.parts[0].activitats`),
breaking the moment rows were reordered or added.

Runs once, mutating `doc` in place, BEFORE render_md_two_pass_with_report
builds its own clean_ctx/html_ctx wraps of the same tree -- so by the time
those run, a self/parent-aware field's text is already its final rendered
form, and the existing pass-1/pass-2 global re-render remains exactly as
useful as before for anything that doesn't need row context at all (e.g. a
field referencing a document-wide value like `{{ doc.pres.contractant }}`)."""

from jinja2 import Environment, StrictUndefined

from .template_recovery import _wrap_safe, render_with_recovery
from .template_filters import _register_common_filters

_SKIP_KEYS = ('_sheet_info', '_hierarchy_schema', 'editor_metadata')


def _wrap_parent_chain(chain):
    """`chain`: ancestor rows, nearest first. Returns a SafeDict for the
    nearest ancestor, whose own `parent` key points to the next one wrapped
    the same way, and so on -- so a field's embedded Jinja2 can write
    `parent.camp`, `parent.parent.camp`, etc. The chain's last entry simply
    has no `parent` key of its own, so one step too far falls straight
    through to SafeDict's existing missing-key Placeholder behavior; no
    special-casing needed for the top of the chain."""
    if not chain:
        return None
    label = 'parent'
    wrapped = []
    for row in chain:
        wrapped.append(_wrap_safe(row, label))
        label += '.parent'
    for i in range(len(wrapped) - 1):
        wrapped[i]['parent'] = wrapped[i + 1]
    return wrapped[0]


def _walk_rows(container, doc_snapshot, env, parent_chain, issues):
    if isinstance(container, list):
        for item in container:
            _walk_rows(item, doc_snapshot, env, parent_chain, issues)
        return
    if not isinstance(container, dict):
        return

    string_fields = [k for k, v in container.items() if isinstance(v, str) and ('{{' in v or '{%' in v)]
    if string_fields:
        row_ctx = dict(doc_snapshot)
        row_ctx.update(_wrap_safe(container, ''))
        parent_wrapper = _wrap_parent_chain(parent_chain)
        if parent_wrapper is not None:
            row_ctx['parent'] = parent_wrapper
        for key in string_fields:
            rendered, sub_issues = render_with_recovery(env, container[key], row_ctx, 'auto-referencial')
            container[key] = rendered
            issues.extend(sub_issues)

    child_parent_chain = (container,) + parent_chain
    for key, val in list(container.items()):
        if key in _SKIP_KEYS:
            continue
        # A hydrated dynamic-Select FK value (see hydrate_foreign_keys) is a
        # dict carrying the related row's own columns -- semantically still
        # this field's own scalar value, never a nested row to walk into or
        # render fields "as" (same convention as calc_fields.py's run_custom_pass).
        if isinstance(val, dict) and '_default_val' in val:
            continue
        if isinstance(val, (dict, list)):
            _walk_rows(val, doc_snapshot, env, child_parent_chain, issues)


def render_field_self_references(doc):
    """Walks `doc` (the full data tree, post FK-hydration), pre-rendering
    every string field's own embedded Jinja2 against a context scoped to
    the row it lives on (see this module's docstring). Mutates and returns
    `doc`, plus the list of recovery issues encountered (same shape as
    render_with_recovery's, foldable into render_md_two_pass_with_report's
    own `issues` list)."""
    if not isinstance(doc, dict):
        return doc, []

    doc_snapshot = _wrap_safe(doc, '')
    if 'doc' not in doc_snapshot:
        doc_snapshot['doc'] = doc_snapshot

    # trim_blocks/lstrip_blocks=True: matches env_clean/env_html in
    # template_render.py -- without it, a {% for %}/{% endfor %} inside a
    # field's own free text would leave stray blank lines behind.
    env = Environment(undefined=StrictUndefined, autoescape=False, trim_blocks=True, lstrip_blocks=True)
    _register_common_filters(env)

    issues = []
    for key, val in doc.items():
        if key in _SKIP_KEYS:
            continue
        _walk_rows(val, doc_snapshot, env, (), issues)
    return doc, issues
