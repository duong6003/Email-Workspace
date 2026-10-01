import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sharedTestExclude } from '../../vitest.shared.js';
// e2e/** holds Playwright specs (own runner: `pnpm e2e`), not vitest tests —
// vitest's default include glob would otherwise try to load them too and
// fail on Playwright's test.describe() outside its own runner context.
export default defineConfig({ plugins: [react()], server: { port: 5173 }, test: { exclude: [...sharedTestExclude, 'e2e/**'] } });
