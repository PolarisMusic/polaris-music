/**
 * Test Handle Registry
 *
 * Provides utilities for registering resources (Neo4j drivers, Redis clients,
 * HTTP servers, etc.) that need to be closed after tests complete.
 *
 * This prevents Jest from hanging with "worker failed to exit" errors.
 *
 * Usage:
 *   import { registerHandle } from './test/handles.js';
 *
 *   const driver = neo4j.driver(...);
 *   registerHandle('Neo4j driver', () => driver.close());
 *
 *   const server = app.listen(3000);
 *   registerHandle('HTTP server', () => server.close());
 */

/**
 * Register a handle (resource) that needs to be closed after tests.
 *
 * @param {string} name - Descriptive name for logging (e.g., 'Neo4j driver', 'Redis client')
 * @param {Function} closeFn - Async or sync function that closes the resource
 */
export function registerHandle(name, closeFn) {
  // Initialize the global handles array if it doesn't exist
  if (!global.__openHandles) {
    global.__openHandles = [];
  }

  // Add the handle to the registry
  global.__openHandles.push({
    name,
    close: closeFn
  });

  console.log(`  Registered handle: ${name}`);
}

/**
 * Clear all registered handles without closing them.
 * Useful for testing the registry itself.
 */
export function clearHandles() {
  global.__openHandles = [];
}

/**
 * Get count of registered handles.
 * Useful for debugging.
 */
export function getHandleCount() {
  return (global.__openHandles || []).length;
}
