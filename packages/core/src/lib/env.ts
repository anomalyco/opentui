import { singleton } from "./singleton.js"

/**
 * Environment variable registry
 *
 * Usage:
 * ```ts
 * import { registerEnvVar, env } from "./lib/env.ts";
 *
 * // Register environment variables
 * registerEnvVar({
 *   name: "DEBUG",
 *   description: "Enable debug logging",
 *   type: "boolean",
 *   default: false
 * });
 *
 * registerEnvVar({
 *   name: "PORT",
 *   description: "Server port number",
 *   type: "number",
 *   default: 3000
 * });
 *
 * // Access environment variables
 * if (env.DEBUG) {
 *   console.log("Debug mode enabled");
 * }
 *
 * const port = env.PORT; // number
 * ```
 */

export interface EnvVarConfig {
  name: string
  description: string
  default?: string | boolean | number
  required?: boolean
  type?: "string" | "boolean" | "number"
}

export const envRegistry: Record<string, EnvVarConfig> = singleton("env-registry", () => ({}))

export function registerEnvVar(config: EnvVarConfig): void {
  const existing = envRegistry[config.name]
  if (existing) {
    if (
      existing.description !== config.description ||
      existing.type !== config.type ||
      existing.default !== config.default ||
      existing.required !== config.required
    ) {
      throw new Error(
        `Environment variable "${config.name}" is already registered with different configuration. ` +
          `Existing: ${JSON.stringify(existing)}, New: ${JSON.stringify(config)}`,
      )
    }
    return
  }
  envRegistry[config.name] = config
}

function normalizeBoolean(value: string): boolean {
  const lowerValue = value.toLowerCase()
  return ["true", "1", "on", "yes"].includes(lowerValue)
}

function parseEnvValue(config: EnvVarConfig): string | boolean | number | undefined {
  const envValue = process.env[config.name]

  if (envValue === undefined && config.default !== undefined) {
    return config.default
  }

  if (envValue === undefined && config.required === false) {
    return undefined
  }

  if (envValue === undefined) {
    throw new Error(`Required environment variable ${config.name} is not set. ${config.description}`)
  }

  switch (config.type) {
    case "boolean":
      return typeof envValue === "boolean" ? envValue : normalizeBoolean(envValue)
    case "number":
      const numValue = Number(envValue)
      if (isNaN(numValue)) {
        throw new Error(`Environment variable ${config.name} must be a valid number, got: ${envValue}`)
      }
      return numValue
    case "string":
    default:
      return envValue
  }
}

class EnvStore {
  private parsedValues: Map<string, string | boolean | number | undefined> = new Map()

  get(key: string): any {
    if (this.parsedValues.has(key)) {
      return this.parsedValues.get(key)!
    }

    if (!(key in envRegistry)) {
      throw new Error(`Environment variable ${key} is not registered.`)
    }

    try {
      const value = parseEnvValue(envRegistry[key])
      this.parsedValues.set(key, value)
      return value
    } catch (error) {
      throw new Error(`Failed to parse env var ${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  has(key: string): boolean {
    return key in envRegistry
  }

  clearCache(): void {
    this.parsedValues.clear()
  }
}

const envStore = singleton("env-store", () => new EnvStore())

export function clearEnvCache(): void {
  envStore.clearCache()
}

export function generateEnvMarkdown(): string {
  const configs = Object.values(envRegistry)

  if (configs.length === 0) {
    return "# Environment Variables\n\nNo environment variables registered.\n"
  }

  let markdown = "# Environment Variables\n\n"

  for (const config of configs) {
    markdown += `## ${config.name}\n\n`
    markdown += `${config.description}\n\n`

    markdown += `**Type:** \`${config.type || "string"}\`  \n`

    if (config.default !== undefined) {
      const defaultValue = typeof config.default === "string" ? `"${config.default}"` : String(config.default)
      markdown += `**Default:** \`${defaultValue}\`\n`
    } else if (config.required === false) {
      markdown += "**Default:** *unset*\n"
    } else {
      markdown += "**Default:** *Required*\n"
    }

    markdown += "\n"
  }

  return markdown
}

export function generateEnvColored(): string {
  const configs = Object.values(envRegistry)

  if (configs.length === 0) {
    return "\x1b[1;36mEnvironment Variables\x1b[0m\n\nNo environment variables registered.\n"
  }

  let output = "\x1b[1;36mEnvironment Variables\x1b[0m\n\n"

  for (const config of configs) {
    output += `\x1b[1;33m${config.name}\x1b[0m\n`
    output += `${config.description}\n`
    output += `\x1b[32mType:\x1b[0m \x1b[36m${config.type || "string"}\x1b[0m\n`

    if (config.default !== undefined) {
      const defaultValue = typeof config.default === "string" ? `"${config.default}"` : String(config.default)
      output += `\x1b[32mDefault:\x1b[0m \x1b[35m${defaultValue}\x1b[0m\n`
    } else if (config.required === false) {
      output += "\x1b[32mDefault:\x1b[0m \x1b[35munset\x1b[0m\n"
    } else {
      output += `\x1b[32mDefault:\x1b[0m \x1b[31mRequired\x1b[0m\n`
    }

    output += "\n"
  }

  return output
}

export const env = new Proxy({} as Record<string, any>, {
  get(target, prop: string) {
    if (typeof prop !== "string") {
      return undefined
    }
    return envStore.get(prop)
  },

  has(target, prop: string) {
    return envStore.has(prop)
  },

  ownKeys() {
    return Object.keys(envRegistry)
  },

  getOwnPropertyDescriptor(target, prop: string) {
    if (envStore.has(prop)) {
      return {
        enumerable: true,
        configurable: true,
        get: () => envStore.get(prop),
      }
    }
    return undefined
  },
})
