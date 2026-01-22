/**
 * Template Rendering Utility for Artillery Load Tests
 *
 * Renders smoke payload templates with variable substitution.
 * This ensures load tests use the same event schemas as smoke tests,
 * preventing silent drift when template shapes change.
 *
 * Template format: {{VARIABLE_NAME}}
 * Variables must be UPPER_SNAKE_CASE.
 */

const fs = require('fs');
const path = require('path');

/**
 * Find repository root by walking up until we find scripts/smoke_payloads/
 * This allows the load test to run from different working directories.
 *
 * @returns {string} Absolute path to repository root
 * @throws {Error} If repo root cannot be found
 */
function findRepoRoot() {
  let currentDir = __dirname;
  let maxDepth = 10; // Prevent infinite loop

  while (maxDepth-- > 0) {
    const smokePath = path.join(currentDir, 'scripts', 'smoke_payloads');
    if (fs.existsSync(smokePath)) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached filesystem root
    }
    currentDir = parentDir;
  }

  throw new Error(
    'Could not find repository root. ' +
    'Expected to find scripts/smoke_payloads/ directory.'
  );
}

/**
 * Render a template file with variable substitution.
 *
 * @param {string} filePath - Absolute or repo-relative path to template file
 * @param {Object} vars - Variables to substitute (keys must match {{PLACEHOLDERS}})
 * @returns {Object} Parsed JSON object with substitutions applied
 * @throws {Error} If template not found, placeholder missing, or JSON invalid
 *
 * @example
 * const event = renderTemplateFile(
 *   'scripts/smoke_payloads/mint-entity.tmpl.json',
 *   { ENTITY_ID: 'test123', TIMESTAMP: '2025-01-14T12:00:00Z' }
 * );
 */
function renderTemplateFile(filePath, vars) {
  // Resolve path relative to repo root if not absolute
  let resolvedPath = filePath;
  if (!path.isAbsolute(filePath)) {
    const repoRoot = findRepoRoot();
    resolvedPath = path.join(repoRoot, filePath);
  }

  // Read template file
  let template;
  try {
    template = fs.readFileSync(resolvedPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read template file: ${resolvedPath}\n` +
      `Error: ${error.message}`
    );
  }

  // Find all placeholders in template
  const placeholderRegex = /__([A-Z0-9_]+)__/g;
  const placeholders = new Set();
  let match;
  while ((match = placeholderRegex.exec(template)) !== null) {
    placeholders.add(match[1]);
  }

  // Check for missing variables
  const missingVars = [];
  for (const placeholder of placeholders) {
    if (!(placeholder in vars)) {
      missingVars.push(placeholder);
    }
  }

  if (missingVars.length > 0) {
    throw new Error(
      `Template rendering failed: Missing required variables\n` +
      `Template: ${path.basename(resolvedPath)}\n` +
      `Missing: ${missingVars.join(', ')}\n` +
      `Provided: ${Object.keys(vars).join(', ')}`
    );
  }

  // Replace placeholders with values
  let rendered = template;
  for (const [key, value] of Object.entries(vars)) {
    const placeholder = `__${key}__`;
    const regex = new RegExp(placeholder, 'g');
    rendered = rendered.replace(regex, value);
  }

  // Parse and validate JSON
  let parsed;
  try {
    parsed = JSON.parse(rendered);
  } catch (error) {
    throw new Error(
      `Template rendering produced invalid JSON\n` +
      `Template: ${path.basename(resolvedPath)}\n` +
      `Parse error: ${error.message}\n` +
      `Rendered content:\n${rendered.substring(0, 500)}...`
    );
  }

  // Validate minimal event structure
  validateEventStructure(parsed, path.basename(resolvedPath));

  return parsed;
}

/**
 * Validate that rendered event has required fields.
 * Catches template drift early with clear error messages.
 *
 * @param {Object} event - Rendered event object
 * @param {string} templateName - Template filename for error messages
 * @throws {Error} If required fields are missing
 */
function validateEventStructure(event, templateName) {
  const requiredFields = ['v', 'type', 'created_at', 'body'];

  const missingFields = requiredFields.filter(field => !(field in event));

  if (missingFields.length > 0) {
    throw new Error(
      `Template produced event with missing required fields\n` +
      `Template: ${templateName}\n` +
      `Missing fields: ${missingFields.join(', ')}\n` +
      `This indicates the template structure has changed. ` +
      `Update the template or validation logic.`
    );
  }

  // Type-specific validation
  if (event.type === 'MINT_ENTITY' && !event.body.entity_type) {
    throw new Error(
      `MINT_ENTITY event missing body.entity_type\n` +
      `Template: ${templateName}`
    );
  }

  if (event.type === 'ADD_CLAIM' && (!event.body.entity_id || !event.body.claim)) {
    throw new Error(
      `ADD_CLAIM event missing body.entity_id or body.claim\n` +
      `Template: ${templateName}`
    );
  }
}

module.exports = {
  renderTemplateFile,
  findRepoRoot
};
