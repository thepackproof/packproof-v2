import {defineConfig} from 'vitest/config';
// Shared timing code is platform-independent. Desktop tests use the desktop
// transform options and must not require an installed Expo toolchain.
export default defineConfig({esbuild:{tsconfigRaw:JSON.stringify({compilerOptions:{jsx:'react-jsx',useDefineForClassFields:true}})},test:{include:['tests/**/*.test.{ts,tsx}','src/**/*.test.{ts,tsx}'],environment:'node'}});
