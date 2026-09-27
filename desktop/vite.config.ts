import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
export default defineConfig({base:'./',plugins:[react()],build:{outDir:'dist/renderer',emptyOutDir:true},worker:{format:'es'},resolve:{alias:[
 {find:/^zxing-wasm\/reader\/zxing_reader\.wasm(\?.*)?$/,replacement:resolve(__dirname,'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm')+'$1'},
 {find:/^zxing-wasm\/reader$/,replacement:resolve(__dirname,'node_modules/zxing-wasm/dist/es/reader/index.js')},
 {find:'react',replacement:resolve(__dirname,'node_modules/react')},{find:'react-dom',replacement:resolve(__dirname,'node_modules/react-dom')}
]}});
