export function isValidDirectoryName(name: string): boolean {
  if (!name || typeof name !== "string") {
    return false
  }

  if (name.trim().length === 0) {
    return false
  }

  const reservedNames = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
  ]
  if (reservedNames.includes(name.toUpperCase())) {
    return false
  }

  // Check for invalid characters
  // Windows: < > : " | ? * \ and control characters (0-31)
  // Unix: null character and forward slash
  const invalidChars = /[<>:"|?*/\\\x00-\x1f]/
  if (invalidChars.test(name)) {
    return false
  }

  if (name.endsWith(".") || name.endsWith(" ")) {
    return false
  }

  if (name === "." || name === "..") {
    return false
  }

  return true
}
