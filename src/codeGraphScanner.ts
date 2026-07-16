import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { scanRepoFiles } from './repoFiles.js'
import type { CodeGraph, CodeGraphEdge, CodeGraphImportKind } from './types.js'

const CODE_EXTENSIONS = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'] as const
const CODE_EXTENSION_SET = new Set<string>(CODE_EXTENSIONS)
const MAX_REPO_FILES = 5_000

type ImportReference = {
  kind: CodeGraphImportKind
  specifier: string
}

export async function scanCodeGraph(repoPath: string): Promise<CodeGraph> {
  const root = path.resolve(repoPath)
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error(`Repo path is not a directory: ${root}`)

  const repoFiles = await scanRepoFiles(root, MAX_REPO_FILES)
  if (repoFiles.truncated) {
    throw new Error(`Code graph scan stopped because the repository contains more than ${MAX_REPO_FILES} files.`)
  }
  const files = repoFiles.files.filter(isCodeFile).map(normalizePath).sort()

  const fileSet = new Set(files)
  const repoName = await readRepoName(root)
  const edges: CodeGraphEdge[] = []
  const edgeIds = new Set<string>()
  const importsByFile = new Map<string, CodeGraphEdge[]>()
  const exportsByFile = new Map<string, string[]>()
  const unresolvedImports: CodeGraph['unresolvedImports'] = []
  let externalImportCount = 0

  for (const file of files) {
    const source = await fs.readFile(path.join(root, file), 'utf8')
    const syntax = extractGraphSyntax(file, source)
    exportsByFile.set(file, syntax.exports)

    for (const reference of syntax.imports) {
      if (!isRelativeImport(reference.specifier)) {
        externalImportCount += 1
        continue
      }

      const target = resolveLocalImport(file, reference.specifier, fileSet)
      if (!target) {
        unresolvedImports.push({ from: file, specifier: reference.specifier })
        continue
      }

      const id = edgeId(file, target, reference.kind)
      if (edgeIds.has(id)) continue
      edgeIds.add(id)
      const edge = {
        id,
        from: file,
        to: target,
        kind: reference.kind,
        fingerprint: fingerprint({ from: file, to: target, kind: reference.kind }),
      }
      edges.push(edge)
      const fileImports = importsByFile.get(file) ?? []
      fileImports.push(edge)
      importsByFile.set(file, fileImports)
    }
  }

  edges.sort((a, b) => a.id.localeCompare(b.id))
  unresolvedImports.sort((a, b) => `${a.from}:${a.specifier}`.localeCompare(`${b.from}:${b.specifier}`))

  const nodes = files.map((file) => {
    const localImports = (importsByFile.get(file) ?? []).sort((a, b) => a.id.localeCompare(b.id))
    return {
      id: file,
      label: file,
      sourcePath: file,
      fingerprint: fingerprint({
        exports: exportsByFile.get(file) ?? [],
        imports: localImports.map((edge) => ({ id: edge.id, fingerprint: edge.fingerprint })),
      }),
      localImportCount: localImports.length,
    }
  })

  return {
    repoName,
    repoPath: root,
    nodes,
    edges,
    externalImportCount,
    unresolvedImports,
  }
}

function isCodeFile(file: string) {
  return CODE_EXTENSION_SET.has(path.extname(file).toLowerCase())
}

async function readRepoName(root: string) {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { name?: string }
    return packageJson.name?.trim() || path.basename(root)
  } catch {
    return path.basename(root)
  }
}

function extractGraphSyntax(file: string, source: string) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  const references: ImportReference[] = []
  const exports = extractExports(sourceFile)

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({ kind: 'import', specifier: node.moduleSpecifier.text })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({ kind: 're-export', specifier: node.moduleSpecifier.text })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      references.push({ kind: 'require', specifier: node.moduleReference.expression.text })
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        references.push({ kind: 'dynamic-import', specifier: node.arguments[0].text })
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        references.push({ kind: 'require', specifier: node.arguments[0].text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const seen = new Set<string>()
  const imports = references.filter((reference) => {
    const key = `${reference.kind}:${reference.specifier}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { imports, exports }
}

function extractExports(sourceFile: ts.SourceFile) {
  const exports = new Set<string>()

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      exports.add('default')
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) exports.add('star')
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) exports.add(`named:${element.name.text}`)
      } else {
        exports.add(`namespace:${statement.exportClause.name.text}`)
      }
      continue
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) exports.add('default')

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) exports.add(`variable:${name}`)
      }
      continue
    }

    const declaration = statement as ts.Statement & { name?: ts.Identifier }
    if (declaration.name) exports.add(`${ts.SyntaxKind[statement.kind]}:${declaration.name.text}`)
  }
  return [...exports].sort()
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind.ExportKeyword | ts.SyntaxKind.DefaultKeyword) {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind))
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
}

function scriptKind(file: string) {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') return ts.ScriptKind.JS
  if (extension === '.jsx') return ts.ScriptKind.JSX
  if (extension === '.tsx') return ts.ScriptKind.TSX
  return ts.ScriptKind.TS
}

function isRelativeImport(specifier: string) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

function resolveLocalImport(from: string, specifier: string, files: Set<string>) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0]
  const base = normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(from), cleanSpecifier)))
  if (base.startsWith('../') || base === '..') return null

  for (const candidate of importCandidates(base)) {
    if (files.has(candidate)) return candidate
  }
  return null
}

function importCandidates(base: string) {
  const candidates = new Set<string>([base])
  const extension = path.posix.extname(base).toLowerCase()

  if (!extension) {
    for (const codeExtension of CODE_EXTENSIONS) {
      candidates.add(`${base}${codeExtension}`)
      candidates.add(`${base}/index${codeExtension}`)
    }
  } else {
    const withoutExtension = base.slice(0, -extension.length)
    const sourceExtensions: Partial<Record<string, readonly string[]>> = {
      '.cjs': ['.cts'],
      '.js': ['.ts', '.tsx'],
      '.jsx': ['.tsx'],
      '.mjs': ['.mts'],
    }
    for (const sourceExtension of sourceExtensions[extension] ?? []) {
      candidates.add(`${withoutExtension}${sourceExtension}`)
    }
  }

  return [...candidates]
}

function edgeId(from: string, to: string, kind: CodeGraphImportKind) {
  return `${kind}:${from}=>${to}`
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
}

function normalizePath(value: string) {
  return value.split(path.sep).join('/')
}
