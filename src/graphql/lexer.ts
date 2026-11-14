// GraphQL lexer: turns a document string into tokens. Follows the October
// 2021 spec's lexical grammar — names, ints, floats, strings (with escapes),
// block strings, punctuation, comments and insignificant commas. The suite's
// 18 documents use only a subset, but a complete lexer costs little and keeps
// the parser honest.

export type TokenKind =
  | 'Name'
  | 'Int'
  | 'Float'
  | 'String'
  | 'BlockString'
  | 'Bang'
  | 'Dollar'
  | 'Amp'
  | 'ParenL'
  | 'ParenR'
  | 'Spread'
  | 'Colon'
  | 'Equals'
  | 'At'
  | 'BracketL'
  | 'BracketR'
  | 'BraceL'
  | 'Pipe'
  | 'BraceR'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  /** The decoded value for Name/Int/Float/String/BlockString, else the raw text. */
  value: string;
  line: number;
  column: number;
}

export class GraphQLSyntaxError extends Error {
  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'GraphQLSyntaxError';
  }
}

const PUNCTUATION: Readonly<Record<string, TokenKind>> = {
  '!': 'Bang',
  '$': 'Dollar',
  '&': 'Amp',
  '(': 'ParenL',
  ')': 'ParenR',
  ':': 'Colon',
  '=': 'Equals',
  '@': 'At',
  '[': 'BracketL',
  ']': 'BracketR',
  '{': 'BraceL',
  '|': 'Pipe',
  '}': 'BraceR',
};

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isNameStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isNameContinue(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch);
}

/** Dedent a block string per the spec (common indent stripped, edges trimmed). */
function dedentBlockString(raw: string): string {
  const lines = raw.split('\n');
  let commonIndent: number | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    commonIndent = commonIndent === null ? indent : Math.min(commonIndent, indent);
  }
  const dedented =
    commonIndent === null || commonIndent === 0
      ? lines
      : lines.map((line, i) => (i === 0 ? line : line.slice(commonIndent as number)));
  // Trim blank leading/trailing lines.
  let start = 0;
  let end = dedented.length;
  while (start < end && dedented[start]?.trim() === '') start += 1;
  while (end > start && dedented[end - 1]?.trim() === '') end -= 1;
  return dedented.slice(start, end).join('\n');
}

export function lexGraphQL(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 1;
  const length = source.length;

  const error = (message: string): never => {
    throw new GraphQLSyntaxError(message, line, column);
  };

  const advance = (count = 1): void => {
    for (let i = 0; i < count; i += 1) {
      if (source[pos] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      pos += 1;
    }
  };

  const push = (kind: TokenKind, value: string, startLine: number, startColumn: number): void => {
    tokens.push({ kind, value, line: startLine, column: startColumn });
  };

  while (pos < length) {
    const ch = source[pos] as string;

    // Ignored: whitespace, commas, BOM, comments.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (pos < length && source[pos] !== '\n' && source[pos] !== '\r') advance();
      continue;
    }

    const startLine = line;
    const startColumn = column;

    // Spread `...`
    if (ch === '.') {
      if (source.slice(pos, pos + 3) !== '...') error('Unexpected character "."');
      advance(3);
      push('Spread', '...', startLine, startColumn);
      continue;
    }

    // Punctuation.
    const punct = PUNCTUATION[ch];
    if (punct !== undefined) {
      advance();
      push(punct, ch, startLine, startColumn);
      continue;
    }

    // Names.
    if (isNameStart(ch)) {
      let value = '';
      while (pos < length && isNameContinue(source[pos] as string)) {
        value += source[pos];
        advance();
      }
      push('Name', value, startLine, startColumn);
      continue;
    }

    // Numbers: Int or Float.
    if (ch === '-' || isDigit(ch)) {
      let raw = '';
      if (ch === '-') {
        raw += '-';
        advance();
        if (pos >= length || !isDigit(source[pos] as string)) error('Invalid number');
      }
      if (source[pos] === '0') {
        raw += '0';
        advance();
      } else {
        while (pos < length && isDigit(source[pos] as string)) {
          raw += source[pos];
          advance();
        }
      }
      let isFloat = false;
      if (source[pos] === '.' && isDigit(source[pos + 1] ?? '')) {
        isFloat = true;
        raw += '.';
        advance();
        while (pos < length && isDigit(source[pos] as string)) {
          raw += source[pos];
          advance();
        }
      }
      const exp = source[pos];
      if (exp === 'e' || exp === 'E') {
        isFloat = true;
        raw += exp;
        advance();
        if (source[pos] === '+' || source[pos] === '-') {
          raw += source[pos];
          advance();
        }
        if (pos >= length || !isDigit(source[pos] as string)) error('Invalid number exponent');
        while (pos < length && isDigit(source[pos] as string)) {
          raw += source[pos];
          advance();
        }
      }
      if (pos < length && (isDigit(source[pos] as string) || source[pos] === '.' || isNameStart(source[pos] as string))) {
        error('Invalid number');
      }
      push(isFloat ? 'Float' : 'Int', raw, startLine, startColumn);
      continue;
    }

    // Strings and block strings.
    if (ch === '"') {
      if (source.slice(pos, pos + 3) === '"""') {
        advance(3);
        let raw = '';
        for (;;) {
          if (pos >= length) error('Unterminated block string');
          if (source.slice(pos, pos + 3) === '"""') {
            advance(3);
            break;
          }
          // `\"""` is an escaped quote inside a block string.
          if (source.slice(pos, pos + 4) === '\\"""') {
            raw += '"""';
            advance(4);
            continue;
          }
          raw += source[pos];
          advance();
        }
        push('BlockString', dedentBlockString(raw), startLine, startColumn);
        continue;
      }
      advance();
      let value = '';
      for (;;) {
        if (pos >= length) error('Unterminated string');
        const c = source[pos] as string;
        if (c === '"') {
          advance();
          break;
        }
        if (c === '\n' || c === '\r') error('Unterminated string');
        if (c === '\\') {
          advance();
          const esc = source[pos] as string;
          if (esc === undefined) error('Unterminated string');
          const simple: Record<string, string> = {
            '"': '"',
            '/': '/',
            '\\': '\\',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (esc === 'u') {
            const hex = source.slice(pos + 1, pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) error('Invalid unicode escape');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            advance(5);
            continue;
          }
          const decoded = simple[esc];
          if (decoded === undefined) error(`Invalid escape sequence \\${esc}`);
          value += decoded;
          advance();
          continue;
        }
        value += c;
        advance();
      }
      push('String', value, startLine, startColumn);
      continue;
    }

    error(`Unexpected character ${JSON.stringify(ch)}`);
  }

  tokens.push({ kind: 'EOF', value: '', line, column });
  return tokens;
}
