import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { envRegistry, registerEnvVar, env, clearEnvCache } from "./env.js"

// Backup and restore registry to avoid interfering with module-level registrations
let registryBackup: Record<string, any> = {}

beforeEach(() => {
  registryBackup = { ...envRegistry }

  clearEnvCache()

  Object.keys(process.env).forEach((key) => {
    if (key.startsWith("TEST_")) {
      delete process.env[key]
    }
  })
})

afterEach(() => {
  Object.keys(envRegistry).forEach((key) => {
    if (key.startsWith("TEST_") && !(key in registryBackup)) {
      delete envRegistry[key]
    }
  })

  Object.keys(process.env).forEach((key) => {
    if (key.startsWith("TEST_")) {
      delete process.env[key]
    }
  })
})

describe("env registry", () => {
  test("should register and access string env vars", () => {
    registerEnvVar({
      name: "TEST_STRING",
      description: "A test string variable",
      type: "string",
      default: "default_value",
    })

    // Set env var
    process.env.TEST_STRING = "test_value"

    expect(env.TEST_STRING).toBe("test_value")
  })

  test("should handle boolean env vars with various true values", () => {
    registerEnvVar({
      name: "TEST_BOOL_TRUE",
      description: "A test boolean variable",
      type: "boolean",
    })

    // Test various true values
    process.env.TEST_BOOL_TRUE = "true"
    expect(env.TEST_BOOL_TRUE).toBe(true)

    process.env.TEST_BOOL_TRUE = "1"
    expect(env.TEST_BOOL_TRUE).toBe(true)

    process.env.TEST_BOOL_TRUE = "on"
    expect(env.TEST_BOOL_TRUE).toBe(true)

    process.env.TEST_BOOL_TRUE = "yes"
    expect(env.TEST_BOOL_TRUE).toBe(true)
  })

  test("should handle boolean env vars with various false values", () => {
    registerEnvVar({
      name: "TEST_BOOL_FALSE",
      description: "A test boolean variable",
      type: "boolean",
    })

    // Test various false values
    process.env.TEST_BOOL_FALSE = "false"
    expect(env.TEST_BOOL_FALSE).toBe(false)

    process.env.TEST_BOOL_FALSE = "0"
    expect(env.TEST_BOOL_FALSE).toBe(false)

    process.env.TEST_BOOL_FALSE = "off"
    expect(env.TEST_BOOL_FALSE).toBe(false)
  })

  test("should handle number env vars", () => {
    registerEnvVar({
      name: "TEST_NUMBER",
      description: "A test number variable",
      type: "number",
    })

    process.env.TEST_NUMBER = "42"
    expect(env.TEST_NUMBER).toBe(42)
  })

  test("should throw error for invalid number", () => {
    registerEnvVar({
      name: "TEST_INVALID_NUMBER",
      description: "A test number variable",
      type: "number",
    })

    process.env.TEST_INVALID_NUMBER = "not_a_number"

    expect(() => env.TEST_INVALID_NUMBER).toThrow("must be a valid number")
  })

  test("should use default values when env var not set", () => {
    registerEnvVar({
      name: "TEST_DEFAULT",
      description: "A test variable with default",
      type: "string",
      default: "default_value",
    })

    // Don't set the env var
    expect(env.TEST_DEFAULT).toBe("default_value")
  })

  test("should throw error for required env var not set", () => {
    registerEnvVar({
      name: "TEST_REQUIRED",
      description: "A required test variable",
    })

    expect(() => env.TEST_REQUIRED).toThrow("Required environment variable TEST_REQUIRED is not set")
  })

  test("should throw error for unregistered env var", () => {
    expect(() => env.UNREGISTERED_VAR).toThrow("Environment variable UNREGISTERED_VAR is not registered")
  })

  test("should support proxy enumeration", () => {
    registerEnvVar({
      name: "TEST_ENUM_1",
      description: "First test var",
      default: "value1",
    })

    registerEnvVar({
      name: "TEST_ENUM_2",
      description: "Second test var",
      default: "value2",
    })

    const keys = Object.keys(env)
    expect(keys).toContain("TEST_ENUM_1")
    expect(keys).toContain("TEST_ENUM_2")
  })

  test("should support 'in' operator", () => {
    registerEnvVar({
      name: "TEST_IN_OPERATOR",
      description: "Test for 'in' operator",
      default: "test",
    })

    expect("TEST_IN_OPERATOR" in env).toBe(true)
    expect("NON_EXISTENT" in env).toBe(false)
  })

  test("should allow re-registering identical configuration", () => {
    const config = {
      name: "TEST_IDENTICAL",
      description: "Test for identical re-registration",
      type: "boolean" as const,
      default: false,
    }

    registerEnvVar(config)
    // Should not throw
    registerEnvVar(config)

    expect("TEST_IDENTICAL" in env).toBe(true)
  })

  test("should throw when re-registering with different type", () => {
    registerEnvVar({
      name: "TEST_DIFFERENT_TYPE",
      description: "Test for different type",
      type: "string",
    })

    expect(() => {
      registerEnvVar({
        name: "TEST_DIFFERENT_TYPE",
        description: "Test for different type",
        type: "boolean",
      })
    }).toThrow("already registered with different configuration")
  })

  test("should throw when re-registering with different default", () => {
    registerEnvVar({
      name: "TEST_DIFFERENT_DEFAULT",
      description: "Test for different default",
      type: "string",
      default: "first",
    })

    expect(() => {
      registerEnvVar({
        name: "TEST_DIFFERENT_DEFAULT",
        description: "Test for different default",
        type: "string",
        default: "second",
      })
    }).toThrow("already registered with different configuration")
  })

  test("should throw when re-registering with different description", () => {
    registerEnvVar({
      name: "TEST_DIFFERENT_DESC",
      description: "First description",
      type: "string",
    })

    expect(() => {
      registerEnvVar({
        name: "TEST_DIFFERENT_DESC",
        description: "Second description",
        type: "string",
      })
    }).toThrow("already registered with different configuration")
  })
})
