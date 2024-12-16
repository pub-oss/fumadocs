import * as path from 'node:path';
import fg from 'fast-glob';
import { getTypeFromPath } from '@/utils/get-type-from-path';
import type { FileInfo } from '@/config/types';
import {
  type InternalDocCollection,
  type InternalMetaCollection,
  type LoadedConfig,
} from '@/config/load';

export async function generateJS(
  configPath: string,
  // config 文件是通过 esbuild 构建到 ~/.source/source.config.mjs 并直接通过 import 导入的模块内容
  config: LoadedConfig,
  outputPath: string,
  hash: string,
  getFrontmatter: (file: string) => Promise<unknown>,
): Promise<string> {
  const outDir = path.dirname(outputPath);
  const imports: ImportInfo[] = [
    {
      type: 'named',
      names: ['toRuntime', 'toRuntimeAsync'],
      specifier: 'fumadocs-mdx',
    },
  ];
  const importedCollections = new Set<string>();

  config._runtime.files.clear();
  // 
  const entries = Array.from(config.collections.entries());
  const declares = entries.map(async ([k, collection]) => {
    // pr 被拒绝了 https://github.com/fuma-nama/fumadocs/issues/1165
    const files = await getCollectionFiles(collection);
    const items = files.map(async (file, i) => {
      config._runtime.files.set(file.absolutePath, k);

      if (collection.type === 'doc' && collection.async) {
        const importPath = `${toImportPath(file.absolutePath, outDir)}?hash=${hash}&collection=${k}`;
        const frontmatter = await getFrontmatter(file.absolutePath);

        return `toRuntimeAsync(${JSON.stringify(frontmatter)}, () => import(${JSON.stringify(importPath)}), ${JSON.stringify(file)})`;
      }

      const importName = `${k}_${i.toString()}`;
      imports.push({
        type: 'namespace',
        name: importName,
        specifier: `${toImportPath(file.absolutePath, outDir)}?collection=${k}&hash=${hash}`,
      });

      return `toRuntime("${collection.type}", ${importName}, ${JSON.stringify(file)})`;
    });
    const resolvedItems = await Promise.all(items);

    if (collection.transform) {
      if (config.global) importedCollections.add('default'); // import global config
      importedCollections.add(k);
    }

    return collection.transform
      ? `export const ${k} = await Promise.all([${resolvedItems.join(', ')}].map(v => c_${k}.transform(v, ${config.global ? 'c_default' : 'undefined'})));`
      : `export const ${k} = [${resolvedItems.join(', ')}];`;
  });

  const resolvedDeclares = await Promise.all(declares);

  if (importedCollections.size > 0) {
    imports.push({
      type: 'named',
      names: Array.from(importedCollections.values())
        .sort()
        .map((v) => [v, `c_${v}`] as const),
      specifier: toImportPath(configPath, outDir),
    });
  }

  return [...imports.map(getImportCode), ...resolvedDeclares].join('\n');
}

async function getCollectionFiles(
  collection: InternalDocCollection | InternalMetaCollection,
): Promise<FileInfo[]> {
  const files = new Map<string, FileInfo>();
  const dirs = Array.isArray(collection.dir)
    ? collection.dir
    : [collection.dir];

  await Promise.all(
    dirs.map(async (dir) => {
      const result = await fg(collection.files ?? '**/*', {
        cwd: path.resolve(dir),
        absolute: true,
      });

      result.forEach((item) => {
        if (getTypeFromPath(item) !== collection.type) return;

        files.set(item, {
          path: path.relative(dir, item),
          absolutePath: item,
        });
      });
    }),
  );

  return Array.from(files.values());
}

type ImportInfo =
  | { name: string; type: 'default'; specifier: string }
  | {
      type: 'named';
      names: ([string, string] | string)[];
      specifier: string;
    }
  | {
      type: 'namespace';
      name: string;
      specifier: string;
    }
  | {
      type: 'side-effect';
      specifier: string;
    };

function getImportCode(info: ImportInfo): string {
  const specifier = JSON.stringify(info.specifier);

  if (info.type === 'default') return `import ${info.name} from ${specifier}`;
  if (info.type === 'namespace')
    return `import * as ${info.name} from ${specifier}`;
  if (info.type === 'named') {
    const names = info.names.map((name) =>
      Array.isArray(name) ? `${name[0]} as ${name[1]}` : name,
    );

    return `import { ${names.join(', ')} } from ${specifier}`;
  }

  return `import ${specifier}`;
}

export function toImportPath(file: string, dir: string): string {
  let importPath = path.relative(dir, file);

  if (!path.isAbsolute(importPath) && !importPath.startsWith('.')) {
    importPath = `./${importPath}`;
  }

  return importPath.replaceAll(path.sep, '/');
}

export function generateTypes(
  configPath: string,
  config: LoadedConfig,
  outputPath: string,
): string {
  const importPath = JSON.stringify(
    toImportPath(configPath, path.dirname(outputPath)),
  );
  const lines: string[] = [
    'import type { GetOutput } from "fumadocs-mdx/config"',
  ];

  for (const name of config.collections.keys()) {
    lines.push(
      `export declare const ${name}: GetOutput<typeof import(${importPath}).${name}>`,
    );
  }

  return lines.join('\n');
}
