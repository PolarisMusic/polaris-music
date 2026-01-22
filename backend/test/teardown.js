/**
 * Jest Global Teardown
 *
 * Closes all registered handles (Neo4j drivers, Redis clients, HTTP servers, etc.)
 * to prevent Jest from hanging with "worker failed to exit" errors.
 *
 * Handles are registered via registerHandle() in test/handles.js.
 * This runs once after all test suites complete.
 */

export default async function globalTeardown() {
  const handles = global.__openHandles || [];

  if (handles.length === 0) {
    console.log('✓ No open handles to close');
    return;
  }

  console.log(`\nClosing ${handles.length} open handle(s)...`);

  // Close in reverse order (LIFO - close most recent first)
  for (let i = handles.length - 1; i >= 0; i--) {
    const handle = handles[i];
    try {
      console.log(`  Closing ${handle.name}...`);
      await handle.close();
      console.log(`  ✓ Closed ${handle.name}`);
    } catch (error) {
      // Log warning but don't fail teardown
      console.warn(`  ⚠ Failed to close ${handle.name}: ${error.message}`);
    }
  }

  // Clear the handles array
  global.__openHandles = [];

  console.log('✓ Teardown complete\n');
}
