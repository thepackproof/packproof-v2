import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/**/*.test.{ts,tsx}','ui/**/*.test.{ts,tsx}'],environment:'node'}});
