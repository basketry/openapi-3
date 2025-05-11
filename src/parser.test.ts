import { readFileSync } from 'fs';
import { join } from 'path';
import * as https from 'https';

import {
  Property,
  ReturnType,
  Scalar,
  Service,
  validate,
  ValidationRule,
  Violation,
} from 'basketry';
import parser from '.';

function noSource(service: Service): Omit<Service, 'sourcePath'> {
  const { sourcePath, ...rest } = service;
  return rest;
}
import { dump as yamlStringify } from 'yaml-ast-parser';

describe('parser', () => {
  describe('snapshots', () => {
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
  });

  describe('types', () => {
    describe('sources', () => {
      describe('schema', () => {
        it('creates a type from a schema component', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: { type: 'object' },
              },
            },
          };

          // ACT
          const { service } = parser(JSON.stringify(oas), 'source/path.ext');

          // ASSERT
          expect(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
        it('creates primitive properties', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  properties: { foo: { type: 'string' } },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'string' },
                      isPrimitive: true,
                    }),
                  ]),
                },
              ],
            }),
          );
        });
        it('creates object properties', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  properties: { foo: { type: 'object' } },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'typeAFoo' },
                      isPrimitive: false,
                    }),
                  ]),
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAFoo' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
      });
      describe('nested', () => {
        it('creates a type from a nested schema component', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  properties: {
                    foo: {
                      type: 'object',
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'typeAFoo' },
                      isPrimitive: false,
                    }),
                  ]),
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAFoo' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
        it('creates primitive properties', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  properties: {
                    foo: {
                      type: 'object',
                      properties: { bar: { type: 'string' } },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'typeAFoo' },
                      isPrimitive: false,
                    }),
                  ]),
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAFoo' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'bar' },
                      typeName: { value: 'string' },
                      isPrimitive: true,
                    }),
                  ]),
                },
              ],
            }),
          );
        });
        it('creates object properties', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  properties: {
                    foo: {
                      type: 'object',
                      properties: { bar: { type: 'object' } },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'typeAFoo' },
                      isPrimitive: false,
                    }),
                  ]),
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAFoo' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'bar' },
                      typeName: { value: 'typeAFooBar' },
                      isPrimitive: false,
                    }),
                  ]),
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAFooBar' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
      });
      describe('request body', () => {
        it('creates a type from a operation body', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            paths: {
              '/thing': {
                post: {
                  operationId: 'createThing',
                  requestBody: {
                    content: {
                      '*/*': {
                        schema: { type: 'object' },
                      },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'createThingBody' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
        it('creates a type from a named operation body', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            paths: {
              '/thing': {
                post: {
                  operationId: 'createThing',
                  'x-codegen-request-body-name': 'payload',
                  requestBody: {
                    content: {
                      '*/*': {
                        schema: { type: 'object' },
                      },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'createThingPayload' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
        it('creates primitive properties', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            paths: {
              '/thing': {
                post: {
                  operationId: 'createThing',
                  requestBody: {
                    content: {
                      '*/*': {
                        schema: {
                          type: 'object',
                          properties: { foo: { type: 'string' } },
                        },
                      },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'createThingBody' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'string' },
                      isPrimitive: true,
                    }),
                  ]),
                },
              ],
            }),
          );
        });
        it('creates object properties', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            paths: {
              '/thing': {
                post: {
                  operationId: 'createThing',
                  requestBody: {
                    content: {
                      '*/*': {
                        schema: {
                          type: 'object',
                          properties: { foo: { type: 'object' } },
                        },
                      },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'createThingBody' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'createThingBodyFoo' },
                      isPrimitive: false,
                    }),
                  ]),
                },
                {
                  kind: 'Type',
                  name: { value: 'createThingBodyFoo' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
      });
      describe('response', () => {
        it('creates a type from a referenced response component', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            paths: {
              '/thing': {
                get: {
                  operationId: 'getThing',
                  responses: {
                    '200': { $ref: '#/components/responses/thing' },
                  },
                },
              },
            },
            components: {
              responses: {
                thing: {
                  content: {
                    '*/*': {
                      schema: { type: 'object' },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'thingResponse' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
        it('creates primitive properties', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            paths: {
              '/thing': {
                get: {
                  operationId: 'getThing',
                  responses: {
                    '200': { $ref: '#/components/responses/thing' },
                  },
                },
              },
            },
            components: {
              responses: {
                thing: {
                  content: {
                    '*/*': {
                      schema: {
                        type: 'object',
                        properties: { foo: { type: 'string' } },
                      },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'thingResponse' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'string' },
                      isPrimitive: true,
                    }),
                  ]),
                },
              ],
            }),
          );
        });
        it('creates object properties', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            paths: {
              '/thing': {
                get: {
                  operationId: 'getThing',
                  responses: {
                    '200': { $ref: '#/components/responses/thing' },
                  },
                },
              },
            },
            components: {
              responses: {
                thing: {
                  content: {
                    '*/*': {
                      schema: {
                        type: 'object',
                        properties: { foo: { type: 'object' } },
                      },
                    },
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'thingResponse' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'thingResponseFoo' },
                      isPrimitive: false,
                    }),
                  ]),
                },
                {
                  kind: 'Type',
                  name: { value: 'thingResponseFoo' },
                  properties: exact([]),
                },
              ],
            }),
          );
        });
      });
    });
    describe('properties', () => {
      // TODO: add tests for parsing properties (eg. arrays, defaults, etc.)
    });
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

  describe('additionalProperties', () => {
    describe('boolean', () => {
      it('creates a rule when false', () => {
        // ARRANGE
        const oas = {
          openapi: '3.0.1',
          info: { title: 'Test', version: '1.0.0', description: 'test' },
          components: {
            schemas: {
              typeA: {
                type: 'object',
                additionalProperties: false,
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
              {
                kind: 'Type',
                name: { value: 'typeA' },
                rules: [
                  {
                    id: 'object-additional-properties',
                    forbidden: true,
                  },
                ],
              },
            ],
          }),
        );
      });

      it('creates map properties when true', () => {
        // ARRANGE
        const oas = {
          openapi: '3.0.1',
          info: { title: 'Test', version: '1.0.0', description: 'test' },
          components: {
            schemas: {
              typeA: {
                type: 'object',
                additionalProperties: true,
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
              {
                kind: 'Type',
                name: { value: 'typeA' },
                mapProperties: {
                  kind: 'MapProperties',
                  key: { typeName: { value: 'string' } },
                  value: { typeName: { value: 'untyped' } },
                },
              },
            ],
          }),
        );
      });
    });

    describe('object', () => {
      describe('primitive schema', () => {
        it('handles a direct primitive schema', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'string' } },
                  },
                },
              ],
            }),
          );
        });

        it('handles a referenced primitive schema', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { $ref: '#/components/schemas/typeB' },
                },
                typeB: { type: 'string' },
              },
            },
          };

          // ACT
          const { service } = parser(JSON.stringify(oas), 'source/path.ext');

          // ASSERT
          expect(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'string' } },
                  },
                },
              ],
            }),
          );
        });

        it('handles a direct enum', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { type: 'string', enum: ['a', 'b'] },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'typeAMapValue' } },
                  },
                },
              ],
              enums: [
                {
                  kind: 'Enum',
                  name: { value: 'typeAMapValue' },
                  values: [
                    { kind: 'EnumValue', content: { value: 'a' } },
                    { kind: 'EnumValue', content: { value: 'b' } },
                  ],
                },
              ],
            }),
          );
        });

        it('handles a referenced enum', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { $ref: '#/components/schemas/enumA' },
                },
                enumA: {
                  type: 'string',
                  enum: ['a', 'b'],
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'enumA' } },
                  },
                },
              ],
              enums: [
                {
                  kind: 'Enum',
                  name: { value: 'enumA' },
                  values: [
                    { kind: 'EnumValue', content: { value: 'a' } },
                    { kind: 'EnumValue', content: { value: 'b' } },
                  ],
                },
              ],
            }),
          );
        });
      });

      describe('object schema', () => {
        it('handles a direct object schema', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { type: 'object' },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'typeAMapValues' } },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAMapValues' },
                },
              ],
            }),
          );
        });

        it('handles a referenced object schema', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { $ref: '#/components/schemas/typeB' },
                },
                typeB: { type: 'object' },
              },
            },
          };

          // ACT
          const { service } = parser(JSON.stringify(oas), 'source/path.ext');

          // ASSERT
          expect(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'typeB' } },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeB' },
                },
              ],
            }),
          );
        });
      });

      describe('oneOf union', () => {
        it.skip('handles a direct oneOf primitive union', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: {
                    oneOf: [{ type: 'string' }, { type: 'number' }],
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'typeAMapValues' } },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAMapValues' },
                },
              ],
            }),
          );
        });

        it('handles a direct oneOf object union', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: {
                    oneOf: [{ type: 'object' }, { type: 'object' }],
                  },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'typeAMapValues' } },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAMapValues1' },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAMapValues2' },
                },
              ],
              unions: [
                {
                  kind: 'Union',
                  name: { value: 'typeAMapValues' },
                  members: [
                    { typeName: { value: 'typeAMapValues1' } },
                    { typeName: { value: 'typeAMapValues2' } },
                  ],
                },
              ],
            }),
          );
        });

        it.skip('handles a referenced oneOf primitive union', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { $ref: '#/components/schemas/unionA' },
                },
                typeB: { type: 'object' },
              },
            },
          };

          // ACT
          const { service } = parser(JSON.stringify(oas), 'source/path.ext');

          // ASSERT
          expect(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'typeB' } },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeB' },
                },
              ],
            }),
          );
        });

        it('handles a referenced oneOf object union', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { $ref: '#/components/schemas/unionA' },
                },
                typeB: { type: 'object' },
                typeC: { type: 'object' },
                unionA: {
                  oneOf: [
                    { $ref: '#/components/schemas/typeB' },
                    { $ref: '#/components/schemas/typeC' },
                  ],
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'unionA' } },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeB' },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeC' },
                },
              ],
              unions: [
                {
                  kind: 'Union',
                  name: { value: 'unionA' },
                  members: [
                    { typeName: { value: 'typeB' } },
                    { typeName: { value: 'typeC' } },
                  ],
                },
              ],
            }),
          );
        });
      });

      describe('propertyNames', () => {
        it('defaults to string', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: { typeName: { value: 'string' } },
                    value: { typeName: { value: 'string' } },
                  },
                },
              ],
            }),
          );
        });
        it('handles a direct propertyNames schema', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  propertyNames: { type: 'string', maxLength: 10 },
                  additionalProperties: { type: 'string' },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      typeName: { value: 'string' },
                      rules: [
                        { id: 'string-max-length', length: { value: 10 } },
                      ],
                    },
                    value: { typeName: { value: 'string' } },
                  },
                },
              ],
            }),
          );
        });
        it('handles a referenced propertyNames schema', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  propertyNames: { $ref: '#/components/schemas/keySchema' },
                  additionalProperties: { type: 'string' },
                },
                keySchema: { type: 'string', maxLength: 10 },
              },
            },
          };

          // ACT
          const { service } = parser(JSON.stringify(oas), 'source/path.ext');

          // ASSERT
          expect(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      typeName: { value: 'string' },
                      rules: [
                        { id: 'string-max-length', length: { value: 10 } },
                      ],
                    },
                    value: { typeName: { value: 'string' } },
                  },
                },
              ],
            }),
          );
        });
        it('handles a direct propertyNames enum', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  propertyNames: { type: 'string', enum: ['a', 'b'] },
                  additionalProperties: { type: 'string' },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      typeName: { value: 'typeAMapKey' },
                    },
                    value: { typeName: { value: 'string' } },
                  },
                },
              ],
              enums: [
                {
                  kind: 'Enum',
                  name: { value: 'typeAMapKey' },
                  values: [
                    { kind: 'EnumValue', content: { value: 'a' } },
                    { kind: 'EnumValue', content: { value: 'b' } },
                  ],
                },
              ],
            }),
          );
        });
        it('handles a referenced propertyNames enum', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  propertyNames: { $ref: '#/components/schemas/keySchema' },
                  additionalProperties: { type: 'string' },
                },
                keySchema: { type: 'string', enum: ['a', 'b'] },
              },
            },
          };

          // ACT
          const { service } = parser(JSON.stringify(oas), 'source/path.ext');

          // ASSERT
          expect(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      typeName: { value: 'keySchema' },
                    },
                    value: { typeName: { value: 'string' } },
                  },
                },
              ],
              enums: [
                {
                  kind: 'Enum',
                  name: { value: 'keySchema' },
                  values: [
                    { kind: 'EnumValue', content: { value: 'a' } },
                    { kind: 'EnumValue', content: { value: 'b' } },
                  ],
                },
              ],
            }),
          );
        });
        it('handles a direct propertyNames union', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  propertyNames: {
                    oneOf: [
                      {
                        type: 'object',
                        properties: { foo: { type: 'string' } },
                      },
                      {
                        type: 'object',
                        properties: { bar: { type: 'string' } },
                      },
                    ],
                  },
                  additionalProperties: { type: 'string' },
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      typeName: { value: 'typeAMapKeys' },
                    },
                    value: { typeName: { value: 'string' } },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAMapKeys1' },
                  properties: [
                    {
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'string' },
                    },
                  ],
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAMapKeys2' },
                  properties: [
                    {
                      kind: 'Property',
                      name: { value: 'bar' },
                      typeName: { value: 'string' },
                    },
                  ],
                },
              ],
            }),
          );
        });
        it('handles a referenced propertyNames union', () => {
          // ARRANGE
          const oas = {
            openapi: '3.0.1',
            info: { title: 'Test', version: '1.0.0', description: 'test' },
            components: {
              schemas: {
                typeA: {
                  type: 'object',
                  propertyNames: {
                    $ref: '#/components/schemas/keyUnion',
                  },
                  additionalProperties: { type: 'string' },
                },
                keyA: {
                  type: 'object',
                  properties: { foo: { type: 'string' } },
                },
                keyB: {
                  type: 'object',
                  properties: { bar: { type: 'string' } },
                },
                keyUnion: {
                  oneOf: [
                    { $ref: '#/components/schemas/keyA' },
                    { $ref: '#/components/schemas/keyB' },
                  ],
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
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      typeName: { value: 'keyUnion' },
                    },
                    value: { typeName: { value: 'string' } },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'keyA' },
                  properties: [
                    {
                      kind: 'Property',
                      name: { value: 'foo' },
                      typeName: { value: 'string' },
                    },
                  ],
                },
                {
                  kind: 'Type',
                  name: { value: 'keyB' },
                  properties: [
                    {
                      kind: 'Property',
                      name: { value: 'bar' },
                      typeName: { value: 'string' },
                    },
                  ],
                },
              ],
              unions: [
                {
                  kind: 'Union',
                  name: { value: 'keyUnion' },
                  members: [
                    { typeName: { value: 'keyA' } },
                    { typeName: { value: 'keyB' } },
                  ],
                },
              ],
            }),
          );
        });
      });
    });

    describe('required', () => {
      it('violation when required includes undefined properties', () => {
        // ARRANGE
        const oas = {
          openapi: '3.0.1',
          info: { title: 'Test', version: '1.0.0', description: 'test' },
          components: {
            schemas: {
              typeA: {
                type: 'object',
                properties: {
                  foo: { type: 'string' },
                  bar: { type: 'string' },
                },
                required: ['foo', 'not_a_defined_property'],
              },
            },
          },
        };

        // ACT
        const { service, violations } = parser(
          JSON.stringify(oas),
          'source/path.ext',
        );

        // ASSERT
        expect(violations).toEqual(
          partial<Violation[]>([
            {
              code: 'openapi-3/invalid-schema',
              severity: 'warning',
              message:
                'Property "not_a_defined_property" is required but not defined.',
            },
          ]),
        );
      });

      it('adds required keys when additionalProperties are allowed', () => {
        // ARRANGE
        const oas = {
          openapi: '3.0.1',
          info: { title: 'Test', version: '1.0.0', description: 'test' },
          components: {
            schemas: {
              typeA: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  foo: { type: 'string' },
                  bar: { type: 'string' },
                },
                required: ['foo', 'not_a_defined_property'],
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
              {
                kind: 'Type',
                name: { value: 'typeA' },
                mapProperties: {
                  kind: 'MapProperties',
                  key: { typeName: { value: 'string' } },
                  requiredKeys: exact([
                    partial<Scalar<string>>({
                      value: 'not_a_defined_property',
                    }),
                  ]),
                  value: { typeName: { value: 'untyped' } },
                },
                properties: [
                  {
                    kind: 'Property',
                    name: { value: 'foo' },
                    typeName: { value: 'string' },
                    rules: [{ id: 'required' }],
                  },
                  {
                    kind: 'Property',
                    name: { value: 'bar' },
                    typeName: { value: 'string' },
                    rules: exact([]),
                  },
                ],
              },
            ],
          }),
        );
      });
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

const exactSet = new Set<unknown>();
function exact<T>(input: T): T {
  exactSet.add(input);
  return input;
}

function partial<T = any>(input: DeepPartial<T>): any {
  if (exactSet.has(input)) return input;

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
