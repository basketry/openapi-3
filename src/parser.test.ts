import { readFileSync } from 'fs';
import { join } from 'path';
import * as https from 'https';

import {
  Property,
  ReturnValue,
  Service,
  StringLiteral,
  validate,
  Violation,
} from 'basketry';
import parser from '.';
import { dump as yamlStringify } from 'yaml-ast-parser';
const absoluteSourcePath = '/dummy-value';

describe('parser', () => {
  describe('snapshots', () => {
    it('recreates a valid exhaustive snapshot', async () => {
      // ARRANGE
      const snapshot = JSON.parse(
        readFileSync(join('src', 'snapshot', 'snapshot.json')).toString(),
      );

      const sourcePath: string = join('src', 'snapshot', 'example.oas3.json');
      const sourceContent = readFileSync(sourcePath).toString();

      // ACT
      const result = JSON.parse(
        JSON.stringify((await parser(sourceContent, absoluteSourcePath)).service, removeLoc),
      );

      // ASSERT
      expect(result).toStrictEqual(snapshot);
    });

    it('parses identical services from JSON and YAML content', async () => {
      // ARRANGE
      const jsonPath: string = join('src', 'snapshot', 'example.oas3.json');
      const jsonContent = readFileSync(jsonPath).toString();
      const yamlContent = yamlStringify(JSON.parse(jsonContent), {});

      const replacer = (key: string, value: any) => {
        return key === 'loc' ? 'REDACTED' : value;
      };

      // ACT
      const jsonResult = JSON.parse(
        JSON.stringify((await parser(jsonContent, absoluteSourcePath)).service, replacer),
      );

      const yamlResult = JSON.parse(
        JSON.stringify((await parser(yamlContent, absoluteSourcePath)).service, replacer),
      );

      // ASSERT
      expect(jsonResult).toStrictEqual(yamlResult);
    });

    it('recreates a valid petstore snapshot', async () => {
      // ARRANGE
      const snapshot = JSON.parse(
        readFileSync(join('src', 'snapshot', 'petstore.json')).toString(),
      );

      const sourcePath = join('src', 'snapshot', 'petstore.oas3.json');
      const sourceContent = readFileSync(sourcePath).toString();

      // ACT
      const result = JSON.parse(
        JSON.stringify((await parser(sourceContent, absoluteSourcePath)).service, removeLoc),
      );

      // ASSERT
      expect(result).toStrictEqual(snapshot);
    });

    it('creates a type for every custom typeName', async () => {
      // ARRANGE

      const sourcePath = join('src', 'snapshot', 'example.oas3.json');
      const sourceContent = readFileSync(sourcePath).toString();

      // ACT
      const { service } = await parser(sourceContent, absoluteSourcePath);

      // ASSERT
      const fromMethodParameters = new Set(
        service.interfaces
          .map((i) => i.methods)
          .reduce((a, b) => a.concat(b), [])
          .map((i) => i.parameters)
          .reduce((a, b) => a.concat(b), [])
          .filter((p) => p.value.kind === 'ComplexValue')
          .map((p) => p.value.typeName.value),
      );

      const fromMethodReturnTypes = new Set(
        service.interfaces
          .map((i) => i.methods)
          .reduce((a, b) => a.concat(b), [])
          .map((i) => i.returns)
          .filter((t): t is ReturnValue => !!t)
          .filter((p) => p.value.kind === 'ComplexValue')
          .map((p) => p.value.typeName.value),
      );

      const fromTypes = new Set(
        service.types
          .map((t) => t.properties)
          .reduce((a, b) => a.concat(b), [])
          .filter((p) => p.value.kind === 'ComplexValue')
          .map((p) => p.value.typeName.value),
      );

      const typeNames = new Set([
        ...service.types.map((t) => t.name.value),
        ...service.unions.map((t) => t.name.value),
        ...service.enums.map((e) => e.name.value),
      ]);

      for (const localTypeName of [
        ...fromMethodParameters,
        ...fromMethodReturnTypes,
        ...fromTypes,
      ]) {
        expect(typeNames.has(localTypeName)).toEqual(true);
      }
    });

    it('creates types with unique names', async () => {
      // ARRANGE

      const sourcePath = join('src', 'snapshot', 'example.oas3.json');
      const sourceContent = readFileSync(sourcePath).toString();

      // ACT
      const { service } = await parser(sourceContent, absoluteSourcePath);

      // ASSERT
      const typeNames = service.types.map((t) => t.name);

      expect(typeNames.length).toEqual(new Set(typeNames).size);
    });

    it('creates a valid service', async () => {
      // ARRANGE
      const sourcePath = join('src', 'snapshot', 'example.oas3.json');
      const sourceContent = readFileSync(sourcePath).toString();

      const { service } = await parser(sourceContent, absoluteSourcePath);

      // ACT
      const { errors } = validate(service);

      // ASSERT
      expect(errors).toEqual([]);
    });

    it('creates a valid service from the example Pet Store schema', async () => {
      // ARRANGE

      const sourcePath =
        'https://raw.githubusercontent.com/swagger-api/swagger-petstore/refs/heads/master/src/main/resources/openapi.yaml';
      const sourceContent = await getText(sourcePath);

      const { service } = await parser(sourceContent, absoluteSourcePath);

      // ACT
      const { errors } = validate(service);

      // ASSERT
      expect(errors).toEqual([]);
    });
  });

  describe('types', () => {
    describe('sources', () => {
      describe('schema', () => {
        it('creates a type from a schema component', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
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
        it('creates primitive properties', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    }),
                  ]),
                },
              ],
            }),
          );
        });
        it('creates object properties', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAFoo' },
                      },
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
        it('creates a type from a nested schema component', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAFoo' },
                      },
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
        it('creates primitive properties', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAFoo' },
                      },
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
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    }),
                  ]),
                },
              ],
            }),
          );
        });
        it('creates object properties', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAFoo' },
                      },
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
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAFooBar' },
                      },
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
        it('creates a type from a operation body', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
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
        it('creates a type from a named operation body', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
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
        it('creates primitive properties', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'createThingBody' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    }),
                  ]),
                },
              ],
            }),
          );
        });
        it('creates object properties', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'createThingBody' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'createThingBodyFoo' },
                      },
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
        it('creates a type from a referenced response component', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
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
        it('creates primitive properties', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'thingResponse' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    }),
                  ]),
                },
              ],
            }),
          );
        });
        it('creates object properties', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'thingResponse' },
                  properties: exact([
                    partial<Property>({
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'thingResponseFoo' },
                      },
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
      describe('primitive', () => {
        describe('string', () => {
          it('parses a string property', async () => {
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
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a string property with a default value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'string', default: 'some string' },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          default: { value: 'some string' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a string property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'string', enum: ['some string'] },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          constant: { value: 'some string' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a string property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'string', const: 'some string' },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          constant: { value: 'some string' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a string array property', async () => {
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
                        type: 'array',
                        items: { type: 'string' },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          describe('rules', () => {
            it('required', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string' } },
                      required: ['foo'],
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [{ id: 'Required' }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it.skip('constant (3.0.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string', enum: ['bar'] } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            constant: { value: 'bar' },
                            rules: [
                              { id: 'Constant', value: { value: 'bar' } },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it.skip('constant (3.1.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.1.0',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string', const: 'bar' } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            constant: { value: 'bar' },
                            rules: [
                              { id: 'Constant', value: { value: 'bar' } },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('string-max-length', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string', maxLength: 10 } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [
                              { id: 'StringMaxLength', length: { value: 10 } },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('string-min-length', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string', minLength: 10 } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [
                              { id: 'StringMinLength', length: { value: 10 } },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('string-pattern', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string', pattern: '^foo$' } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [
                              {
                                id: 'StringPattern',
                                pattern: { value: '^foo$' },
                              },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('string-format', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: {
                        foo: { type: 'string', format: 'password' },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [
                              {
                                id: 'StringFormat',
                                format: { value: 'password' },
                              },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('string-enum', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string', enum: ['bar'] } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [
                              {
                                id: 'StringEnum',
                                values: [{ value: 'bar' }],
                              },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-min-items', async () => {
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
                          type: 'array',
                          items: { type: 'string' },
                          minItems: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [
                              {
                                id: 'ArrayMinItems',
                                min: { value: 10 },
                              },
                            ],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-max-items', async () => {
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
                          type: 'array',
                          items: { type: 'string' },
                          maxItems: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [
                              {
                                id: 'ArrayMaxItems',
                                max: { value: 10 },
                              },
                            ],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-unique-items', async () => {
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
                          type: 'array',
                          items: { type: 'string' },
                          uniqueItems: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'string' },
                            rules: [{ id: 'ArrayUniqueItems', required: true }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });
          });
        });

        describe('nullable', () => {
          it.only('parses a nullable string property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'string', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);
            console.log(JSON.stringify(service, null, 2));

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable number property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'number' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable integer property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'integer', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'integer' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable boolean property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'boolean', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'boolean' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable date property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'string', format: 'date', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable date-time property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'string', format: 'date-time', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date-time' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable binary property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'string', format: 'binary', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'binary' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable long property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'integer', format: 'int64', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'long' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable float property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number', format: 'float', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'float' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable double property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number', format: 'double', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'double' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable null property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'null', nullable: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'null' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable string array property', async () => {
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
                        type: 'array',
                        items: { type: 'string', nullable: true },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          isArray: { value: true },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable property in request body', async () => {
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
                            properties: { foo: { type: 'string', nullable: true } },
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
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'createThingBody' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable property in response', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              paths: {
                '/thing': {
                  get: {
                    operationId: 'getThing',
                    responses: {
                      '200': {
                        content: {
                          '*/*': {
                            schema: {
                              type: 'object',
                              properties: { foo: { type: 'string', nullable: true } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'getThingResponse' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a nullable property in method parameter', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              paths: {
                '/thing/{id}': {
                  get: {
                    operationId: 'getThing',
                    parameters: [
                      {
                        name: 'id',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', nullable: true },
                      },
                    ],
                    responses: { '200': { description: 'success' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                interfaces: [
                  {
                    kind: 'Interface',
                    name: { value: 'getThing' },
                    methods: [
                      {
                        kind: 'Method',
                        name: { value: 'getThing' },
                        parameters: [
                          {
                            kind: 'Parameter',
                            name: { value: 'id' },
                            value: {
                              kind: 'PrimitiveValue',
                              typeName: { value: 'string' },
                              isNullable: { kind: 'TrueLiteral', value: true },
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              }),
            );
          });

          it('parses a nullable property in union member', async () => {
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
                        oneOf: [
                          { type: 'string', nullable: true },
                          { type: 'number', nullable: true },
                        ],
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'ComplexValue',
                          typeName: { value: 'typeAFoo' },
                        },
                      }),
                    ]),
                  },
                ],
                unions: [
                  {
                    kind: 'SimpleUnion',
                    name: { value: 'typeAFoo' },
                    members: [
                      {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                        isNullable: { kind: 'TrueLiteral', value: true },
                      },
                      {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'number' },
                        isNullable: { kind: 'TrueLiteral', value: true },
                      },
                    ],
                  },
                ],
              }),
            );
          });

          it('parses a nullable property in map values', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    additionalProperties: { type: 'string', nullable: true },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    mapProperties: {
                      kind: 'MapProperties',
                      key: {
                        kind: 'MapKey',
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                        },
                      },
                      value: {
                        kind: 'MapValue',
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'string' },
                          isNullable: { kind: 'TrueLiteral', value: true },
                        },
                      },
                    },
                  },
                ],
              }),
            );
          });
        });

        describe('number', () => {
          it('parses a number property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'number' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a number property with a default value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number', default: 42 } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'number' },
                          default: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a number property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number', enum: [42] } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'number' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a number property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number', const: 42 } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'number' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a number property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'array', items: { type: 'number' } },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'number' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          describe('rules', () => {
            it('required', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'number' } },
                      required: ['foo'],
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [{ id: 'Required' }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it.skip('constant (3.0.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'number', enum: [42] } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            constant: { value: 42 },
                            rules: [{ id: 'Constant', value: { value: '42' } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it.skip('constant (3.1.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.1.0',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'number', const: 42 } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            constant: { value: 42 },
                            rules: [{ id: 'Constant', value: { value: '42' } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-multiple-of', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'number', multipleOf: 10 } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [
                              {
                                id: 'NumberMultipleOf',
                                value: { value: 10 },
                              },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-gt (3.0.x)', async () => {
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
                          type: 'number',
                          minimum: 10,
                          exclusiveMinimum: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [{ id: 'NumberGT', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-gt (3.1.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.1.0',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: {
                        foo: {
                          type: 'number',
                          exclusiveMinimum: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [{ id: 'NumberGT', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-gte', async () => {
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
                          type: 'number',
                          minimum: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [{ id: 'NumberGTE', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-lt (3.0.x)', async () => {
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
                          type: 'number',
                          maximum: 10,
                          exclusiveMaximum: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [{ id: 'NumberLT', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-lt (3.1.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.1.0',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: {
                        foo: {
                          type: 'number',
                          exclusiveMaximum: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [{ id: 'NumberLT', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-lte', async () => {
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
                          type: 'number',
                          maximum: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [{ id: 'NumberLTE', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-min-items', async () => {
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
                          type: 'array',
                          items: { type: 'number' },
                          minItems: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [
                              { id: 'ArrayMinItems', min: { value: 10 } },
                            ],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-max-items', async () => {
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
                          type: 'array',
                          items: { type: 'number' },
                          maxItems: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [
                              { id: 'ArrayMaxItems', max: { value: 10 } },
                            ],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-unique-items', async () => {
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
                          type: 'array',
                          items: { type: 'number' },
                          uniqueItems: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'number' },
                            rules: [{ id: 'ArrayUniqueItems', required: true }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });
          });
        });

        describe('integer', () => {
          it('parses an integer property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'integer' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'integer' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses an integer property with a default value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'integer', default: 42 } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'integer' },
                          default: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses an integer property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'integer', enum: [42] } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'integer' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses an integer property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'integer', const: 42 } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'integer' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses an integer array property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'array', items: { type: 'integer' } },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'integer' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          describe('rules', () => {
            it('required', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'integer' } },
                      required: ['foo'],
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [{ id: 'Required' }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it.skip('constant (3.0.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'integer', enum: [42] } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            constant: { value: 42 },
                            rules: [{ id: 'Constant', value: { value: '42' } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it.skip('constant (3.1.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.1.0',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'integer', const: 42 } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            constant: { value: 42 },
                            rules: [{ id: 'Constant', value: { value: '42' } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-multiple-of', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'integer', multipleOf: 10 } },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            rules: [
                              {
                                id: 'NumberMultipleOf',
                                value: { value: 10 },
                              },
                            ],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-gt (3.0.x)', async () => {
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
                          type: 'integer',
                          minimum: 10,
                          exclusiveMinimum: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [{ id: 'NumberGT', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-gt (3.1.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.1.0',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: {
                        foo: {
                          type: 'integer',
                          exclusiveMinimum: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [{ id: 'NumberGT', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-gte', async () => {
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
                          type: 'integer',
                          minimum: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [{ id: 'NumberGTE', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-lt (3.0.x)', async () => {
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
                          type: 'integer',
                          maximum: 10,
                          exclusiveMaximum: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [{ id: 'NumberLT', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-lt (3.1.x)', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.1.0',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: {
                        foo: {
                          type: 'integer',
                          exclusiveMaximum: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [{ id: 'NumberLT', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('number-lte', async () => {
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
                          type: 'integer',
                          maximum: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [{ id: 'NumberLTE', value: { value: 10 } }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-min-items', async () => {
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
                          type: 'array',
                          items: { type: 'integer' },
                          minItems: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [
                              { id: 'ArrayMinItems', min: { value: 10 } },
                            ],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-max-items', async () => {
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
                          type: 'array',
                          items: { type: 'integer' },
                          maxItems: 10,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [
                              { id: 'ArrayMaxItems', max: { value: 10 } },
                            ],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-unique-items', async () => {
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
                          type: 'array',
                          items: { type: 'integer' },
                          uniqueItems: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'integer' },
                            rules: [{ id: 'ArrayUniqueItems', required: true }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });
          });
        });

        describe('long', () => {
          it('parses a long property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'integer', format: 'int64' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'long' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a long property with a default value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'integer', format: 'int64', default: 42 },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'long' },
                          default: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a long property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'integer', format: 'int64', enum: [42] },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'long' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a long property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'integer', format: 'int64', const: 42 },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'long' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a long array property', async () => {
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
                        type: 'array',
                        items: { type: 'integer', format: 'int64' },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'long' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });
        });

        describe('float', () => {
          it('parses a float property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number', format: 'float' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'float' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a float property with a default value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'number', format: 'float', default: 42 },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'float' },
                          default: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a float property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'number', format: 'float', enum: [42] },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'float' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a float property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'number', format: 'float', const: 42 },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'float' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a float array property', async () => {
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
                        type: 'array',
                        items: { type: 'number', format: 'float' },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'float' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });
        });

        describe('double', () => {
          it('parses a double property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'number', format: 'double' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'double' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a double property with a default value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'number', format: 'double', default: 42 },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'double' },
                          default: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a double property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'number', format: 'double', enum: [42] },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'double' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a double property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'number', format: 'double', const: 42 },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'double' },
                          constant: { value: 42 },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a double array property', async () => {
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
                        type: 'array',
                        items: { type: 'number', format: 'double' },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'double' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });
        });

        describe('boolean', () => {
          it('parses a boolean property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'boolean' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'boolean' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a boolean property with a default value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'boolean', default: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'boolean' },
                          default: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a boolean property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'boolean', enum: [true] } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'boolean' },
                          constant: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a boolean property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'boolean', const: true } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'boolean' },
                          constant: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a boolean array property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'array', items: { type: 'boolean' } },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'boolean' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          describe('rules', () => {
            it('required', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'boolean' } },
                      required: ['foo'],
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'boolean' },
                            rules: [{ id: 'Required' }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-min-items', async () => {
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
                          type: 'array',
                          items: { type: 'boolean' },
                          minItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'boolean' },
                            rules: [{ id: 'ArrayMinItems', min: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-max-items', async () => {
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
                          type: 'array',
                          items: { type: 'boolean' },
                          maxItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'boolean' },
                            rules: [{ id: 'ArrayMaxItems', max: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-unique-items', async () => {
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
                          type: 'array',
                          items: { type: 'boolean' },
                          uniqueItems: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'boolean' },
                            rules: [{ id: 'ArrayUniqueItems', required: true }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });
          });
        });

        describe('date', () => {
          it('parses a date property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'string', format: 'date' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a date property with a default value', async () => {
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
                        type: 'string',
                        format: 'date',
                        default: '2023-01-01',
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date' },
                          default: { value: '2023-01-01' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a date property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string',
                        format: 'date',
                        enum: ['2023-01-01'],
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date' },
                          constant: { value: '2023-01-01' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a date property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string',
                        format: 'date',
                        const: '2023-01-01',
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date' },
                          constant: { value: '2023-01-01' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a date array property', async () => {
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
                        type: 'array',
                        items: { type: 'string', format: 'date' },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          describe('rules', () => {
            it('required', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string', format: 'date' } },
                      required: ['foo'],
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'date' },
                            rules: [{ id: 'Required' }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-min-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'date' },
                          minItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'date' },
                            rules: [{ id: 'ArrayMinItems', min: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-max-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'date' },
                          maxItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'date' },
                            rules: [{ id: 'ArrayMaxItems', max: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-unique-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'date' },
                          uniqueItems: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'date' },
                            rules: [{ id: 'ArrayUniqueItems', required: true }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });
          });
        });

        describe('date-time', () => {
          it('parses a date-time property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date-time' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a date-time property with a default value', async () => {
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
                        type: 'string',
                        format: 'date-time',
                        default: '2023-01-01T00:00:00Z',
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date-time' },
                          default: { value: '2023-01-01T00:00:00Z' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a date-time property with a 3.0.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string',
                        format: 'date-time',
                        enum: ['2023-01-01T00:00:00Z'],
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date-time' },
                          constant: { value: '2023-01-01T00:00:00Z' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a date-time property with a 3.1.x const value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.1.0',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string',
                        format: 'date-time',
                        const: '2023-01-01T00:00:00Z',
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date-time' },
                          constant: { value: '2023-01-01T00:00:00Z' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a date-time array property', async () => {
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
                        type: 'array',
                        items: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'date-time' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          describe('rules', () => {
            it('required', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: {
                        foo: { type: 'string', format: 'date-time' },
                      },
                      required: ['foo'],
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'date-time' },
                            rules: [{ id: 'Required' }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-min-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'date-time' },
                          minItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'date-time' },
                            rules: [{ id: 'ArrayMinItems', min: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-max-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'date-time' },
                          maxItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'date-time' },
                            rules: [{ id: 'ArrayMaxItems', max: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-unique-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'date-time' },
                          uniqueItems: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'date-time' },
                            rules: [{ id: 'ArrayUniqueItems', required: true }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });
          });
        });

        describe('null', () => {
          it('parses a null property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'null' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'null' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a null property with a default value', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'null', default: null } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'null' },
                          default: { value: null },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it.todo('parses a null property with a 3.0.x const value');

          it.todo('parses a null property with a 3.1.x const value');

          it('parses a null array property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: {
                      foo: { type: 'array', items: { type: 'null' } },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'null' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          describe('rules', () => {
            it('required', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'null' } },
                      required: ['foo'],
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'null' },
                            rules: [{ id: 'Required' }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-min-items', async () => {
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
                          type: 'array',
                          items: { type: 'null' },
                          minItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'null' },
                            rules: [{ id: 'ArrayMinItems', min: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-max-items', async () => {
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
                          type: 'array',
                          items: { type: 'null' },
                          maxItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'null' },
                            rules: [{ id: 'ArrayMaxItems', max: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-unique-items', async () => {
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
                          type: 'array',
                          items: { type: 'null' },
                          uniqueItems: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'null' },
                            rules: [{ id: 'ArrayUniqueItems', required: true }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });
          });
        });

        describe('binary', () => {
          it('parses a binary property', async () => {
            // ARRANGE
            const oas = {
              openapi: '3.0.1',
              info: { title: 'Test', version: '1.0.0', description: 'test' },
              components: {
                schemas: {
                  typeA: {
                    type: 'object',
                    properties: { foo: { type: 'string', format: 'binary' } },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'binary' },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          it('parses a binary array property', async () => {
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
                        type: 'array',
                        items: { type: 'string', format: 'binary' },
                      },
                    },
                  },
                },
              },
            };

            // ACT
            const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

            // ASSERT
            expectService(service).toEqual(
              partial<Service>({
                types: [
                  {
                    kind: 'Type',
                    name: { value: 'typeA' },
                    properties: exact([
                      partial<Property>({
                        kind: 'Property',
                        name: { value: 'foo' },
                        value: {
                          kind: 'PrimitiveValue',
                          typeName: { value: 'binary' },
                          isArray: { value: true },
                        },
                      }),
                    ]),
                  },
                ],
              }),
            );
          });

          describe('rules', () => {
            it('required', async () => {
              // ARRANGE
              const oas = {
                openapi: '3.0.1',
                info: { title: 'Test', version: '1.0.0', description: 'test' },
                components: {
                  schemas: {
                    typeA: {
                      type: 'object',
                      properties: { foo: { type: 'string', format: 'binary' } },
                      required: ['foo'],
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'binary' },
                            rules: [{ id: 'Required' }],
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-min-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'binary' },
                          minItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'binary' },
                            rules: [{ id: 'ArrayMinItems', min: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-max-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'binary' },
                          maxItems: 5,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'binary' },
                            rules: [{ id: 'ArrayMaxItems', max: { value: 5 } }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });

            it('array-unique-items', async () => {
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
                          type: 'array',
                          items: { type: 'string', format: 'binary' },
                          uniqueItems: true,
                        },
                      },
                    },
                  },
                },
              };

              // ACT
              const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

              // ASSERT
              expectService(service).toEqual(
                partial<Service>({
                  types: [
                    {
                      kind: 'Type',
                      name: { value: 'typeA' },
                      properties: exact([
                        partial<Property>({
                          kind: 'Property',
                          name: { value: 'foo' },
                          value: {
                            kind: 'PrimitiveValue',
                            typeName: { value: 'binary' },
                            rules: [{ id: 'ArrayUniqueItems', required: true }],
                            isArray: { value: true },
                          },
                        }),
                      ]),
                    },
                  ],
                }),
              );
            });
          });
        });
      });
    });
  });

  describe('unions', () => {
    it('correctly parses a oneOf without $refs in a body parameter', async () => {
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
      const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

      // ASSERT
      expectService(service).toEqual(
        partial<Service>({
          types: [
            { kind: 'Type', name: { value: 'testTestBody1' } },
            { kind: 'Type', name: { value: 'testTestBody2' } },
          ],
          unions: [
            {
              kind: 'SimpleUnion',
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

    it('correctly parses a oneOf with $refs in a body parameter', async () => {
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
      const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

      // ASSERT
      expectService(service).toEqual(
        partial<Service>({
          types: [
            { kind: 'Type', name: { value: 'typeA' } },
            { kind: 'Type', name: { value: 'typeB' } },
          ],
          unions: [
            {
              kind: 'SimpleUnion',
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

    describe('primitive', () => {
      it('parses a primitive union from oneOf', async () => {
        // ARRANGE
        const oas = {
          openapi: '3.0.1',
          info: { title: 'Test', version: '1.0.0', description: 'test' },
          components: {
            schemas: {
              typeA: {
                type: 'object',
                properties: {
                  foo: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                },
              },
            },
          },
        };

        // ACT
        const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

        // ASSERT
        expectService(service).toEqual(
          partial<Service>({
            types: [
              {
                kind: 'Type',
                name: { value: 'typeA' },
                properties: exact([
                  partial<Property>({
                    kind: 'Property',
                    name: { value: 'foo' },
                    value: {
                      kind: 'ComplexValue',
                      typeName: { value: 'typeAFoo' },
                    },
                  }),
                ]),
              },
            ],
            unions: [
              {
                kind: 'SimpleUnion',
                name: { value: 'typeAFoo' },
                members: [
                  { kind: 'PrimitiveValue', typeName: { value: 'string' } },
                  { kind: 'PrimitiveValue', typeName: { value: 'number' } },
                ],
              },
            ],
          }),
        );
      });

      it('parses a primitive union from anyOf', async () => {
        // ARRANGE
        const oas = {
          openapi: '3.0.1',
          info: { title: 'Test', version: '1.0.0', description: 'test' },
          components: {
            schemas: {
              typeA: {
                type: 'object',
                properties: {
                  foo: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                },
              },
            },
          },
        };

        // ACT
        const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

        // ASSERT
        expectService(service).toEqual(
          partial<Service>({
            types: [
              {
                kind: 'Type',
                name: { value: 'typeA' },
                properties: exact([
                  partial<Property>({
                    kind: 'Property',
                    name: { value: 'foo' },
                    value: {
                      kind: 'ComplexValue',
                      typeName: { value: 'typeAFoo' },
                    },
                  }),
                ]),
              },
            ],
            unions: [
              {
                kind: 'SimpleUnion',
                name: { value: 'typeAFoo' },
                members: [
                  { kind: 'PrimitiveValue', typeName: { value: 'string' } },
                  { kind: 'PrimitiveValue', typeName: { value: 'number' } },
                ],
              },
            ],
          }),
        );
      });
    });

    describe('mixed', () => {
      it('parses a mixed union (primitive and complex) from oneOf', async () => {
        // ARRANGE
        const oas = {
          openapi: '3.0.1',
          info: { title: 'Test', version: '1.0.0', description: 'test' },
          components: {
            schemas: {
              typeA: {
                type: 'object',
                properties: {
                  foo: { oneOf: [{ type: 'string' }, { type: 'object' }] },
                },
              },
            },
          },
        };

        // ACT
        const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

        // ASSERT
        expectService(service).toEqual(
          partial<Service>({
            types: [
              {
                kind: 'Type',
                name: { value: 'typeA' },
                properties: exact([
                  partial<Property>({
                    kind: 'Property',
                    name: { value: 'foo' },
                    value: {
                      kind: 'ComplexValue',
                      typeName: { value: 'typeAFoo' },
                    },
                  }),
                ]),
              },
              {
                kind: 'Type',
                name: { value: 'typeAFoo2' },
              },
            ],
            unions: [
              {
                kind: 'SimpleUnion',
                name: { value: 'typeAFoo' },
                members: [
                  { kind: 'PrimitiveValue', typeName: { value: 'string' } },
                  { kind: 'ComplexValue', typeName: { value: 'typeAFoo2' } },
                ],
              },
            ],
          }),
        );
      });
    });
  });

  describe('additionalProperties', () => {
    describe('boolean', () => {
      it('creates a rule when false', async () => {
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
        const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

        // ASSERT
        expectService(service).toEqual(
          partial<Service>({
            types: [
              {
                kind: 'Type',
                name: { value: 'typeA' },
                rules: [
                  {
                    id: 'ObjectAdditionalProperties',
                    forbidden: { value: true },
                  },
                ],
              },
            ],
          }),
        );
      });

      it('creates map properties when true', async () => {
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
        const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

        // ASSERT
        expectService(service).toEqual(
          partial<Service>({
            types: [
              {
                kind: 'Type',
                name: { value: 'typeA' },
                mapProperties: {
                  kind: 'MapProperties',
                  key: {
                    kind: 'MapKey',
                    value: {
                      kind: 'PrimitiveValue',
                      typeName: { value: 'string' },
                    },
                  },
                  value: {
                    kind: 'MapValue',
                    value: {
                      kind: 'PrimitiveValue',
                      typeName: { value: 'untyped' },
                    },
                  },
                },
              },
            ],
          }),
        );
      });
    });

    describe('object', () => {
      describe('primitive schema', () => {
        it('handles a direct primitive schema', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
              ],
            }),
          );
        });

        it('handles a referenced primitive schema', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
              ],
            }),
          );
        });

        it('handles a direct enum', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAMapValue' },
                      },
                    },
                  },
                },
              ],
              enums: [
                {
                  kind: 'Enum',
                  name: { value: 'typeAMapValue' },
                  members: [
                    { kind: 'EnumMember', content: { value: 'a' } },
                    { kind: 'EnumMember', content: { value: 'b' } },
                  ],
                },
              ],
            }),
          );
        });

        it('handles a referenced enum', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'enumA' },
                      },
                    },
                  },
                },
              ],
              enums: [
                {
                  kind: 'Enum',
                  name: { value: 'enumA' },
                  members: [
                    { kind: 'EnumMember', content: { value: 'a' } },
                    { kind: 'EnumMember', content: { value: 'b' } },
                  ],
                },
              ],
            }),
          );
        });
      });

      describe('object schema', () => {
        it('handles a direct object schema', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAMapValues' },
                      },
                    },
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

        it('handles a referenced object schema', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeB' },
                      },
                    },
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
        it.skip('handles a direct oneOf primitive union', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAMapValues' },
                      },
                    },
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

        it('handles a direct oneOf object union', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAMapValues' },
                      },
                    },
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
                  kind: 'SimpleUnion',
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

        it.skip('handles a referenced oneOf primitive union', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeB' },
                      },
                    },
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

        it('handles a referenced oneOf object union', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'unionA' },
                      },
                    },
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
                  kind: 'SimpleUnion',
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
        it('defaults to string', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
              ],
            }),
          );
        });
        it('handles a direct propertyNames schema', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        rules: [
                          { id: 'StringMaxLength', length: { value: 10 } },
                        ],
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
              ],
            }),
          );
        });
        it('handles a referenced propertyNames schema', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'PrimitiveValue',
                        rules: [
                          { id: 'StringMaxLength', length: { value: 10 } },
                        ],
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
              ],
            }),
          );
        });
        it('handles a direct propertyNames enum', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAMapKey' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
              ],
              enums: [
                {
                  kind: 'Enum',
                  name: { value: 'typeAMapKey' },
                  members: [
                    { kind: 'EnumMember', content: { value: 'a' } },
                    { kind: 'EnumMember', content: { value: 'b' } },
                  ],
                },
              ],
            }),
          );
        });
        it('handles a referenced propertyNames enum', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'keySchema' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
              ],
              enums: [
                {
                  kind: 'Enum',
                  name: { value: 'keySchema' },
                  members: [
                    { kind: 'EnumMember', content: { value: 'a' } },
                    { kind: 'EnumMember', content: { value: 'b' } },
                  ],
                },
              ],
            }),
          );
        });
        it('handles a direct propertyNames union', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'typeAMapKeys' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'typeAMapKeys1' },
                  properties: [
                    {
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
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
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  ],
                },
              ],
            }),
          );
        });
        it('handles a referenced propertyNames union', async () => {
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
          const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

          // ASSERT
          expectService(service).toEqual(
            partial<Service>({
              types: [
                {
                  kind: 'Type',
                  name: { value: 'typeA' },
                  mapProperties: {
                    kind: 'MapProperties',
                    key: {
                      kind: 'MapKey',
                      value: {
                        kind: 'ComplexValue',
                        typeName: { value: 'keyUnion' },
                      },
                    },
                    value: {
                      kind: 'MapValue',
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  },
                },
                {
                  kind: 'Type',
                  name: { value: 'keyA' },
                  properties: [
                    {
                      kind: 'Property',
                      name: { value: 'foo' },
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
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
                      value: {
                        kind: 'PrimitiveValue',
                        typeName: { value: 'string' },
                      },
                    },
                  ],
                },
              ],
              unions: [
                {
                  kind: 'SimpleUnion',
                  name: { value: 'keyUnion' },
                  members: [
                    { kind: 'ComplexValue', typeName: { value: 'keyA' } },
                    { kind: 'ComplexValue', typeName: { value: 'keyB' } },
                  ],
                },
              ],
            }),
          );
        });
      });
    });

    describe('required', () => {
      it('violation when required includes undefined properties', async () => {
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
        const { violations } = await parser(JSON.stringify(oas), absoluteSourcePath);

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

      it('adds required keys when additionalProperties are allowed', async () => {
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
        const { service } = await parser(JSON.stringify(oas), absoluteSourcePath);

        // ASSERT
        expectService(service).toEqual(
          partial<Service>({
            types: [
              {
                kind: 'Type',
                name: { value: 'typeA' },
                mapProperties: {
                  kind: 'MapProperties',
                  key: {
                    kind: 'MapKey',
                    value: { typeName: { value: 'string' } },
                  },
                  requiredKeys: exact([
                    partial<StringLiteral>({
                      value: 'not_a_defined_property',
                    }),
                  ]),
                  value: {
                    kind: 'MapValue',
                    value: {
                      kind: 'PrimitiveValue',
                      typeName: { value: 'untyped' },
                    },
                  },
                },
                properties: [
                  {
                    kind: 'Property',
                    name: { value: 'foo' },
                    value: {
                      kind: 'PrimitiveValue',
                      typeName: { value: 'string' },
                      rules: [{ id: 'Required' }],
                    },
                  },
                  {
                    kind: 'Property',
                    name: { value: 'bar' },
                    value: {
                      kind: 'PrimitiveValue',
                      typeName: { value: 'string' },
                      rules: exact([]),
                    },
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

const expectService = (service: Service): ReturnType<typeof expect> => {
  expect(validate(service).errors).toEqual([]);

  return expect(service);
};

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
