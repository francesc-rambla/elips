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

"""Tokenizer for the calculated-field formula mini-language."""


class Token:
    __slots__ = ('type', 'value', 'pos')

    def __init__(self, type_, value, pos):
        self.type = type_
        self.value = value
        self.pos = pos

    def __repr__(self):
        return f'Token({self.type!r}, {self.value!r})'


class FormulaSyntaxError(Exception):
    def __init__(self, message, pos=None):
        super().__init__(message)
        self.pos = pos


_SINGLE_CHAR = {
    '(': 'LPAREN', ')': 'RPAREN', '[': 'LBRACKET', ']': 'RBRACKET',
    ',': 'COMMA', ';': 'SEMI', '.': 'DOT',
    '+': 'PLUS', '-': 'MINUS', '/': 'SLASH', '%': 'PERCENT',
}


def tokenize(src):
    tokens = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]

        if ch in ' \t\r\n':
            i += 1
            continue

        if ch in '"\'':
            quote = ch
            j = i + 1
            buf = []
            while j < n and src[j] != quote:
                if src[j] == '\\' and j + 1 < n and src[j + 1] in (quote, '\\'):
                    buf.append(src[j + 1])
                    j += 2
                else:
                    buf.append(src[j])
                    j += 1
            if j >= n:
                raise FormulaSyntaxError('Cadena de text sense cometa de tancament', i)
            tokens.append(Token('STRING', ''.join(buf), i))
            i = j + 1
            continue

        if ch.isdigit() or (ch == '.' and i + 1 < n and src[i + 1].isdigit()):
            j = i
            seen_dot = False
            while j < n and (src[j].isdigit() or (src[j] == '.' and not seen_dot)):
                if src[j] == '.':
                    seen_dot = True
                j += 1
            tokens.append(Token('NUMBER', float(src[i:j]), i))
            i = j
            continue

        if ch.isalpha() or ch == '_':
            j = i
            while j < n and (src[j].isalnum() or src[j] == '_'):
                j += 1
            word = src[i:j]
            tokens.append(Token('IDENT', word, i))
            i = j
            continue

        if ch == '*':
            if i + 1 < n and src[i + 1] == '*':
                tokens.append(Token('POWER', '**', i))
                i += 2
            else:
                tokens.append(Token('STAR', '*', i))
                i += 1
            continue

        if ch == '/':
            if i + 1 < n and src[i + 1] == '/':
                tokens.append(Token('FLOORDIV', '//', i))
                i += 2
            else:
                tokens.append(Token('SLASH', '/', i))
                i += 1
            continue

        if ch == '=':
            if i + 1 < n and src[i + 1] == '=':
                tokens.append(Token('EQ', '==', i))
                i += 2
            else:
                tokens.append(Token('EQ', '==', i))
                i += 1
            continue

        if ch == '!':
            if i + 1 < n and src[i + 1] == '=':
                tokens.append(Token('NE', '!=', i))
                i += 2
            else:
                raise FormulaSyntaxError(f"Caràcter inesperat '!' a la posició {i}", i)
            continue

        if ch == '<':
            if i + 1 < n and src[i + 1] == '=':
                tokens.append(Token('LE', '<=', i))
                i += 2
            elif i + 1 < n and src[i + 1] == '>':
                tokens.append(Token('NE', '<>', i))
                i += 2
            else:
                tokens.append(Token('LT', '<', i))
                i += 1
            continue

        if ch == '>':
            if i + 1 < n and src[i + 1] == '=':
                tokens.append(Token('GE', '>=', i))
                i += 2
            else:
                tokens.append(Token('GT', '>', i))
                i += 1
            continue

        if ch == '^':
            tokens.append(Token('POWER', '^', i))
            i += 1
            continue

        if ch in _SINGLE_CHAR:
            tokens.append(Token(_SINGLE_CHAR[ch], ch, i))
            i += 1
            continue

        raise FormulaSyntaxError(f"Caràcter inesperat '{ch}' a la posició {i}", i)

    tokens.append(Token('EOF', None, n))
    return tokens
