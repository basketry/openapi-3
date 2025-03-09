import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as https from 'https';

import { ReturnValue, Service, validate } from 'basketry';
import parser from '.';

function noSources(service: Service): Omit<Service, 'sourcePaths'> {
  const { sourcePaths, ...rest } = service;
  return rest;
}
import { dump as yamlStringify } from 'yaml-ast-parser';

describe('parser', () => {
  it('recreates a valid exhaustive snapshot', async () => {
    // ARRANGE
    const snapshot = JSON.parse(
      readFileSync(join('src', 'snapshot', 'snapshot.json')).toString(),
    );

    const sourcePath: string = join('src', 'snapshot', 'example.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    // ACT
    const output = await parser(sourceContent);
    const result = JSON.parse(JSON.stringify(output.service, removeLoc));

    // ASSERT
    expect(noSources(result)).toStrictEqual(noSources(snapshot));
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
    const jsonOutput = await parser(jsonContent);
    const jsonResult = JSON.parse(JSON.stringify(jsonOutput.service, replacer));

    const yamlOutput = await parser(jsonContent);
    const yamlResult = JSON.parse(JSON.stringify(yamlOutput.service, replacer));

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
    const output = await parser(sourceContent);
    const result = JSON.parse(JSON.stringify(output.service, removeLoc));

    // ASSERT
    expect(noSources(result)).toStrictEqual(noSources(snapshot));
  });

  it('creates a type for every custom typeName', async () => {
    // ARRANGE

    const sourcePath = join('src', 'snapshot', 'example.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    // ACT
    const output = await parser(sourceContent);
    const result = output.service;

    // ASSERT
    const fromMethodParameters = new Set(
      result.interfaces
        .map((i) => i.methods)
        .reduce((a, b) => a.concat(b), [])
        .map((i) => i.parameters)
        .reduce((a, b) => a.concat(b), [])
        .filter((p) => p.value.kind === 'ComplexValue')
        .map((p) => p.value.typeName.value),
    );

    const fromMethodReturnTypes = new Set(
      result.interfaces
        .map((i) => i.methods)
        .reduce((a, b) => a.concat(b), [])
        .map((i) => i.returns)
        .filter((t): t is ReturnValue => !!t)
        .filter((p) => p.value.kind === 'ComplexValue')
        .map((p) => p.value.typeName.value),
    );

    const fromTypes = new Set(
      result.types
        .map((t) => t.properties)
        .reduce((a, b) => a.concat(b), [])
        .filter((p) => p.value.kind === 'ComplexValue')
        .map((p) => p.value.typeName.value),
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

  it('creates types with unique names', async () => {
    // ARRANGE

    const sourcePath = join('src', 'snapshot', 'example.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    // ACT
    const output = await parser(sourceContent);
    const result = output.service;

    // ASSERT
    const typeNames = result.types.map((t) => t.name);

    expect(typeNames.length).toEqual(new Set(typeNames).size);
  });

  it('creates a valid service', async () => {
    // ARRANGE
    const sourcePath = join('src', 'snapshot', 'example.oas3.json');
    const sourceContent = readFileSync(sourcePath).toString();

    const output = await parser(sourceContent);
    const service = output.service;

    // ACT
    const errors = validate(service).errors;

    writeFileSync('service.json', JSON.stringify(service, null, 2));

    // ASSERT
    expect(errors).toEqual([]);
  });

  it.skip('creates a valid service from the example Pet Store schema', async () => {
    // ARRANGE

    const sourcePath =
      'https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/examples/v3.0/petstore.json';
    const sourceContent = await getText(sourcePath);

    const output = await parser(sourceContent);
    const service = output.service;

    // ACT
    const errors = validate(service).errors;

    // ASSERT
    expect(errors).toEqual([]);
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
