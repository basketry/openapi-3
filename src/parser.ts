import { major } from 'semver';
import { singular } from 'pluralize';
import { camel, kebab, pascal } from 'case';

import { AST, DocumentNode, parse } from '@basketry/ast';
import * as OAS3 from './types';

import {
  ComplexValue,
  decodeRange,
  DiscriminatedUnion,
  encodeRange,
  Enum,
  EnumMember,
  HttpMethod,
  HttpRoute,
  Interface,
  MemberValue,
  Method,
  ObjectValidationRule,
  Parameter,
  Property,
  ReturnValue,
  SecurityScheme,
  Service,
  Type,
  Union,
  ValidationRule,
  Violation,
  IntegerLiteral,
  StringLiteral,
  HttpArrayFormatLiteral,
  HttpArrayFormat,
  TrueLiteral,
  OAuth2Flow,
  OAuth2Scope,
  PrimitiveLiteral,
  MetaValue,
  SecurityOption,
  NumberLiteral,
  BooleanLiteral,
  HttpStatusCodeLiteral,
} from 'basketry';
import { relative } from 'path';

type Meta = MetaValue[];

function range(node: AST.ASTNode | DocumentNode): string {
  return encodeRange(0, node.loc);
}

export class OAS3Parser {
  constructor(schema: string) {
    this.schema = new OAS3.OpenAPINode(parse(0, schema));
  }

  // # represents the root source document path
  private readonly sourcePath = '#';

  public readonly violations: Violation[] = [];

  private readonly schema: OAS3.OpenAPINode;

  private readonly ruleFactories: ValidationRuleFactory[] = factories;
  private enums: Enum[];
  private anonymousTypes: Type[];
  private unions: Union[] = [];

  parse(): Service {
    this.enums = [];
    this.anonymousTypes = [];
    const interfaces = this.parseInterfaces();
    const types = this.parseDefinitions();

    const typesByName = [...types, ...this.anonymousTypes].reduce(
      (acc, item) => ({ ...acc, [item.name.value]: item }),
      {},
    );

    const enumsByName = this.enums.reduce(
      (acc, item) => ({ ...acc, [item.name.value]: item }),
      {},
    );

    const unionsByName = this.unions.reduce(
      (acc, item) => ({ ...acc, [item.name.value]: item }),
      {},
    );

    return {
      kind: 'Service',
      basketry: '0.2',
      sourcePaths: [this.sourcePath],
      title: {
        kind: 'StringLiteral',
        value: pascal(this.schema.info.title.value),
        loc: range(this.schema.info.title),
      },
      majorVersion: {
        kind: 'IntegerLiteral',
        value: major(this.schema.info.version.value),
        loc: range(this.schema.info.version),
      },
      interfaces,
      types: Object.keys(typesByName).map((name) => typesByName[name]),
      enums: Object.keys(enumsByName).map((name) => enumsByName[name]),
      unions: Object.keys(unionsByName).map((name) => unionsByName[name]),
      loc: range(this.schema),
      meta: this.parseMeta(this.schema),
    };
  }

  private parseMeta(node: DocumentNode): Meta | undefined {
    const n = node.node;
    if (!n.isObject()) return undefined;

    const meta: Meta = n.children
      .filter((child) => child.key.value.startsWith('x-'))
      .map((child) => ({
        kind: 'MetaValue',
        key: {
          kind: 'StringLiteral',
          value: child.key.value.substring(2),
          loc: encodeRange(0, child.key.loc),
        },
        value: {
          kind: 'UntypedLiteral',
          value: OAS3.toJson(child.value),
          loc: encodeRange(0, child.value.loc),
        },
      }));

    return meta.length ? meta : undefined;
  }

  private parseInterfaces(): Interface[] {
    return this.parserInterfaceNames().map((name) => ({
      kind: 'Interface',
      name: { kind: 'StringLiteral', value: singular(name) },
      methods: this.parseMethods(name),
      protocols: {
        kind: 'InterfaceProtocols',
        http: this.parseHttpProtocol(name),
      },
    }));
  }

  private parseResponseCode(
    verb: string,
    operation: OAS3.OperationNode,
  ): HttpStatusCodeLiteral {
    const primary = this.parsePrimaryResponseKey(operation);

    if (primary?.kind === 'IntegerLiteral') {
      return {
        kind: 'HttpStatusCodeLiteral',
        value: primary.value,
        loc: primary.loc,
      };
    } else if (primary?.value === 'default') {
      const res = operation.responses.read(primary.value);
      if (res && this.resolve(res, OAS3.ResponseNode)?.content?.keys?.length) {
        switch (verb) {
          case 'delete':
            return {
              kind: 'HttpStatusCodeLiteral',
              value: 202,
              loc: primary.loc,
            };
          case 'options':
            return {
              kind: 'HttpStatusCodeLiteral',
              value: 204,
              loc: primary.loc,
            };
          case 'post':
            return {
              kind: 'HttpStatusCodeLiteral',
              value: 201,
              loc: primary.loc,
            };
          default:
            return {
              kind: 'HttpStatusCodeLiteral',
              value: 200,
              loc: primary.loc,
            };
        }
      } else {
        return { kind: 'HttpStatusCodeLiteral', value: 204, loc: primary.loc };
      }
    }

    return { kind: 'HttpStatusCodeLiteral', value: 200 };
  }

  private parseHttpProtocol(interfaceName: string): HttpRoute[] {
    if (!this.schema.paths) return [];

    const paths = this.schema.paths.keys;

    const httpPaths: HttpRoute[] = [];

    for (const path of paths) {
      const pathItem = this.resolve(
        this.schema.paths.read(path)!,
        OAS3.PathItemNode,
      );
      const keyLoc = this.schema.paths.keyRange(path);
      const loc = this.schema.paths.propRange(path)!;
      const commonParameters = pathItem.parameters || [];

      const httpPath: HttpRoute = {
        kind: 'HttpRoute',
        pattern: { kind: 'StringLiteral', value: path, loc: keyLoc },
        methods: [],
        loc,
      };

      for (const verb of pathItem.keys) {
        if (verb === 'parameters') continue;
        const operation = pathItem[verb]! as OAS3.OperationNode;
        if (this.parseInterfaceName(path, operation) !== interfaceName) {
          continue;
        }

        const verbLoc = pathItem.keyRange(verb);
        const methodLoc = pathItem.propRange(verb)!;

        const methodName = operation.operationId?.value || 'unknown';

        const httpMethod: HttpMethod = {
          kind: 'HttpMethod',
          name: {
            kind: 'StringLiteral',
            value: methodName,
            loc: operation.operationId
              ? range(operation.operationId)
              : undefined,
          },
          verb: { kind: 'HttpVerbLiteral', value: verb as any, loc: verbLoc }, // TODO: fix any
          parameters: [],
          successCode: this.parseResponseCode(verb, operation),
          requestMediaTypes: this.parseHttpRequestMediaType(operation),
          responseMediaTypes: this.parseHttpResponseMediaType(operation),
          loc: methodLoc,
        };

        const bodyParamName = this.parseBodyParamName(operation);
        const body = this.parseRequestBody(
          operation.requestBody,
          methodName,
          bodyParamName,
        );

        if (body) {
          httpMethod.parameters.push({
            kind: 'HttpParameter',
            name: body.name,
            location: { kind: 'HttpLocationLiteral', value: 'body' },
            loc: body.loc,
          });
        }

        for (const param of [
          ...(operation.parameters || []),
          ...commonParameters,
        ]) {
          const name = this.parseParameterName(param);

          const resolved = OAS3.resolveParam(this.schema.node, param);
          if (!resolved) throw new Error('Cannot resolve reference');

          const location = this.parseParameterLocation(param);

          const locationValue = location.value;

          if (locationValue === 'cookie') {
            // TODO: Support cookie location
            this.violations.push({
              code: 'openapi-3/unsupported-feature',
              message:
                'Cookie is not yet supported. This parameter will be ignored.',
              range: location.loc,
              severity: 'warning',
              sourcePath: this.sourcePath,
            });
            continue;
          }

          if (
            (resolved.in.value === 'header' ||
              resolved.in.value === 'path' ||
              resolved.in.value === 'query') &&
            resolved.schema?.nodeType === 'ArraySchema'
          ) {
            httpMethod.parameters.push({
              kind: 'HttpParameter',
              name: {
                kind: 'StringLiteral',
                value: name.value,
                loc: range(name),
              },
              location: {
                kind: 'HttpLocationLiteral',
                value: locationValue,
                loc: range(location),
              },
              arrayFormat: this.parseArrayFormat(resolved),
              loc: range(resolved),
            });
          } else {
            httpMethod.parameters.push({
              kind: 'HttpParameter',
              name: {
                kind: 'StringLiteral',
                value: name.value,
                loc: range(name),
              },
              location: {
                kind: 'HttpLocationLiteral',
                value: locationValue,
                loc: range(location),
              },
              loc: range(resolved),
            });
          }
        }

        httpPath.methods.push(httpMethod);
      }

      if (httpPath.methods.length) httpPaths.push(httpPath);
    }
    return httpPaths;
  }

  private parseHttpRequestMediaType(
    operation: OAS3.OperationNode,
  ): StringLiteral[] {
    if (!operation.requestBody) return [];
    const body = this.resolve(operation.requestBody, OAS3.RequestBodyNode);
    return body.content ? this.parseMediaType(body.content) : [];
  }

  private parseHttpResponseMediaType(
    operation: OAS3.OperationNode,
  ): StringLiteral[] {
    const { response } = this.parsePrimiaryResponse(operation) ?? {};
    if (!response) return [];

    const res = this.resolve(response, OAS3.ResponseNode);
    return res.content ? this.parseMediaType(res.content) : [];
  }

  private parseMediaType(
    mediaTypeIndexNode: OAS3.MediaTypeIndexNode,
  ): StringLiteral[] {
    return mediaTypeIndexNode.keys.map((key) => ({
      kind: 'StringLiteral',
      value: key,
      loc: mediaTypeIndexNode.keyRange(key),
    }));
  }

  private parseArrayFormat(
    paramNode: OAS3.ParameterNode,
  ): HttpArrayFormatLiteral {
    if (!paramNode.style)
      return { kind: 'HttpArrayFormatLiteral', value: 'csv' };

    let value: HttpArrayFormat = 'csv';

    switch (paramNode.style.value) {
      case 'matrix':
      case 'label':
        // TODO: support RFC6570
        this.violations.push({
          code: 'openapi-3/unsupported-feature',
          message: `Parameter style '${paramNode.style.value}' is not yet supported. The default 'csv' array style will be used instead.`,
          range: paramNode.style.loc,
          severity: 'warning',
          sourcePath: this.sourcePath,
        });
        break;
      case 'form':
        value = paramNode.explode?.value ? 'multi' : 'csv';
        break;
      case 'simple':
        value = 'csv';
        break;
      case 'spaceDelimited':
        value = 'ssv';
        break;
      case 'pipeDelimited':
        value = 'pipes';
        break;
    }

    return {
      kind: 'HttpArrayFormatLiteral',
      value,
      loc: encodeRange(0, paramNode.style.loc),
    };
  }

  private *allOperations(): Iterable<{
    path: string;
    verb: string;
    operation: OAS3.OperationNode;
  }> {
    const pathsNode = this.schema.paths;
    if (!pathsNode) return;
    for (const path of pathsNode.keys) {
      for (const verb of pathsNode.read(path)!.keys) {
        if (verb === 'parameters' || verb.startsWith('x-')) continue;

        const operation: OAS3.OperationNode = pathsNode.read(path)![verb];

        yield { path, verb, operation };
      }
    }
  }

  private parserInterfaceNames(): string[] {
    const interfaceNames = new Set<string>();
    for (const { path, operation } of this.allOperations()) {
      interfaceNames.add(this.parseInterfaceName(path, operation));
    }
    return Array.from(interfaceNames);
  }

  private parseInterfaceName(
    path: string,
    operation: OAS3.OperationNode,
  ): string {
    return operation.tags?.[0].value || path.split('/')[1];
  }

  private parseDeprecated(node: {
    deprecated: OAS3.LiteralNode<boolean> | undefined;
  }): TrueLiteral | undefined {
    if (node.deprecated) {
      return { kind: 'TrueLiteral', value: true, loc: range(node.deprecated) };
    }
    return;
  }

  private parseMethods(interfaceName: string): Method[] {
    const pathsNode = this.schema.paths;
    if (!pathsNode) return [];
    const paths = pathsNode.keys;

    const methods: Method[] = [];

    for (const { path, verb, operation } of this.allOperations()) {
      const pathNode = this.resolve(pathsNode.read(path)!, OAS3.PathItemNode);
      const commonParameters = pathNode.parameters || [];

      if (this.parseInterfaceName(path, operation) !== interfaceName) {
        continue;
      }

      operation.deprecated;

      const nameLoc = operation.operationId
        ? range(operation.operationId)
        : undefined;
      methods.push({
        kind: 'Method',
        name: {
          kind: 'StringLiteral',
          value: operation.operationId?.value || 'UNNAMED',
          loc: nameLoc,
        },
        security: this.parseSecurity(operation),
        parameters: this.parseParameters(operation, commonParameters),
        description: this.parseDescription(
          operation.summary,
          operation.description,
        ),
        deprecated: this.parseDeprecated(operation),
        returns: this.parseReturnValue(operation),
        loc: pathsNode.read(path)!.propRange(verb)!,
        meta: this.parseMeta(operation),
      });
    }
    return methods;
  }

  private parseDescription(
    summary: OAS3.LiteralNode<string> | undefined,
    description: OAS3.LiteralNode<string> | undefined,
  ): StringLiteral[] | undefined {
    if (summary && description)
      return [
        { kind: 'StringLiteral', value: summary.value, loc: range(summary) },
        {
          kind: 'StringLiteral',
          value: description.value,
          loc: range(description),
        },
      ];
    if (summary)
      return [
        {
          kind: 'StringLiteral',
          value: summary.value,
          loc: range(summary),
        },
      ];
    if (description)
      return [
        {
          kind: 'StringLiteral',
          value: description.value,
          loc: range(description),
        },
      ];
    return;
  }

  private parseDescriptionOnly(
    description: OAS3.LiteralNode<string> | undefined,
  ): StringLiteral[] | undefined {
    if (description)
      return [
        {
          kind: 'StringLiteral',
          value: description.value,
          loc: range(description),
        },
      ];
    return;
  }

  private parseSecurity(operation: OAS3.OperationNode): SecurityOption[] {
    const { security: defaultSecurity } = this.schema;
    const securitySchemes = this.schema.components?.securitySchemes;
    const { security: operationSecurity } = operation;
    const security = operationSecurity || defaultSecurity || [];

    const options: SecurityOption[] = security.map((requirements) => {
      const schemes = requirements.keys
        .map((key): SecurityScheme | undefined => {
          const requirement = requirements.read(key);
          const definition = securitySchemes?.read(key);

          if (!requirement || !definition) return;

          const keyLoc = securitySchemes?.keyRange(key);
          const loc = securitySchemes?.propRange(key)!;

          const name: StringLiteral = {
            kind: 'StringLiteral',
            value: key,
            loc: keyLoc,
          };

          switch (definition.nodeType) {
            case 'HttpSecurityScheme':
              return this.parseHttpSecurity(definition, name, loc);
            case 'ApiKeySecurityScheme':
              return this.parseApiKeySecurity(definition, name, loc);
            case 'OAuth2SecurityScheme': {
              return this.parseOAuth2Security(definition, name, loc);
            }
            default:
              return;
          }
        })
        .filter((scheme): scheme is SecurityScheme => !!scheme);

      return {
        kind: 'SecurityOption',
        schemes,
        loc: range(requirements),
      };
    });

    return options;
  }

  private parseHttpSecurity(
    definition: OAS3.HttpSecuritySchemeNode,
    name: StringLiteral,
    loc: string,
  ): SecurityScheme {
    return {
      kind: 'BasicScheme',
      type: { value: 'basic', loc: range(definition.type) },
      name,
      // TODO: deprecated: this.parseDeprecated(definition),
      loc,
      meta: this.parseMeta(definition),
    };
  }

  private parseApiKeySecurity(
    definition: OAS3.ApiKeySecuritySchemeNode,
    name: StringLiteral,
    loc: string,
  ): SecurityScheme {
    return {
      kind: 'ApiKeyScheme',
      type: { value: 'apiKey', loc: range(definition.type) },
      name,
      description: this.parseDescriptionOnly(definition.description),
      parameter: toStringLiteral(definition.name),
      in: {
        value: definition.in.value,
        loc: range(definition.in),
      },
      // TODO: deprecated: this.parseDeprecated(definition),
      loc,
      meta: this.parseMeta(definition),
    };
  }

  private parseOAuth2Security(
    definition: OAS3.OAuth2SecuritySchemeNode,
    name: StringLiteral,
    loc: string,
  ): SecurityScheme {
    return {
      kind: 'OAuth2Scheme',
      type: { value: 'oauth2', loc: range(definition.type) },
      name,
      description: this.parseDescriptionOnly(definition.description),
      flows: Array.from(this.parseOauth2Flows(definition.flows, name, loc)),
      // TODO: deprecated: this.parseDeprecated(definition),
      loc,
      meta: this.parseMeta(definition),
    };
  }

  private *parseOauth2Flows(
    flows: OAS3.OAuthFlowsNode,
    name: StringLiteral,
    loc: string,
  ): Iterable<OAuth2Flow> {
    if (flows.authorizationCode) {
      const flow = flows.authorizationCode;
      yield {
        kind: 'OAuth2AuthorizationCodeFlow',
        type: {
          value: 'authorizationCode',
          loc: flows.keyRange('authorizationCode'),
        },
        authorizationUrl: toStringLiteral(flow.authorizationUrl),
        refreshUrl: toStringLiteral(flow.refreshUrl),
        tokenUrl: toStringLiteral(flow.tokenUrl),
        scopes: this.parseScopes(flow.scopes),
        // TODO: deprecated: this.parseDeprecated(definition),
        loc,
      };
    }
    if (flows.clientCredentials) {
      const flow = flows.clientCredentials;
      yield {
        kind: 'OAuth2ClientCredentialsFlow',
        type: {
          value: 'clientCredentials',
          loc: flows.keyRange('clientCredentials'),
        },
        refreshUrl: toStringLiteral(flow.refreshUrl),
        tokenUrl: toStringLiteral(flow.tokenUrl),
        scopes: this.parseScopes(flow.scopes),
        // TODO: deprecated: this.parseDeprecated(definition),
        loc,
      };
    }
    if (flows.implicit) {
      const flow = flows.implicit;
      yield {
        kind: 'OAuth2ImplicitFlow',
        type: {
          value: 'implicit',
          loc: flows.keyRange('implicit'),
        },
        authorizationUrl: toStringLiteral(flow.authorizationUrl),
        refreshUrl: toStringLiteral(flow.refreshUrl),
        scopes: this.parseScopes(flow.scopes),
        // TODO: deprecated: this.parseDeprecated(definition),
        loc,
      };
    }
    if (flows.password) {
      const flow = flows.password;
      yield {
        kind: 'OAuth2PasswordFlow',
        type: {
          value: 'password',
          loc: flows.keyRange('password'),
        },
        refreshUrl: toStringLiteral(flow.refreshUrl),
        tokenUrl: toStringLiteral(flow.tokenUrl),
        scopes: this.parseScopes(flow.scopes),
        // TODO: deprecated: this.parseDeprecated(definition),
        loc,
      };
    }
  }

  private parseScopes(scopes: OAS3.StringMappingNode): OAuth2Scope[] {
    return scopes.keys.map((k) => ({
      kind: 'OAuth2Scope',
      name: {
        kind: 'StringLiteral',
        value: k,
        loc: scopes.keyRange(k),
      },
      description: this.parseDescriptionOnly(scopes.read(k))!,
      loc: scopes.propRange(k)!,
    }));
  }

  private parseParameters(
    operation: OAS3.OperationNode,
    commonParameters: (OAS3.ParameterNode | OAS3.RefNode)[],
  ): Parameter[] {
    const parametersOrRefs = [
      ...commonParameters,
      ...(operation.parameters || []),
    ];

    const parameters = parametersOrRefs
      .map((p) => OAS3.resolveParam(this.schema.node, p))
      .filter((p): p is OAS3.ParameterNode => !!p);

    const nonBodyParams = parameters.map((p) =>
      this.parseParameter(p, operation.operationId?.value || ''),
    );

    const bodyParam = this.parseRequestBody(
      operation.requestBody,
      operation.operationId?.value || '',
      this.parseBodyParamName(operation),
    );

    return bodyParam ? [bodyParam, ...nonBodyParams] : nonBodyParams;
  }

  private parseBodyParamName(operation: OAS3.OperationNode): StringLiteral {
    const meta = this.parseMeta(operation);

    const metaValue = meta?.find(
      (m) => kebab(m.key.value) === 'codegen-request-body-name',
    )?.value;

    const value = typeof metaValue?.value;
    const loc = metaValue?.loc;

    if (typeof value === 'string') {
      return { kind: 'StringLiteral', value, loc };
    } else {
      return { kind: 'StringLiteral', value: 'body' };
    }
  }

  private parseParameter(
    param: OAS3.ParameterNode,
    methodName: string,
  ): Parameter {
    // const unresolved = isBodyParameter(param) ? param.schema : param;
    // const resolved = OAS3.resolveParamOrSchema(this.schema.node, unresolved);

    if (!param.schema) throw new Error('Unexpected undefined schema');

    const unresolved = param.schema;
    const resolved = OAS3.resolveSchema(this.schema.node, param.schema);

    if (!resolved) throw new Error('Cannot resolve reference');
    // if (resolved.nodeType === 'BodyParameter') {
    //   throw new Error('Unexpected body parameter');
    // }

    const x = this.parseType(unresolved, param.name.value, methodName);

    if (x.kind === 'PrimitiveValue') {
      return {
        kind: 'Parameter',
        name: {
          kind: 'StringLiteral',
          value: param.name.value,
          loc: range(param.name),
        },
        description: this.parseDescription(undefined, param.description),
        value: {
          kind: 'PrimitiveValue',
          typeName: x.typeName,
          isArray: x.isArray,
          default: x.default,
          constant: undefined, // TODO
          rules: this.parseRules(resolved, param.required?.value),
        },
        deprecated: this.parseDeprecated(param),
        loc: range(param),
        meta: this.parseMeta(param),
      };
    } else {
      return {
        kind: 'Parameter',
        name: {
          kind: 'StringLiteral',
          value: param.name.value,
          loc: range(param.name),
        },
        description: this.parseDescription(undefined, param.description),
        value: {
          kind: 'ComplexValue',
          typeName: x.typeName,
          isArray: x.isArray,
          rules: this.parseRules(resolved, param.required?.value),
        },
        deprecated: this.parseDeprecated(param),
        loc: range(param),
        meta: this.parseMeta(param),
      };
    }
  }

  private parseRequestBody(
    bodyOrRef: OAS3.RefNode | OAS3.RequestBodyNode | undefined,
    methodName: string,
    paramName: StringLiteral,
  ): Parameter | undefined {
    if (!bodyOrRef) return;

    const body = this.resolve(bodyOrRef, OAS3.RequestBodyNode);

    const schemaOrRef = this.getSchemaOrRef(body.content);
    if (!schemaOrRef) return;

    const schema = OAS3.resolveSchema(this.schema.node, schemaOrRef);
    if (!schema) return;

    const value = this.parseType(schemaOrRef, paramName.value, methodName);

    return {
      kind: 'Parameter',
      name: paramName,
      description: this.parseDescription(undefined, body.description),
      value,
      loc: range(body),
      meta: this.parseMeta(body),
    };
  }

  private parseParameterLocation(
    def: OAS3.ParameterNode | OAS3.RefNode,
  ): OAS3.ParameterNode['in'] {
    const resolved = OAS3.resolveParam(this.schema.node, def);
    if (!resolved) throw new Error('Cannot resolve reference');

    return resolved.in;
  }

  private parseParameterName(
    def: OAS3.ParameterNode | OAS3.RefNode,
  ): OAS3.ParameterNode['name'] {
    const resolved = OAS3.resolveParam(this.schema.node, def);
    if (!resolved) throw new Error('Cannot resolve reference');

    return resolved.name;
  }

  private parseType(
    schemaOrRef: // | Exclude<OAS3.ParameterNodeUnion, OAS3.BodyParameterNode>
    OAS3.SchemaNodeUnion | OAS3.RefNode,
    localName: string,
    parentName: string,
  ): {
    enumValues?: StringLiteral[];
    rules: ValidationRule[];
    loc: string;
  } & MemberValue {
    if (OAS3.isRefNode(schemaOrRef)) {
      const schema = OAS3.resolveSchema(this.schema.node, schemaOrRef);
      if (!schema) {
        throw new Error(
          `Cannot resolve reference: '${schemaOrRef.$ref.value}'`,
        );
      }
      // if (res.nodeType === 'BodyParameter') {
      //   throw new Error('Unexpected body parameter');
      // }

      // TODO: do a better job of detecting a definitions ref
      const prefix = '#/components/schemas/';
      if (schemaOrRef.$ref.value.startsWith(prefix)) {
        if (OAS3.isObject(schema)) {
          return {
            kind: 'ComplexValue',
            typeName: {
              kind: 'StringLiteral',
              value: schemaOrRef.$ref.value.substring(prefix.length),
              loc: OAS3.refRange(this.schema.node, schemaOrRef.$ref.value),
            },
            rules: this.parseRules(schema),
            loc: range(schema),
          };
        } else if (OAS3.isString(schema) && schema.enum) {
          const name: StringLiteral = {
            kind: 'StringLiteral',
            value: schemaOrRef.$ref.value.substring(prefix.length),
            loc: OAS3.refRange(this.schema.node, schemaOrRef.$ref.value),
          };

          this.enums.push({
            kind: 'Enum',
            name: name,
            members: schema.enum.map<EnumMember>((n) => ({
              kind: 'EnumMember',
              content: {
                kind: 'StringLiteral',
                value: n.value,
                loc: encodeRange(0, n.loc),
              },
              loc: range(n),
            })),
            deprecated: this.parseDeprecated(schema),
            loc: schema.propRange('enum')!,
          });
          return {
            kind: 'ComplexValue',
            typeName: name,
            rules: this.parseRules(schema),
            loc: range(schema),
          };
        } else {
          return this.parseType(schema, localName, parentName);
        }
      } else {
        return {
          kind: 'ComplexValue',
          typeName: {
            kind: 'StringLiteral',
            value: schemaOrRef.$ref.value,
            loc: OAS3.refRange(this.schema.node, schemaOrRef.$ref.value),
          },
          rules: this.parseRules(schema),
          loc: range(schema),
        };
      }
    }
    const rules = this.parseRules(schemaOrRef);

    switch (schemaOrRef.nodeType) {
      // case 'StringParameter':
      case 'StringSchema':
        if (schemaOrRef.enum) {
          if (!schemaOrRef.const && schemaOrRef.enum.length === 1) {
            return {
              kind: 'PrimitiveValue',
              typeName: this.parseStringName(schemaOrRef),
              default: toStringLiteral(schemaOrRef.default),
              constant: toStringLiteral(schemaOrRef.enum[0]),
              rules,
              loc: range(schemaOrRef),
            };
          } else {
            const enumName = camel(`${parentName}_${singular(localName)}`);
            this.enums.push({
              kind: 'Enum',
              name: { kind: 'StringLiteral', value: enumName },
              members: schemaOrRef.enum.map<EnumMember>((n) => ({
                kind: 'EnumMember',
                content: {
                  kind: 'StringLiteral', // TODO: support other types
                  value: n.value,
                  loc: encodeRange(0, n.loc),
                },
                // TODO: deprecated
                loc: range(n),
              })),
              deprecated: this.parseDeprecated(schemaOrRef),
              loc: schemaOrRef.propRange('enum')!,
            });
            return {
              kind: 'ComplexValue',
              typeName: { kind: 'StringLiteral', value: enumName },
              rules,
              loc: range(schemaOrRef),
            };
          }
        } else {
          return {
            kind: 'PrimitiveValue',
            typeName: this.parseStringName(schemaOrRef),
            default: toStringLiteral(schemaOrRef.default),
            constant: toStringLiteral(schemaOrRef.const),
            rules,
            loc: range(schemaOrRef),
          };
        }
      // case 'NumberParameter':
      case 'NumberSchema':
        return {
          kind: 'PrimitiveValue',
          typeName: this.parseNumberName(schemaOrRef),
          default: toNumberLiteral(schemaOrRef.default),
          constant: toNumberLiteral(schemaOrRef.const),
          rules,
          loc: range(schemaOrRef),
        };
      // case 'BooleanParameter':
      case 'BooleanSchema':
        // case 'NullSchema':
        return {
          kind: 'PrimitiveValue',
          typeName: {
            kind: 'PrimitiveLiteral',
            value: schemaOrRef.type.value,
            loc: range(schemaOrRef.type),
          },
          default: toBooleanLiteral(schemaOrRef.default),
          constant: toBooleanLiteral(schemaOrRef.const),
          rules,
          loc: range(schemaOrRef),
        };
      // case 'ArrayParameter':
      case 'ArraySchema':
        if (!schemaOrRef.items) {
          throw new Error('Expected array items but found undefined');
        }
        const items = this.parseType(schemaOrRef.items, localName, parentName);

        return {
          ...items,
          isArray: {
            kind: 'TrueLiteral',
            value: true,
            loc: range(schemaOrRef.items),
          },
        };

      case 'ObjectSchema':
        const typeName: StringLiteral = {
          kind: 'StringLiteral',
          value: camel(`${parentName}_${localName}`),
        };
        if (schemaOrRef.oneOf) {
          this.parseAsUnion(
            typeName.value,
            schemaOrRef,
            schemaOrRef.oneOf,
            undefined,
          );
        } else {
          this.anonymousTypes.push({
            kind: 'Type',
            name: typeName,
            properties: this.parseProperties(
              schemaOrRef.properties,
              schemaOrRef.required,
              schemaOrRef.allOf,
              typeName.value,
            ),
            description: schemaOrRef.description
              ? [
                  {
                    kind: 'StringLiteral',
                    value: schemaOrRef.description.value,
                    loc: range(schemaOrRef.description),
                  },
                ]
              : undefined,
            deprecated: this.parseDeprecated(schemaOrRef),
            rules: this.parseObjectRules(schemaOrRef),
            loc: range(schemaOrRef),
          });
        }

        return {
          kind: 'ComplexValue',
          typeName,
          rules,
          loc: range(schemaOrRef),
        };
      default:
        return {
          kind: 'PrimitiveValue',
          typeName: { kind: 'PrimitiveLiteral', value: 'untyped' },
          rules,
          loc: range(schemaOrRef),
        };
    }
  }

  private parseStringName(
    def: OAS3.ParameterNode | OAS3.StringSchemaNode,
  ): PrimitiveLiteral {
    const { type, format } = (() => {
      if (def.nodeType === 'StringSchema') return def;
      if (!def.schema) {
        throw new Error('Expected parameter schema but found undefined');
      }

      const schema = OAS3.resolveSchema(this.schema.node, def.schema);

      if (!schema) {
        throw new Error('Cannot resolve ref');
      }

      if (schema.nodeType !== 'StringSchema') {
        throw new Error(`Expected StringSchema but found ${schema.nodeType}`);
      }

      return schema;
    })();

    if (format?.value === 'date') {
      return {
        kind: 'PrimitiveLiteral',
        value: 'date',
        loc: range(def),
      };
    } else if (format?.value === 'date-time') {
      return {
        kind: 'PrimitiveLiteral',
        value: 'date-time',
        loc: range(def),
      };
    } else if (format?.value === 'binary') {
      return {
        kind: 'PrimitiveLiteral',
        value: 'binary',
        loc: range(def),
      };
    } else {
      return {
        kind: 'PrimitiveLiteral',
        value: type.value,
        loc: range(type),
      };
    }
  }

  private parseNumberName(
    def: OAS3.ParameterNode | OAS3.NumberSchemaNode,
  ): PrimitiveLiteral {
    const { type, format } = (() => {
      if (def.nodeType === 'NumberSchema') return def;
      if (!def.schema) {
        throw new Error('Expected parameter schema but found undefined');
      }

      const schema = OAS3.resolveSchema(this.schema.node, def.schema);

      if (!schema) {
        throw new Error('Cannot resolve ref');
      }

      if (schema.nodeType !== 'NumberSchema') {
        throw new Error(`Expected NumberSchema but found ${schema.nodeType}`);
      }

      return schema;
    })();

    if (type.value === 'integer') {
      if (format?.value === 'int32') {
        return {
          kind: 'PrimitiveLiteral',
          value: 'integer',
          loc: range(def),
        };
      } else if (format?.value === 'int64') {
        return {
          kind: 'PrimitiveLiteral',
          value: 'long',
          loc: range(def),
        };
      }
    } else if (type.value === 'number') {
      if (format?.value === 'float') {
        return {
          kind: 'PrimitiveLiteral',
          value: 'float',
          loc: range(def),
        };
      } else if (format?.value === 'double') {
        return {
          kind: 'PrimitiveLiteral',
          value: 'double',
          loc: range(def),
        };
      }
    }

    return {
      kind: 'PrimitiveLiteral',
      value: type.value,
      loc: range(type),
    };
  }

  private parsePrimiaryResponse(operation: OAS3.OperationNode): {
    code: StringLiteral | undefined;
    response: OAS3.RefNode | OAS3.ResponseNode | undefined;
  } {
    const defaultResponse = operation.responses.read('default');
    if (defaultResponse) {
      return {
        code: {
          kind: 'StringLiteral',
          value: 'default',
          loc: operation.responses.keyRange('default'),
        },
        response: defaultResponse,
      };
    }

    const successCodes = operation.responses.keys
      .sort((a, b) => a.localeCompare(b))
      .filter((c) => c.startsWith('2'));

    if (successCodes.length === 0) {
      return { code: undefined, response: undefined };
    }

    const code = successCodes[0];

    return {
      code: {
        kind: 'StringLiteral',
        value: code,
        loc: operation.responses.keyRange(code),
      },
      response: operation.responses.read(code),
    };
  }

  private parsePrimaryResponseKey(
    operation: OAS3.OperationNode,
  ): IntegerLiteral | StringLiteral | undefined {
    const { code } = this.parsePrimiaryResponse(operation);
    if (!code) return;

    const n = Number(code.value);

    if (!Number.isNaN(n)) {
      return { kind: 'IntegerLiteral', value: n, loc: code.loc };
    }
    if (code.value === 'default') {
      return { kind: 'StringLiteral', value: 'default', loc: code.loc };
    }

    return;
  }

  private getSchemaOrRef(
    content: OAS3.MediaTypeIndexNode | undefined,
  ): OAS3.SchemaNodeUnion | OAS3.RefNode | undefined {
    const keys = content?.keys;
    if (!keys?.length) return undefined;

    // TODO: verify that all media types reference the same schema
    const mediaType = content?.read(keys[0]);

    return mediaType?.schema;
  }

  private parseReturnValue(
    operation: OAS3.OperationNode,
  ): ReturnValue | undefined {
    const primaryCode = this.parsePrimaryResponseKey(operation);
    const success = operation.responses.read(`${primaryCode?.value}`);
    if (!success) return;

    const response = this.resolve(success, OAS3.ResponseNode);
    const prefix = '#/components/responses/';
    const name =
      OAS3.isRefNode(success) && success.$ref.value.startsWith(prefix)
        ? success.$ref.value.substring(prefix.length)
        : undefined;

    const schemaOrRef = this.getSchemaOrRef(response.content);

    if (!schemaOrRef) return;

    return {
      kind: 'ReturnValue',
      value: this.parseType(
        schemaOrRef,
        'response',
        name || operation.operationId?.value || '',
      ),
    };
  }

  private getSchemas(): OAS3.SchemaIndexNode | undefined {
    return this.schema.components?.schemas;
  }

  private getSchema(name: string): OAS3.SchemaNodeUnion | undefined {
    const schemas = this.getSchemas();
    if (!schemas) return;

    const schemaOrRef = schemas.read(name);
    if (!schemaOrRef) return;

    if (OAS3.isRefNode(schemaOrRef)) {
      return OAS3.resolveSchema(this.schema.node, schemaOrRef);
    } else {
      return schemaOrRef;
    }
  }

  private parseDefinitions(): Type[] {
    const schemas = this.getSchemas();
    if (!schemas) return [];

    const indexNode = this.getSchemas();

    const definitions = schemas.keys
      .map<[string, OAS3.SchemaNodeUnion, string | undefined, string]>(
        (name) => [
          name,
          this.getSchema(name)!,
          schemas.keyRange(name),
          schemas.propRange(name)!,
        ],
      )
      .filter(([, node]) => node.nodeType === 'ObjectSchema');

    const types: Type[] = [];

    for (const [name, node, nameLoc, defLoc] of definitions) {
      if (node.nodeType !== 'ObjectSchema') continue;

      if (node.oneOf) {
        this.parseAsUnion(name, node, node.oneOf, nameLoc);
      } else {
        types.push(this.parseAsType(name, node, nameLoc, defLoc));
      }
    }

    return types;
  }

  private parseAsUnion(
    name: string,
    node: OAS3.ObjectSchemaNode,
    oneOf: (OAS3.RefNode | OAS3.ObjectSchemaNode)[],
    nameLoc: string | undefined,
  ): void {
    const members: MemberValue[] = oneOf.map((subDef) =>
      this.parseType(subDef, name, ''),
    );

    if (node.discriminator) {
      const { propertyName, mapping } = node.discriminator;

      if (mapping) {
        this.violations.push({
          code: 'openapi-3/unsupported-feature',
          message:
            'Discriminator mapping is not yet supported and will have no effect.',
          range: mapping.loc,
          severity: 'info',
          sourcePath: this.sourcePath,
        });
      }

      // TODO: validate that the discriminator definition is compatable with the referenced types

      const customTypes: ComplexValue[] = [];
      for (const member of members) {
        if (member.kind === 'PrimitiveValue') {
          this.violations.push({
            code: 'openapi-3/misconfigured-discriminator',
            message: 'Discriminators may not reference primitive types.',
            range: node.discriminator.loc,
            severity: 'error',
            sourcePath: this.sourcePath,
          });
        } else {
          customTypes.push(member);
        }
      }

      const union: DiscriminatedUnion = {
        kind: 'DiscriminatedUnion',
        name: { kind: 'StringLiteral', value: name, loc: nameLoc },
        discriminator: toStringLiteral(propertyName),
        members: customTypes,
        loc: range(node),
        meta: this.parseMeta(node),
      };

      this.unions.push(union);
    } else {
      const primitiveMembers = members.filter(
        (m) => m.kind === 'PrimitiveValue',
      );

      const complexMembers = members.filter((m) => m.kind === 'ComplexValue');

      if (primitiveMembers.length === members.length) {
        this.unions.push({
          kind: 'PrimitiveUnion',
          name: { kind: 'StringLiteral', value: name, loc: nameLoc },
          members: primitiveMembers,
          loc: range(node),
          meta: this.parseMeta(node),
        });
      } else if (complexMembers.length === members.length) {
        this.unions.push({
          kind: 'ComplexUnion',
          name: { kind: 'StringLiteral', value: name, loc: nameLoc },
          members: complexMembers,
          loc: range(node),
          meta: this.parseMeta(node),
        });
      } else {
        this.violations.push({
          code: 'openapi-3/mixed-union',
          message: 'Unions must be either all primitive or all complex types.',
          range: node.loc,
          severity: 'error',
          sourcePath: this.sourcePath,
        });
      }
    }
  }

  private parseAsType(
    name: string,
    node: OAS3.SchemaNodeUnion,
    nameLoc: string | undefined,
    defLoc: string,
  ): Type {
    return {
      kind: 'Type',
      name: { kind: 'StringLiteral', value: name, loc: nameLoc },
      description: node.description
        ? [
            {
              kind: 'StringLiteral',
              value: node.description.value,
              loc: range(node.description),
            },
          ]
        : undefined,
      properties:
        node.nodeType === 'ObjectSchema'
          ? this.parseProperties(
              node.properties,
              node.required,
              node.allOf,
              name,
            )
          : [],
      deprecated: this.parseDeprecated(node),
      rules: this.parseObjectRules(node),
      loc: defLoc,
      meta: this.parseMeta(node),
    };
  }

  private parseProperties(
    properties: OAS3.PropertiesNode | undefined,
    required: OAS3.LiteralNode<string>[] | undefined,
    allOf: (OAS3.RefNode | OAS3.ObjectSchemaNode)[] | undefined,
    parentName?: string,
  ): Property[] {
    if (allOf) {
      return allOf
        .map((subDef) => {
          const resolved = this.resolve(subDef, OAS3.ObjectSchemaNode);
          const p = resolved.properties;
          const r = safeConcat(resolved.required, required);
          return this.parseProperties(p, r, resolved.allOf, parentName);
        })
        .reduce((a, b) => a.concat(b), []);
    } else {
      const requiredSet = new Set<string>(required?.map((r) => r.value) || []);
      const props: Property[] = [];

      for (const name of properties?.keys || []) {
        const prop = properties?.read(name);
        if (!prop) continue;

        const resolvedProp = OAS3.resolveSchema(this.schema.node, prop);
        if (!resolvedProp) throw new Error('Cannot resolve reference');

        const value = this.parseType(prop, name, parentName || '');
        props.push({
          kind: 'Property',
          name: {
            kind: 'StringLiteral',
            value: name,
            loc: properties?.keyRange(name),
          },
          description: this.parseDescriptionOnly(resolvedProp.description),
          value,
          deprecated: this.parseDeprecated(resolvedProp),
          loc: range(resolvedProp),
          meta: this.parseMeta(resolvedProp),
        });
      }
      return props;
    }
  }

  private resolve<T extends OAS3.DocumentNode>(
    itemOrRef: T | OAS3.RefNode,
    Node: new (n: AST.ASTNode) => T,
  ): T {
    return OAS3.resolve(this.schema.node, itemOrRef, Node);
  }

  private parseRules(
    def: OAS3.SchemaNodeUnion | OAS3.ParameterNode,
    required?: boolean,
  ): ValidationRule[] {
    const schema = this.parseSchema(def);
    if (!schema) {
      return required
        ? [
            {
              kind: 'ValidationRule',
              id: 'Required',
            },
          ]
        : [];
    }

    const localRules = this.ruleFactories
      .map((f) => f(schema))
      .filter((x): x is ValidationRule => !!x);

    if (schema.nodeType !== 'ArraySchema' || !schema.items)
      return required
        ? [
            {
              kind: 'ValidationRule',
              id: 'Required',
            },
            ...localRules,
          ]
        : localRules;

    const itemsSchema = OAS3.resolveSchema(this.schema.node, schema.items);
    if (!itemsSchema) return [];

    const itemRules = this.ruleFactories
      .map((f) => f(itemsSchema))
      .filter((x): x is ValidationRule => !!x);

    const rules = [...localRules, ...itemRules];

    return required
      ? [
          {
            kind: 'ValidationRule',
            id: 'Required',
          },
          ...rules,
        ]
      : rules;
  }

  private parseObjectRules(def: OAS3.SchemaNodeUnion): ObjectValidationRule[] {
    return objectFactories
      .map((f) => f(def))
      .filter((x): x is ObjectValidationRule => !!x);
  }

  private parseArraySchema(
    node: OAS3.SchemaNodeUnion | OAS3.ParameterNode | undefined,
  ): OAS3.ArraySchemaNode | undefined {
    if (!node) return undefined;
    if (node.nodeType === 'ArraySchema') return node;

    if (node.nodeType === 'Parameter') {
      if (!node.schema) return undefined;

      const schema = OAS3.resolveSchema(this.schema.node, node.schema);

      if (schema?.nodeType === 'ArraySchema') return schema;
    }

    return undefined;
  }

  private parseSchema(
    node: OAS3.SchemaNodeUnion | OAS3.ParameterNode | undefined,
  ): OAS3.SchemaNodeUnion | undefined {
    if (!node) return undefined;
    if (node.nodeType !== 'Parameter') return node;
    if (!node.schema) return undefined;

    return OAS3.resolveSchema(this.schema.node, node.schema);
  }
}

export interface ValidationRuleFactory {
  (def: OAS3.SchemaNodeUnion): ValidationRule | undefined;
}

export interface ObjectValidationRuleFactory {
  (def: OAS3.SchemaNodeUnion): ObjectValidationRule | undefined;
}

const stringMaxLengthFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isString(def) && typeof def.maxLength?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: 'StringMaxLength',
      length: {
        kind: 'NonNegativeIntegerLiteral',
        value: def.maxLength.value,
        loc: range(def.maxLength),
      },
      loc: def.propRange('maxLength')!,
    };
  } else {
    return;
  }
};

const stringMinLengthFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isString(def) && typeof def.minLength?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: 'StringMinLength',
      length: {
        kind: 'NonNegativeIntegerLiteral',
        value: def.minLength.value,
        loc: range(def.minLength),
      },
      loc: def.propRange('minLength')!,
    };
  } else {
    return;
  }
};

const stringPatternFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isString(def) && typeof def.pattern?.value === 'string') {
    return {
      kind: 'ValidationRule',
      id: 'StringPattern',
      pattern: {
        kind: 'NonEmptyStringLiteral',
        value: def.pattern.value,
        loc: range(def.pattern),
      },
      loc: def.propRange('pattern')!,
    };
  } else {
    return;
  }
};

const stringFormatFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isString(def) && typeof def.format?.value === 'string') {
    return {
      kind: 'ValidationRule',
      id: 'StringFormat',
      format: {
        kind: 'NonEmptyStringLiteral',
        value: def.format.value,
        loc: range(def.format),
      },
      loc: def.propRange('format')!,
    };
  } else {
    return;
  }
};

const stringEnumFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isString(def) && Array.isArray(def.enum)) {
    return {
      kind: 'ValidationRule',
      id: 'StringEnum',
      values: def.enum.map((n) => ({
        kind: 'StringLiteral',
        value: n.value,
        loc: range(n),
      })),
      loc: def.propRange('enum')!,
    };
  } else {
    return;
  }
};

const numberMultipleOfFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isNumber(def) && typeof def.multipleOf?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: 'NumberMultipleOf',
      value: {
        kind: 'NonNegativeNumberLiteral',
        value: def.multipleOf.value,
        loc: range(def.multipleOf),
      },
      loc: def.propRange('multipleOf')!,
    };
  } else {
    return;
  }
};

const numberGreaterThanFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isNumber(def) && typeof def.minimum?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: def.exclusiveMinimum?.value ? 'NumberGT' : 'NumberGTE',
      value: {
        kind: 'NumberLiteral',
        value: def.minimum.value,
        loc: range(def.minimum),
      },
      loc: def.propRange('minimum')!,
    };
  } else {
    return;
  }
};

const numberLessThanFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isNumber(def) && typeof def.maximum?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: def.exclusiveMinimum?.value ? 'NumberLT' : 'NumberLTE',
      value: {
        kind: 'NumberLiteral',
        value: def.maximum.value,
        loc: range(def.maximum),
      },
      loc: def.propRange('maximum')!,
    };
  } else {
    return;
  }
};

const arrayMinItemsFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isArray(def) && typeof def.minItems?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: 'ArrayMinItems',
      min: {
        kind: 'NonNegativeNumberLiteral',
        value: def.minItems.value,
        loc: range(def.minItems),
      },
      loc: def.propRange('minItems')!,
    };
  } else {
    return;
  }
};

const arrayMaxItemsFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isArray(def) && typeof def.maxItems?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: 'ArrayMaxItems',
      max: {
        kind: 'NonNegativeNumberLiteral',
        value: def.maxItems.value,
        loc: range(def.maxItems),
      },
      loc: def.propRange('maxItems')!,
    };
  } else {
    return;
  }
};

const arrayUniqueItemsFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isArray(def) && def.uniqueItems) {
    return {
      kind: 'ValidationRule',
      id: 'ArrayUniqueItems',
      required: true,
      loc: def.propRange('uniqueItems')!,
    };
  } else {
    return;
  }
};

const objectMinPropertiesFactory: ObjectValidationRuleFactory = (def) => {
  if (OAS3.isObject(def) && typeof def.minProperties?.value === 'number') {
    return {
      kind: 'ObjectValidationRule',
      id: 'ObjectMinProperties',
      min: {
        kind: 'NonNegativeIntegerLiteral',
        value: def.minProperties.value,
        loc: range(def.minProperties),
      },
      loc: def.propRange('minProperties')!,
    };
  } else {
    return;
  }
};

const objectMaxPropertiesFactory: ObjectValidationRuleFactory = (def) => {
  if (OAS3.isObject(def) && typeof def.maxProperties?.value === 'number') {
    return {
      kind: 'ObjectValidationRule',
      id: 'ObjectMaxProperties',
      max: {
        kind: 'NonNegativeIntegerLiteral',
        value: def.maxProperties.value,
        loc: range(def.maxProperties),
      },
      loc: def.propRange('maxProperties')!,
    };
  } else {
    return;
  }
};

const objectAdditionalPropertiesFactory: ObjectValidationRuleFactory = (
  def,
) => {
  if (
    OAS3.isObject(def) &&
    OAS3.isLiteral(def.additionalProperties) &&
    def.additionalProperties.value === false
  ) {
    return {
      kind: 'ObjectValidationRule',
      id: 'ObjectAdditionalProperties',
      forbidden: { kind: 'TrueLiteral', value: true },
      loc: def.propRange('additionalProperties')!,
    };
  } else {
    return;
  }
};

const factories = [
  stringEnumFactory,
  stringFormatFactory,
  stringMaxLengthFactory,
  stringMinLengthFactory,
  stringPatternFactory,
  numberMultipleOfFactory,
  numberGreaterThanFactory,
  numberLessThanFactory,
  arrayMaxItemsFactory,
  arrayMinItemsFactory,
  arrayUniqueItemsFactory,
];

const objectFactories = [
  objectMaxPropertiesFactory,
  objectMinPropertiesFactory,
  objectAdditionalPropertiesFactory,
];

function safeConcat<T>(
  a: T[] | undefined,
  b: T[] | undefined,
): T[] | undefined {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.concat(b);
  } else if (Array.isArray(a)) {
    return a;
  } else if (Array.isArray(b)) {
    return b;
  } else {
    return undefined;
  }
}

// type MirrorUndefined<Input, Output> = Exclude<
//   Input,
//   Exclude<Input, undefined>
// > extends never
//   ? Output
//   : Output | undefined;

// function literal<
//   Primitive extends string | number | boolean | null,
//   Node extends OAS3.LiteralNode<Primitive> | undefined,
// >(node: Node): MirrorUndefined<Node, Scalar<Primitive>> {
//   if (!node) return undefined as any;
//   return {
//     value: node.value,
//     loc: range(node),
//   };
// }

// class EmptyObject implements AST.ASTNode {
//   public readonly type: AST.NodeType = 'Object';
//   public readonly loc = decodeRange(null);
//   isObject(): this is AST.ObjectNode {
//     return true;
//   }
//   isProperty(): this is AST.PropertyNode {
//     throw new Error('Method not implemented.');
//   }
//   isIdentifier(): this is AST.IdentifierNode {
//     throw new Error('Method not implemented.');
//   }
//   isArray(): this is AST.ArrayNode {
//     throw new Error('Method not implemented.');
//   }
//   isLiteral(): this is AST.LiteralNode {
//     throw new Error('Method not implemented.');
//   }
// }

function toStringLiteral(node: OAS3.LiteralNode<string>): StringLiteral;
function toStringLiteral(
  node: OAS3.LiteralNode<string> | undefined,
): StringLiteral | undefined;
function toStringLiteral(
  node: OAS3.LiteralNode<string> | undefined,
): StringLiteral | undefined {
  if (!node) return undefined;

  return {
    kind: 'StringLiteral',
    value: node.value,
    loc: encodeRange(0, node.loc),
  };
}

function toNumberLiteral(node: OAS3.LiteralNode<number>): NumberLiteral;
function toNumberLiteral(
  node: OAS3.LiteralNode<number> | undefined,
): NumberLiteral | undefined;
function toNumberLiteral(
  node: OAS3.LiteralNode<number> | undefined,
): NumberLiteral | undefined {
  if (!node) return undefined;

  return {
    kind: 'NumberLiteral',
    value: node.value,
    loc: encodeRange(0, node.loc),
  };
}

function toBooleanLiteral(node: OAS3.LiteralNode<boolean>): BooleanLiteral;
function toBooleanLiteral(
  node: OAS3.LiteralNode<boolean> | undefined,
): BooleanLiteral | undefined;
function toBooleanLiteral(
  node: OAS3.LiteralNode<boolean> | undefined,
): BooleanLiteral | undefined {
  if (!node) return undefined;

  return {
    kind: 'BooleanLiteral',
    value: node.value,
    loc: encodeRange(0, node.loc),
  };
}
