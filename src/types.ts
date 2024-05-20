import { encodeRange } from 'basketry';
import {
  AST,
  DocumentNode as AbstractDocumentNode,
  LiteralNode,
} from '@basketry/ast';

export { LiteralNode };

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

export function resolveRef(root: AST.ASTNode, ref: string): AST.ASTNode {
  if (!ref.startsWith('#')) throw new Error(`Cannot resolve ref '${ref}'`);

  let result: AST.ASTNode = root;

  for (const segment of ref.split('/')) {
    if (segment === '#') {
      result = root;
    } else {
      if (result.isObject()) {
        const child = result.children.find((n) => n.key.value === segment);
        if (!child) throw new Error(`Cannot resolve ref '${ref}'`);
        result = child.value;
      } else {
        throw new Error(`Cannot resolve ref '${ref}'`);
      }
    }
  }

  return result;
}

export function resolve<T extends DocumentNode>(
  root: AST.ASTNode,
  itemOrRef: T | RefNode,
  Node: new (n: AST.ASTNode) => T,
): T {
  return isRefNode(itemOrRef)
    ? new Node(resolveRef(root, itemOrRef.$ref.value))
    : itemOrRef;
}

export function resolveParam(
  root: AST.ASTNode,
  paramOrRef: RefNode | ParameterNode,
): ParameterNode | undefined {
  if (!isRefNode(paramOrRef)) return paramOrRef;

  const node = resolveRef(root, paramOrRef.$ref.value);
  if (!node.isObject()) return;

  return new ParameterNode(node);
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

  const node = resolveRef(root, schemaOrRef.$ref.value);
  if (!node.isObject()) return;

  const typeNode = node.children.find((n) => n.key.value === 'type')?.value;
  if (!typeNode) {
    // Probably an allOf, anyOf, or oneOf
    return new ObjectSchemaNode(node);
  }

  if (!typeNode?.isLiteral()) return;

  switch (typeNode.value) {
    case 'string':
      return new StringSchemaNode(node);
    case 'integer':
    case 'number':
      return new NumberSchemaNode(node);
    case 'boolean':
      return new BooleanSchemaNode(node);
    case 'array':
      return new ArraySchemaNode(node);
    case 'object':
      return new ObjectSchemaNode(node);
    default:
      return;
  }
}

export function resolveParamOrSchema(
  root: AST.ASTNode,
  itemOrRef: RefNode | ParameterNode | SchemaNodeUnion,
): ParameterNode | SchemaNodeUnion | undefined {
  if (!isRefNode(itemOrRef)) return itemOrRef;

  const node = resolveRef(root, itemOrRef.$ref.value);
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
): SchemaNodeUnion | RefNode | undefined {
  if (!value) return;

  if (isRef(value)) return new RefNode(value);

  if (value.isObject()) {
    const typeNode = value.children.find((n) => n.key.value === 'type')?.value;
    if (!typeNode) {
      // Probably an allOf, anyOf, or oneOf
      return new ObjectSchemaNode(value);
    }
    if (typeNode?.isLiteral()) {
      switch (typeNode.value) {
        case 'string':
          return new StringSchemaNode(value);
        case 'number':
        case 'integer':
          return new NumberSchemaNode(value);
        case 'boolean':
          return new BooleanSchemaNode(value);
        case 'array':
          return new ArraySchemaNode(value);
        case 'object':
          return new ObjectSchemaNode(value);
      }
    }
  }

  throw new Error('Unknown schema definition');
}

function toSecuritySchemeOrRef(
  value: AST.ValueNode | undefined,
): SecuritySchemeNode | RefNode | undefined {
  if (!value) return;

  if (isRef(value)) return new RefNode(value);

  if (value.isObject()) {
    const typeNode = value.children.find((n) => n.key.value === 'type')?.value;
    if (typeNode?.isLiteral()) {
      switch (typeNode.value) {
        case 'apiKey':
          return new ApiKeySecuritySchemeNode(value);
        case 'http':
          return new HttpSecuritySchemeNode(value);
        case 'oauth2':
          return new OAuth2SecuritySchemeNode(value);
        case 'openIdConnect':
          return new OpenIdConnectSecuritySchemeNode(value);
      }
    }
  }

  throw new Error('Unknown security scheme type');
}

export abstract class DocumentNode extends AbstractDocumentNode {
  protected getChildOrRef<T extends AbstractDocumentNode>(
    key: string,
    Node: new (n: AST.ASTNode) => T,
  ): T | RefNode | undefined {
    const value = this.getProperty(key)?.value;
    if (!value) return undefined;
    if (isRef(value)) return new RefNode(value);
    return new Node(value);
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

  get openapi() {
    return this.getLiteral<string>('openapi')!;
  }

  get info() {
    return this.getChild('info', InfoNode)!;
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

  get title() {
    return this.getLiteral<string>('title')!;
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
    return this.getLiteral<string>('version')!;
  }
}

// Done
export class ContactNode extends DocumentNode {
  public readonly nodeType = 'Contact';

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

  get name() {
    return this.getLiteral<string>('name')!;
  }

  get url() {
    return this.getLiteral<string>('url');
  }
}

// Done
export class ServerNode extends DocumentNode {
  public readonly nodeType = 'Server';

  get url() {
    return this.getLiteral<string>('url')!;
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

  read(key: string) {
    return this.getChild(key, ServerVariableNode);
  }
}

// Done
export class ServerVariableNode extends DocumentNode {
  public readonly nodeType = 'ServerVariable';

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

  read(key: string) {
    return this.getChildOrRef(key, PathItemNode);
  }
}

// Done
export class PathItemNode extends DocumentNode {
  public readonly nodeType = 'PathItem';

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
      isRef(value) ? new RefNode(value) : new ParameterNode(value),
    );
  }
}

// Done
export class OperationNode extends DocumentNode {
  public readonly nodeType = 'Operation';
  constructor(node: AST.ASTNode) {
    super(node);
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
    return this.getLiteral<string>('operationId');
  }

  get parameters() {
    const array = this.getProperty('parameters')?.value;
    if (!array) return;

    if (!array.isArray()) throw new Error('Value is not an array');

    return array.children.map((value) =>
      isRef(value) ? new RefNode(value) : new ParameterNode(value),
    );
  }

  get requestBody() {
    return this.getChildOrRef('requestBody', RequestBodyNode);
  }

  get responses() {
    return this.getChild('responses', ResponsesNode)!;
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

  get description() {
    return this.getLiteral<string>('description');
  }

  get url() {
    return this.getLiteral<string>('url')!;
  }
}

// Done
export class ParameterNode extends DocumentNode {
  public readonly nodeType = 'Parameter';

  get name() {
    return this.getLiteral<string>('name')!;
  }

  get in() {
    return this.getLiteral<'query' | 'header' | 'path' | 'cookie'>('in')!;
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
    return toSchemaOrRef(this.getProperty('schema')?.value);
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
  constructor(node: AST.ASTNode) {
    super(node);
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get content() {
    return this.getChild('content', MediaTypeIndexNode)!;
  }

  get required() {
    return this.getLiteral<boolean>('required');
  }
}

// Done
export class MediaTypeNode extends DocumentNode {
  public readonly nodeType = 'MediaType';

  get schema() {
    return toSchemaOrRef(this.getProperty('schema')?.value);
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
  constructor(node: AST.ASTNode) {
    super(node);
  }

  get description() {
    return this.getLiteral<string>('description')!;
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
    return toSchemaOrRef(this.getProperty('schema')?.value);
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

  get name() {
    return this.getLiteral<string>('name')!;
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

  get type() {
    return this.getLiteral<'string'>('type')!;
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

  get type() {
    return this.getLiteral<'integer' | 'number'>('type')!;
  }

  get default() {
    return this.getLiteral<number>('default');
  }

  get const() {
    return this.getLiteral<number>('const');
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

  get type() {
    return this.getLiteral<'boolean'>('type')!;
  }

  get default() {
    return this.getLiteral<boolean>('default');
  }

  get const() {
    return this.getLiteral<boolean>('const');
  }
}

// Done
export class ArraySchemaNode extends SchemaNode {
  public readonly nodeType = 'ArraySchema';

  get type() {
    return this.getLiteral<'array'>('type')!;
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get items() {
    return toSchemaOrRef(this.getProperty('items')?.value);
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

    return prop.children.map(toSchemaOrRef).filter(isObjectSchemaOrRef);
  }

  get oneOf() {
    const prop = this.getProperty('oneOf')?.value;
    if (!prop?.isArray()) return;

    return prop.children.map(toSchemaOrRef).filter(isObjectSchemaOrRef);
  }

  get anyOf() {
    const prop = this.getProperty('oneOf')?.value;
    if (!prop?.isArray()) return;

    return prop.children.map(toSchemaOrRef).filter(isObjectSchemaOrRef);
  }

  get minProperties() {
    return this.getLiteral<number>('minProperties');
  }

  get maxProperties() {
    return this.getLiteral<number>('maxProperties');
  }

  get additionalProperties() {
    const value = this.getProperty('additionalProperties')?.value;
    if (value?.isLiteral()) {
      return this.getLiteral<boolean>('additionalProperties');
    } else if (value?.isObject()) {
      return toSchemaOrRef(value);
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

  get propertyName() {
    return this.getLiteral<string>('propertyName')!;
  }

  get mapping() {
    return this.getChild('mapping', StringMappingNode);
  }
}

// Done
export class HttpSecuritySchemeNode extends DocumentNode {
  public readonly nodeType = 'HttpSecurityScheme';
  constructor(node: AST.ASTNode) {
    super(node);
  }

  get type() {
    return this.getLiteral<'http'>('type')!;
  }

  get description() {
    return this.getLiteral<string>('description')!;
  }
}

// Done
export class ApiKeySecuritySchemeNode extends DocumentNode {
  public readonly nodeType = 'ApiKeySecurityScheme';
  constructor(node: AST.ASTNode) {
    super(node);
  }

  get type() {
    return this.getLiteral<'apiKey'>('type')!;
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get name() {
    return this.getLiteral<string>('name')!;
  }

  get in() {
    return this.getLiteral<'header' | 'query' | 'cookie'>('in')!;
  }
}

// Done
export class OAuth2SecuritySchemeNode extends DocumentNode {
  public readonly nodeType = 'OAuth2SecurityScheme';
  constructor(node: AST.ASTNode) {
    super(node);
  }

  get type() {
    return this.getLiteral<'oauth2'>('type')!;
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get flows() {
    return this.getChild('flows', OAuthFlowsNode)!;
  }
}

// Done
export class OpenIdConnectSecuritySchemeNode extends DocumentNode {
  public readonly nodeType = 'OpenIdConnectSecurityScheme';
  constructor(node: AST.ASTNode) {
    super(node);
  }

  get type() {
    return this.getLiteral<'openIdConnect'>('type')!;
  }

  get description() {
    return this.getLiteral<string>('description');
  }

  get openIdConnectUrl() {
    return this.getLiteral<string>('openIdConnectUrl')!;
  }
}

// Done
export class OAuthFlowsNode extends DocumentNode {
  public readonly nodeType = 'OAuthFlowsNode';

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
    return this.getChild('scopes', StringMappingNode)!;
  }
}

// Done
export class ImplicitFlowNode extends OAuthFlowNode {
  public readonly nodeType = 'ImplicitFlow';

  get authorizationUrl() {
    return this.getLiteral<string>('authorizationUrl')!;
  }
}

// Done
export class PasswordFlowNode extends OAuthFlowNode {
  public readonly nodeType = 'PasswordFlow';

  get tokenUrl() {
    return this.getLiteral<string>('tokenUrl')!;
  }
}

// Done
export class ClientCredentialsFlowNode extends OAuthFlowNode {
  public readonly nodeType = 'ClientCredentialsFlow';

  get tokenUrl() {
    return this.getLiteral<string>('tokenUrl')!;
  }
}

// Done
export class AuthorizationCodeFlowNode extends OAuthFlowNode {
  public readonly nodeType = 'AuthorizationCodeFlow';

  get authorizationUrl() {
    return this.getLiteral<string>('authorizationUrl')!;
  }

  get tokenUrl() {
    return this.getLiteral<string>('tokenUrl')!;
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
    return toSchemaOrRef(this.getProperty(key)?.value);
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
    return toSecuritySchemeOrRef(this.getProperty(key)?.value);
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
    return toSchemaOrRef(this.getProperty(key)?.value);
  }
}

export class RefNode extends DocumentNode {
  public readonly nodeType = 'Ref';
  constructor(node: AST.ASTNode) {
    super(node);
  }

  get $ref() {
    return this.getLiteral<string>('$ref')!;
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
