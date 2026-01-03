#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const schemasDir = path.join(__dirname, '../packages/core/docs/api/schemas');
const outputDir = path.join(__dirname, '../packages/core/src/types');

// Create output directory
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Convert JSON Schema to TypeScript with TSDoc
function schemaToTypeScript(schema, typeName) {
  let tsContent = '';
  
  // Find the main definition
  const definition = schema.definitions?.[typeName] || schema;
  
  if (!definition.properties) {
    console.warn(`No properties found for ${typeName}`);
    return '';
  }
  
  // Add TSDoc header
  tsContent += `/**\n`;
  tsContent += ` * ${typeName} configuration options\n`;
  
  if (definition.description || definition.$comment) {
    tsContent += ` * \n`;
    tsContent += ` * ${definition.description || definition.$comment}\n`;
  }
  
  tsContent += ` * \n`;
  tsContent += ` * @public\n`;
  tsContent += ` * @category Configuration\n`;
  tsContent += ` */\n`;
  tsContent += `export interface ${typeName} {\n`;
  
  // Process properties
  Object.entries(definition.properties).forEach(([propName, propDef]) => {
    const isRequired = definition.required?.includes(propName);
    
    // Add property documentation
    if (propDef.description || propDef.$comment) {
      tsContent += `  /**\n`;
      tsContent += `   * ${propDef.description || propDef.$comment}\n`;
      
      if (propDef.default !== undefined) {
        tsContent += `   * @defaultValue ${JSON.stringify(propDef.default)}\n`;
      }
      
      if (propDef.enum) {
        tsContent += `   * @remarks Possible values: ${propDef.enum.map(v => `'${v}'`).join(', ')}\n`;
      }
      
      tsContent += `   */\n`;
    }
    
    // Add property definition
    const propType = jsonSchemaTypeToTS(propDef);
    tsContent += `  ${propName}${isRequired ? '' : '?'}: ${propType};\n\n`;
  });
  
  tsContent += '}\n';
  
  return tsContent;
}

// Convert JSON Schema type to TypeScript type
function jsonSchemaTypeToTS(schema) {
  if (schema.$ref) {
    // Extract type name from ref
    const typeName = schema.$ref.split('/').pop();
    return typeName;
  }
  
  if (schema.enum) {
    return schema.enum.map(v => typeof v === 'string' ? `'${v}'` : v).join(' | ');
  }
  
  if (schema.type === 'array') {
    const itemType = schema.items ? jsonSchemaTypeToTS(schema.items) : 'any';
    return `${itemType}[]`;
  }
  
  if (schema.type === 'object') {
    if (schema.properties) {
      const props = Object.entries(schema.properties)
        .map(([key, value]) => `${key}: ${jsonSchemaTypeToTS(value)}`)
        .join('; ');
      return `{ ${props} }`;
    }
    return 'Record<string, any>';
  }
  
  if (schema.anyOf) {
    return schema.anyOf.map(s => jsonSchemaTypeToTS(s)).join(' | ');
  }
  
  if (schema.oneOf) {
    return schema.oneOf.map(s => jsonSchemaTypeToTS(s)).join(' | ');
  }
  
  const typeMap = {
    'string': 'string',
    'number': 'number',
    'integer': 'number',
    'boolean': 'boolean',
    'null': 'null'
  };
  
  return typeMap[schema.type] || 'any';
}

// Process all schema files
const files = fs.readdirSync(schemasDir).filter(f => f.endsWith('.json'));

console.log('Converting JSON Schemas to TypeScript with TSDoc...\n');

const imports = new Set();
const typeExports = [];

files.forEach(file => {
  const typeName = file.replace('.json', '');
  const schemaPath = path.join(schemasDir, file);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  
  const tsContent = schemaToTypeScript(schema, typeName);
  
  if (tsContent) {
    const outputFile = `${typeName}.d.ts`;
    const outputPath = path.join(outputDir, outputFile);
    
    fs.writeFileSync(outputPath, tsContent);
    typeExports.push(typeName);
    console.log(`✓ Generated ${outputFile}`);
  }
});

// Create index file
const indexContent = `/**
 * OpenTUI Type Definitions
 * 
 * This module exports all configuration interfaces and types used by OpenTUI components.
 * 
 * @module @opentui/core/types
 * @packageDocumentation
 */

// Component Options
${typeExports.map(name => `export type { ${name} } from './${name}';`).join('\n')}

// Re-export commonly used types
export type {
  BoxOptions,
  TextOptions,
  InputRenderableOptions,
  ASCIIFontOptions,
  AnimationOptions,
  TimelineOptions,
  CliRendererConfig
} from './index';

/**
 * Common color input type
 */
export type ColorInput = string | RGBA;

/**
 * RGBA color representation
 */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Border style options
 */
export type BorderStyle = 'single' | 'double' | 'rounded' | 'heavy';

/**
 * Flexbox alignment options
 */
export type AlignString = 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline';

/**
 * Flexbox justification options
 */
export type JustifyString = 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly';

/**
 * Flexbox direction options
 */
export type FlexDirectionString = 'row' | 'column' | 'row-reverse' | 'column-reverse';

/**
 * Position type options
 */
export type PositionTypeString = 'relative' | 'absolute';
`;

fs.writeFileSync(path.join(outputDir, 'index.d.ts'), indexContent);
console.log('\n✓ Created index.d.ts');

// Create a package.json for the types
const packageJson = {
  "name": "@opentui/core/types",
  "types": "./index.d.ts",
  "description": "TypeScript type definitions for OpenTUI"
};

fs.writeFileSync(
  path.join(outputDir, 'package.json'),
  JSON.stringify(packageJson, null, 2)
);
console.log('✓ Created package.json');

console.log(`\n✅ TSDoc type definitions generated!`);
console.log(`📁 Output: ${outputDir}`);
console.log('\nUsage in TypeScript:');
console.log('  import type { BoxOptions, TextOptions } from "@opentui/core/types";');