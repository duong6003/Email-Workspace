import { defineConfig } from 'vitest/config';
import { sharedTestExclude } from '../../vitest.shared.js';

export default defineConfig({ test: { exclude: sharedTestExclude } });
