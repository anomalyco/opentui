import { Parser, Query, Tree, Language } from "web-tree-sitter"
import type { Edit, QueryCapture, Range } from "web-tree-sitter"
import { mkdir } from "fs/promises"
import * as path from "path"
import type {
  HighlightRange,
  HighlightResponse,
  SimpleHighlight,
  FiletypeParserOptions,
  PerformanceStats,
  InjectionMapping,
  TreeSitterWorkerLogType,
  TreeSitterWorkerRequest,
  TreeSitterWorkerResponse,
} from "./types.js"
import { DownloadUtils } from "./download-utils.js"
import { isBunfsPath, normalizeBunfsPath } from "../bunfs.js"
import { resolveBundledFilePath } from "../../platform/runtime.js"
import {
  isWorkerRuntime,
  postWorkerMessage,
  setWorkerMessageHandler,
  type WorkerMessageEvent,
} from "../../platform/worker.js"

type ParserState = {
  parser: Parser
  tree: Tree
  queries: {
    highlights: Query
    injections?: Query
  }
  filetype: string
  content: string
  injectionMapping?: InjectionMapping
}

interface FiletypeParser {
  filetype: string
  queries: {
    highlights: Query
    injections?: Query
  }
  language: Language
  injectionMapping?: InjectionMapping
}

interface ReusableParserState {
  parser: Parser
  filetypeParser: FiletypeParser
  queries: {
    highlights: Query
    injections?: Query
  }
}

class ParserWorker {
  private bufferParsers: Map<number, ParserState> = new Map()
  private filetypeParserOptions: Map<string, FiletypeParserOptions> = new Map()
  private filetypeAliases: Map<string, string> = new Map()
  private filetypeParsers: Map<string, FiletypeParser> = new Map()
  private filetypeParserPromises: Map<string, Promise<FiletypeParser | undefined>> = new Map()
  private reusableParsers: Map<string, ReusableParserState> = new Map()
  private reusableParserPromises: Map<string, Promise<ReusableParserState | undefined>> = new Map()
  private initializePromise: Promise<void> | undefined
  public performance: PerformanceStats
  private dataPath: string | undefined
  private tsDataPath: string | undefined
  private initialized: boolean = false

  constructor() {
    this.performance = {
      averageParseTime: 0,
      parseTimes: [],
      averageQueryTime: 0,
      queryTimes: [],
    }
  }

  private async fetchQueries(sources: string[], filetype: string): Promise<string> {
    if (!this.tsDataPath) {
      return ""
    }
    return DownloadUtils.fetchHighlightQueries(sources, this.tsDataPath, filetype)
  }

  async initialize({ dataPath }: { dataPath: string }) {
    if (this.initializePromise) {
      return this.initializePromise
    }
    this.initializePromise = (async () => {
      this.dataPath = dataPath
      this.tsDataPath = path.join(dataPath, "tree-sitter")

      await mkdir(path.join(this.tsDataPath, "languages"), { recursive: true })
      await mkdir(path.join(this.tsDataPath, "queries"), { recursive: true })

      let treeWasm = await resolveBundledFilePath(
        () => import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } }),
        () => import.meta.resolve("web-tree-sitter/tree-sitter.wasm"),
        import.meta.url,
      )

      if (isBunfsPath(treeWasm)) {
        treeWasm = normalizeBunfsPath(path.parse(treeWasm).base)
      }

      await Parser.init({
        locateFile() {
          return treeWasm
        },
      })

      this.initialized = true
    })()
    return this.initializePromise
  }

  public addFiletypeParser(filetypeParser: FiletypeParserOptions) {
    const previousAliases = this.filetypeParserOptions.get(filetypeParser.filetype)?.aliases ?? []
    for (const alias of previousAliases) {
      if (this.filetypeAliases.get(alias) === filetypeParser.filetype) {
        this.filetypeAliases.delete(alias)
      }
    }

    const aliases = [...new Set((filetypeParser.aliases ?? []).filter((alias) => alias !== filetypeParser.filetype))]

    this.filetypeAliases.delete(filetypeParser.filetype)
    this.filetypeParserOptions.set(filetypeParser.filetype, {
      ...filetypeParser,
      aliases,
    })

    for (const alias of aliases) {
      this.filetypeAliases.set(alias, filetypeParser.filetype)
    }

    this.invalidateParserCaches(filetypeParser.filetype)
  }

  private resolveCanonicalFiletype(filetype: string): string {
    if (this.filetypeParserOptions.has(filetype)) {
      return filetype
    }

    return this.filetypeAliases.get(filetype) ?? filetype
  }

  private invalidateParserCaches(filetype: string): void {
    this.filetypeParsers.delete(filetype)
    this.filetypeParserPromises.delete(filetype)

    const reusableParser = this.reusableParsers.get(filetype)
    if (reusableParser) {
      reusableParser.parser.delete()
      this.reusableParsers.delete(filetype)
    }

    this.reusableParserPromises.delete(filetype)
  }

  private async createQueries(
    filetypeParser: FiletypeParserOptions,
    language: Language,
  ): Promise<
    | {
        highlights: Query
        injections?: Query
      }
    | undefined
  > {
    try {
      const highlightQueryContent = await this.fetchQueries(filetypeParser.queries.highlights, filetypeParser.filetype)
      if (!highlightQueryContent) {
        console.error("Failed to fetch highlight queries for:", filetypeParser.filetype)
        return undefined
      }

      const highlightsQuery = new Query(language, highlightQueryContent)
      const result: { highlights: Query; injections?: Query } = {
        highlights: highlightsQuery,
      }

      if (filetypeParser.queries.injections && filetypeParser.queries.injections.length > 0) {
        const injectionQueryContent = await this.fetchQueries(
          filetypeParser.queries.injections,
          filetypeParser.filetype,
        )
        if (injectionQueryContent) {
          result.injections = new Query(language, injectionQueryContent)
        }
      }

      return result
    } catch (error) {
      console.error("Error creating queries for", filetypeParser.filetype, filetypeParser.queries)
      console.error(error)
      return undefined
    }
  }

  private async loadLanguage(languageSource: string): Promise<Language | undefined> {
    if (!this.initialized || !this.tsDataPath) {
      return undefined
    }

    const result = await DownloadUtils.downloadOrLoad(languageSource, this.tsDataPath, "languages", ".wasm", false)

    if (result.error) {
      console.error(`Error loading language ${languageSource}:`, result.error)
      return undefined
    }

    if (!result.filePath) {
      return undefined
    }

    // Normalize path for Windows compatibility - tree-sitter expects forward slashes
    const normalizedPath = result.filePath.replaceAll("\\", "/")

    try {
      const language = await Language.load(normalizedPath)
      return language
    } catch (error) {
      console.error(`Error loading language from ${normalizedPath}:`, error)
      return undefined
    }
  }

  private async resolveFiletypeParser(filetype: string): Promise<FiletypeParser | undefined> {
    const canonicalFiletype = this.resolveCanonicalFiletype(filetype)

    if (this.filetypeParsers.has(canonicalFiletype)) {
      return this.filetypeParsers.get(canonicalFiletype)
    }

    if (this.filetypeParserPromises.has(canonicalFiletype)) {
      return this.filetypeParserPromises.get(canonicalFiletype)
    }

    const loadingPromise = this.loadFiletypeParser(canonicalFiletype)
    this.filetypeParserPromises.set(canonicalFiletype, loadingPromise)

    try {
      const result = await loadingPromise
      if (result) {
        this.filetypeParsers.set(canonicalFiletype, result)
      }
      return result
    } finally {
      this.filetypeParserPromises.delete(canonicalFiletype)
    }
  }

  private async loadFiletypeParser(filetype: string): Promise<FiletypeParser | undefined> {
    const filetypeParserOptions = this.filetypeParserOptions.get(filetype)
    if (!filetypeParserOptions) {
      return undefined
    }
    const language = await this.loadLanguage(filetypeParserOptions.wasm)
    if (!language) {
      return undefined
    }
    const queries = await this.createQueries(filetypeParserOptions, language)
    if (!queries) {
      console.error("Failed to create queries for:", filetype)
      return undefined
    }
    const filetypeParser: FiletypeParser = {
      ...filetypeParserOptions,
      queries,
      language,
    }
    return filetypeParser
  }

  public async preloadParser(filetype: string) {
    return this.resolveFiletypeParser(filetype)
  }

  private async getReusableParser(filetype: string): Promise<ReusableParserState | undefined> {
    const canonicalFiletype = this.resolveCanonicalFiletype(filetype)

    if (this.reusableParsers.has(canonicalFiletype)) {
      return this.reusableParsers.get(canonicalFiletype)
    }

    if (this.reusableParserPromises.has(canonicalFiletype)) {
      return this.reusableParserPromises.get(canonicalFiletype)
    }

    const creationPromise = this.createReusableParser(canonicalFiletype)
    this.reusableParserPromises.set(canonicalFiletype, creationPromise)

    try {
      const result = await creationPromise
      if (result) {
        this.reusableParsers.set(canonicalFiletype, result)
      }
      return result
    } finally {
      this.reusableParserPromises.delete(canonicalFiletype)
    }
  }

  private async createReusableParser(filetype: string): Promise<ReusableParserState | undefined> {
    const filetypeParser = await this.resolveFiletypeParser(filetype)
    if (!filetypeParser) {
      return undefined
    }

    const parser = new Parser()
    parser.setLanguage(filetypeParser.language)

    const reusableState: ReusableParserState = {
      parser,
      filetypeParser,
      queries: filetypeParser.queries,
    }

    return reusableState
  }

  async handleInitializeParser(
    bufferId: number,
    version: number,
    content: string,
    filetype: string,
    messageId: string,
  ) {
    const filetypeParser = await this.resolveFiletypeParser(filetype)

    if (!filetypeParser) {
      postWorkerMessage({
        type: "PARSER_INIT_RESPONSE",
        bufferId,
        messageId,
        hasParser: false,
        warning: `No parser available for filetype ${filetype}`,
      })
      return
    }

    const parser = new Parser()
    parser.setLanguage(filetypeParser.language)
    const tree = parser.parse(content)
    if (!tree) {
      postWorkerMessage({
        type: "PARSER_INIT_RESPONSE",
        bufferId,
        messageId,
        hasParser: false,
        error: "Failed to parse buffer",
      })
      return
    }

    const parserState: ParserState = {
      parser,
      tree,
      queries: filetypeParser.queries,
      filetype,
      content,
      injectionMapping: filetypeParser.injectionMapping,
    }
    this.bufferParsers.set(bufferId, parserState)

    postWorkerMessage({
      type: "PARSER_INIT_RESPONSE",
      bufferId,
      messageId,
      hasParser: true,
    })
    const highlights = await this.initialQuery(parserState)
    postWorkerMessage({
      type: "HIGHLIGHT_RESPONSE",
      bufferId,
      version,
      ...highlights,
    })
  }

  private async initialQuery(parserState: ParserState) {
    const query = parserState.queries.highlights
    const matches: QueryCapture[] = query.captures(parserState.tree.rootNode)
    let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()

    if (parserState.queries.injections) {
      const injectionResult = await this.processInjections(parserState)
      matches.push(...injectionResult.captures)
      injectionRanges = injectionResult.injectionRanges
    }

    return this.getHighlights(parserState, matches, injectionRanges)
  }

  private getNodeText(node: any, content: string): string {
    return content.substring(node.startIndex, node.endIndex)
  }

  private async processInjections(
    parserState: ParserState,
  ): Promise<{ captures: QueryCapture[]; injectionRanges: Map<string, Array<{ start: number; end: number }>> }> {
    const injectionMatches: QueryCapture[] = []
    const injectionRanges = new Map<string, Array<{ start: number; end: number }>>()

    if (!parserState.queries.injections) {
      return { captures: injectionMatches, injectionRanges }
    }

    const content = parserState.content
    const injectionCaptures = parserState.queries.injections.captures(parserState.tree.rootNode)
    const languageGroups = new Map<string, Array<{ node: any; name: string }>>()

    // Use the injection mapping stored in the parser state
    const injectionMapping = parserState.injectionMapping

    for (const capture of injectionCaptures) {
      const captureName = capture.name

      if (captureName === "injection.content" || captureName.includes("injection")) {
        const nodeType = capture.node.type
        let targetLanguage: string | undefined

        // First, check if there's a direct node type mapping
        if (injectionMapping?.nodeTypes && injectionMapping.nodeTypes[nodeType]) {
          targetLanguage = injectionMapping.nodeTypes[nodeType]
        } else if (nodeType === "code_fence_content") {
          // For code fence content, try to extract language from info_string
          const parent = capture.node.parent
          if (parent) {
            const infoString = parent.children.find((child: any) => child.type === "info_string")
            if (infoString) {
              const languageNode = infoString.children.find((child: any) => child.type === "language")
              if (languageNode) {
                const languageName = this.getNodeText(languageNode, content)

                if (injectionMapping?.infoStringMap && injectionMapping.infoStringMap[languageName]) {
                  targetLanguage = injectionMapping.infoStringMap[languageName]
                } else {
                  targetLanguage = languageName
                }
              }
            }
          }
        }

        if (targetLanguage) {
          if (!languageGroups.has(targetLanguage)) {
            languageGroups.set(targetLanguage, [])
          }
          languageGroups.get(targetLanguage)!.push({ node: capture.node, name: capture.name })
        }
      }
    }

    // Process each language group
    for (const [language, captures] of languageGroups.entries()) {
      const injectedParser = await this.getReusableParser(language)

      if (!injectedParser) {
        console.warn(`No parser found for injection language: ${language}`)
        continue
      }

      // Track injection ranges for this language
      if (!injectionRanges.has(language)) {
        injectionRanges.set(language, [])
      }

      const parser = injectedParser.parser
      for (const { node: injectionNode } of captures) {
        try {
          // Record the injection range
          injectionRanges.get(language)!.push({
            start: injectionNode.startIndex,
            end: injectionNode.endIndex,
          })

          const injectionContent = this.getNodeText(injectionNode, content)
          const tree = parser.parse(injectionContent)

          if (tree) {
            const matches = injectedParser.queries.highlights.captures(tree.rootNode)

            // Create new QueryCapture objects with offset positions
            for (const match of matches) {
              // Calculate offset positions by creating a new capture with adjusted node properties
              // Store the injected query reference so we can look up properties correctly
              const offsetCapture: QueryCapture & { _injectedQuery?: Query } = {
                name: match.name,
                patternIndex: match.patternIndex,
                _injectedQuery: injectedParser.queries.highlights, // Store the correct query reference
                node: {
                  ...match.node,
                  startPosition: {
                    row: match.node.startPosition.row + injectionNode.startPosition.row,
                    column:
                      match.node.startPosition.row === 0
                        ? match.node.startPosition.column + injectionNode.startPosition.column
                        : match.node.startPosition.column,
                  },
                  endPosition: {
                    row: match.node.endPosition.row + injectionNode.startPosition.row,
                    column:
                      match.node.endPosition.row === 0
                        ? match.node.endPosition.column + injectionNode.startPosition.column
                        : match.node.endPosition.column,
                  },
                  startIndex: match.node.startIndex + injectionNode.startIndex,
                  endIndex: match.node.endIndex + injectionNode.startIndex,
                } as any, // Cast to any since we're creating a pseudo-node
              }

              injectionMatches.push(offsetCapture)
            }

            tree.delete()
          }
        } catch (error) {
          console.error(`Error processing injection for language ${language}:`, error)
        }
      }

      // NOTE: Do NOT call parser.delete() here - this is a reusable parser!
    }

    return { captures: injectionMatches, injectionRanges }
  }

  private editToRange(edit: Edit): Range {
    return {
      startPosition: {
        column: edit.startPosition.column,
        row: edit.startPosition.row,
      },
      endPosition: {
        column: edit.newEndPosition.column,
        row: edit.newEndPosition.row,
      },
      startIndex: edit.startIndex,
      endIndex: edit.newEndIndex,
    }
  }

  async handleEdits(
    bufferId: number,
    content: string,
    edits: Edit[],
  ): Promise<{ highlights?: HighlightResponse[]; warning?: string; error?: string }> {
    const parserState = this.bufferParsers.get(bufferId)
    if (!parserState) {
      return { warning: "No parser state found for buffer" }
    }

    parserState.content = content

    for (const edit of edits) {
      parserState.tree.edit(edit)
    }

    const startParse = performance.now()

    const newTree = parserState.parser.parse(content, parserState.tree)

    const endParse = performance.now()
    const parseTime = endParse - startParse
    this.performance.parseTimes.push(parseTime)
    if (this.performance.parseTimes.length > 10) {
      this.performance.parseTimes.shift()
    }
    this.performance.averageParseTime =
      this.performance.parseTimes.reduce((acc, time) => acc + time, 0) / this.performance.parseTimes.length

    if (!newTree) {
      return { error: "Failed to parse buffer" }
    }

    const changedRanges = parserState.tree.getChangedRanges(newTree)
    parserState.tree = newTree

    const startQuery = performance.now()
    const matches: QueryCapture[] = []

    if (changedRanges.length === 0) {
      edits.forEach((edit) => {
        const range = this.editToRange(edit)
        changedRanges.push(range)
      })
    }

    for (const range of changedRanges) {
      let node = parserState.tree.rootNode.descendantForPosition(range.startPosition, range.endPosition)

      if (!node) {
        continue
      }

      // If we got the root node, query with range to limit scope
      if (node.equals(parserState.tree.rootNode)) {
        // WHY ARE RANGES NOT WORKING!?
        // The changed ranges are not returning anything in some cases
        // Even this shit somehow returns many lines before the actual range,
        // and even though expanded by 1000 bytes it does not capture much beyond the actual range.
        // So freaking weird.
        const rangeCaptures = parserState.queries.highlights.captures(
          node,
          // WTF!?
          {
            startIndex: range.startIndex - 100,
            endIndex: range.endIndex + 1000,
          },
        )
        matches.push(...rangeCaptures)
        continue
      }

      while (node && !this.nodeContainsRange(node, range)) {
        node = node.parent
      }

      if (!node) {
        node = parserState.tree.rootNode
      }

      const nodeCaptures = parserState.queries.highlights.captures(node)
      matches.push(...nodeCaptures)
    }

    let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()
    if (parserState.queries.injections) {
      const injectionResult = await this.processInjections(parserState)
      // Only add injection matches that are in the changed ranges
      // This is a simplification - ideally we'd only process injections in changed ranges
      matches.push(...injectionResult.captures)
      injectionRanges = injectionResult.injectionRanges
    }

    const endQuery = performance.now()
    const queryTime = endQuery - startQuery
    this.performance.queryTimes.push(queryTime)
    if (this.performance.queryTimes.length > 10) {
      this.performance.queryTimes.shift()
    }
    this.performance.averageQueryTime =
      this.performance.queryTimes.reduce((acc, time) => acc + time, 0) / this.performance.queryTimes.length

    return this.getHighlights(parserState, matches, injectionRanges)
  }

  private nodeContainsRange(node: any, range: any): boolean {
    return (
      node.startPosition.row <= range.startPosition.row &&
      node.endPosition.row >= range.endPosition.row &&
      (node.startPosition.row < range.startPosition.row || node.startPosition.column <= range.startPosition.column) &&
      (node.endPosition.row > range.endPosition.row || node.endPosition.column >= range.endPosition.column)
    )
  }

  private getHighlights(
    parserState: ParserState,
    matches: QueryCapture[],
    injectionRanges?: Map<string, Array<{ start: number; end: number }>>,
  ): { highlights: HighlightResponse[] } {
    const lineHighlights: Map<number, Map<number, HighlightRange>> = new Map()
    const droppedHighlights: Map<number, Map<number, HighlightRange>> = new Map()

    for (const match of matches) {
      const node = match.node
      const startLine = node.startPosition.row
      const endLine = node.endPosition.row

      const highlight = {
        startCol: node.startPosition.column,
        endCol: node.endPosition.column,
        group: match.name,
      }

      if (!lineHighlights.has(startLine)) {
        lineHighlights.set(startLine, new Map())
        droppedHighlights.set(startLine, new Map())
      }
      if (lineHighlights.get(startLine)?.has(node.id)) {
        droppedHighlights.get(startLine)?.set(node.id, lineHighlights.get(startLine)?.get(node.id)!)
      }
      lineHighlights.get(startLine)?.set(node.id, highlight)

      if (startLine !== endLine) {
        for (let line = startLine + 1; line <= endLine; line++) {
          if (!lineHighlights.has(line)) {
            lineHighlights.set(line, new Map())
          }
          const hl: HighlightRange = {
            startCol: 0,
            endCol: node.endPosition.column,
            group: match.name,
          }
          lineHighlights.get(line)?.set(node.id, hl)
        }
      }
    }

    return {
      highlights: Array.from(lineHighlights.entries()).map(([line, lineHighlights]) => ({
        line,
        highlights: Array.from(lineHighlights.values()),
        droppedHighlights: droppedHighlights.get(line) ? Array.from(droppedHighlights.get(line)!.values()) : [],
      })),
    }
  }

  private getSimpleHighlights(
    matches: QueryCapture[],
    injectionRanges: Map<string, Array<{ start: number; end: number }>>,
  ): SimpleHighlight[] {
    const highlights: SimpleHighlight[] = []

    const flatInjectionRanges: Array<{ start: number; end: number; lang: string }> = []
    for (const [lang, ranges] of injectionRanges.entries()) {
      for (const range of ranges) {
        flatInjectionRanges.push({ ...range, lang })
      }
    }

    for (const match of matches) {
      const node = match.node

      let isInjection = false
      let injectionLang: string | undefined
      let containsInjection = false
      for (const injRange of flatInjectionRanges) {
        if (node.startIndex >= injRange.start && node.endIndex <= injRange.end) {
          isInjection = true
          injectionLang = injRange.lang
          break
        } else if (node.startIndex <= injRange.start && node.endIndex >= injRange.end) {
          containsInjection = true
          break
        }
      }

      const matchQuery = (match as any)._injectedQuery
      const patternProperties = matchQuery?.setProperties?.[match.patternIndex]

      const concealValue = patternProperties?.conceal ?? match.setProperties?.conceal
      const concealLines = patternProperties?.conceal_lines ?? match.setProperties?.conceal_lines

      const meta: any = {}
      if (isInjection && injectionLang) {
        meta.isInjection = true
        meta.injectionLang = injectionLang
      }
      if (containsInjection) {
        meta.containsInjection = true
      }
      if (concealValue !== undefined) {
        meta.conceal = concealValue
      }
      if (concealLines !== undefined) {
        meta.concealLines = concealLines
      }

      if (Object.keys(meta).length > 0) {
        highlights.push([node.startIndex, node.endIndex, match.name, meta])
      } else {
        highlights.push([node.startIndex, node.endIndex, match.name])
      }
    }

    highlights.sort((a, b) => a[0] - b[0])

    return highlights
  }

  async handleResetBuffer(
    bufferId: number,
    version: number,
    content: string,
  ): Promise<{ highlights?: HighlightResponse[]; warning?: string; error?: string }> {
    const parserState = this.bufferParsers.get(bufferId)
    if (!parserState) {
      return { warning: "No parser state found for buffer" }
    }

    parserState.content = content

    const newTree = parserState.parser.parse(content)

    if (!newTree) {
      return { error: "Failed to parse buffer during reset" }
    }

    parserState.tree = newTree
    const matches = parserState.queries.highlights.captures(parserState.tree.rootNode)

    let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()
    if (parserState.queries.injections) {
      const injectionResult = await this.processInjections(parserState)
      matches.push(...injectionResult.captures)
      injectionRanges = injectionResult.injectionRanges
    }

    return this.getHighlights(parserState, matches, injectionRanges)
  }

  disposeBuffer(bufferId: number): void {
    const parserState = this.bufferParsers.get(bufferId)
    if (!parserState) {
      return
    }

    parserState.tree.delete()
    parserState.parser.delete()

    this.bufferParsers.delete(bufferId)
  }

  async handleOneShotHighlight(content: string, filetype: string, messageId: string): Promise<void> {
    const reusableState = await this.getReusableParser(filetype)

    if (!reusableState) {
      postWorkerMessage({
        type: "ONESHOT_HIGHLIGHT_RESPONSE",
        messageId,
        hasParser: false,
        warning: `No parser available for filetype ${filetype}`,
      })
      return
    }

    // Markdown Parser BUG: For markdown, ensure content ends with newline so closing delimiters are parsed correctly
    // The tree-sitter markdown parser only creates closing delimiter nodes when followed by newline
    const parseContent = filetype === "markdown" && content.endsWith("```") ? content + "\n" : content

    const tree = reusableState.parser.parse(parseContent)

    if (!tree) {
      postWorkerMessage({
        type: "ONESHOT_HIGHLIGHT_RESPONSE",
        messageId,
        hasParser: false,
        error: "Failed to parse content",
      })
      return
    }

    try {
      const matches = reusableState.filetypeParser.queries.highlights.captures(tree.rootNode)

      let injectionRanges = new Map<string, Array<{ start: number; end: number }>>()
      if (reusableState.filetypeParser.queries.injections) {
        const parserState: ParserState = {
          parser: reusableState.parser,
          tree,
          queries: reusableState.filetypeParser.queries,
          filetype,
          content,
          injectionMapping: reusableState.filetypeParser.injectionMapping,
        }
        const injectionResult = await this.processInjections(parserState)

        matches.push(...injectionResult.captures)
        injectionRanges = injectionResult.injectionRanges
      }

      const highlights = this.getSimpleHighlights(matches, injectionRanges)

      postWorkerMessage({
        type: "ONESHOT_HIGHLIGHT_RESPONSE",
        messageId,
        hasParser: true,
        highlights,
      })
    } finally {
      tree.delete()
    }
  }

  async updateDataPath(dataPath: string): Promise<void> {
    this.dataPath = dataPath
    this.tsDataPath = path.join(dataPath, "tree-sitter")

    try {
      await mkdir(path.join(this.tsDataPath, "languages"), { recursive: true })
      await mkdir(path.join(this.tsDataPath, "queries"), { recursive: true })
    } catch (error) {
      throw new Error(`Failed to update data path: ${error}`)
    }
  }

  async clearCache(): Promise<void> {
    if (!this.dataPath || !this.tsDataPath) {
      throw new Error("No data path configured")
    }

    const { rm } = await import("fs/promises")

    try {
      const treeSitterPath = path.join(this.dataPath, "tree-sitter")

      await rm(treeSitterPath, { recursive: true, force: true })

      await mkdir(path.join(treeSitterPath, "languages"), { recursive: true })
      await mkdir(path.join(treeSitterPath, "queries"), { recursive: true })

      this.filetypeParsers.clear()
      this.filetypeParserPromises.clear()
      this.reusableParsers.clear()
      this.reusableParserPromises.clear()
    } catch (error) {
      throw new Error(`Failed to clear cache: ${error}`)
    }
  }
}

function logMessage(type: TreeSitterWorkerLogType, ...args: unknown[]): void {
  postWorkerMessage({
    type: "WORKER_LOG",
    logType: type,
    data: args,
  } satisfies TreeSitterWorkerResponse)
}

function postWorkerError(bufferId: number | undefined, error: unknown): void {
  postWorkerMessage({
    type: "ERROR",
    bufferId,
    error: error instanceof Error ? error.stack || error.message : String(error),
  } satisfies TreeSitterWorkerResponse)
}

if (isWorkerRuntime) {
  const worker = new ParserWorker()

  console.log = (...args) => logMessage("log", ...args)
  console.error = (...args) => logMessage("error", ...args)
  console.warn = (...args) => logMessage("warn", ...args)

  setWorkerMessageHandler<TreeSitterWorkerRequest>(async (event: WorkerMessageEvent<TreeSitterWorkerRequest>) => {
    const message = event.data
    const messageType = String((event.data as { type?: unknown }).type ?? "unknown")

    try {
      switch (message.type) {
        case "INIT":
          try {
            await worker.initialize({ dataPath: message.dataPath })
            postWorkerMessage({ type: "INIT_RESPONSE" } satisfies TreeSitterWorkerResponse)
          } catch (error) {
            postWorkerMessage({
              type: "INIT_RESPONSE",
              error: error instanceof Error ? error.stack || error.message : String(error),
            } satisfies TreeSitterWorkerResponse)
          }
          break

        case "ADD_FILETYPE_PARSER":
          worker.addFiletypeParser(message.filetypeParser)
          break

        case "PRELOAD_PARSER": {
          const maybeParser = await worker.preloadParser(message.filetype)
          postWorkerMessage({
            type: "PRELOAD_PARSER_RESPONSE",
            messageId: message.messageId,
            hasParser: !!maybeParser,
          } satisfies TreeSitterWorkerResponse)
          break
        }

        case "INITIALIZE_PARSER":
          await worker.handleInitializeParser(
            message.bufferId,
            message.version,
            message.content,
            message.filetype,
            message.messageId,
          )
          break

        case "HANDLE_EDITS": {
          const response = await worker.handleEdits(message.bufferId, message.content, message.edits)
          if (response.highlights && response.highlights.length > 0) {
            postWorkerMessage({
              type: "HIGHLIGHT_RESPONSE",
              bufferId: message.bufferId,
              version: message.version,
              highlights: response.highlights,
            } satisfies TreeSitterWorkerResponse)
          } else if (response.warning) {
            postWorkerMessage({
              type: "WARNING",
              bufferId: message.bufferId,
              warning: response.warning,
            } satisfies TreeSitterWorkerResponse)
          } else if (response.error) {
            postWorkerMessage({
              type: "ERROR",
              bufferId: message.bufferId,
              error: response.error,
            } satisfies TreeSitterWorkerResponse)
          }
          break
        }

        case "GET_PERFORMANCE":
          postWorkerMessage({
            type: "PERFORMANCE_RESPONSE",
            performance: worker.performance,
            messageId: message.messageId,
          } satisfies TreeSitterWorkerResponse)
          break

        case "RESET_BUFFER": {
          const resetResponse = await worker.handleResetBuffer(message.bufferId, message.version, message.content)
          if (resetResponse.highlights && resetResponse.highlights.length > 0) {
            postWorkerMessage({
              type: "HIGHLIGHT_RESPONSE",
              bufferId: message.bufferId,
              version: message.version,
              highlights: resetResponse.highlights,
            } satisfies TreeSitterWorkerResponse)
          } else if (resetResponse.warning) {
            postWorkerMessage({
              type: "WARNING",
              bufferId: message.bufferId,
              warning: resetResponse.warning,
            } satisfies TreeSitterWorkerResponse)
          } else if (resetResponse.error) {
            postWorkerMessage({
              type: "ERROR",
              bufferId: message.bufferId,
              error: resetResponse.error,
            } satisfies TreeSitterWorkerResponse)
          }
          break
        }

        case "DISPOSE_BUFFER":
          worker.disposeBuffer(message.bufferId)
          postWorkerMessage({
            type: "BUFFER_DISPOSED",
            bufferId: message.bufferId,
          } satisfies TreeSitterWorkerResponse)
          break

        case "ONESHOT_HIGHLIGHT":
          await worker.handleOneShotHighlight(message.content, message.filetype, message.messageId)
          break

        case "UPDATE_DATA_PATH":
          try {
            await worker.updateDataPath(message.dataPath)
            postWorkerMessage({
              type: "UPDATE_DATA_PATH_RESPONSE",
              messageId: message.messageId,
            } satisfies TreeSitterWorkerResponse)
          } catch (error) {
            postWorkerMessage({
              type: "UPDATE_DATA_PATH_RESPONSE",
              messageId: message.messageId,
              error: error instanceof Error ? error.message : String(error),
            } satisfies TreeSitterWorkerResponse)
          }
          break

        case "CLEAR_CACHE":
          try {
            await worker.clearCache()
            postWorkerMessage({
              type: "CLEAR_CACHE_RESPONSE",
              messageId: message.messageId,
            } satisfies TreeSitterWorkerResponse)
          } catch (error) {
            postWorkerMessage({
              type: "CLEAR_CACHE_RESPONSE",
              messageId: message.messageId,
              error: error instanceof Error ? error.message : String(error),
            } satisfies TreeSitterWorkerResponse)
          }
          break

        default:
          postWorkerMessage({
            type: "ERROR",
            error: `Unknown message type: ${messageType}`,
          } satisfies TreeSitterWorkerResponse)
      }
    } catch (error) {
      if ("bufferId" in message) {
        postWorkerError(message.bufferId, error)
      } else {
        postWorkerError(undefined, error)
      }
    }
  })
}
