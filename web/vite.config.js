import { defineConfig } from 'vite';
// base relativa: funziona sia su https://utente.github.io/repo/ sia in locale
export default defineConfig({ base: './', build: { target: 'es2022', chunkSizeWarningLimit: 1500 }, worker: { format: 'es' } });
