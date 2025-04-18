import { readFileSync } from 'fs';
import { join } from 'path';
import * as https from 'https';

import { ReturnType, Service, validate } from 'basketry';
import parser from '.';

function noSource(service: Service): Omit<Service, 'sourcePath'> {
  const { sourcePath, ...rest } = service;
  return rest;
}
import { dump as yamlStringify } from 'yaml-ast-parser';

describe('parser', () => {
  it('recreates a valid exhaustive snapshot', () => {
    // ARRANGE
    const snapshot = JSON.parse(
      readFileSync(join('src', 'snapshot', 'snapshot.json')).toString(),
    );

    const sourcePath: string = join('src', 'snapshot', 'example.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    // ACT
    const result = JSON.parse(
      JSON.stringify(parser(sourceContent, sourcePath).service, removeLoc),
    );

    // ASSERT
    expect(noSource(result)).toStrictEqual(noSource(snapshot));
  });

  it('parses identical services from JSON and YAML content', () => {
    // ARRANGE
    const jsonPath: string = join('src', 'snapshot', 'example.oas3.json');
    const jsonContent = readFileSync(jsonPath).toString();
    const yamlContent = yamlStringify(JSON.parse(jsonContent), {});

    const replacer = (key: string, value: any) => {
      return key === 'loc' ? 'REDACTED' : value;
    };

    // ACT
    const jsonResult = JSON.parse(
      JSON.stringify(parser(jsonContent, jsonPath).service, replacer),
    );

    const yamlResult = JSON.parse(
      JSON.stringify(parser(yamlContent, jsonPath).service, replacer),
    );

    // ASSERT
    expect(jsonResult).toStrictEqual(yamlResult);
  });

  it('recreates a valid petstore snapshot', () => {
    // ARRANGE
    const snapshot = JSON.parse(
      readFileSync(join('src', 'snapshot', 'petstore.json')).toString(),
    );

    const sourcePath = join('src', 'snapshot', 'petstore.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    // ACT
    const result = JSON.parse(
      JSON.stringify(parser(sourceContent, sourcePath).service, removeLoc),
    );

    // ASSERT
    expect(noSource(result)).toStrictEqual(noSource(snapshot));
  });

  it('creates a type for every custom typeName', () => {
    // ARRANGE

    const sourcePath = join('src', 'snapshot', 'example.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    // ACT
    const result = parser(sourceContent, sourcePath).service;

    // ASSERT
    const fromMethodParameters = new Set(
      result.interfaces
        .map((i) => i.methods)
        .reduce((a, b) => a.concat(b), [])
        .map((i) => i.parameters)
        .reduce((a, b) => a.concat(b), [])
        .filter((p) => !p.isPrimitive)
        .map((p) => p.typeName.value),
    );

    const fromMethodReturnTypes = new Set(
      result.interfaces
        .map((i) => i.methods)
        .reduce((a, b) => a.concat(b), [])
        .map((i) => i.returnType)
        .filter((t): t is ReturnType => !!t)
        .filter((p) => !p.isPrimitive)
        .map((p) => p.typeName.value),
    );

    const fromTypes = new Set(
      result.types
        .map((t) => t.properties)
        .reduce((a, b) => a.concat(b), [])
        .filter((p) => !p.isPrimitive)
        .map((p) => p.typeName.value),
    );

    const typeNames = new Set([
      ...result.types.map((t) => t.name.value),
      ...result.unions.map((t) => t.name.value),
      ...result.enums.map((e) => e.name.value),
    ]);

    for (const localTypeName of [
      ...fromMethodParameters,
      ...fromMethodReturnTypes,
      ...fromTypes,
    ]) {
      expect(typeNames.has(localTypeName)).toEqual(true);
    }
  });

  it('creates types with unique names', () => {
    // ARRANGE

    const sourcePath = join('src', 'snapshot', 'example.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    // ACT
    const result = parser(sourceContent, sourcePath).service;

    // ASSERT
    const typeNames = result.types.map((t) => t.name);

    expect(typeNames.length).toEqual(new Set(typeNames).size);
  });

  it('creates a valid service', () => {
    // ARRANGE
    const sourcePath = join('src', 'snapshot', 'example.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    const service = parser(sourceContent, sourcePath).service;

    // ACT
    const errors = validate(service).errors;

    // ASSERT
    expect(errors).toEqual([]);
  });

  it('creates a valid service from the example Pet Store schema', async () => {
    // ARRANGE

    const sourcePath =
      'https://raw.githubusercontent.com/swagger-api/swagger-petstore/refs/heads/master/src/main/resources/openapi.yaml';
    const sourceContent = await getText(sourcePath);

    const service = parser(sourceContent, sourcePath).service;

    // ACT
    const errors = validate(service).errors;

    // ASSERT
    expect(errors).toEqual([]);
  });

  describe('unions', () => {
    it('correctly parses a oneOf without $refs in a body parameter', () => {
      const oas = {
        openapi: '3.0.1',
        info: { title: 'Test', version: '1.0.0', description: 'test' },
        paths: {
          '/test': {
            post: {
              operationId: 'test',
              parameters: [
                {
                  name: 'testBody',
                  in: 'body',
                  required: true,
                  schema: {
                    oneOf: [
                      {
                        type: 'object',
                        properties: {
                          typeA: {
                            type: 'string',
                            example: 'exampleValueA',
                          },
                        },
                        required: ['typeA'],
                      },
                      {
                        type: 'object',
                        properties: {
                          typeB: { type: 'number', example: 42 },
                        },
                        required: ['typeB'],
                      },
                    ],
                  },
                },
              ],
              responses: { '200': { description: 'success' } },
            },
          },
        },
      };

      // ACT
      const { service } = parser(JSON.stringify(oas), 'source/path.ext');

      // ASSERT
      expect(service).toEqual(
        partial<Service>({
          types: [
            { kind: 'Type', name: { value: 'testTestBody1' } },
            { kind: 'Type', name: { value: 'testTestBody2' } },
          ],
          unions: [
            {
              kind: 'Union',
              name: { value: 'testTestBody' },
              members: [
                { typeName: { value: 'testTestBody1' } },
                { typeName: { value: 'testTestBody1' } },
              ],
            },
          ],
        }),
      );
    });

    it('correctly parses a oneOf with $refs in a body parameter', () => {
      const oas = {
        openapi: '3.0.1',
        info: { title: 'Test', version: '1.0.0', description: 'test' },
        paths: {
          '/test': {
            post: {
              operationId: 'test',
              parameters: [
                {
                  name: 'testBody',
                  in: 'body',
                  required: true,
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/typeA' },
                      { $ref: '#/components/schemas/typeB' },
                    ],
                  },
                },
              ],
              responses: { '200': { description: 'success' } },
            },
          },
        },
        components: {
          schemas: {
            typeA: {
              type: 'object',
              properties: {
                typeA: {
                  type: 'string',
                  example: 'exampleValueA',
                },
              },
              required: ['typeA'],
            },
            typeB: {
              type: 'object',
              properties: {
                typeB: { type: 'number', example: 42 },
              },
              required: ['typeB'],
            },
          },
        },
      };

      // ACT
      const { service } = parser(JSON.stringify(oas), 'source/path.ext');

      // ASSERT
      expect(service).toEqual(
        partial<Service>({
          types: [
            { kind: 'Type', name: { value: 'typeA' } },
            { kind: 'Type', name: { value: 'typeB' } },
          ],
          unions: [
            {
              kind: 'Union',
              name: { value: 'testTestBody' },
              members: [
                { typeName: { value: 'typeA' } },
                { typeName: { value: 'typeB' } },
              ],
            },
          ],
        }),
      );
    });
  });
});

function getText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data: string = '';

        res.on('data', (d) => {
          data += d.toString();
        });

        res.on('end', () => {
          resolve(data);
        });
      })
      .on('error', (e) => {
        reject(e);
      });
  });
}

function removeLoc(key: string, value: any): any {
  return key === 'loc' ? undefined : value;
}

type DeepPartial<T> = T extends Function
  ? T
  : T extends Array<infer U>
  ? Array<DeepPartial<U>>
  : T extends ReadonlyArray<infer U>
  ? ReadonlyArray<DeepPartial<U>>
  : T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

function partial<T = any>(input: DeepPartial<T>): any {
  if (Array.isArray(input)) {
    return expect.arrayContaining(input.map(partial));
  }

  if (input && typeof input === 'object' && !(input instanceof Date)) {
    const entries = Object.entries(input).map(([key, value]) => [
      key,
      partial(value),
    ]);
    return expect.objectContaining(Object.fromEntries(entries));
  }

  return input;
}
