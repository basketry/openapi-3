import { major } from 'semver';
import { singular } from 'pluralize';
import { camel, kebab, pascal } from 'case';

import { AST, DocumentNode, NodeConstructor, parse } from '@basketry/ast';
import * as OAS3 from './types';

import {
  CustomValue,
  encodeRange,
  Enum,
  EnumValue,
  HttpMethod,
  HttpParameter,
  HttpPath,
  Interface,
  MapKey,
  MapProperties,
  MapValue,
  Meta,
  Method,
  OAuth2Flow,
  OAuth2Scope,
  ObjectValidationRule,
  Parameter,
  PrimitiveValue,
  Property,
  ReturnType,
  Scalar,
  SecurityOption,
  SecurityScheme,
  Service,
  Type,
  TypedValue,
  Union,
  ValidationRule,
  Violation,
} from 'basketry';
import { relative } from 'path';

function range(node: AST.ASTNode | DocumentNode): string {
  return encodeRange(node.loc);
}

export class OAS3Parser {
  constructor(
    schema: string,
    private readonly sourcePath: string,
  ) {
    this.schema = new OAS3.OpenAPINode(parse(schema), {
      root: undefined,
      parentKey: undefined,
    });
  }

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
      basketry: '1.1-rc',
      sourcePath: relative(process.cwd(), this.sourcePath),
      title: {
        value: title ? pascal(title.value) : 'untitled',
        loc: title ? range(title) : undefined,
      },
      majorVersion: {
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

  private parseMeta(node: DocumentNode): Meta | undefined {
    const n = node.node;
    if (!n.isObject()) return undefined;

    const meta: Meta = n.children
      .filter((child) => child.key.value.startsWith('x-'))
      .map((child) => ({
        key: {
          value: child.key.value.substring(2),
          loc: encodeRange(child.key.loc),
        },
        value: {
          value: OAS3.toJson(child.value),
          loc: encodeRange(child.value.loc),
        },
      }));

    return meta.length ? meta : undefined;
  }

  private parseInterfaces(): Interface[] {
    return this.parserInterfaceNames().map((name) => ({
      kind: 'Interface',
      name: { value: singular(name) },
      methods: this.parseMethods(name),
      protocols: {
        http: this.parseHttpProtocol(name),
      },
    }));
  }

  private parseResponseCode(
    verb: string,
    operation: OAS3.OperationNode,
  ): Scalar<number> {
    const primary = this.parsePrimaryResponseKey(operation);

    if (typeof primary?.value === 'number') {
      return primary as Scalar<number>;
    } else if (primary?.value === 'default') {
      const res = operation.responses?.read(primary.value);
      if (res && this.resolve(res, OAS3.ResponseNode)?.content?.keys?.length) {
        switch (verb) {
          case 'delete':
            return { value: 202, loc: primary.loc };
          case 'options':
            return { value: 204, loc: primary.loc };
          case 'post':
            return { value: 201, loc: primary.loc };
          default:
            return { value: 200, loc: primary.loc };
        }
      } else {
        return { value: 204, loc: primary.loc };
      }
    }

    return { value: 200 };
  }

  private parseHttpProtocol(interfaceName: string): HttpPath[] {
    if (!this.schema.paths) return [];

    const paths = this.schema.paths.keys;

    const httpPaths: HttpPath[] = [];

    for (const path of paths) {
      const pathOrRef = this.schema.paths.read(path);
      if (!pathOrRef) continue;

      const pathItem = this.resolve(pathOrRef, OAS3.PathItemNode);
      if (!pathItem) continue;

      const keyLoc = this.schema.paths.keyRange(path);
      const loc = this.schema.paths.propRange(path)!;
      const commonParameters = pathItem.parameters || [];

      const httpPath: HttpPath = {
        kind: 'HttpPath',
        path: { value: path, loc: keyLoc },
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

        const verbLoc = pathItem.keyRange(verb);
        const methodLoc = pathItem.propRange(verb)!;

        const methodName = operation.operationId?.value || 'unknown';

        const httpMethod: HttpMethod = {
          kind: 'HttpMethod',
          name: {
            value: methodName,
            loc: operation.operationId
              ? range(operation.operationId)
              : undefined,
          },
          verb: { value: verb as any, loc: verbLoc },
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
            in: { value: 'body' },
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
              name: { value, loc: nameLoc },
              in: { value: locationValue, loc: range(location) },
              array: this.parseArrayStyle(resolved),
              loc: range(resolved),
            });
          } else {
            httpMethod.parameters.push({
              kind: 'HttpParameter',
              name: { value, loc: nameLoc },
              in: { value: locationValue, loc: range(location) },
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
  ): Scalar<string>[] {
    if (!operation.requestBody) return [];
    const body = this.resolve(operation.requestBody, OAS3.RequestBodyNode);
    return body?.content ? this.parseMediaType(body.content) : [];
  }

  private parseHttpResponseMediaType(
    operation: OAS3.OperationNode,
  ): Scalar<string>[] {
    const { response } = this.parsePrimiaryResponse(operation) ?? {};
    if (!response) return [];

    const res = this.resolve(response, OAS3.ResponseNode);
    return res?.content ? this.parseMediaType(res.content) : [];
  }

  private parseMediaType(
    mediaTypeIndexNode: OAS3.MediaTypeIndexNode,
  ): Scalar<string>[] {
    return mediaTypeIndexNode.keys.map((key) => ({
      value: key,
      loc: mediaTypeIndexNode.keyRange(key),
    }));
  }

  private parseArrayStyle(
    paramNode: OAS3.ParameterNode,
  ): Exclude<HttpParameter['array'], undefined> {
    if (!paramNode.style) return { value: 'csv' };

    let value: Exclude<HttpParameter['array'], undefined>['value'] = 'csv';

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

    return { value, loc: encodeRange(paramNode.style.loc) };
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
  }): Scalar<true> | undefined {
    if (node.deprecated) {
      return { value: true, loc: range(node.deprecated) };
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
        name: { value: operationId, loc: nameLoc },
        security: this.parseSecurity(operation),
        parameters: this.parseParameters(operation, commonParameters),
        description: this.parseDescription(
          operation.summary,
          operation.description,
        ),
        deprecated: this.parseDeprecated(operation),
        returnType: this.parseReturnType(operation),
        loc: pathsNode.read(path)!.propRange(verb)!,
        meta: this.parseMeta(operation),
      });
    }
    return methods;
  }

  private parseDescription(
    summary: OAS3.LiteralNode<string> | undefined,
    description: OAS3.LiteralNode<string> | undefined,
  ): Scalar<string> | Scalar<string>[] | undefined {
    if (summary && description)
      return [
        { value: summary.value, loc: range(summary) },
        { value: description.value, loc: range(description) },
      ];
    if (summary) return { value: summary.value, loc: range(summary) };
    if (description)
      return { value: description.value, loc: range(description) };
    return;
  }

  private parseDescriptionOnly(
    description: OAS3.LiteralNode<string> | undefined,
  ): Scalar<string> | undefined {
    if (description)
      return { value: description.value, loc: range(description) };
    return;
  }

  private parseSecurity(operation: OAS3.OperationNode): SecurityOption[] {
    const { security: defaultSecurity } = this.schema;
    const securitySchemes = this.schema.components?.securitySchemes;
    const { security: operationSecurity } = operation;
    const security = operationSecurity || defaultSecurity || [];

    const options: SecurityOption[] = security.map((requirements) =>
      requirements.keys
        .map((key): SecurityScheme | undefined => {
          const requirement = requirements.read(key);
          const definition = securitySchemes?.read(key);

          if (!requirement || !definition) return;

          const keyLoc = securitySchemes?.keyRange(key);
          const loc = securitySchemes?.propRange(key)!;

          const name = { value: key, loc: keyLoc };

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
    );

    return options;
  }

  private parseHttpSecurity(
    definition: OAS3.HttpSecuritySchemeNode,
    name: Scalar<string>,
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
    name: Scalar<string>,
    loc: string,
  ): SecurityScheme {
    return {
      kind: 'ApiKeyScheme',
      type: { value: 'apiKey', loc: range(definition.type) },
      name,
      description: this.parseDescriptionOnly(definition.description),
      parameter: literal(definition.name),
      in: literal(definition.in),
      // TODO: deprecated: this.parseDeprecated(definition),
      loc,
      meta: this.parseMeta(definition),
    };
  }

  private parseOAuth2Security(
    definition: OAS3.OAuth2SecuritySchemeNode,
    name: Scalar<string>,
    loc: string,
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
    name: Scalar<string>,
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
        authorizationUrl: literal(flow.authorizationUrl),
        refreshUrl: literal(flow.refreshUrl),
        tokenUrl: literal(flow.tokenUrl),
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
        refreshUrl: literal(flow.refreshUrl),
        tokenUrl: literal(flow.tokenUrl),
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
        authorizationUrl: literal(flow.authorizationUrl),
        refreshUrl: literal(flow.refreshUrl),
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
        refreshUrl: literal(flow.refreshUrl),
        tokenUrl: literal(flow.tokenUrl),
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

  private parseBodyParamName(operation: OAS3.OperationNode): Scalar<string> {
    const meta = this.parseMeta(operation);

    const value = meta?.find(
      (m) => kebab(m.key.value) === 'codegen-request-body-name',
    )?.value;

    return typeof value?.value === 'string' ? value : { value: 'body' };
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

    if (x.isPrimitive) {
      return {
        kind: 'Parameter',
        name: { value, loc },
        description: this.parseDescription(undefined, param.description),
        typeName: x.typeName,
        isPrimitive: x.isPrimitive,
        isArray: x.isArray,
        default: x.default,
        deprecated: this.parseDeprecated(param),
        rules: this.parseRules(resolved, param.required?.value),
        loc: range(param),
        meta: this.parseMeta(param),
      };
    } else {
      return {
        kind: 'Parameter',
        name: { value, loc },
        description: this.parseDescription(undefined, param.description),
        typeName: x.typeName,
        isPrimitive: x.isPrimitive,
        isArray: x.isArray,
        deprecated: this.parseDeprecated(param),
        rules: this.parseRules(resolved, param.required?.value),
        loc: range(param),
        meta: this.parseMeta(param),
      };
    }
  }

  private parseRequestBody(
    bodyOrRef: OAS3.RefNode | OAS3.RequestBodyNode | undefined,
    methodName: string,
    paramName: Scalar<string>,
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

    if (x.isPrimitive) {
      return {
        kind: 'Parameter',
        name: paramName,
        description: this.parseDescription(undefined, body.description),
        typeName: x.typeName,
        isPrimitive: x.isPrimitive,
        isArray: x.isArray,
        rules: this.parseRules(schema, body.required?.value),
        loc: range(body),
        meta: this.parseMeta(body),
      };
    } else {
      return {
        kind: 'Parameter',
        name: paramName,
        description: this.parseDescription(undefined, body.description),
        typeName: x.typeName,
        isPrimitive: x.isPrimitive,
        isArray: x.isArray,
        rules: this.parseRules(schema, body.required?.value),
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
  }): Scalar<T> | undefined {
    if (schema.const) {
      return {
        value: schema.const.value,
        loc: range(schema.const),
      };
    } else if (schema.enum && schema.enum.length === 1) {
      return {
        value: schema.enum[0].value,
        loc: range(schema.enum[0]),
      };
    } else {
      return;
    }
  }

  private parseType(
    schemaOrRef: OAS3.SchemaNodeUnion | OAS3.RefNode,
    localName: string,
    parentName: string,
  ):
    | ({
        enumValues?: Scalar<string>[];
        rules: ValidationRule[];
        loc: string;
      } & TypedValue)
    | undefined {
    if (OAS3.isRefNode(schemaOrRef)) {
      const schema = OAS3.resolveSchema(this.schema.node, schemaOrRef);
      if (!schema) return;

      // TODO: do a better job of detecting a definitions ref
      const prefix = '#/components/schemas/';
      if (schemaOrRef.$ref?.value.startsWith(prefix)) {
        if (OAS3.isObject(schema)) {
          return {
            typeName: {
              value: schemaOrRef.$ref.value.substring(prefix.length),
              loc: OAS3.refRange(this.schema.node, schemaOrRef.$ref.value),
            },
            isPrimitive: false,
            isArray: false,
            rules: this.parseRules(schema),
            loc: range(schema),
          };
        } else if (OAS3.isString(schema) && schema.enum) {
          const name = {
            value: schemaOrRef.$ref.value.substring(prefix.length),
            loc: OAS3.refRange(this.schema.node, schemaOrRef.$ref.value),
          };

          this.enums.push({
            kind: 'Enum',
            name: name,
            values: schema.enum.map<EnumValue>((n) => ({
              kind: 'EnumValue',
              content: { value: n.value, loc: encodeRange(n.loc) },
              loc: range(n),
            })),
            deprecated: this.parseDeprecated(schema),
            loc: schema.propRange('enum')!,
          });
          return {
            typeName: name,
            isPrimitive: false,
            isArray: false,
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
          typeName: {
            value: $ref?.value ?? 'untyped',
            loc: $ref ? OAS3.refRange(this.schema.node, $ref.value) : undefined,
          },
          isPrimitive: false,
          isArray: false,
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
              isArray: false,
              default: toScalar(schemaOrRef.default),
              constant: toScalar(schemaOrRef.enum[0]),
              rules,
              loc: range(schemaOrRef),
            };
          } else {
            const enumName = camel(`${parentName}_${singular(localName)}`);
            this.enums.push({
              kind: 'Enum',
              name: { value: enumName },
              values: schemaOrRef.enum.map<EnumValue>((n) => ({
                kind: 'EnumValue',
                content: { value: n.value, loc: encodeRange(n.loc) },
                // TODO: deprecated
                loc: range(n),
              })),
              deprecated: this.parseDeprecated(schemaOrRef),
              loc: schemaOrRef.propRange('enum')!,
            });
            return {
              typeName: { value: enumName },
              isPrimitive: false,
              isArray: false,
              rules,
              loc: range(schemaOrRef),
            };
          }
        } else {
          const stringName = this.parseStringName(schemaOrRef);
          if (!stringName) return;
          return {
            ...stringName,
            isArray: false,
            default: toScalar(schemaOrRef.default),
            constant: toScalar(schemaOrRef.const),
            rules,
            loc: range(schemaOrRef),
          };
        }
      // case 'NumberParameter':
      case 'NumberSchema':
        return {
          ...this.parseNumberName(schemaOrRef),
          isArray: false,
          default: toScalar(schemaOrRef.default),
          constant: this.parseConst(schemaOrRef),
          rules,
          loc: range(schemaOrRef),
        };
      // case 'BooleanParameter':
      case 'BooleanSchema':
        // case 'NullSchema':
        return {
          typeName: {
            value: schemaOrRef.type.value,
            loc: range(schemaOrRef.type),
          },
          isPrimitive: true,
          isArray: false,
          default: toScalar(schemaOrRef.default),
          constant: this.parseConst(schemaOrRef),
          rules,
          loc: range(schemaOrRef),
        };
      // case 'ArrayParameter':
      case 'ArraySchema':
        if (!schemaOrRef.items) return;

        const items = this.parseType(schemaOrRef.items, localName, parentName);
        if (!items) return;

        if (items.isPrimitive) {
          return {
            typeName: items.typeName,
            isPrimitive: items.isPrimitive,
            isArray: true,
            rules,
            loc: range(schemaOrRef),
          };
        } else {
          return {
            typeName: items.typeName,
            isPrimitive: items.isPrimitive,
            isArray: true,
            rules,
            loc: range(schemaOrRef),
          };
        }

      case 'ObjectSchema':
        const typeName = { value: camel(`${parentName}_${localName}`) };
        if (schemaOrRef.oneOf) {
          this.parseAsUnion(
            typeName.value,
            schemaOrRef,
            schemaOrRef.oneOf,
            undefined,
          );
        } else if (schemaOrRef.anyOf) {
          this.parseAsUnion(
            typeName.value,
            schemaOrRef,
            schemaOrRef.anyOf,
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
            mapProperties: this.parseMapProperties(schemaOrRef, typeName.value),
            description: schemaOrRef.description
              ? {
                  value: schemaOrRef.description.value,
                  loc: range(schemaOrRef.description),
                }
              : undefined,
            deprecated: this.parseDeprecated(schemaOrRef),
            rules: this.parseObjectRules(schemaOrRef),
            loc: range(schemaOrRef),
          });
        }

        return {
          typeName,
          isPrimitive: false,
          isArray: false,
          rules,
          loc: range(schemaOrRef),
        };
      case 'NullSchema': {
        return {
          typeName: {
            value: schemaOrRef.type.value,
            loc: range(schemaOrRef.type),
          },
          isPrimitive: true,
          isArray: false,
          default: toScalar(schemaOrRef.default),
          constant:
            schemaOrRef.const === null
              ? toScalar(schemaOrRef.const)
              : undefined,
          rules,
          loc: range(schemaOrRef),
        };
        break;
      }
      default:
        return {
          typeName: { value: 'untyped' },
          isPrimitive: true,
          isArray: false,
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
        typeName: {
          value: 'date',
          loc: range(def),
        },
        isPrimitive: true,
      };
    } else if (format?.value === 'date-time') {
      return {
        typeName: {
          value: 'date-time',
          loc: range(def),
        },
        isPrimitive: true,
      };
    } else if (format?.value === 'binary') {
      return {
        typeName: {
          value: 'binary',
          loc: range(def),
        },
        isPrimitive: true,
      };
    } else {
      return {
        typeName: {
          value: type.value,
          loc: range(type),
        },
        isPrimitive: true,
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
          typeName: {
            value: 'integer',
            loc: range(def),
          },
          isPrimitive: true,
        };
      } else if (format?.value === 'int64') {
        return {
          typeName: {
            value: 'long',
            loc: range(def),
          },
          isPrimitive: true,
        };
      }
    } else if (type.value === 'number') {
      if (format?.value === 'float') {
        return {
          typeName: {
            value: 'float',
            loc: range(def),
          },
          isPrimitive: true,
        };
      } else if (format?.value === 'double') {
        return {
          typeName: {
            value: 'double',
            loc: range(def),
          },
          isPrimitive: true,
        };
      }
    }

    return {
      typeName: {
        value: type.value,
        loc: range(type),
      },
      isPrimitive: true,
    };
  }

  private parsePrimiaryResponse(operation: OAS3.OperationNode): {
    code: Scalar<string> | undefined;
    response: OAS3.RefNode | OAS3.ResponseNode | undefined;
  } {
    const responses = operation.responses;
    if (!responses) return { code: undefined, response: undefined };

    const defaultResponse = operation.responses.read('default');
    if (defaultResponse) {
      return {
        code: {
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
        value: code,
        loc: operation.responses.keyRange(code),
      },
      response: operation.responses.read(code),
    };
  }

  private parsePrimaryResponseKey(
    operation: OAS3.OperationNode,
  ): Scalar<number> | Scalar<'default'> | undefined {
    const { code } = this.parsePrimiaryResponse(operation);
    if (!code) return;

    const n = Number(code.value);

    if (!Number.isNaN(n)) return { value: n, loc: code.loc };
    if (code.value === 'default') return { value: code.value, loc: code.loc };
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

  private parseReturnType(
    operation: OAS3.OperationNode,
  ): ReturnType | undefined {
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
      kind: 'ReturnType',
      ...type,
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
      >((name) => [name, this.getSchema(name)!, schemas.keyRange(name), schemas.propRange(name)!])
      .filter(([, node]) => node.nodeType === 'ObjectSchema');

    const types: Type[] = [];

    for (const [name, node, nameLoc, defLoc] of definitions) {
      if (node.nodeType !== 'ObjectSchema') continue;

      if (node.oneOf) {
        this.parseAsUnion(name, node, node.oneOf, nameLoc);
      } else if (node.anyOf) {
        this.parseAsUnion(name, node, node.anyOf, nameLoc);
      } else {
        types.push(this.parseAsType(name, node, nameLoc, defLoc));
      }
    }

    return types;
  }

  private parseAsUnion(
    name: string,
    node: OAS3.SchemaNodeUnion,
    oneOf: (OAS3.RefNode | OAS3.SchemaNodeUnion)[],
    nameLoc: string | undefined,
  ): void {
    const members: TypedValue[] = oneOf
      .map((subDef, i) => this.parseType(subDef, `${i + 1}`, name))
      .filter(
        (
          x,
        ): x is {
          enumValues?: Scalar<string>[];
          rules: ValidationRule[];
          loc: string;
        } & TypedValue => !!x,
      );

    if (node.nodeType === 'ObjectSchema' && node.discriminator) {
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

      const customTypes: CustomValue[] = [];
      for (const member of members) {
        if (member.isPrimitive) {
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

      const union: Union = {
        kind: 'Union',
        name: { value: name, loc: nameLoc },
        discriminator: toScalar(propertyName),
        members: customTypes,
        loc: range(node),
        meta: this.parseMeta(node),
      };

      this.unions.push(union);
    } else {
      this.unions.push({
        kind: 'Union',
        name: { value: name, loc: nameLoc },
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
      name: { value: name, loc: nameLoc },
      description: node.description
        ? {
            value: node.description.value,
            loc: range(node.description),
          }
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

        if (x.isPrimitive) {
          props.push({
            kind: 'Property',
            name: { value: name, loc: properties?.keyRange(name) },
            description: this.parseDescriptionOnly(resolvedProp.description),
            typeName: x.typeName,
            isPrimitive: x.isPrimitive,
            isArray: x.isArray,
            default: x.default,
            deprecated: this.parseDeprecated(resolvedProp),
            constant: this.parseConstant(prop, x),
            rules: this.parseRules(resolvedProp, requiredSet.has(name)),
            loc: range(resolvedProp),
            meta: this.parseMeta(resolvedProp),
          });
        } else {
          props.push({
            kind: 'Property',
            name: { value: name, loc: properties?.keyRange(name) },
            description: this.parseDescriptionOnly(resolvedProp.description),
            typeName: x.typeName,
            isPrimitive: x.isPrimitive,
            isArray: x.isArray,
            deprecated: this.parseDeprecated(resolvedProp),
            rules: this.parseRules(resolvedProp, requiredSet.has(name)),
            loc: range(resolvedProp),
            meta: this.parseMeta(resolvedProp),
          });
        }
      }
      return props;
    }
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

    const requiredKeys: Scalar<string>[] = requiredMapKeys.map((r) =>
      toScalar<string>(r),
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
          isPrimitive: true,
          typeName: { value: 'string' },
          isArray: false,
          rules: [],
        },
        requiredKeys,
        value: {
          kind: 'MapValue',
          isPrimitive: true,
          typeName: { value: 'untyped' },
          isArray: false,
          rules: [],
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
        isPrimitive: true,
        typeName: { value: 'string' },
        isArray: false,
        rules: [],
      };
    }

    if (typeOrPrimitive.isPrimitive) {
      return {
        kind: 'MapKey',
        isPrimitive: true,
        typeName: typeOrPrimitive.typeName,
        isArray: typeOrPrimitive.isArray,
        rules: typeOrPrimitive.rules,
        default: typeOrPrimitive.default,
        constant: typeOrPrimitive.constant,
        loc: schemaOrRef ? range(schemaOrRef) : undefined,
        meta: schemaOrRef ? this.parseMeta(schemaOrRef) : undefined,
      };
    } else {
      return {
        kind: 'MapKey',
        isPrimitive: false,
        typeName: typeOrPrimitive.typeName,
        isArray: typeOrPrimitive.isArray,
        rules: typeOrPrimitive.rules,
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
        isPrimitive: true,
        typeName: { value: 'untyped' },
        isArray: false,
        rules: [],
      };
    }

    if (typeOrPrimitive.isPrimitive) {
      return {
        kind: 'MapValue',
        isPrimitive: true,
        typeName: typeOrPrimitive.typeName,
        isArray: typeOrPrimitive.isArray,
        rules: typeOrPrimitive.rules,
        default: typeOrPrimitive.default,
        constant: typeOrPrimitive.constant,
        loc: range(schemaOrRef),
        meta: this.parseMeta(schemaOrRef),
      };
    } else {
      return {
        kind: 'MapValue',
        isPrimitive: false,
        typeName: typeOrPrimitive.typeName,
        isArray: typeOrPrimitive.isArray,
        rules: typeOrPrimitive.rules,
        loc: range(schemaOrRef),
        meta: this.parseMeta(schemaOrRef),
      };
    }
  }

  private parseConstant(
    unresolvedProp: OAS3.SchemaNodeUnion | OAS3.RefNode,
    parsedType: {
      enumValues?: Scalar<string>[] | undefined;
      rules: ValidationRule[];
      loc: string;
    } & TypedValue,
  ): Scalar<string | number | boolean> | undefined {
    if (parsedType.isPrimitive) {
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
    required?: boolean,
  ): ValidationRule[] {
    const schema = this.parseSchema(def);
    if (!schema) {
      return required
        ? [
            {
              kind: 'ValidationRule',
              id: 'required',
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
              id: 'required',
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
            id: 'required',
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
      id: 'string-max-length',
      length: { value: def.maxLength.value, loc: range(def.maxLength) },
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
      id: 'string-min-length',
      length: { value: def.minLength.value, loc: range(def.minLength) },
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
      id: 'string-pattern',
      pattern: { value: def.pattern.value, loc: range(def.pattern) },
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
      id: 'string-format',
      format: { value: def.format.value, loc: range(def.format) },
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
      id: 'string-enum',
      values: def.enum.map((n) => ({ value: n.value, loc: range(n) })),
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
      id: 'number-multiple-of',
      value: { value: def.multipleOf.value, loc: range(def.multipleOf) },
      loc: def.propRange('multipleOf')!,
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
        id: def.exclusiveMinimum?.value ? 'number-gt' : 'number-gte',
        value: { value: def.minimum.value, loc: range(def.minimum) },
        loc: def.propRange('minimum')!,
      };
    } else if (typeof def.exclusiveMinimum?.value === 'number') {
      return {
        kind: 'ValidationRule',
        id: 'number-gt',
        value: {
          value: def.exclusiveMinimum.value,
          loc: range(def.exclusiveMinimum),
        },
        loc: def.propRange('exclusiveMinimum')!,
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
        id: def.exclusiveMaximum?.value ? 'number-lt' : 'number-lte',
        value: { value: def.maximum.value, loc: range(def.maximum) },
        loc: def.propRange('maximum')!,
      };
    } else if (typeof def.exclusiveMaximum?.value === 'number') {
      return {
        kind: 'ValidationRule',
        id: 'number-lt',
        value: {
          value: def.exclusiveMaximum.value,
          loc: range(def.exclusiveMaximum),
        },
        loc: def.propRange('exclusiveMaximum')!,
      };
    }
  }

  return;
};

const arrayMinItemsFactory: ValidationRuleFactory = (def) => {
  if (OAS3.isArray(def) && typeof def.minItems?.value === 'number') {
    return {
      kind: 'ValidationRule',
      id: 'array-min-items',
      min: { value: def.minItems.value, loc: range(def.minItems) },
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
      id: 'array-max-items',
      max: { value: def.maxItems.value, loc: range(def.maxItems) },
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
      id: 'array-unique-items',
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
      id: 'object-min-properties',
      min: {
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
      id: 'object-max-properties',
      max: {
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
      id: 'object-additional-properties',
      forbidden: true,
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

type MirrorUndefined<Input, Output> =
  Exclude<Input, Exclude<Input, undefined>> extends never
    ? Output
    : Output | undefined;

function literal<
  Primitive extends string | number | boolean | null,
  Node extends OAS3.LiteralNode<Primitive> | undefined,
>(node: Node): MirrorUndefined<Node, Scalar<Primitive>> {
  if (!node) return undefined as any;
  return {
    value: node.value,
    loc: range(node),
  };
}

function toScalar<T extends string | number | boolean | null>(
  node: OAS3.LiteralNode<T>,
): Scalar<T>;
function toScalar<T extends string | number | boolean | null>(
  node: OAS3.LiteralNode<T> | undefined,
): Scalar<T> | undefined;
function toScalar<T extends string | number | boolean | null>(
  node: OAS3.LiteralNode<T> | undefined,
): Scalar<T> | undefined {
  if (!node) return undefined;

  return {
    value: node.value,
    loc: encodeRange(node.loc),
  };
}
