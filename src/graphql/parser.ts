// GraphQL parser: tokens → AST. Recursive descent over the October 2021
// spec's grammar — operations, fragments, variable definitions, arguments,
// and literal values (variables, enums, lists, input objects). Directives are
// parsed and dropped (the suite sends none; @skip/@include are not needed).

import { lexGraphQL, GraphQLSyntaxError, type Token, type TokenKind } from './lexer.ts';

export type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'IntValue'; value: string }
  | { kind: 'FloatValue'; value: string }
  | { kind: 'StringValue'; value: string }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'NullValue' }
  | { kind: 'EnumValue'; value: string }
  | { kind: 'ListValue'; values: ValueNode[] }
  | { kind: 'ObjectValue'; fields: { name: string; value: ValueNode }[] };

export type TypeNode =
  | { kind: 'NamedType'; name: string }
  | { kind: 'ListType'; ofType: TypeNode }
  | { kind: 'NonNullType'; ofType: TypeNode };

export interface ArgumentNode {
  name: string;
  value: ValueNode;
}

export interface DirectiveNode {
  name: string;
  arguments: ArgumentNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  arguments: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}

export interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
  directives: DirectiveNode[];
}

export interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export interface VariableDefinitionNode {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | null;
  directives: DirectiveNode[];
}

export interface OperationDefinitionNode {
  kind: 'OperationDefinition';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VariableDefinitionNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export interface FragmentDefinitionNode {
  kind: 'FragmentDefinition';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export type DefinitionNode = OperationDefinitionNode | FragmentDefinitionNode;

export interface DocumentNode {
  kind: 'Document';
  definitions: DefinitionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = lexGraphQL(source);
  }

  private get current(): Token {
    return this.tokens[this.index] as Token;
  }

  private error(message: string): never {
    const token = this.current;
    throw new GraphQLSyntaxError(message, token.line, token.column);
  }

  private advance(): Token {
    const token = this.current;
    if (token.kind !== 'EOF') this.index += 1;
    return token;
  }

  private expect(kind: TokenKind): Token {
    if (this.current.kind !== kind) {
      this.error(`Expected ${kind} but found ${this.current.kind} ${JSON.stringify(this.current.value)}`);
    }
    return this.advance();
  }

  private expectKeyword(keyword: string): Token {
    if (this.current.kind !== 'Name' || this.current.value !== keyword) {
      this.error(`Expected "${keyword}" but found ${JSON.stringify(this.current.value)}`);
    }
    return this.advance();
  }

  private peekKeyword(keyword: string): boolean {
    return this.current.kind === 'Name' && this.current.value === keyword;
  }

  private skip(kind: TokenKind): boolean {
    if (this.current.kind !== kind) return false;
    this.advance();
    return true;
  }

  parseDocument(): DocumentNode {
    const definitions: DefinitionNode[] = [];
    while (this.current.kind !== 'EOF') {
      definitions.push(this.parseDefinition());
    }
    if (definitions.length === 0) this.error('Expected at least one definition');
    return { kind: 'Document', definitions };
  }

  private parseDefinition(): DefinitionNode {
    if (this.peekKeyword('fragment')) return this.parseFragmentDefinition();
    return this.parseOperationDefinition();
  }

  private parseOperationDefinition(): OperationDefinitionNode {
    // Shorthand: `{ ... }`
    if (this.current.kind === 'BraceL') {
      return {
        kind: 'OperationDefinition',
        operation: 'query',
        name: null,
        variableDefinitions: [],
        directives: [],
        selectionSet: this.parseSelectionSet(),
      };
    }
    const operationToken = this.advance();
    if (
      operationToken.kind !== 'Name' ||
      (operationToken.value !== 'query' && operationToken.value !== 'mutation' && operationToken.value !== 'subscription')
    ) {
      this.error(`Expected an operation but found ${JSON.stringify(operationToken.value)}`);
    }
    const operation = operationToken.value as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.current.kind === 'Name') name = this.advance().value;
    const variableDefinitions = this.parseVariableDefinitions();
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'OperationDefinition', operation, name, variableDefinitions, directives, selectionSet };
  }

  private parseVariableDefinitions(): VariableDefinitionNode[] {
    if (!this.skip('ParenL')) return [];
    const definitions: VariableDefinitionNode[] = [];
    while (!this.skip('ParenR')) {
      this.expect('Dollar');
      const name = this.expect('Name').value;
      this.expect('Colon');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.skip('Equals')) defaultValue = this.parseValueLiteral(true);
      const directives = this.parseDirectives();
      definitions.push({ name, type, defaultValue, directives });
    }
    return definitions;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.skip('BracketL')) {
      const ofType = this.parseType();
      this.expect('BracketR');
      type = { kind: 'ListType', ofType };
    } else {
      type = { kind: 'NamedType', name: this.expect('Name').value };
    }
    if (this.skip('Bang')) type = { kind: 'NonNullType', ofType: type };
    return type;
  }

  private parseFragmentDefinition(): FragmentDefinitionNode {
    this.expectKeyword('fragment');
    const nameToken = this.expect('Name');
    if (nameToken.value === 'on') this.error('Fragment name cannot be "on"');
    this.expectKeyword('on');
    const typeCondition = this.expect('Name').value;
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'FragmentDefinition', name: nameToken.value, typeCondition, directives, selectionSet };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('BraceL');
    const selections: SelectionNode[] = [];
    while (!this.skip('BraceR')) {
      selections.push(this.parseSelection());
    }
    if (selections.length === 0) this.error('Expected at least one selection');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.current.kind === 'Spread') return this.parseFragment();
    return this.parseField();
  }

  private parseFragment(): FragmentSpreadNode | InlineFragmentNode {
    this.expect('Spread');
    if (this.current.kind === 'Name' && this.current.value !== 'on') {
      const name = this.advance().value;
      const directives = this.parseDirectives();
      return { kind: 'FragmentSpread', name, directives };
    }
    let typeCondition: string | null = null;
    if (this.peekKeyword('on')) {
      this.advance();
      typeCondition = this.expect('Name').value;
    }
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'InlineFragment', typeCondition, directives, selectionSet };
  }

  private parseField(): FieldNode {
    const first = this.expect('Name');
    let alias: string | null = null;
    let name = first.value;
    if (this.skip('Colon')) {
      alias = name;
      name = this.expect('Name').value;
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selectionSet = this.current.kind === 'BraceL' ? this.parseSelectionSet() : null;
    return { kind: 'Field', alias, name, arguments: args, directives, selectionSet };
  }

  private parseArguments(): ArgumentNode[] {
    if (!this.skip('ParenL')) return [];
    const args: ArgumentNode[] = [];
    while (!this.skip('ParenR')) {
      const name = this.expect('Name').value;
      this.expect('Colon');
      const value = this.parseValueLiteral(false);
      args.push({ name, value });
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.current.kind === 'At') {
      this.advance();
      const name = this.expect('Name').value;
      const args = this.parseArguments();
      directives.push({ name, arguments: args });
    }
    return directives;
  }

  private parseValueLiteral(constant: boolean): ValueNode {
    const token = this.current;
    switch (token.kind) {
      case 'BracketL': {
        this.advance();
        const values: ValueNode[] = [];
        while (!this.skip('BracketR')) values.push(this.parseValueLiteral(constant));
        return { kind: 'ListValue', values };
      }
      case 'BraceL': {
        this.advance();
        const fields: { name: string; value: ValueNode }[] = [];
        while (!this.skip('BraceR')) {
          const name = this.expect('Name').value;
          this.expect('Colon');
          fields.push({ name, value: this.parseValueLiteral(constant) });
        }
        return { kind: 'ObjectValue', fields };
      }
      case 'Int': {
        this.advance();
        return { kind: 'IntValue', value: token.value };
      }
      case 'Float': {
        this.advance();
        return { kind: 'FloatValue', value: token.value };
      }
      case 'String':
      case 'BlockString': {
        this.advance();
        return { kind: 'StringValue', value: token.value };
      }
      case 'Dollar': {
        if (constant) this.error('Variable values are not allowed in constant positions');
        this.advance();
        return { kind: 'Variable', name: this.expect('Name').value };
      }
      case 'Name': {
        this.advance();
        if (token.value === 'true') return { kind: 'BooleanValue', value: true };
        if (token.value === 'false') return { kind: 'BooleanValue', value: false };
        if (token.value === 'null') return { kind: 'NullValue' };
        return { kind: 'EnumValue', value: token.value };
      }
      default:
        return this.error(`Unexpected ${token.kind} ${JSON.stringify(token.value)} as a value`);
    }
  }
}

/** Parse a GraphQL document string into an AST (throws GraphQLSyntaxError). */
export function parseGraphQL(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}
