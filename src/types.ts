import { encodeRange, Violation } from 'basketry';
import {
  AST,
  DocumentNode as AbstractDocumentNode,
  LiteralNode,
  NodeConstructor,
  NodeContext,
} from '@basketry/ast';

export { LiteralNode };

export type PartialViolation = Pick<
  Violation,
  'code' | 'message' | 'range' | 'severity'
>;

const violations = new WeakMap<
  AbstractDocumentNode,
  Map<string, PartialViolation>
>();

function violationKey(violation: PartialViolation): string {
  return `${violation.message}|${violation.range.start.offset}|${violation.range.end.offset}`;
}

function error(
  root: AbstractDocumentNode,
  violation: Omit<PartialViolation, 'code' | 'severity'>,
): void {
  addViolation(root, {
    code: 'openapi-3/invalid-schema',
    ...violation,
    severity: 'error',
  });
}

function warning(
  root: AbstractDocumentNode,
  violation: Omit<PartialViolation, 'code' | 'severity'>,
): void {
  addViolation(root, {
    code: 'openapi-3/invalid-schema',
    ...violation,
    severity: 'warning',
  });
}

function unsupported(
  root: AbstractDocumentNode,
  violation: Omit<PartialViolation, 'code' | 'severity'>,
): void {
  addViolation(root, {
    code: 'openapi-3/unsupported-feature',
    ...violation,
    severity: 'warning',
  });
}

function addViolation(
  root: AbstractDocumentNode,
  violation: PartialViolation,
): void {
  const map = violations.get(root);
  if (map) {
    map.set(violationKey(violation), violation);
  } else {
    violations.set(root, new Map([[violationKey(violation), violation]]));
    return;
  }
}

export function getViolations(node: AbstractDocumentNode): PartialViolation[] {
  const map = violations.get(node);
  if (!map) return [];

  return Array.from(map.values());
}

export function refRange(root: AST.ASTNode, ref: string): string {
  if (!ref.startsWith('#')) throw new Error(`Cannot resolve ref '${ref}'`);

  let node: AST.ASTNode = root;

  let result: string = encodeRange(node.loc);

  for (const segment of ref.split('/')) {
    if (segment === '#') {
      node = root;
    } else {
      if (node.isObject()) {
        const child = node.children.find((n) => n.key.value === segment);
        if (!child) throw new Error(`Cannot resolve ref '${ref}'`);
        node = child.value;
        result = encodeRange(child.key.loc);
      } else {
        throw new Error(`Cannot resolve ref '${ref}'`);
      }
    }
  }

  return result;
}

export function resolveRef(
  root: AST.ASTNode,
  ref: string,
): AST.ASTNode | undefined {
  if (!ref.startsWith('#')) return undefined;

  let result: AST.ASTNode = root;

  for (const segment of ref.split('/')) {
    if (segment === '#') {
      result = root;
    } else {
      if (result.isObject()) {
        const child = result.children.find((n) => n.key.value === segment);
        if (!child) return undefined;
        result = child.value;
      } else {
        return undefined;
      }
    }
  }

  return result;
}

export function resolve<T extends DocumentNode>(
  root: AST.ASTNode,
  itemOrRef: T | RefNode,
  Node: NodeConstructor<T>,
): T | undefined {
  try {
    if (isRefNode(itemOrRef)) {
      const { $ref } = itemOrRef;
      if (!$ref) {
        error(itemOrRef.root, {
          message: 'Missing property "$ref".',
          range: itemOrRef.loc,
        });
        return;
      }

      const resolved = resolveRef(root, $ref.value);
      if (!resolved) {
        error(itemOrRef.root, {
          message: `Cannot resolve reference "${$ref.value}".`,
          range: $ref.loc,
        });
        return;
      }

      return new Node(resolved, {
        root: itemOrRef.root,
        parentKey: undefined,
      });
    } else {
      return itemOrRef;
    }
  } catch {
    error(itemOrRef.root, {
      message: 'Invalid reference.',
      range: itemOrRef.loc,
    });
    return;
  }
}

export function resolveParam(
  root: AST.ASTNode,
  paramOrRef: RefNode | ParameterNode,
): ParameterNode | undefined {
  return resolve(root, paramOrRef, ParameterNode);
}

export type SchemaNodeUnion =
  | StringSchemaNode
  | NumberSchemaNode
  | BooleanSchemaNode
  | ArraySchemaNode
  | ObjectSchemaNode;

export type SecuritySchemeNode =
  | HttpSecuritySchemeNode
  | ApiKeySecuritySchemeNode
  | OAuth2SecuritySchemeNode
  | OpenIdConnectSecuritySchemeNode;

export function resolveSchema(
  root: AST.ASTNode,
  schemaOrRef: RefNode | SchemaNodeUnion,
): SchemaNodeUnion | undefined {
  if (!isRefNode(schemaOrRef)) return schemaOrRef;

  const { $ref } = schemaOrRef;
  if (!$ref) {
    error(schemaOrRef.root, {
      message: 'Missing property "$ref".',
      range: schemaOrRef.loc,
    });
    return;
  }

  const node = resolveRef(root, $ref.value);
  if (!node) {
    error(schemaOrRef.root, {
      message: `Cannot resolve reference "${$ref.value}".`,
      range: $ref.loc,
    });
    return;
  }
  if (!node.isObject()) return;

  const typeNode = node.children.find((n) => n.key.value === 'type')?.value;

  const context: NodeContext = { root: schemaOrRef.root, parentKey: undefined };

  if (!typeNode) {
    // Probably an allOf, anyOf, or oneOf
    return new ObjectSchemaNode(node, context);
  }

  if (!typeNode?.isLiteral()) return;

  switch (typeNode.value) {
    case 'string':
      return new StringSchemaNode(node, context);
    case 'integer':
    case 'number':
      return new NumberSchemaNode(node, context);
    case 'boolean':
      return new BooleanSchemaNode(node, context);
    case 'array':
      return new ArraySchemaNode(node, context);
    case 'object':
      return new ObjectSchemaNode(node, context);
    default:
      return;
  }
}

export function resolveParamOrSchema(
  root: AST.ASTNode,
  itemOrRef: RefNode | ParameterNode | SchemaNodeUnion,
): ParameterNode | SchemaNodeUnion | undefined {
  if (!isRefNode(itemOrRef)) return itemOrRef;

  const { $ref } = itemOrRef;
  if (!$ref) {
    error(itemOrRef.root, {
      message: 'Missing property "$ref".',
      range: itemOrRef.loc,
    });
    return;
  }

  const node = resolveRef(root, $ref.value);
  if (!node) {
    error(itemOrRef.root, {
      message: `Cannot resolve reference "${$ref.value}".`,
      range: $ref.loc,
    });
    return;
  }
  if (!node.isObject()) return;

  const inNode = node.children.find((n) => n.key.value === 'in')?.value;
  if (inNode?.isLiteral()) {
    return resolveParam(root, itemOrRef);
  } else {
    return resolveSchema(root, itemOrRef);
  }
}

export function toJson(node: AST.ASTNode | undefined) {
  if (node === undefined) return undefined;
  if (node.isLiteral()) {
    return node.value;
  } else if (node.isObject()) {
    return node.children.reduce(
      (acc, child) => ({ ...acc, [child.key.value]: toJson(child.value) }),
      {},
    );
  } else if (node.isArray()) {
    return node.children.map((child) => toJson(child));
  }
}

function toSchemaOrRef(
  value: AST.ValueNode | undefined,
  root: AbstractDocumentNode,
): SchemaNodeUnion | RefNode | undefined {
  if (!value) return;

  const context: NodeContext = { root, parentKey: undefined }; // TODO: verify parentKey

  if (isRef(value)) return new RefNode(value, context);

  if (value.isObject()) {
    const typeNode = value.children.find((n) => n.key.value === 'type')?.value;
    if (!typeNode) {
      // Probably an allOf, anyOf, or oneOf
      return new ObjectSchemaNode(value, context);
    }
    if (typeNode?.isLiteral()) {
      switch (typeNode.value) {
        case 'string':
          return new StringSchemaNode(value, context);
        case 'number':
        case 'integer':
          return new NumberSchemaNode(value, context);
        case 'boolean':
          return new BooleanSchemaNode(value, context);
        case 'array':
          return new ArraySchemaNode(value, context);
        case 'object':
          return new ObjectSchemaNode(value, context);
      }
    }
  }

  throw new Error('Unknown schema definition');
}

function toSecuritySchemeOrRef(
  value: AST.ValueNode | undefined,
  root: AbstractDocumentNode,
): SecuritySchemeNode | RefNode | undefined {
  if (!value) return;

  const context: NodeContext = { root, parentKey: undefined }; // TODO: verify parentKey

  if (isRef(value)) return new RefNode(value, context);

  if (value.isObject()) {
    const typeNode = value.children.find((n) => n.key.value === 'type')?.value;
    if (typeNode?.isLiteral()) {
      switch (typeNode.value) {
        case 'apiKey':
          return new ApiKeySecuritySchemeNode(value, context);
        case 'http':
          return new HttpSecuritySchemeNode(value, context);
        case 'oauth2':
          return new OAuth2SecuritySchemeNode(value, context);
        case 'openIdConnect':
          return new OpenIdConnectSecuritySchemeNode(value, context);
      }
    }
  }

  throw new Error('Unknown security scheme type');
}

type KeyPattern = {
  regex: RegExp;
  message: string;
};

export abstract class DocumentNode extends AbstractDocumentNode {
  constructor(value: AST.ASTNode, context: NodeContext) {
    super(value, context);
    this.validate();
  }

  private validate(): void {
    for (const key of this.keys) {
      for (const unsupportedKey of this.unsupportedKeys) {
        if (key === unsupportedKey) {
          unsupported(this.root, {
            message: `Property "${key}" is not yet supported and will have no effect.`,
            range: this.getProperty(key)?.key.loc ?? {
              start: this.loc.start,
              end: this.loc.start,
            },
          });
        }
      }

      let missingRequiredPattern = false;
      for (const pattern of this.requiredPatterns) {
        if (!pattern.regex.test(key)) {
          missingRequiredPattern = true;
          warning(this.root, {
            message: pattern.message,
            range: this.getProperty(key)?.key.loc ?? {
              start: this.loc.start,
              end: this.loc.start,
            },
          });
        }
      }
      if (missingRequiredPattern) continue;

      if (this.allowedKeys.has(key)) continue;

      let isDisallowed = false;
      for (const pattern of this.disallowedPatterns) {
        if (pattern.regex.test(key)) {
          isDisallowed = true;
          warning(this.root, {
            message: pattern.message,
            range: this.getProperty(key)?.key.loc ?? {
              start: this.loc.start,
              end: this.loc.start,
            },
          });
        }
      }
      if (isDisallowed) continue;

      if (this.allowedPatterns.some((pattern) => pattern.test(key))) continue;

      warning(this.root, {
        message: `Property ${key} is not allowed.`,
        range: this.getProperty(key)?.key.loc ?? {
          start: this.loc.start,
          end: this.loc.start,
        },
      });
    }
  }

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(this.keys);
  }
  protected get allowedPatterns(): ReadonlyArray<RegExp> {
    return [/^x-/];
  }
  protected get requiredPatterns(): ReadonlyArray<KeyPattern> {
    return [];
  }
  protected get disallowedPatterns(): ReadonlyArray<KeyPattern> {
    return [];
  }

  protected get unsupportedKeys(): ReadonlySet<string> {
    return new Set([]);
  }

  protected getRequiredChild<T extends AbstractDocumentNode>(
    key: string,
    Node: NodeConstructor<T>,
  ): T | undefined {
    const node = super.getChild(key, Node);

    if (!node) {
      error(this.root, {
        message: `Missing property "${key}".`,
        range: this.parentKey
          ? this.parentKey.loc
          : { start: this.loc.start, end: this.loc.start },
      });
    }

    return node;
  }

  protected getRequiredArray<T extends AbstractDocumentNode>(
    key: string,
    Node: NodeConstructor<T>,
  ): T[] | undefined {
    const nodes = super.getArray(key, Node);

    if (!nodes) {
      error(this.root, {
        message: `Missing property "${key}".`,
        range: this.parentKey
          ? this.parentKey.loc
          : { start: this.loc.start, end: this.loc.start },
      });
    }

    return nodes;
  }

  protected getRequiredProperty(key: string): AST.PropertyNode | undefined {
    const node = super.getProperty(key);

    if (!node) {
      error(this.root, {
        message: `Missing property "${key}".`,
        range: this.parentKey
          ? this.parentKey.loc
          : { start: this.loc.start, end: this.loc.start },
      });
    }

    return node;
  }

  protected getRequiredLiteral<T extends string | number | boolean | null>(
    key: string,
  ): LiteralNode<T> | undefined {
    const literal = super.getLiteral<T>(key);

    if (!literal) {
      error(this.root, {
        message: `Missing property "${key}".`,
        range: this.parentKey
          ? this.parentKey.loc
          : { start: this.loc.start, end: this.loc.start },
      });
    }

    return literal;
  }

  protected getChildOrRef<T extends AbstractDocumentNode>(
    key: string,
    Node: NodeConstructor<T>,
  ): T | RefNode | undefined {
    const prop = this.getProperty(key);
    if (!prop) return undefined;

    const context: NodeContext = { root: this.root, parentKey: prop.key };

    if (isRef(prop.value)) {
      return new RefNode(prop.value, context);
    } else {
      return new Node(prop.value, context);
    }
  }
}

export abstract class IndexNode<
  T extends AbstractDocumentNode,
> extends DocumentNode {
  abstract read(key: string): T | undefined;
}

export abstract class RefIndexNode<
  T extends AbstractDocumentNode,
> extends DocumentNode {
  abstract read(key: string): T | RefNode | undefined;
}

// Begin specification //

// Done
export class OpenAPINode extends DocumentNode {
  public readonly nodeType = 'Schema';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'openapi',
      'info',
      'servers',
      'paths',
      'components',
      'security',
      'tags',
      'externalDocs',
    ]);
  }

  get openapi() {
    return this.getRequiredLiteral<string>('openapi');
  }

  get info() {
    return this.getRequiredChild('info', InfoNode);
  }

  get servers() {
    throw new Error('Not implemented');
  }

  get paths() {
    return this.getChild('paths', PathsNode);
  }

  get components() {
    return this.getChild('components', ComponentsNode);
  }

  get security() {
    return this.getArray('security', SecurityRequirementNode);
  }

  get tags() {
    return this.getArray('tags', TagNode);
  }

  get externalDocs() {
    return this.getChild('externalDocs', ExternalDocumentationNode);
  }
}

// Done
export class InfoNode extends DocumentNode {
  public readonly nodeType = 'Info';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'title',
      'description',
      'termsOfService',
      'contact',
      'license',
      'version',
    ]);
  }

  get title() {
    return this.getRequiredLiteral<string>('title');
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get termsOfService() {
    return this.getLiteral<string>('termsOfService');
  }

  get contact() {
    return this.getChild('contact', ContactNode);
  }

  get license() {
    return this.getChild('license', LicenseNode);
  }

  get version() {
    return this.getRequiredLiteral<string>('version');
  }
}

// Done
export class ContactNode extends DocumentNode {
  public readonly nodeType = 'Contact';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['name', 'url', 'email']);
  }

  get name() {
    return this.getLiteral<string>('name');
  }

  get url() {
    return this.getLiteral<string>('url');
  }

  get email() {
    return this.getLiteral<string>('email');
  }
}

// Done
export class LicenseNode extends DocumentNode {
  public readonly nodeType = 'License';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['name', 'url']);
  }

  get name() {
    return this.getRequiredLiteral<string>('name');
  }

  get url() {
    return this.getLiteral<string>('url');
  }
}

// Done
export class ServerNode extends DocumentNode {
  public readonly nodeType = 'Server';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['url', 'description', 'variables']);
  }

  get url() {
    return this.getRequiredLiteral<string>('url');
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get variables() {
    return this.getChild('variables', ServerVariablesNode);
  }
}

// Done
export class ServerVariablesNode extends DocumentNode {
  public readonly nodeType = 'ServerVariables';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['url', 'description']);
  }

  read(key: string) {
    return this.getChild(key, ServerVariableNode);
  }
}

// Done
export class ServerVariableNode extends DocumentNode {
  public readonly nodeType = 'ServerVariable';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['enum', 'default', 'description']);
  }

  get enum() {
    return this.getArray<LiteralNode<string>>('enum', LiteralNode);
  }

  get default() {
    return this.getLiteral<string>('default');
  }

  get description() {
    return this.getLiteral<string>('description');
  }
}

// Done
export class ComponentsNode extends DocumentNode {
  public readonly nodeType = 'Components';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'schemas',
      'responses',
      'parameters',
      'examples',
      'requestBodies',
      'headers',
      'securitySchemes',
      'links',
      'callbacks',
    ]);
  }

  get schemas() {
    return this.getChild('schemas', SchemaIndexNode);
  }

  get responses() {
    return this.getChild('responses', ResponseIndexNode);
  }

  get parameters() {
    return this.getChild('parameters', ParameterIndexNode);
  }

  get examples() {
    return this.getChild('examples', ExampleIndexNode);
  }

  get requestBodies() {
    return this.getChild('requestBodies', RequestBodyIndexNode);
  }

  get headers() {
    return this.getChild('headers', HeaderIndexNode);
  }

  get securitySchemes() {
    return this.getChild('securitySchemes', SecuritySchemeIndexNode);
  }

  get links() {
    return this.getChild('links', LinkIndexNode);
  }

  get callbacks() {
    return this.getChild('callbacks', CallbackIndexNode);
  }
}

// Done
export class PathsNode extends RefIndexNode<PathItemNode> {
  public readonly nodeType = 'Paths';

  protected get requiredPatterns(): ReadonlyArray<KeyPattern> {
    return [{ regex: /^\/.+/, message: 'Path must start with a "/".' }];
  }

  read(key: string) {
    return this.getChildOrRef(key, PathItemNode);
  }
}

// Done
export class PathItemNode extends DocumentNode {
  public readonly nodeType = 'PathItem';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'summary',
      'description',
      'get',
      'put',
      'post',
      'delete',
      'options',
      'head',
      'patch',
      'trace',
      'servers',
      'parameters',
    ]);
  }
  protected get disallowedPatterns(): ReadonlyArray<KeyPattern> {
    return [
      {
        regex: /[A-Z]/,
        message: 'Method must be lowercase.',
      },
    ];
  }

  get summary() {
    return this.getLiteral<string>('summary');
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get get() {
    return this.getChild('get', OperationNode);
  }

  get put() {
    return this.getChild('put', OperationNode);
  }

  get post() {
    return this.getChild('post', OperationNode);
  }

  get delete() {
    return this.getChild('delete', OperationNode);
  }

  get options() {
    return this.getChild('options', OperationNode);
  }

  get head() {
    return this.getChild('head', OperationNode);
  }

  get patch() {
    return this.getChild('patch', OperationNode);
  }

  get trace() {
    return this.getChild('trace', OperationNode);
  }

  get servers() {
    return this.getArray('servers', ServerNode);
  }

  get parameters() {
    const array = this.getProperty('parameters')?.value;
    if (!array) return;

    if (!array.isArray()) throw new Error('Value is not an array');

    return array.children.map((value) =>
      isRef(value)
        ? new RefNode(value, this.root)
        : new ParameterNode(value, this.root),
    );
  }
}

// Done
export class OperationNode extends DocumentNode {
  public readonly nodeType = 'Operation';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'tags',
      'summary',
      'description',
      'externalDocs',
      'operationId',
      'parameters',
      'requestBody',
      'responses',
      'callbacks',
      'deprecated',
      'security',
      'servers',
    ]);
  }

  get tags() {
    return this.getArray<LiteralNode<string>>('tags', LiteralNode);
  }

  get summary() {
    return this.getLiteral<string>('summary');
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get externalDocs() {
    return this.getChild('externalDocs', ExternalDocumentationNode);
  }

  get operationId() {
    return this.getRequiredLiteral<string>('operationId');
  }

  get parameters() {
    const array = this.getProperty('parameters')?.value;
    if (!array) return;

    if (!array.isArray()) throw new Error('Value is not an array');

    return array.children.map((value) =>
      isRef(value)
        ? new RefNode(value, this.root)
        : new ParameterNode(value, this.root),
    );
  }

  get requestBody() {
    return this.getChildOrRef('requestBody', RequestBodyNode);
  }

  get responses() {
    return this.getRequiredChild('responses', ResponsesNode);
  }

  get callbacks() {
    return this.getChild('callbacks', CallbackIndexNode);
  }

  get deprecated() {
    return this.getLiteral<boolean>('deprecated');
  }

  get security() {
    return this.getArray('security', SecurityRequirementNode);
  }

  get servers() {
    return this.getArray('servers', ServerNode);
  }
}

// Done
export class ExternalDocumentationNode extends DocumentNode {
  public readonly nodeType = 'ExternalDocumentation';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['url', 'description']);
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get url() {
    return this.getRequiredLiteral<string>('url');
  }
}

// Done
export class ParameterNode extends DocumentNode {
  public readonly nodeType = 'Parameter';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'name',
      'in',
      'description',
      'required',
      'deprecated',
      'allowEmptyValue',
      'style',
      'explode',
      'allowReserved',
      'schema',
      'example',
      'examples',
      'content',
    ]);
  }

  get name() {
    return this.getRequiredLiteral<string>('name');
  }

  get in() {
    return this.getRequiredLiteral<'query' | 'header' | 'path' | 'cookie'>(
      'in',
    )!;
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get required() {
    return this.getLiteral<boolean>('required');
  }

  get deprecated() {
    return this.getLiteral<boolean>('deprecated');
  }

  get allowEmptyValue() {
    return this.getLiteral<boolean>('allowEmptyValue');
  }

  get style() {
    return this.getLiteral<
      | 'matrix'
      | 'label'
      | 'form'
      | 'simple'
      | 'spaceDelimited'
      | 'pipeDelimited'
      | 'deepObject'
    >('style');
  }

  get explode() {
    return this.getLiteral<boolean>('explode');
  }

  get allowReserved() {
    return this.getLiteral<boolean>('allowReserved');
  }

  get schema() {
    return toSchemaOrRef(this.getProperty('schema')?.value, this.root);
  }

  get example() {
    return this.getLiteral<string>('example');
  }

  get examples() {
    return this.getChild('examples', ExampleIndexNode);
  }

  get content() {
    return this.getChild('content', MediaTypeIndexNode);
  }
}

// Done
export class RequestBodyNode extends DocumentNode {
  public readonly nodeType = 'RequestBody';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['description', 'content', 'required']);
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get content() {
    return this.getRequiredChild('content', MediaTypeIndexNode);
  }

  get required() {
    return this.getLiteral<boolean>('required');
  }
}

// Done
export class MediaTypeNode extends DocumentNode {
  public readonly nodeType = 'MediaType';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['schema', 'example', 'examples', 'encoding']);
  }

  get schema() {
    return toSchemaOrRef(this.getProperty('schema')?.value, this.root);
  }

  get example() {
    return this.getLiteral<string>('example');
  }

  get examples() {
    return this.getChild('examples', ExampleIndexNode);
  }
}

// Done
export class EncodingNode extends DocumentNode {
  public readonly nodeType = 'Encoding';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'contentType',
      'headers',
      'style',
      'explode',
      'allowReserved',
    ]);
  }

  get contentType() {
    return this.getLiteral<string>('contentType');
  }

  get headers() {
    return this.getChild('headers', HeaderIndexNode);
  }

  get style() {
    return this.getLiteral<
      | 'matrix'
      | 'label'
      | 'form'
      | 'simple'
      | 'spaceDelimited'
      | 'pipeDelimited'
      | 'deepObject'
    >('style');
  }

  get explode() {
    return this.getLiteral<boolean>('explode');
  }

  get allowReserved() {
    return this.getLiteral<boolean>('allowReserved');
  }
}

// Done
export class ResponsesNode extends RefIndexNode<ResponseNode> {
  public readonly nodeType = 'Responses';

  read(key: string) {
    return this.getChildOrRef(key, ResponseNode);
  }
}

// Done
export class ResponseNode extends DocumentNode {
  public readonly nodeType = 'Response';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['description', 'headers', 'content', 'links']);
  }

  get description() {
    return this.getRequiredLiteral<string>('description');
  }

  get headers() {
    return this.getChild('headers', HeaderIndexNode);
  }

  get content() {
    return this.getChild('content', MediaTypeIndexNode);
  }

  get links() {
    return this.getChild('links', LinkIndexNode);
  }
}

// Done
export class CallbackNode extends IndexNode<PathItemNode> {
  public readonly nodeType = 'Callback';

  read(key: string) {
    return this.getChild(key, PathItemNode);
  }
}

// Done
export class ExampleNode extends DocumentNode {
  public readonly nodeType = 'Example';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['summary', 'description', 'value', 'externalValue']);
  }

  get summary() {
    return this.getLiteral<string>('summary');
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get value() {
    return this.getLiteral<string>('value');
  }

  get externalValue() {
    return this.getLiteral<string>('externalValue');
  }
}

// TODO
export class LinkNode extends DocumentNode {
  public readonly nodeType = 'Link';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'operationRef',
      'operationId',
      'parameters',
      'requestBody',
      'description',
      'server',
    ]);
  }

  get operationRef() {
    return this.getLiteral<string>('operationRef');
  }

  get operationId() {
    return this.getLiteral<string>('operationRef');
  }

  // TODO
}

// Done
export class HeaderNode extends DocumentNode {
  public readonly nodeType = 'Header';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'description',
      'required',
      'deprecated',
      'allowEmptyValue',
      'style',
      'explode',
      'allowReserved',
      'schema',
      'example',
      'examples',
      'content',
    ]);
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get required() {
    return this.getLiteral<boolean>('required');
  }

  get deprecated() {
    return this.getLiteral<boolean>('deprecated');
  }

  get allowEmptyValue() {
    return this.getLiteral<boolean>('allowEmptyValue');
  }

  get style() {
    return this.getLiteral<
      | 'matrix'
      | 'label'
      | 'form'
      | 'simple'
      | 'spaceDelimited'
      | 'pipeDelimited'
      | 'deepObject'
    >('style');
  }

  get explode() {
    return this.getLiteral<boolean>('explode');
  }

  get allowReserved() {
    return this.getLiteral<boolean>('allowReserved');
  }

  get schema() {
    return toSchemaOrRef(this.getProperty('schema')?.value, this.root);
  }

  get example() {
    return this.getLiteral<string>('example');
  }

  get examples() {
    return this.getChild('examples', ExampleIndexNode);
  }

  get content() {
    return this.getChild('content', MediaTypeIndexNode);
  }
}

// Done
export class TagNode extends DocumentNode {
  public readonly nodeType = 'Tag';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['name', 'description', 'externalDocs']);
  }

  get name() {
    return this.getRequiredLiteral<string>('name');
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get externalDocs() {
    return this.getChild('externalDocs', ExternalDocumentationNode);
  }
}

// Done
export abstract class SchemaNode extends DocumentNode {
  protected get unsupportedKeys(): ReadonlySet<string> {
    return new Set(['nullable', 'anyOf']);
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get nullable() {
    return this.getLiteral<boolean>('nullable');
  }

  get externalDocs() {
    return this.getChild('externalDocs', ExternalDocumentationNode);
  }

  get example() {
    return this.getLiteral<string>('example');
  }

  get deprecated() {
    return this.getLiteral<boolean>('deprecated');
  }
}

// Done
export class StringSchemaNode extends SchemaNode {
  public readonly nodeType = 'StringSchema';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'description',
      'nullable',
      'externalDocs',
      'example',
      'deprecated',
      'type',
      'default',
      'const',
      'minLength',
      'maxLength',
      'pattern',
      'format',
      'enum',
    ]);
  }

  get type() {
    return this.getRequiredLiteral<'string'>('type')!;
  }

  get default() {
    return this.getLiteral<string>('default');
  }

  get const() {
    return this.getLiteral<string>('const');
  }

  get minLength() {
    return this.getLiteral<number>('minLength');
  }

  get maxLength() {
    return this.getLiteral<number>('maxLength');
  }

  get pattern() {
    return this.getLiteral<string>('pattern');
  }

  get format() {
    return this.getLiteral<string>('format');
  }

  get enum() {
    return this.getArray<LiteralNode<string>>('enum', LiteralNode);
  }
}

// Done
export class NumberSchemaNode extends SchemaNode {
  public readonly nodeType = 'NumberSchema';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'description',
      'nullable',
      'externalDocs',
      'example',
      'deprecated',
      'type',
      'default',
      'const',
      'enum',
      'multipleOf',
      'minimum',
      'exclusiveMinimum',
      'maximum',
      'exclusiveMaximum',
      'format',
    ]);
  }

  get type() {
    return this.getRequiredLiteral<'integer' | 'number'>('type')!;
  }

  get default() {
    return this.getLiteral<number>('default');
  }

  get const() {
    return this.getLiteral<number>('const');
  }

  get enum() {
    return this.getArray<LiteralNode<number>>('enum', LiteralNode);
  }

  get multipleOf() {
    return this.getLiteral<number>('multipleOf');
  }

  get minimum() {
    return this.getLiteral<number>('minimum');
  }

  get exclusiveMinimum() {
    return this.getLiteral<boolean>('exclusiveMinimum');
  }

  get maximum() {
    return this.getLiteral<number>('maximum');
  }

  get exclusiveMaximum() {
    return this.getLiteral<boolean>('exclusiveMaximum');
  }

  get format() {
    return this.getLiteral<string>('format');
  }
}

// Done
export class BooleanSchemaNode extends SchemaNode {
  public readonly nodeType = 'BooleanSchema';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'description',
      'nullable',
      'externalDocs',
      'example',
      'deprecated',
      'type',
      'default',
      'const',
      'enum',
    ]);
  }

  get type() {
    return this.getRequiredLiteral<'boolean'>('type')!;
  }

  get default() {
    return this.getLiteral<boolean>('default');
  }

  get const() {
    return this.getLiteral<boolean>('const');
  }

  get enum() {
    return this.getArray<LiteralNode<boolean>>('enum', LiteralNode);
  }
}

// Done
export class ArraySchemaNode extends SchemaNode {
  public readonly nodeType = 'ArraySchema';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'description',
      'nullable',
      'externalDocs',
      'example',
      'deprecated',
      'type',
      'items',
      'minItems',
      'maxItems',
      'uniqueItems',
    ]);
  }

  get type() {
    return this.getRequiredLiteral<'array'>('type');
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get items() {
    return toSchemaOrRef(this.getProperty('items')?.value, this.root);
  }

  get minItems() {
    return this.getLiteral<number>('minItems');
  }

  get maxItems() {
    return this.getLiteral<number>('maxItems');
  }

  get uniqueItems() {
    return this.getLiteral<boolean>('uniqueItems');
  }
}

function isObjectSchemaOrRef(
  node: RefNode | SchemaNodeUnion | undefined,
): node is ObjectSchemaNode | RefNode {
  return node?.nodeType === 'ObjectSchema' || node?.nodeType === 'Ref';
}

// Done
export class ObjectSchemaNode extends SchemaNode {
  public readonly nodeType = 'ObjectSchema';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'description',
      'nullable',
      'externalDocs',
      'example',
      'deprecated',
      'type',
      'properties',
      'description',
      'required',
      'propertyNames',
      'additionalProperties',
      'allOf',
      'oneOf',
      'anyOf',
      'minProperties',
      'maxProperties',
      'discriminator',
      'readOnly',
      'writeOnly',
    ]);
  }

  get type() {
    return this.getLiteral<'object'>('type') || { value: 'type' };
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get required() {
    return this.getArray<LiteralNode<string>>('required', LiteralNode);
  }

  get properties() {
    return this.getChild('properties', PropertiesNode);
  }

  get allOf() {
    const prop = this.getProperty('allOf')?.value;
    if (!prop?.isArray()) return;

    return prop.children
      .map((c) => toSchemaOrRef(c, this.root))
      .filter(isObjectSchemaOrRef);
  }

  get oneOf() {
    const prop = this.getProperty('oneOf')?.value;
    if (!prop?.isArray()) return;

    return prop.children
      .map((c) => toSchemaOrRef(c, this.root))
      .filter(isObjectSchemaOrRef);
  }

  get anyOf() {
    const prop = this.getProperty('oneOf')?.value;
    if (!prop?.isArray()) return;

    return prop.children
      .map((c) => toSchemaOrRef(c, this.root))
      .filter(isObjectSchemaOrRef);
  }

  get minProperties() {
    return this.getLiteral<number>('minProperties');
  }

  get maxProperties() {
    return this.getLiteral<number>('maxProperties');
  }

  get propertyNames() {
    const value = this.getProperty('propertyNames')?.value;
    if (value?.isObject()) {
      return toSchemaOrRef(value, this.root);
    }
    return;
  }

  get additionalProperties() {
    const value = this.getProperty('additionalProperties')?.value;
    if (value?.isLiteral()) {
      return this.getLiteral<boolean>('additionalProperties');
    } else if (value?.isObject()) {
      return toSchemaOrRef(value, this.root);
    }
    return;
  }

  get discriminator() {
    return this.getChild('discriminator', DiscriminatorNode);
  }

  get readOnly() {
    return this.getLiteral<boolean>('readOnly');
  }

  get writeOnly() {
    return this.getLiteral<boolean>('writeOnly');
  }
}

// Done
export class DiscriminatorNode extends DocumentNode {
  public readonly nodeType = 'Discriminator';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['propertyName', 'mapping']);
  }

  get propertyName() {
    return this.getRequiredLiteral<string>('propertyName');
  }

  get mapping() {
    return this.getChild('mapping', StringMappingNode);
  }
}

// Done
export class HttpSecuritySchemeNode extends DocumentNode {
  public readonly nodeType = 'HttpSecurityScheme';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'type',
      'description',
      'scheme',
      'bearerFormat',
      'name',
      'in',
    ]);
  }

  get type() {
    return this.getRequiredLiteral<'http'>('type')!;
  }

  get description() {
    return this.getRequiredLiteral<string>('description');
  }
}

// Done
export class ApiKeySecuritySchemeNode extends DocumentNode {
  public readonly nodeType = 'ApiKeySecurityScheme';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['type', 'description', 'name', 'in']);
  }

  get type() {
    return this.getRequiredLiteral<'apiKey'>('type')!;
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get name() {
    return this.getRequiredLiteral<string>('name')!;
  }

  get in() {
    return this.getRequiredLiteral<'header' | 'query' | 'cookie'>('in')!;
  }
}

// Done
export class OAuth2SecuritySchemeNode extends DocumentNode {
  public readonly nodeType = 'OAuth2SecurityScheme';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['type', 'description', 'flows']);
  }

  get type() {
    return this.getRequiredLiteral<'oauth2'>('type')!;
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get flows() {
    return this.getRequiredChild('flows', OAuthFlowsNode)!;
  }
}

// Done
export class OpenIdConnectSecuritySchemeNode extends DocumentNode {
  public readonly nodeType = 'OpenIdConnectSecurityScheme';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['type', 'description', 'openIdConnectUrl']);
  }

  get type() {
    return this.getRequiredLiteral<'openIdConnect'>('type');
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get openIdConnectUrl() {
    return this.getRequiredLiteral<string>('openIdConnectUrl');
  }
}

// Done
export class OAuthFlowsNode extends DocumentNode {
  public readonly nodeType = 'OAuthFlowsNode';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set([
      'implicit',
      'password',
      'clientCredentials',
      'authorizationCode',
    ]);
  }

  get implicit() {
    return this.getChild('implicit', ImplicitFlowNode);
  }

  get password() {
    return this.getChild('password', PasswordFlowNode);
  }

  get clientCredentials() {
    return this.getChild('clientCredentials', ClientCredentialsFlowNode);
  }

  get authorizationCode() {
    return this.getChild('authorizationCode', AuthorizationCodeFlowNode);
  }
}

// Done
export abstract class OAuthFlowNode extends DocumentNode {
  get refreshUrl() {
    return this.getLiteral<string>('refreshUrl');
  }

  get scopes() {
    return this.getRequiredChild('scopes', StringMappingNode)!;
  }
}

// Done
export class ImplicitFlowNode extends OAuthFlowNode {
  public readonly nodeType = 'ImplicitFlow';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['authorizationUrl', 'refreshUrl', 'scopes']);
  }

  get authorizationUrl() {
    return this.getRequiredLiteral<string>('authorizationUrl')!;
  }
}

// Done
export class PasswordFlowNode extends OAuthFlowNode {
  public readonly nodeType = 'PasswordFlow';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['tokenUrl', 'refreshUrl', 'scopes']);
  }

  get tokenUrl() {
    return this.getRequiredLiteral<string>('tokenUrl')!;
  }
}

// Done
export class ClientCredentialsFlowNode extends OAuthFlowNode {
  public readonly nodeType = 'ClientCredentialsFlow';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['tokenUrl', 'refreshUrl', 'scopes']);
  }

  get tokenUrl() {
    return this.getRequiredLiteral<string>('tokenUrl')!;
  }
}

// Done
export class AuthorizationCodeFlowNode extends OAuthFlowNode {
  public readonly nodeType = 'AuthorizationCodeFlow';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['authorizationUrl', 'tokenUrl', 'refreshUrl', 'scopes']);
  }

  get authorizationUrl() {
    return this.getRequiredLiteral<string>('authorizationUrl')!;
  }

  get tokenUrl() {
    return this.getRequiredLiteral<string>('tokenUrl')!;
  }
}

// Done
export class SecurityRequirementNode extends DocumentNode {
  public readonly nodeType = 'SecurityRequirement';

  read(key: string) {
    return this.getArray<LiteralNode<string>>(key, LiteralNode);
  }
}

// Index Nodes //

export class SchemaIndexNode extends RefIndexNode<SchemaNodeUnion> {
  public readonly nodeType = 'SchemaIndex';

  read(key: string) {
    return toSchemaOrRef(this.getProperty(key)?.value, this.root);
  }
}

export class ResponseIndexNode extends RefIndexNode<ResponseNode> {
  public readonly nodeType = 'ResponseIndex';

  read(key: string) {
    return this.getChildOrRef(key, ResponseNode);
  }
}

export class ParameterIndexNode extends RefIndexNode<ParameterNode> {
  public readonly nodeType = 'ParameterIndex';

  read(key: string) {
    return this.getChildOrRef(key, ParameterNode);
  }
}

export class ExampleIndexNode extends RefIndexNode<ExampleNode> {
  public readonly nodeType = 'ExampleIndex';

  read(key: string) {
    return this.getChildOrRef(key, ExampleNode);
  }
}

export class RequestBodyIndexNode extends RefIndexNode<RequestBodyNode> {
  public readonly nodeType = 'RequestBodyIndex';

  read(key: string) {
    return this.getChildOrRef(key, RequestBodyNode);
  }
}

export class HeaderIndexNode extends RefIndexNode<HeaderNode> {
  public readonly nodeType = 'HeaderIndex';

  read(key: string) {
    return this.getChildOrRef(key, HeaderNode);
  }
}

export class SecuritySchemeIndexNode extends RefIndexNode<SecuritySchemeNode> {
  public readonly nodeType = 'SecuritySchemeIndex';

  read(key: string) {
    return toSecuritySchemeOrRef(this.getProperty(key)?.value, this.root);
  }
}

export class LinkIndexNode extends RefIndexNode<LinkNode> {
  public readonly nodeType = 'LinkIndex';

  read(key: string) {
    return this.getChildOrRef(key, LinkNode);
  }
}

export class CallbackIndexNode extends RefIndexNode<CallbackNode> {
  public readonly nodeType = 'CallbackIndex';

  read(key: string) {
    return this.getChildOrRef(key, CallbackNode);
  }
}

export class MediaTypeIndexNode extends IndexNode<MediaTypeNode> {
  public readonly nodeType = 'MediaTypeIndex';

  read(key: string) {
    return this.getChild(key, MediaTypeNode);
  }
}

export class StringMappingNode extends DocumentNode {
  public readonly nodeType = 'StringMapping';

  read(key: string) {
    return this.getLiteral<string>(key);
  }
}

export class PropertiesNode extends RefIndexNode<SchemaNodeUnion> {
  public readonly nodeType = 'Properties';

  read(key: string) {
    return toSchemaOrRef(this.getProperty(key)?.value, this.root);
  }
}

export class RefNode extends DocumentNode {
  public readonly nodeType = 'Ref';

  protected get allowedKeys(): ReadonlySet<string> {
    return new Set(['$ref']);
  }
  protected get allowExtensions(): boolean {
    return false;
  }

  get $ref() {
    return this.getRequiredLiteral<string>('$ref');
  }
}

export function isRefNode(node: DocumentNode): node is RefNode {
  return node.nodeType === 'Ref';
}

export function isString(item: SchemaNodeUnion): item is StringSchemaNode {
  return item.nodeType === 'StringSchema';
}

export function isNumber(item: SchemaNodeUnion): item is NumberSchemaNode {
  return item.nodeType === 'NumberSchema';
}

export function isArray(item: SchemaNodeUnion): item is ArraySchemaNode {
  return item.nodeType === 'ArraySchema';
}

export function isObject(item: SchemaNodeUnion): item is ObjectSchemaNode {
  return item.nodeType === 'ObjectSchema';
}

export function isLiteral<T extends string | number | boolean | null>(
  item: AbstractDocumentNode | undefined,
): item is LiteralNode<T> {
  return item?.nodeType === 'Literal';
}

function isRef(node: AST.ASTNode | undefined): boolean {
  return !!(
    node?.isObject() && node.children.some((n) => n.key.value === '$ref')
  );
}
