#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const jsdocDir = path.join(__dirname, '../packages/core/docs/api/jsdoc');
const outputDir = path.join(__dirname, '../packages/core/docs/api/types');

// Create output directory
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Function to convert JSDoc to TSDoc
function convertJSDocToTSDoc(content, filename) {
  const typeName = filename.replace('.js', '');
  
  // Extract JSDoc comments and properties
  const jsdocRegex = /\/\*\*([\s\S]*?)\*\//g;
  const propertyRegex = /@property\s+\{([^}]+)\}\s+(\[?[\w.]+\]?)\s*-?\s*(.*)/g;
  
  let tsDoc = `/**\n * ${typeName} interface\n`;
  
  // Extract description from first JSDoc block
  const firstMatch = jsdocRegex.exec(content);
  if (firstMatch) {
    const lines = firstMatch[1].split('\n');
    const description = lines
      .filter(line => !line.includes('@') && line.trim().length > 0)
      .map(line => line.replace(/^\s*\*\s?/, ''))
      .join(' ')
      .trim();
    
    if (description && !description.includes('Generated from:')) {
      tsDoc += ` * ${description}\n`;
    }
  }
  
  tsDoc += ` * \n * @public\n */\n`;
  tsDoc += `export interface ${typeName} {\n`;
  
  // Reset regex
  propertyRegex.lastIndex = 0;
  
  // Extract properties
  let match;
  const properties = [];
  
  while ((match = propertyRegex.exec(content)) !== null) {
    const [, type, name, description] = match;
    const isOptional = name.startsWith('[') && name.endsWith(']');
    const propName = isOptional ? name.slice(1, -1) : name;
    const cleanName = propName.split('.').pop(); // Handle nested properties
    
    properties.push({
      name: cleanName,
      type: mapJSTypeToTS(type),
      description: description.trim(),
      optional: isOptional
    });
  }
  
  // Add properties to interface
  properties.forEach(prop => {
    if (prop.description) {
      tsDoc += `  /**\n   * ${prop.description}\n   */\n`;
    }
    tsDoc += `  ${prop.name}${prop.optional ? '?' : ''}: ${prop.type};\n\n`;
  });
  
  tsDoc += '}\n';
  
  return tsDoc;
}

// Map JS types to TypeScript types
function mapJSTypeToTS(jsType) {
  const typeMap = {
    'String': 'string',
    'string': 'string',
    'Number': 'number',
    'number': 'number',
    'Boolean': 'boolean',
    'boolean': 'boolean',
    'Object': 'Record<string, any>',
    'object': 'Record<string, any>',
    'Array': 'any[]',
    'array': 'any[]',
    'Function': '(...args: any[]) => any',
    'function': '(...args: any[]) => any',
    'any': 'any',
    '*': 'any'
  };
  
  // Handle union types
  if (jsType.includes('|')) {
    return jsType.split('|')
      .map(t => mapJSTypeToTS(t.trim()))
      .join(' | ');
  }
  
  // Handle array types
  if (jsType.includes('[]')) {
    const baseType = jsType.replace('[]', '');
    return `${mapJSTypeToTS(baseType)}[]`;
  }
  
  // Handle specific OpenTUI types
  if (jsType.includes('RGBA') || jsType.includes('ColorInput')) {
    return jsType; // Keep as-is
  }
  
  return typeMap[jsType] || jsType;
}

// Process all JSDoc files
const files = fs.readdirSync(jsdocDir).filter(f => f.endsWith('.js'));

console.log('Converting JSDoc to TSDoc...\n');

files.forEach(file => {
  if (file === 'all-types.js') {
    // Skip the aggregated file
    return;
  }
  
  const inputPath = path.join(jsdocDir, file);
  const outputFile = file.replace('.js', '.d.ts');
  const outputPath = path.join(outputDir, outputFile);
  
  const content = fs.readFileSync(inputPath, 'utf8');
  const tsDoc = convertJSDocToTSDoc(content, file);
  
  fs.writeFileSync(outputPath, tsDoc);
  console.log(`✓ Converted ${file} → ${outputFile}`);
});

// Create an index file that exports all types
const indexContent = `/**
 * OpenTUI Type Definitions
 * 
 * @packageDocumentation
 */

${files
  .filter(f => f !== 'all-types.js')
  .map(f => {
    const typeName = f.replace('.js', '');
    return `export type { ${typeName} } from './${typeName}';`;
  })
  .join('\n')}
`;

fs.writeFileSync(path.join(outputDir, 'index.d.ts'), indexContent);
console.log('\n✓ Created index.d.ts');

console.log(`\n✅ TSDoc conversion complete!`);
console.log(`📁 Output: ${outputDir}`);