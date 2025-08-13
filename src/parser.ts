import { major } from 'semver';
import { singular } from 'pluralize';
import { camel, kebab, pascal } from 'case';

import { AST, DocumentNode, NodeConstructor, parse } from '@basketry/ast';
import * as OAS3 from './types';

import {
  BooleanLiteral,
  ComplexValue,
  encodeRange,
  Enum,
  EnumMember,
  HttpArrayFormat,
  HttpArrayFormatLiteral,
  HttpMethod,
  HttpRoute,
  HttpStatusCodeLiteral,
  Interface,
  MapKey,
  MapProperties,
  MapValue,
  MemberValue,
  MetaValue,
  Method,
  NullLiteral,
  NumberLiteral,
  OAuth2Flow,
  OAuth2Scope,
  ObjectValidationRule,
  Parameter,
  PrimitiveValue,
  PrimitiveValueConstant,
  Property,
  ReturnValue,
  SecurityOption,
  SecurityScheme,
  Service,
  StringLiteral,
  TrueLiteral,
  Type,
  Union,
  ValidationRule,
  Violation,
} from 'basketry';

function range(node: AST.ASTNode | DocumentNode): string {
  // TODO: support multi-document schemas
  return encodeRange(0, node.loc);
}

/**
 * Hack to prepend 0: on each key range.
 * we need to do this in the AST instead of here.
 */
function keyRange(
  node: DocumentNode | undefined,
  key: string,
): string | undefined {
  if (!node) return undefined;

  const r = node.keyRange(key);
  if (!r) return undefined;

  return r.includes(':') ? r : `0:${r}`; // prepend 0: if not already present
}

/**
 * Hack to prepend 0: on each prop range.
 * we need to do this in the AST instead of here.
 */
function propRange(
  node: DocumentNode | undefined,
  key: string,
): string | undefined {
  if (!node) return undefined;

  const r = node.propRange(key);
  if (!r) return undefined;

  return r.includes(':') ? r : `0:${r}`; // prepend 0: if not already present
}

export class OAS3Parser {
  constructor(schema: string) {
    this.schema = new OAS3.OpenAPINode(parse(0, schema), {
      root: undefined,
      parentKey: undefined,
    });
  }
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

    const title = this.schema.info?.title;
    const version = this.schema.info?.version;

    const openapi = this.schema.openapi;
    if (openapi) {
      const semverV3Regex = /^3\.\d+\.\d+$/;
      if (!semverV3Regex.test(openapi.value)) {
        this.violations.push({
          code: 'openapi-3/invalid-schema',
          message: `OpenAPI version ${openapi.value} is not supported.`,
          range: openapi.loc,
          severity: 'error',
          sourcePath: this.sourcePath,
        });
      }
    }

    const service: Service = {
      kind: 'Service',
      basketry: '0.2',
      sourcePaths: [this.sourcePath],
      title: {
        kind: 'StringLiteral',
        value: title ? pascal(title.value) : 'untitled',
        loc: title ? range(title) : undefined,
      },
      majorVersion: {
        kind: 'IntegerLiteral',
        value: version ? major(version.value) : 1,
        loc: version ? range(version) : undefined,
      },
      interfaces,
      types: Object.keys(typesByName).map((name) => typesByName[name]),
      enums: Object.keys(enumsByName).map((name) => enumsByName[name]),
      unions: Object.keys(unionsByName).map((name) => unionsByName[name]),
      loc: range(this.schema),
      meta: this.parseMeta(this.schema),
    };

    for (const violation of OAS3.getViolations(this.schema.root)) {
      this.violations.push({
        code: violation.code,
        message: violation.message,
        range: violation.range,
        severity: violation.severity,
        sourcePath: this.sourcePath,
      });
    }

    return service;
  }

  private parseMeta(node: DocumentNode): MetaValue[] | undefined {
    const n = node.node;
    if (!n.isObject()) return undefined;

    const meta: MetaValue[] = n.children
      .filter((child) => child.key.value.startsWith('x-'))
      .map((child) => ({
        kind: 'MetaValue',
        key: {
          kind: 'StringLiteral',
          value: child.key.value.substring(2),
          // TODO: support multi-document schemas
          loc: encodeRange(0, child.key.loc),
        },
        value: {
          kind: 'UntypedLiteral',
          value: OAS3.toJson(child.value),
          // TODO: support multi-document schemas
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

    if (typeof primary?.value === 'number') {
      return primary as HttpStatusCodeLiteral;
    } else if (primary?.value === 'default') {
      const res = operation.responses?.read(primary.value);
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
      const pathOrRef = this.schema.paths.read(path);
      if (!pathOrRef) continue;

      const pathItem = this.resolve(pathOrRef, OAS3.PathItemNode);
      if (!pathItem) continue;

      const keyLoc = keyRange(this.schema.paths, path);
      const loc = propRange(this.schema.paths, path);
      const commonParameters = pathItem.parameters || [];

      const httpRoute: HttpRoute = {
        kind: 'HttpRoute',
        pattern: { kind: 'StringLiteral', value: path, loc: keyLoc },
        methods: [],
        loc,
      };

      for (const verb of pathItem.keys) {
        if (verb === 'parameters') continue;
        const operation = pathItem[verb] as OAS3.OperationNode | undefined;
        if (!operation) continue;

        if (this.parseInterfaceName(path, operation) !== interfaceName) {
          continue;
        }

        const verbLoc = keyRange(pathItem, verb);
        const methodLoc = propRange(pathItem, verb);

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
          // TODO: validate verbs
          verb: { kind: 'HttpVerbLiteral', value: verb as any, loc: verbLoc },
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
          if (!resolved) continue;

          const location = this.parseParameterLocation(param);
          if (!location) continue;

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

          const value = name?.value ?? 'unnamed';
          const nameLoc = name ? range(name) : undefined;

          if (
            (resolved.in.value === 'header' ||
              resolved.in.value === 'path' ||
              resolved.in.value === 'query') &&
            resolved.schema?.nodeType === 'ArraySchema'
          ) {
            httpMethod.parameters.push({
              kind: 'HttpParameter',
              name: { kind: 'StringLiteral', value, loc: nameLoc },
              location: {
                kind: 'HttpLocationLiteral',
                value: locationValue,
                loc: range(location),
              },
              arrayFormat: this.parseArrayStyle(resolved),
              loc: range(resolved),
            });
          } else {
            httpMethod.parameters.push({
              kind: 'HttpParameter',
              name: { kind: 'StringLiteral', value, loc: nameLoc },
              location: {
                kind: 'HttpLocationLiteral',
                value: locationValue,
                loc: range(location),
              },
              loc: range(resolved),
            });
          }
        }

        httpRoute.methods.push(httpMethod);
      }

      if (httpRoute.methods.length) httpPaths.push(httpRoute);
    }
    return httpPaths;
  }

  private parseHttpRequestMediaType(
    operation: OAS3.OperationNode,
  ): StringLiteral[] {
    if (!operation.requestBody) return [];
    const body = this.resolve(operation.requestBody, OAS3.RequestBodyNode);
    return body?.content ? this.parseMediaType(body.content) : [];
  }

  private parseHttpResponseMediaType(
    operation: OAS3.OperationNode,
  ): StringLiteral[] {
    const { response } = this.parsePrimiaryResponse(operation) ?? {};
    if (!response) return [];

    const res = this.resolve(response, OAS3.ResponseNode);
    return res?.content ? this.parseMediaType(res.content) : [];
  }

  private parseMediaType(
    mediaTypeIndexNode: OAS3.MediaTypeIndexNode,
  ): StringLiteral[] {
    return mediaTypeIndexNode.keys.map((key) => ({
      kind: 'StringLiteral',
      value: key,
      loc: keyRange(mediaTypeIndexNode, key),
    }));
  }

  private parseArrayStyle(
    paramNode: OAS3.ParameterNode,
  ): Exclude<HttpArrayFormatLiteral, undefined> {
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

    // TODO: support multi-document schemas
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
      const pathNode = pathsNode.read(path);
      if (!pathNode) continue;

      for (const verb of pathNode.keys) {
        if (verb === 'parameters' || verb.startsWith('x-')) continue;

        const operation: OAS3.OperationNode = pathNode[verb];
        if (!operation) continue;

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
    const segments = path.split('/');
    return operation.tags?.[0].value || segments[1] || segments[0] || 'default';
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

    const methods: Method[] = [];

    for (const { path, verb, operation } of this.allOperations()) {
      const pathNode = this.resolve(pathsNode.read(path)!, OAS3.PathItemNode);
      const commonParameters = pathNode?.parameters ?? [];

      if (this.parseInterfaceName(path, operation) !== interfaceName) {
        continue;
      }

      const nameLoc = operation.operationId
        ? range(operation.operationId)
        : undefined;

      const operationId = operation.operationId?.value;
      if (!operationId) continue;

      methods.push({
        kind: 'Method',
        name: { kind: 'StringLiteral', value: operationId, loc: nameLoc },
        security: this.parseSecurity(operation),
        parameters: this.parseParameters(operation, commonParameters),
        description: this.parseDescription(
          operation.summary,
          operation.description,
        ),
        deprecated: this.parseDeprecated(operation),
        returns: this.parseReturnValue(operation),
        loc: propRange(pathsNode.read(path), verb),
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

    const options: SecurityOption[] = security.map((requirements) => ({
      kind: 'SecurityOption',
      schemes: requirements.keys
        .map((key): SecurityScheme | undefined => {
          const requirement = requirements.read(key);
          const definition = securitySchemes?.read(key);

          if (!requirement || !definition) return;

          const keyLoc = keyRange(securitySchemes, key);
          const loc = propRange(securitySchemes, key);

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
        .filter((scheme): scheme is SecurityScheme => !!scheme),
      loc: range(requirements),
    }));

    return options;
  }

  private parseHttpSecurity(
    definition: OAS3.HttpSecuritySchemeNode,
    name: StringLiteral,
    loc: string | undefined,
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
    loc: string | undefined,
  ): SecurityScheme {
    return {
      kind: 'ApiKeyScheme',
      type: {
        value: 'apiKey',
        loc: range(definition.type),
      },
      name,
      description: this.parseDescriptionOnly(definition.description),
      parameter: toStringLiteral(definition.name),
      in: {
        value: definition.in.value,
        loc: range(definition.in),
      },
      // in: literal(definition.in),
      // TODO: deprecated: this.parseDeprecated(definition),
      loc,
      meta: this.parseMeta(definition),
    };
  }

  private parseOAuth2Security(
    definition: OAS3.OAuth2SecuritySchemeNode,
    name: StringLiteral,
    loc: string | undefined,
  ): SecurityScheme {
    return {
      kind: 'OAuth2Scheme',
      type: { value: 'oauth2', loc: range(definition.type) },
      name,
      description: this.parseDescriptionOnly(definition.description),
      flows: Array.from(this.parseOAuth2Flows(definition.flows, name, loc)),
      // TODO: deprecated: this.parseDeprecated(definition),
      loc,
      meta: this.parseMeta(definition),
    };
  }

  private *parseOAuth2Flows(
    flows: OAS3.OAuthFlowsNode,
    name: StringLiteral,
    loc: string | undefined,
  ): Iterable<OAuth2Flow> {
    if (flows.authorizationCode) {
      const flow = flows.authorizationCode;
      yield {
        kind: 'OAuth2AuthorizationCodeFlow',
        type: {
          value: 'authorizationCode',
          loc: keyRange(flows, 'authorizationCode'),
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
          loc: keyRange(flows, 'clientCredentials'),
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
          loc: keyRange(flows, 'implicit'),
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
          loc: keyRange(flows, 'password'),
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
        loc: keyRange(scopes, k),
      },
      description: this.parseDescriptionOnly(scopes.read(k))!,
      loc: propRange(scopes, k),
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

    const nonBodyParams = parameters
      .map((p) => this.parseParameter(p, operation.operationId?.value || ''))
      .filter((x): x is Parameter => !!x);

    const bodyParam = this.parseRequestBody(
      operation.requestBody,
      operation.operationId?.value || '',
      this.parseBodyParamName(operation),
    );

    return bodyParam ? [bodyParam, ...nonBodyParams] : nonBodyParams;
  }

  private parseBodyParamName(operation: OAS3.OperationNode): StringLiteral {
    const meta = this.parseMeta(operation);

    const name = meta?.find(
      (m) => kebab(m.key.value) === 'codegen-request-body-name',
    )?.value;

    return typeof name?.value === 'string'
      ? { kind: 'StringLiteral', value: name.value, loc: name.loc }
      : {
          kind: 'StringLiteral',
          value: 'body',
          // TODO: support multi-document schemas
          loc: encodeRange(0, operation.requestBody?.parentKey?.loc),
        };
  }

  private parseParameter(
    param: OAS3.ParameterNode,
    methodName: string,
  ): Parameter | undefined {
    if (!param.schema) return;

    const unresolved = param.schema;
    const resolved = OAS3.resolveSchema(this.schema.node, param.schema);
    if (!resolved) return;

    const value = param.name?.value ?? 'unnamed';
    const loc = param.name ? range(param.name) : undefined;

    const x = this.parseType(unresolved, value, methodName);
    if (!x) return;

    if (x.kind === 'PrimitiveValue') {
      return {
        kind: 'Parameter',
        name: { kind: 'StringLiteral', value, loc },
        description: this.parseDescription(undefined, param.description),
        value: {
          kind: 'PrimitiveValue',
          typeName: x.typeName,
          isArray: x.isArray,
          // TODO: parse isNullable
          isOptional: param.required?.value
            ? undefined
            : {
                kind: 'TrueLiteral',
                value: true,
                loc: encodeRange(0, param.required?.loc),
              },
          default: x.default,
          rules: this.parseRules(resolved),
        },
        deprecated: this.parseDeprecated(param),
        loc: range(param),
        meta: this.parseMeta(param),
      };
    } else {
      return {
        kind: 'Parameter',
        name: { kind: 'StringLiteral', value, loc },
        description: this.parseDescription(undefined, param.description),
        value: {
          kind: 'ComplexValue',
          typeName: x.typeName,
          isArray: x.isArray,
          // TODO: parse isNullable
          isOptional: param.required?.value
            ? undefined
            : {
                kind: 'TrueLiteral',
                value: true,
                loc: encodeRange(0, param.required?.loc),
              },
          rules: this.parseRules(resolved),
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
    if (!body) return;

    const schemaOrRef = this.getSchemaOrRef(body?.content);
    if (!schemaOrRef) return;

    const schema = OAS3.resolveSchema(this.schema.node, schemaOrRef);
    if (!schema) return;

    const x = this.parseType(schemaOrRef, paramName.value, methodName);
    if (!x) return;

    if (x.kind === 'PrimitiveValue') {
      return {
        kind: 'Parameter',
        name: paramName,
        description: this.parseDescription(undefined, body.description),
        value: {
          kind: 'PrimitiveValue',
          typeName: x.typeName,
          isArray: x.isArray,
          // TODO: parse isNullable
          isOptional: body.required?.value
            ? undefined
            : {
                kind: 'TrueLiteral',
                value: true,
                loc: encodeRange(0, body.required?.loc),
              },
          rules: this.parseRules(schema),
        },
        loc: range(body),
        meta: this.parseMeta(body),
      };
    } else {
      return {
        kind: 'Parameter',
        name: paramName,
        description: this.parseDescription(undefined, body.description),
        value: {
          kind: 'ComplexValue',
          typeName: x.typeName,
          isArray: x.isArray,
          // TODO: parse isNullable
          isOptional: body.required?.value
            ? undefined
            : {
                kind: 'TrueLiteral',
                value: true,
                loc: encodeRange(0, body.required?.loc),
              },
          rules: this.parseRules(schema),
        },
        loc: range(body),
        meta: this.parseMeta(body),
      };
    }
  }

  private parseParameterLocation(
    def: OAS3.ParameterNode | OAS3.RefNode,
  ): OAS3.ParameterNode['in'] | undefined {
    const resolved = OAS3.resolveParam(this.schema.node, def);
    if (!resolved) return;

    return resolved.in;
  }

  private parseParameterName(
    def: OAS3.ParameterNode | OAS3.RefNode,
  ): OAS3.ParameterNode['name'] | undefined {
    const resolved = OAS3.resolveParam(this.schema.node, def);
    if (!resolved) return;

    return resolved.name;
  }

  private parseConst<T extends string | number | boolean | null>(schema: {
    enum?: OAS3.LiteralNode<T>[];
    const?: OAS3.LiteralNode<T>;
  }): PrimitiveValueConstant | undefined {
    const value =
      schema.const ?? (schema.enum?.length === 1 ? schema.enum[0] : undefined);

    switch (typeof value?.value) {
      case 'boolean':
        return {
          kind: 'BooleanLiteral',
          value: value.value,
          loc: range(value),
        };
      case 'number':
      case 'bigint':
        return {
          kind: 'NumberLiteral',
          value: value.value,
          loc: range(value),
        };
      case 'string':
        return {
          kind: 'StringLiteral',
          value: value.value,
          loc: range(value),
        };
      case 'object':
        if (value.value === null) {
          return {
            kind: 'NullLiteral',
            value: null,
            loc: range(value),
          };
        }
        break;
    }
    return undefined;
  }

  private parseType(
    schemaOrRef: OAS3.SchemaNodeUnion | OAS3.RefNode,
    localName: string,
    parentName: string,
  ):
    | ({
        enumValues?: StringLiteral[];
        rules: ValidationRule[];
        loc: string;
      } & MemberValue)
    | undefined {
    if (OAS3.isRefNode(schemaOrRef)) {
      const schema = OAS3.resolveSchema(this.schema.node, schemaOrRef);
      if (!schema) return;

      // TODO: do a better job of detecting a definitions ref
      const prefix = '#/components/schemas/';
      if (schemaOrRef.$ref?.value.startsWith(prefix)) {
        if (OAS3.isObject(schema)) {
          return {
            kind: 'ComplexValue',
            typeName: {
              kind: 'StringLiteral',
              value: schemaOrRef.$ref.value.substring(prefix.length),
              loc: OAS3.refRange(this.schema.node, schemaOrRef.$ref.value),
            },
            // TODO: parse isNullable?
            // TODO: parse isOptional?
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
                // TODO: support multi-document schemas
                loc: encodeRange(0, n.loc),
              },
              loc: range(n),
            })),
            deprecated: this.parseDeprecated(schema),
            loc: propRange(schema, 'enum'),
          });
          return {
            kind: 'ComplexValue',
            typeName: name,
            // TODO: parse isNullable?
            // TODO: parse isOptional?
            rules: this.parseRules(schema),
            loc: range(schema),
          };
        } else {
          return this.parseType(schema, localName, parentName);
        }
      } else {
        // TODO: what is this?
        const { $ref } = schemaOrRef;
        return {
          kind: 'ComplexValue',
          typeName: {
            kind: 'StringLiteral',
            value: $ref?.value ?? 'untyped', // TODO: emit violation and/or return untyped primitive
            loc: $ref ? OAS3.refRange(this.schema.node, $ref.value) : undefined,
          },
          // TODO: parse isNullable?
          // TODO: parse isOptional?
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
            const stringName = this.parseStringName(schemaOrRef);
            if (!stringName) return;
            return {
              ...stringName,
              default: toStringLiteral(schemaOrRef.default),
              constant: toStringLiteral(schemaOrRef.enum[0]),
              // TODO: parse isNullable?
              // TODO: parse isOptional?
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
                  kind: 'StringLiteral',
                  value: n.value,
                  // TODO: support multi-document schemas
                  loc: encodeRange(0, n.loc),
                },
                // TODO: deprecated
                loc: range(n),
              })),
              deprecated: this.parseDeprecated(schemaOrRef),
              loc: propRange(schemaOrRef, 'enum'),
            });
            return {
              kind: 'ComplexValue',
              typeName: { kind: 'StringLiteral', value: enumName },
              // TODO: parse isNullable?
              // TODO: parse isOptional?
              rules,
              loc: range(schemaOrRef),
            };
          }
        } else {
          const stringName = this.parseStringName(schemaOrRef);
          if (!stringName) return;
          return {
            ...stringName,
            default: toStringLiteral(schemaOrRef.default),
            constant: toStringLiteral(schemaOrRef.const),
            // TODO: parse isNullable?
            // TODO: parse isOptional?
            rules,
            loc: range(schemaOrRef),
          };
        }
      // case 'NumberParameter':
      case 'NumberSchema':
        return {
          ...this.parseNumberName(schemaOrRef),
          default: toNumberLiteral(schemaOrRef.default),
          constant: this.parseConst(schemaOrRef),
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
          constant: this.parseConst(schemaOrRef),
          // TODO: parse isNullable?
          // TODO: parse isOptional?
          rules,
          loc: range(schemaOrRef),
        };
      // case 'ArrayParameter':
      case 'ArraySchema':
        if (!schemaOrRef.items) return;

        const items = this.parseType(schemaOrRef.items, localName, parentName);
        if (!items) return;

        if (items.kind === 'PrimitiveValue') {
          return {
            kind: 'PrimitiveValue',
            typeName: items.typeName,
            isArray: {
              kind: 'TrueLiteral',
              value: true,
              // TODO: loc
            },
            // TODO: parse isNullable?
            // TODO: parse isOptional?
            rules,
            loc: range(schemaOrRef),
          };
        } else {
          return {
            kind: 'ComplexValue',
            typeName: items.typeName,
            isArray: {
              kind: 'TrueLiteral',
              value: true,
              // TODO: loc
            },
            // TODO: parse isNullable?
            // TODO: parse isOptional?
            rules,
            loc: range(schemaOrRef),
          };
        }

      case 'ObjectSchema':
        const typeName: StringLiteral = {
          kind: 'StringLiteral',
          value: camel(`${parentName}_${localName}`),
        };
        if (schemaOrRef.oneOf) {
          const nullableMember = this.preParseAsUnion(
            typeName.value,
            schemaOrRef,
            schemaOrRef.oneOf,
            undefined,
          );
          if (nullableMember) {
            return { ...nullableMember, loc: range(schemaOrRef) };
          }
        } else if (schemaOrRef.anyOf) {
          const nullableMember = this.preParseAsUnion(
            typeName.value,
            schemaOrRef,
            schemaOrRef.anyOf,
            undefined,
          );
          if (nullableMember) {
            return { ...nullableMember, loc: range(schemaOrRef) };
          }
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
            mapProperties: this.parseMapProperties(schemaOrRef, typeName.value),
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
            // TODO: parse isNullable?
            // TODO: parse isOptional?
            rules: this.parseObjectRules(schemaOrRef),
            loc: range(schemaOrRef),
          });
        }

        return {
          kind: 'ComplexValue',
          typeName,
          // TODO: parse isNullable?
          // TODO: parse isOptional?
          rules,
          loc: range(schemaOrRef),
        };
      case 'NullSchema': {
        return {
          kind: 'PrimitiveValue',
          typeName: {
            kind: 'PrimitiveLiteral',
            value: schemaOrRef.type.value,
            loc: range(schemaOrRef.type),
          },
          default: toNullLiteral(schemaOrRef.default),
          constant:
            schemaOrRef.const === null
              ? toNullLiteral(schemaOrRef.const)
              : undefined,
          // TODO: parse isNullable?
          // TODO: parse isOptional?
          rules,
          loc: range(schemaOrRef),
        };
        break;
      }
      default:
        return {
          kind: 'PrimitiveValue',
          typeName: { kind: 'PrimitiveLiteral', value: 'untyped' },
          // TODO: parse isNullable?
          // TODO: parse isOptional?
          rules,
          loc: range(schemaOrRef),
        };
    }
  }

  private parseStringName(
    def: OAS3.ParameterNode | OAS3.StringSchemaNode,
  ): Omit<PrimitiveValue, 'isArray' | 'rules'> | undefined {
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
        kind: 'PrimitiveValue',
        typeName: {
          kind: 'PrimitiveLiteral',
          value: 'date',
          loc: range(def),
        },
      };
    } else if (format?.value === 'date-time') {
      return {
        kind: 'PrimitiveValue',
        typeName: {
          kind: 'PrimitiveLiteral',
          value: 'date-time',
          loc: range(def),
        },
      };
    } else if (format?.value === 'binary') {
      return {
        kind: 'PrimitiveValue',
        typeName: {
          kind: 'PrimitiveLiteral',
          value: 'binary',
          loc: range(def),
        },
      };
    } else {
      return {
        kind: 'PrimitiveValue',
        typeName: {
          kind: 'PrimitiveLiteral',
          value: type.value,
          loc: range(type),
        },
      };
    }
  }

  private parseNumberName(
    def: OAS3.ParameterNode | OAS3.NumberSchemaNode,
  ): Omit<PrimitiveValue, 'isArray' | 'rules'> {
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
          kind: 'PrimitiveValue',
          typeName: {
            kind: 'PrimitiveLiteral',
            value: 'integer',
            loc: range(def),
          },
        };
      } else if (format?.value === 'int64') {
        return {
          kind: 'PrimitiveValue',
          typeName: {
            kind: 'PrimitiveLiteral',
            value: 'long',
            loc: range(def),
          },
        };
      }
    } else if (type.value === 'number') {
      if (format?.value === 'float') {
        return {
          kind: 'PrimitiveValue',
          typeName: {
            kind: 'PrimitiveLiteral',
            value: 'float',
            loc: range(def),
          },
        };
      } else if (format?.value === 'double') {
        return {
          kind: 'PrimitiveValue',
          typeName: {
            kind: 'PrimitiveLiteral',
            value: 'double',
            loc: range(def),
          },
        };
      }
    }

    return {
      kind: 'PrimitiveValue',
      typeName: {
        kind: 'PrimitiveLiteral',
        value: type.value,
        loc: range(type),
      },
    };
  }

  private parsePrimiaryResponse(operation: OAS3.OperationNode): {
    code: StringLiteral | undefined;
    response: OAS3.RefNode | OAS3.ResponseNode | undefined;
  } {
    const responses = operation.responses;
    if (!responses) return { code: undefined, response: undefined };

    const defaultResponse = operation.responses.read('default');
    if (defaultResponse) {
      return {
        code: {
          kind: 'StringLiteral',
          value: 'default',
          loc: keyRange(operation.responses, 'default'),
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
        loc: keyRange(operation.responses, code),
      },
      response: operation.responses.read(code),
    };
  }

  private parsePrimaryResponseKey(
    operation: OAS3.OperationNode,
  ): HttpStatusCodeLiteral | StringLiteral | undefined {
    const { code } = this.parsePrimiaryResponse(operation);
    if (!code) return;

    const n = Number(code.value);

    if (!Number.isNaN(n))
      return { kind: 'HttpStatusCodeLiteral', value: n, loc: code.loc };
    if (code.value === 'default')
      return { kind: 'StringLiteral', value: code.value, loc: code.loc };
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
    const success = operation.responses?.read(`${primaryCode?.value}`);
    if (!success) return;

    const response = this.resolve(success, OAS3.ResponseNode);
    const prefix = '#/components/responses/';
    const name =
      OAS3.isRefNode(success) && success.$ref?.value.startsWith(prefix)
        ? success.$ref.value.substring(prefix.length)
        : undefined;

    const schemaOrRef = this.getSchemaOrRef(response?.content);

    if (!schemaOrRef) return;

    const type = this.parseType(
      schemaOrRef,
      'response',
      name || operation.operationId?.value || '',
    );
    if (!type) return;

    return {
      kind: 'ReturnValue',
      value: type,
      loc: encodeRange(0, schemaOrRef.loc),
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

    const definitions = schemas.keys
      .map<
        [string, OAS3.SchemaNodeUnion, string | undefined, string]
      >((name) => [name, this.getSchema(name)!, keyRange(schemas, name), propRange(schemas, name)!])
      .filter(([, node]) => node.nodeType === 'ObjectSchema');

    const types: Type[] = [];

    for (const [name, node, nameLoc, defLoc] of definitions) {
      if (node.nodeType !== 'ObjectSchema') continue;

      if (node.oneOf) {
        this.preParseAsUnion(name, node, node.oneOf, nameLoc);
      } else if (node.anyOf) {
        this.preParseAsUnion(name, node, node.anyOf, nameLoc);
      } else {
        types.push(this.parseAsType(name, node, nameLoc, defLoc));
      }
    }

    return types;
  }

  private preParseAsUnion(
    name: string,
    node: OAS3.SchemaNodeUnion,
    memberNodes: (OAS3.RefNode | OAS3.SchemaNodeUnion)[],
    // TODO: parse disjunction
    nameLoc: string | undefined,
  ): MemberValue | undefined {
    const members: MemberValue[] = memberNodes
      .map((subDef, i) => this.parseType(subDef, `${i + 1}`, name))
      .filter(
        (
          x,
        ): x is {
          enumValues?: StringLiteral[];
          rules: ValidationRule[];
          loc: string;
        } & MemberValue => !!x,
      );

    const nullMember = members.find(
      (m) =>
        m.kind === 'PrimitiveValue' &&
        m.typeName.value === 'null' &&
        !m.isArray,
    );
    const otherMember = members.find((m) => m.typeName.value !== 'null');

    if (nullMember && otherMember && members.length === 2) {
      const nullable: MemberValue = {
        ...otherMember,
        isNullable: { kind: 'TrueLiteral', value: true },
      };

      return nullable;
    } else {
      this.parseAsUnion(name, node, members, nameLoc);
      return undefined;
    }
  }

  private parseAsUnion(
    name: string,
    node: OAS3.SchemaNodeUnion,
    members: MemberValue[],
    // TODO: parse disjunction
    nameLoc: string | undefined,
  ): void {
    if (node.nodeType === 'ObjectSchema' && node.discriminator?.propertyName) {
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

      const complexValues: ComplexValue[] = [];
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
          complexValues.push(member);
        }
      }

      const union: Union = {
        kind: 'DiscriminatedUnion',
        name: { kind: 'StringLiteral', value: name, loc: nameLoc },
        discriminator: toStringLiteral(propertyName),
        members: complexValues,
        loc: range(node),
        meta: this.parseMeta(node),
      };

      this.unions.push(union);
    } else {
      this.unions.push({
        kind: 'SimpleUnion',
        name: { kind: 'StringLiteral', value: name, loc: nameLoc },
        members,
        loc: range(node),
        meta: this.parseMeta(node),
      });
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
      mapProperties: this.parseMapProperties(node, name),
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
      return allOf.flatMap((subDef) => {
        const resolved = this.resolve(subDef, OAS3.ObjectSchemaNode);
        if (!resolved) return [];

        const p = resolved.properties;
        const r = safeConcat(resolved.required, required);
        return this.parseProperties(p, r, resolved.allOf, parentName);
      });
    } else {
      const requiredSet = new Set<string>(required?.map((r) => r.value) || []);
      const props: Property[] = [];

      for (const name of properties?.keys || []) {
        const prop = properties?.read(name);
        if (!prop) continue;

        const resolvedProp = OAS3.resolveSchema(this.schema.node, prop);
        if (!resolvedProp) continue;

        const x = this.parseType(prop, name, parentName || '');
        if (!x) continue;

        if (x.kind === 'PrimitiveValue') {
          props.push({
            kind: 'Property',
            name: {
              kind: 'StringLiteral',
              value: name,
              loc: keyRange(properties, name),
            },
            description: this.parseDescriptionOnly(resolvedProp.description),
            value: {
              kind: 'PrimitiveValue',
              typeName: x.typeName,
              isArray: x.isArray,
              default: x.default,
              constant: this.parseConstant(prop, x),
              isNullable: x.isNullable ?? this.parseNullable(resolvedProp),
              isOptional: requiredSet.has(name)
                ? undefined
                : {
                    kind: 'TrueLiteral',
                    value: true,
                  },
              rules: this.parseRules(resolvedProp),
            },
            deprecated: this.parseDeprecated(resolvedProp),
            loc: range(resolvedProp),
            meta: this.parseMeta(resolvedProp),
          });
        } else {
          props.push({
            kind: 'Property',
            name: {
              kind: 'StringLiteral',
              value: name,
              loc: keyRange(properties, name),
            },
            description: this.parseDescriptionOnly(resolvedProp.description),
            value: {
              kind: 'ComplexValue',
              typeName: x.typeName,
              isArray: x.isArray,
              isNullable: x.isNullable ?? this.parseNullable(resolvedProp),
              isOptional: requiredSet.has(name)
                ? undefined
                : {
                    kind: 'TrueLiteral',
                    value: true,
                  },
              rules: this.parseRules(resolvedProp),
            },
            deprecated: this.parseDeprecated(resolvedProp),
            loc: range(resolvedProp),
            meta: this.parseMeta(resolvedProp),
          });
        }
      }
      return props;
    }
  }

  private parseNullable(node: OAS3.SchemaNodeUnion): TrueLiteral | undefined {
    return node.nullable?.value
      ? { kind: 'TrueLiteral', value: true }
      : undefined;
  }

  private parseMapProperties(
    node: OAS3.SchemaNodeUnion,
    parentName: string,
  ): MapProperties | undefined {
    if (node.nodeType !== 'ObjectSchema') return;

    const required = node.required ?? [];
    const definedPropNames = new Set(node.properties?.keys);
    const requiredMapKeys = required.filter(
      (r) => !definedPropNames.has(r.value),
    );

    const emitInvalidRequired = () => {
      for (const mapKey of requiredMapKeys) {
        this.violations.push({
          code: 'openapi-3/invalid-schema',
          message: `Property "${mapKey.value}" is required but not defined.`,
          range: mapKey.loc,
          severity: 'warning',
          sourcePath: this.sourcePath,
        });
      }
    };

    const additionalProperties = node.additionalProperties;
    if (!additionalProperties) {
      emitInvalidRequired();
      return;
    }

    const requiredKeys: StringLiteral[] = requiredMapKeys.map((r) =>
      toStringLiteral(r),
    );

    if (additionalProperties.nodeType === 'Literal') {
      if (additionalProperties.value === false) {
        emitInvalidRequired();
        return;
      }

      return {
        kind: 'MapProperties',
        key: {
          kind: 'MapKey',
          value: {
            kind: 'PrimitiveValue',
            typeName: { kind: 'PrimitiveLiteral', value: 'string' },
            isOptional: { kind: 'TrueLiteral', value: true },
            rules: [],
          },
        },
        requiredKeys,
        value: {
          kind: 'MapValue',
          value: {
            kind: 'PrimitiveValue',
            typeName: { kind: 'PrimitiveLiteral', value: 'untyped' },
            isOptional: { kind: 'TrueLiteral', value: true },
            rules: [],
          },
        },
        loc: range(additionalProperties),
      };
    }

    return {
      kind: 'MapProperties',
      key: this.parseMapKey(node.propertyNames, parentName),
      requiredKeys,
      value: this.parseMapValue(additionalProperties, parentName),
      loc: range(additionalProperties),
      meta: this.parseMeta(additionalProperties),
    };
  }

  private parseMapKey(
    schemaOrRef: OAS3.RefNode | OAS3.SchemaNodeUnion | undefined,
    parentName: string,
  ): MapKey {
    const typeOrPrimitive = schemaOrRef
      ? this.parseType(schemaOrRef, 'mapKeys', parentName)
      : undefined;
    if (!typeOrPrimitive) {
      return {
        kind: 'MapKey',
        value: {
          kind: 'PrimitiveValue',
          typeName: { kind: 'PrimitiveLiteral', value: 'string' },
          isOptional: { kind: 'TrueLiteral', value: true },
          rules: [],
        },
      };
    }

    if (typeOrPrimitive.kind === 'PrimitiveValue') {
      return {
        kind: 'MapKey',
        value: {
          kind: 'PrimitiveValue',
          typeName: typeOrPrimitive.typeName,
          isArray: typeOrPrimitive.isArray,
          default: typeOrPrimitive.default,
          constant: typeOrPrimitive.constant,
          isOptional: { kind: 'TrueLiteral', value: true },
          rules: typeOrPrimitive.rules,
        },
        loc: schemaOrRef ? range(schemaOrRef) : undefined,
        meta: schemaOrRef ? this.parseMeta(schemaOrRef) : undefined,
      };
    } else {
      return {
        kind: 'MapKey',
        value: {
          kind: 'ComplexValue',
          typeName: typeOrPrimitive.typeName,
          isArray: typeOrPrimitive.isArray,
          isOptional: { kind: 'TrueLiteral', value: true },
          rules: typeOrPrimitive.rules,
        },
        loc: schemaOrRef ? range(schemaOrRef) : undefined,
        meta: schemaOrRef ? this.parseMeta(schemaOrRef) : undefined,
      };
    }
  }

  private parseMapValue(
    schemaOrRef: OAS3.SchemaNodeUnion | OAS3.RefNode,
    parentName: string,
  ): MapValue {
    const typeOrPrimitive = this.parseType(
      schemaOrRef,
      'mapValues',
      parentName,
    );
    if (!typeOrPrimitive) {
      return {
        kind: 'MapValue',
        value: {
          kind: 'PrimitiveValue',
          typeName: { kind: 'PrimitiveLiteral', value: 'untyped' },
          isOptional: { kind: 'TrueLiteral', value: true },
          rules: [],
        },
      };
    }

    if (typeOrPrimitive.kind === 'PrimitiveValue') {
      return {
        kind: 'MapValue',
        value: {
          kind: 'PrimitiveValue',
          typeName: typeOrPrimitive.typeName,
          isArray: typeOrPrimitive.isArray,
          isOptional: { kind: 'TrueLiteral', value: true },
          rules: typeOrPrimitive.rules,
          default: typeOrPrimitive.default,
          constant: typeOrPrimitive.constant,
        },
        loc: range(schemaOrRef),
        meta: this.parseMeta(schemaOrRef),
      };
    } else {
      return {
        kind: 'MapValue',
        value: {
          kind: 'ComplexValue',
          typeName: typeOrPrimitive.typeName,
          isArray: typeOrPrimitive.isArray,
          isOptional: { kind: 'TrueLiteral', value: true },
          rules: typeOrPrimitive.rules,
        },
        loc: range(schemaOrRef),
        meta: this.parseMeta(schemaOrRef),
      };
    }
  }

  private parseConstant(
    unresolvedProp: OAS3.SchemaNodeUnion | OAS3.RefNode,
    parsedType: {
      enumValues?: StringLiteral[] | undefined;
      rules: ValidationRule[];
      loc: string;
    } & MemberValue,
  ): PrimitiveValueConstant | undefined {
    if (parsedType.kind === 'PrimitiveValue') {
      if (parsedType.constant) {
        return parsedType.constant;
      } else if (
        parsedType.enumValues &&
        !OAS3.isRefNode(unresolvedProp) &&
        parsedType.enumValues.length === 1
      ) {
        return parsedType.enumValues[0];
      }
    }

    return undefined;
  }

  private resolve<T extends OAS3.DocumentNode>(
    itemOrRef: T | OAS3.RefNode,
    Node: NodeConstructor<T>,
  ): T | undefined {
    return OAS3.resolve(this.schema.node, itemOrRef, Node);
  }

  private parseRules(
    def: OAS3.SchemaNodeUnion | OAS3.ParameterNode,
  ): ValidationRule[] {
    const schema = this.parseSchema(def);
    if (!schema) return [];

    const localRules = this.ruleFactories
      .map((f) => f(schema))
      .filter((x): x is ValidationRule => !!x);

    if (schema.nodeType !== 'ArraySchema' || !schema.items) return localRules;

    const itemsSchema = OAS3.resolveSchema(this.schema.node, schema.items);
    if (!itemsSchema) return [];

    const itemRules = this.ruleFactories
      .map((f) => f(itemsSchema))
      .filter((x): x is ValidationRule => !!x);

    const rules = [...localRules, ...itemRules];

    return rules;
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
      loc: propRange(def, 'maxLength'),
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
      loc: propRange(def, 'minLength'),
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
      loc: propRange(def, 'pattern'),
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
      loc: propRange(def, 'format')!,
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
      loc: propRange(def, 'multipleOf'),
    };
  } else {
    return;
  }
};

const numberGreaterThanFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isNumber(def)) {
    if (
      typeof def.minimum?.value === 'number' &&
      typeof def.exclusiveMinimum?.value !== 'number'
    ) {
      return {
        kind: 'ValidationRule',
        id: def.exclusiveMinimum?.value ? 'NumberGT' : 'NumberGTE',
        value: {
          kind: 'NumberLiteral',
          value: def.minimum.value,
          loc: range(def.minimum),
        },
        loc: propRange(def, 'minimum')!,
      };
    } else if (typeof def.exclusiveMinimum?.value === 'number') {
      return {
        kind: 'ValidationRule',
        id: 'NumberGT',
        value: {
          kind: 'NumberLiteral',
          value: def.exclusiveMinimum.value,
          loc: range(def.exclusiveMinimum),
        },
        loc: propRange(def, 'exclusiveMinimum'),
      };
    }
  }

  return;
};

const numberLessThanFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isNumber(def)) {
    if (
      typeof def.maximum?.value === 'number' &&
      typeof def.exclusiveMaximum?.value !== 'number'
    ) {
      return {
        kind: 'ValidationRule',
        id: def.exclusiveMaximum?.value ? 'NumberLT' : 'NumberLTE',
        value: {
          kind: 'NumberLiteral',
          value: def.maximum.value,
          loc: range(def.maximum),
        },
        loc: propRange(def, 'maximum'),
      };
    } else if (typeof def.exclusiveMaximum?.value === 'number') {
      return {
        kind: 'ValidationRule',
        id: 'NumberLT',
        value: {
          kind: 'NumberLiteral',
          value: def.exclusiveMaximum.value,
          loc: range(def.exclusiveMaximum),
        },
        loc: propRange(def, 'exclusiveMaximum'),
      };
    }
  }

  return;
};

const arrayMinItemsFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isArray(def) && typeof def.minItems?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: 'ArrayMinItems',
      min: {
        kind: 'NonNegativeIntegerLiteral',
        value: def.minItems.value,
        loc: range(def.minItems),
      },
      loc: propRange(def, 'minItems'),
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
        kind: 'NonNegativeIntegerLiteral',
        value: def.maxItems.value,
        loc: range(def.maxItems),
      },
      loc: propRange(def, 'maxItems'),
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
      loc: propRange(def, 'uniqueItems'),
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
      loc: propRange(def, 'minProperties'),
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
      loc: propRange(def, 'maxProperties'),
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
      loc: propRange(def, 'additionalProperties'),
    };
  } else {
    return;
  }
};

const factories = [
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

function toStringLiteral(
  value: string | OAS3.LiteralNode<string>,
): StringLiteral;
function toStringLiteral(
  value: string | OAS3.LiteralNode<string> | undefined,
): StringLiteral | undefined;
function toStringLiteral(
  value: string | OAS3.LiteralNode<string> | undefined,
): StringLiteral | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return { kind: 'StringLiteral', value, loc: undefined };
  } else {
    return { kind: 'StringLiteral', value: value.value, loc: range(value) };
  }
}

function toNumberLiteral(
  value: number | OAS3.LiteralNode<number>,
): NumberLiteral;
function toNumberLiteral(
  value: number | OAS3.LiteralNode<number> | undefined,
): NumberLiteral | undefined;
function toNumberLiteral(
  value: number | OAS3.LiteralNode<number> | undefined,
): NumberLiteral | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    return { kind: 'NumberLiteral', value, loc: undefined };
  } else {
    return { kind: 'NumberLiteral', value: value.value, loc: range(value) };
  }
}

function toBooleanLiteral(
  value: boolean | OAS3.LiteralNode<boolean>,
): BooleanLiteral;
function toBooleanLiteral(
  value: boolean | OAS3.LiteralNode<boolean> | undefined,
): BooleanLiteral | undefined;
function toBooleanLiteral(
  value: boolean | OAS3.LiteralNode<boolean> | undefined,
): BooleanLiteral | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') {
    return { kind: 'BooleanLiteral', value, loc: undefined };
  } else {
    return { kind: 'BooleanLiteral', value: value.value, loc: range(value) };
  }
}

function toNullLiteral(value: null | OAS3.LiteralNode<null>): NullLiteral;
function toNullLiteral(
  value: null | OAS3.LiteralNode<null> | undefined,
): NullLiteral | undefined;
function toNullLiteral(
  value: null | OAS3.LiteralNode<null> | undefined,
): NullLiteral | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    return { kind: 'NullLiteral', value, loc: undefined };
  } else {
    return { kind: 'NullLiteral', value: value.value, loc: range(value) };
  }
}

// type MirrorUndefined<Input, Output> =
//   Exclude<Input, Exclude<Input, undefined>> extends never
//     ? Output
//     : Output | undefined;

// function literal<
//   Primitive extends string | number | boolean | null,
//   Node extends OAS3.LiteralNode<Primitive> | undefined,
// >(node: Node): MirrorUndefined<Node, PrimitiveLiteral> {
//   if (!node) return undefined as any;
//   return {
//     kind: 'PrimitiveLiteral',
//     value: node.value,
//     loc: range(node),
//   };
// }

// function toScalar<T extends string | number | boolean | null>(
//   node: OAS3.LiteralNode<T>,
// ): T extends string
//   ? StringLiteral
//   : T extends number
//     ? NumberLiteral
//     : T extends boolean
//       ? BooleanLiteral
//       : NullLiteral;
// function toScalar<T extends string | number | boolean | null>(
//   node: OAS3.LiteralNode<T> | undefined,
// ): T extends string
//   ? StringLiteral
//   : T extends number
//     ? NumberLiteral
//     : T extends boolean
//       ? BooleanLiteral
//       : NullLiteral | undefined;
// function toScalar<T extends string | number | boolean | null>(
//   node: OAS3.LiteralNode<T> | undefined,
// ): T extends string
//   ? StringLiteral
//   : T extends number
//     ? NumberLiteral
//     : T extends boolean
//       ? BooleanLiteral
//       : NullLiteral | undefined {
//   if (!node) return undefined;

//   const loc = range(node);
//   const { value } = node;

//   switch (typeof value) {
//     case 'string':
//       return { kind: 'StringLiteral', value, loc };
//   }

//   return {
//     value: node.value,
//     loc: encodeRange(node.loc),
//   };
// }
