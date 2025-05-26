import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { format } from 'prettier';
import parser from '..';

createSnapshot(
  join(process.cwd(), 'src', 'snapshot', 'example.oas3.json'),
  join(process.cwd(), 'src', 'snapshot', 'snapshot.json'),
);

createSnapshot(
  join(process.cwd(), 'src', 'snapshot', 'petstore.oas3.json'),
  join(process.cwd(), 'src', 'snapshot', 'petstore.json'),
);

async function createSnapshot(
  source: string,
  destination: string,
): Promise<void> {
  const schema = readFileSync(source).toString('utf8');
  const prettierOptions = JSON.parse(
    readFileSync(join(process.cwd(), '.prettierrc')).toString('utf8'),
  );
  const { service, violations } = parser(schema, source);
  const snapshot = await format(
    JSON.stringify(service, (key, value) =>
      key === 'loc' ? undefined : value,
    ),
    {
      ...prettierOptions,
      parser: 'json',
    },
  );
  writeFileSync(destination, snapshot);
  for (const violation of violations) console.warn(violation);
}
