import path from 'node:path'
import type { SFCBlock, SFCDescriptor } from '@vue/compiler-sfc'
import type {
  PluginContext,
  SourceMapInput,
  TransformPluginContext,
} from 'rollup'
import { SourceMapConsumer, type RawSourceMap } from 'source-map-js'
import type { EncodedSourceMap as TraceEncodedSourceMap } from '@jridgewell/trace-mapping'
import { TraceMap, eachMapping } from '@jridgewell/trace-mapping'
import type { EncodedSourceMap as GenEncodedSourceMap } from '@jridgewell/gen-mapping'
import { addMapping, fromMap, toEncodedMap } from '@jridgewell/gen-mapping'
import {
  createResolveErrorMsg,
  createRollupError,
  matchEasycom,
  normalizePath,
  offsetToStartAndEnd,
  parseUTSComponent,
  removeExt,
} from '@dcloudio/uni-cli-shared'
import type { CompilerError, Position } from '@vue/compiler-core'
import type { ImportSpecifier } from 'es-module-lexer'
import { createDescriptor, setSrcDescriptor } from '../descriptorCache'
import { resolveScript, scriptIdentifier } from './script'
import type { ResolvedOptions } from './index'
import {
  addAutoImports,
  addExtApiComponents,
  createResolveError,
  genClassName,
  parseImports,
  parseUTSImportFilename,
  parseUTSRelativeFilename,
  wrapResolve,
} from '../../utils'
import { genTemplateCode } from '../code/template'
import { generateCodeFrameColumns } from '@dcloudio/uni-cli-shared'
import { genComponentPublicInstanceImported } from '../compiler/utils'

export async function transformMain(
  code: string,
  filename: string,
  options: ResolvedOptions,
  pluginContext: TransformPluginContext,
  isAppVue: boolean = false
) {
  if (!options.compiler) {
    options.compiler = require('@vue/compiler-sfc')
  }
  const relativeFileName = parseUTSRelativeFilename(filename)

  const { descriptor, errors } = createDescriptor(filename, code, options)

  if (errors.length) {
    errors.forEach((error) =>
      pluginContext.error(createRollupError('', filename, error, code))
    )
    return null
  }

  // script
  const { code: scriptCode, map: scriptMap } = await genScriptCode(
    descriptor,
    options
  )

  const className = genClassName(relativeFileName)
  let templateCode = ''
  let templateMap = undefined
  let templateImportsCode = ''
  let templateImportEasyComponentsCode = ''
  let templateImportUTSComponentsCode = ''

  if (!isAppVue) {
    // template
    const inputRoot = normalizePath(options.root)
    const templateStartLine = descriptor.template?.loc.start.line ?? 0
    const templateResult = await genTemplateCode(descriptor, {
      ...options,
      mode: 'function',
      rootDir: options.root,
      filename: relativeFileName,
      className,
      prefixIdentifiers: true,
      inMap: descriptor.template?.map,
      matchEasyCom: (tag, uts) => {
        const source = matchEasycom(tag)
        if (uts && source) {
          if (source.startsWith(inputRoot)) {
            return '@/' + normalizePath(path.relative(inputRoot, source))
          }
          return parseUTSImportFilename(source)
        }
        return source
      },
      onWarn(warning) {
        onTemplateLog(
          'warn',
          warning,
          code,
          relativeFileName,
          templateStartLine
        )
      },
      onError(error) {
        onTemplateLog('error', error, code, relativeFileName, templateStartLine)
      },
      parseUTSComponent,
    })

    templateCode = templateResult.code
    templateMap = templateResult.map
    const {
      easyComponentAutoImports,
      elements,
      importEasyComponents,
      importUTSComponents,
      imports,
    } = templateResult

    templateImportEasyComponentsCode = importEasyComponents.join('\n')
    templateImportUTSComponentsCode = importUTSComponents.join('\n')
    templateImportsCode = imports.join('\n')

    Object.keys(easyComponentAutoImports).forEach((source) => {
      addAutoImports(source, easyComponentAutoImports[source])
    })

    if (process.env.NODE_ENV === 'production') {
      addExtApiComponents(
        elements.filter((element) => {
          // 如果是UTS原生组件，则无需记录摇树
          if (parseUTSComponent(element, 'kotlin')) {
            return false
          }
          return true
        })
      )
    }
  }

  // styles
  const stylesCode = await genStyleCode(descriptor, pluginContext)

  const utsOutput: string[] = [
    scriptCode ||
      `
export default {}
`,
    templateCode,
    `/*${className}Styles*/`,
  ]

  let resolvedMap: RawSourceMap | undefined = undefined
  if (options.sourceMap) {
    if (scriptMap && templateMap) {
      // if the template is inlined into the main module (indicated by the presence
      // of templateMap), we need to concatenate the two source maps.

      const gen = fromMap(
        // version property of result.map is declared as string
        // but actually it is `3`
        scriptMap as Omit<RawSourceMap, 'version'> as TraceEncodedSourceMap
      )
      const tracer = new TraceMap(
        // same above
        templateMap as Omit<RawSourceMap, 'version'> as TraceEncodedSourceMap
      )
      const offset = (scriptCode.match(/\r?\n/g)?.length ?? 0) + 1
      eachMapping(tracer, (m) => {
        if (m.source == null) return
        addMapping(gen, {
          source: m.source,
          original: { line: m.originalLine, column: m.originalColumn },
          generated: {
            line: m.generatedLine + offset,
            column: m.generatedColumn,
          },
        })
      })

      // same above
      resolvedMap = toEncodedMap(gen) as Omit<
        GenEncodedSourceMap,
        'version'
      > as RawSourceMap
      // if this is a template only update, we will be reusing a cached version
      // of the main module compile result, which has outdated sourcesContent.
      // resolvedMap.sourcesContent = templateMap.sourcesContent
    } else {
      // if one of `scriptMap` and `templateMap` is empty, use the other one
      resolvedMap = scriptMap ?? templateMap
    }
  }

  // handle TS transpilation
  const utsCode = utsOutput.join('\n')

  if (resolvedMap) {
    pluginContext.emitFile({
      type: 'asset',
      fileName: removeExt(relativeFileName) + '.map',
      source: JSON.stringify(resolvedMap),
    })
  }

  const jsCodes = [
    templateImportEasyComponentsCode,
    templateImportUTSComponentsCode,
    templateImportsCode,
  ]
  // 仅需要再解析script中的import，template上边已经加入了
  if (scriptCode) {
    jsCodes.push(
      await parseImports(
        scriptCode,
        resolvedMap
          ? createTryResolve(filename, pluginContext.resolve, resolvedMap)
          : undefined
      )
    )
    pluginContext.emitFile({
      type: 'asset',
      fileName: relativeFileName,
      source: utsCode,
    })
  }
  if (stylesCode) {
    jsCodes.push(stylesCode)
  }
  jsCodes.push(`export default "${className}"
export const ${genComponentPublicInstanceImported(
    options.root,
    relativeFileName
  )} = {}`)
  const jsCode = jsCodes.filter(Boolean).join('\n')

  return {
    code: jsCode,
    map: {
      mappings: '',
    } as SourceMapInput,
  }
}

async function genScriptCode(
  descriptor: SFCDescriptor,
  options: ResolvedOptions
): Promise<{
  code: string
  map: RawSourceMap | undefined
}> {
  let scriptCode = `const ${scriptIdentifier} = {}`
  let map: RawSourceMap | undefined

  const script = resolveScript(descriptor, options)
  if (script) {
    scriptCode = script.content
    map = script.map
  }
  return {
    code: scriptCode,
    map,
  }
}

async function genStyleCode(
  descriptor: SFCDescriptor,
  pluginContext: PluginContext
) {
  let stylesCode = ``
  if (descriptor.styles.length) {
    for (let i = 0; i < descriptor.styles.length; i++) {
      const style = descriptor.styles[i]
      if (style.src) {
        await linkSrcToDescriptor(style.src, descriptor, pluginContext)
      }
      const src = style.src || descriptor.filename
      // do not include module in default query, since we use it to indicate
      // that the module needs to export the modules json
      const attrsQuery = attrsToQuery(style.attrs, 'css')
      style.scoped = false // fixed by xxxxxx 强制不scoped
      const srcQuery = style.src
        ? style.scoped
          ? `&src=${descriptor.id}`
          : '&src=true'
        : ''
      const directQuery = ``
      const scopedQuery = style.scoped ? `&scoped=${descriptor.id}` : ``
      const query = `?vue&type=style&index=${i}${srcQuery}${directQuery}${scopedQuery}`
      const styleRequest = src + query + attrsQuery

      stylesCode += `\nimport ${JSON.stringify(styleRequest)}`
    }
    // TODO SSR critical CSS collection
  }

  return stylesCode
}

/**
 * For blocks with src imports, it is important to link the imported file
 * with its owner SFC descriptor so that we can get the information about
 * the owner SFC when compiling that file in the transform phase.
 */
async function linkSrcToDescriptor(
  src: string,
  descriptor: SFCDescriptor,
  pluginContext: PluginContext
) {
  const srcFile =
    (await pluginContext.resolve(src, descriptor.filename))?.id || src
  // #1812 if the src points to a dep file, the resolved id may contain a
  // version query.
  setSrcDescriptor(srcFile.replace(/\?.*$/, ''), descriptor)
}

// these are built-in query parameters so should be ignored
// if the user happen to add them as attrs
const ignoreList = [
  'id',
  'index',
  'src',
  'type',
  'lang',
  'module',
  'scoped',
  'generic',
]

function attrsToQuery(
  attrs: SFCBlock['attrs'],
  langFallback?: string,
  forceLangFallback = false
): string {
  let query = ``
  for (const name in attrs) {
    const value = attrs[name]
    if (!ignoreList.includes(name)) {
      query += `&${encodeURIComponent(name)}${
        value ? `=${encodeURIComponent(value)}` : ``
      }`
    }
  }
  if (langFallback || attrs.lang) {
    query +=
      `lang` in attrs
        ? forceLangFallback
          ? `&lang.${langFallback}`
          : `&lang.${attrs.lang}`
        : `&lang.${langFallback}`
  }
  return query
}

function createTryResolve(
  importer: string,
  resolve: PluginContext['resolve'],
  resolvedMap: RawSourceMap
) {
  return async (source: string, code: string, { ss, se }: ImportSpecifier) => {
    const resolved = await wrapResolve(resolve)(source, importer)
    if (!resolved) {
      const { start, end } = offsetToStartAndEnd(code, ss, se)
      const consumer = new SourceMapConsumer(resolvedMap)
      const startPos = consumer.originalPositionFor({
        line: start.line,
        column: start.column,
      })
      if (
        startPos.line != null &&
        startPos.column != null &&
        startPos.source != null
      ) {
        const endPos = consumer.originalPositionFor({
          line: end.line,
          column: end.column,
        })
        if (endPos.line != null && endPos.column != null) {
          startPos.column = startPos.column + 1
          endPos.column = endPos.column + 1
          throw createResolveError(
            consumer.sourceContentFor(startPos.source),
            createResolveErrorMsg(source, importer),
            startPos as unknown as Position,
            endPos as unknown as Position
          )
        }
      }
    }
  }
}

function onTemplateLog(
  type: 'warn' | 'error',
  error: CompilerError,
  code: string,
  relativeFileName: string,
  templateStartLine: number
) {
  console.error(type + ': ' + error.message)
  if (error.loc) {
    const start = error.loc.start
    console.log(
      'at ' +
        relativeFileName +
        ':' +
        (start.line + templateStartLine - 1) +
        ':' +
        (start.column - 1)
    )
    console.log(generateCodeFrameColumns(code, error.loc))
  }
}