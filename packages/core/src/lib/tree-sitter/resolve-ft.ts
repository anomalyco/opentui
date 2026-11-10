import path from "node:path"

export const extensionToFiletype: Map<string, string> = new Map([
  ["astro", "astro"],
  ["bash", "bash"],
  ["c", "c"],
  ["cc", "cpp"],
  ["cjs", "javascript"],
  ["clj", "clojure"],
  ["cljs", "clojure"],
  ["cljc", "clojure"],
  ["cpp", "cpp"],
  ["cxx", "cpp"],
  ["cs", "csharp"],
  ["cts", "typescript"],
  ["ctsx", "typescriptreact"],
  ["dart", "dart"],
  ["diff", "diff"],
  ["edn", "clojure"],
  ["go", "go"],
  ["gemspec", "ruby"],
  ["groovy", "groovy"],
  ["h", "c"],
  ["handlebars", "handlebars"],
  ["hbs", "handlebars"],
  ["hpp", "cpp"],
  ["hxx", "cpp"],
  ["h++", "cpp"],
  ["hh", "cpp"],
  ["hrl", "erlang"],
  ["hs", "haskell"],
  ["htm", "html"],
  ["html", "html"],
  ["ini", "ini"],
  ["js", "javascript"],
  ["jsx", "javascriptreact"],
  ["jl", "julia"],
  ["json", "json"],
  ["ksh", "bash"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["latex", "latex"],
  ["less", "less"],
  ["lua", "lua"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["mdown", "markdown"],
  ["mkd", "markdown"],
  ["mjs", "javascript"],
  ["ml", "ocaml"],
  ["mli", "ocaml"],
  ["mts", "typescript"],
  ["mtsx", "typescriptreact"],
  ["patch", "diff"],
  ["php", "php"],
  ["pl", "perl"],
  ["pm", "perl"],
  ["ps1", "powershell"],
  ["psm1", "powershell"],
  ["py", "python"],
  ["pyi", "python"],
  ["r", "r"],
  ["rb", "ruby"],
  ["rake", "ruby"],
  ["rs", "rust"],
  ["ru", "ruby"],
  ["sass", "sass"],
  ["sc", "scala"],
  ["scala", "scala"],
  ["scss", "scss"],
  ["sh", "bash"],
  ["sql", "sql"],
  ["svelte", "svelte"],
  ["swift", "swift"],
  ["ts", "typescript"],
  ["tsx", "typescriptreact"],
  ["tex", "latex"],
  ["toml", "toml"],
  ["vue", "vue"],
  ["vim", "vim"],
  ["xml", "xml"],
  ["xsl", "xsl"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["zig", "zig"],
  ["zon", "zig"],
  ["zsh", "bash"],
  ["c++", "cpp"],
  ["erl", "erlang"],
  ["exs", "elixir"],
  ["ex", "elixir"],
  ["elm", "elm"],
  ["fsharp", "fsharp"],
  ["fs", "fsharp"],
  ["fsx", "fsharp"],
  ["fsscript", "fsharp"],
  ["fsi", "fsharp"],
  ["java", "java"],
  ["css", "css"],
])

export const basenameToFiletype: Map<string, string> = new Map([
  [".bash_aliases", "bash"],
  [".bash_logout", "bash"],
  [".bash_profile", "bash"],
  [".bashrc", "bash"],
  [".kshrc", "bash"],
  [".profile", "bash"],
  [".vimrc", "vim"],
  [".zlogin", "bash"],
  [".zlogout", "bash"],
  [".zprofile", "bash"],
  [".zshenv", "bash"],
  [".zshrc", "bash"],
  ["appfile", "ruby"],
  ["berksfile", "ruby"],
  ["brewfile", "ruby"],
  ["cheffile", "ruby"],
  ["containerfile", "dockerfile"],
  ["dockerfile", "dockerfile"],
  ["fastfile", "ruby"],
  ["gemfile", "ruby"],
  ["gnumakefile", "make"],
  ["gvimrc", "vim"],
  ["guardfile", "ruby"],
  ["makefile", "make"],
  ["podfile", "ruby"],
  ["rakefile", "ruby"],
  ["thorfile", "ruby"],
  ["vagrantfile", "ruby"],
])

function normalizeFiletypeToken(value: string): string | undefined {
  const normalizedValue = value.trim().replace(/^\./, "").toLowerCase()
  return normalizedValue || undefined
}

function getBasename(value: string): string | undefined {
  const normalizedValue = value.trim().replaceAll("\\", "/")
  if (!normalizedValue) return undefined

  const basename = path.posix.basename(normalizedValue).toLowerCase()
  return basename || undefined
}

export function extToFiletype(extension: string): string | undefined {
  const normalizedExtension = normalizeFiletypeToken(extension)
  if (!normalizedExtension) return undefined

  return extensionToFiletype.get(normalizedExtension)
}

export function pathToFiletype(path: string): string | undefined {
  if (typeof path !== "string") return undefined

  const basename = getBasename(path)
  if (!basename) return undefined

  const basenameFiletype = basenameToFiletype.get(basename)
  if (basenameFiletype) {
    return basenameFiletype
  }

  const lastDot = basename.lastIndexOf(".")
  if (lastDot === -1 || lastDot === basename.length - 1) {
    return undefined
  }

  const extension = basename.substring(lastDot + 1)
  return extToFiletype(extension)
}

export function infoStringToFiletype(infoString: string): string | undefined {
  if (typeof infoString !== "string") return undefined

  const token = infoString.trim().split(/\s+/, 1)[0]
  const directBasenameMatch = basenameToFiletype.get(token.toLowerCase())
  if (directBasenameMatch) return directBasenameMatch

  const normalizedToken = normalizeFiletypeToken(token)
  if (!normalizedToken) return undefined

  return (
    basenameToFiletype.get(normalizedToken) ??
    pathToFiletype(normalizedToken) ??
    extToFiletype(normalizedToken) ??
    normalizedToken
  )
}
