import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/* The states gallery at /dev.html is a second entry, and it must never reach
   `dist`. The server hands out any file that exists there — only a *miss* is
   redirected to index.html — so a built dev.html would be a live, unauthenticated
   page on the tailnet, which is the one thing this page must not become.

   Vite already serves any .html at the project root in dev, so the gallery needs
   no build input at all to be usable; the input below exists so that the page can
   be proven to compile, which is worth having but is not worth shipping. Hence the
   flag: `ORBIT_GALLERY=1 npm run build -w web` type-checks and bundles it into a
   throwaway dist, and the ordinary build emits index.html and nothing else.

   The alternative — building it always and deleting the file afterwards — was
   rejected because "and then we remember to delete it" is not a guarantee, and
   the chunks it pulled in would still be sitting in dist/assets. */
const withGallery = !!process.env.ORBIT_GALLERY
/* Resolved against this file rather than left as bare names: an input string is
   relative to the working directory, so `vite build web` from the repo root
   would otherwise look for index.html one directory too high. */
const entry = (name: string) => new URL(name, import.meta.url).pathname

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: withGallery
    ? { rollupOptions: { input: { app: entry('index.html'), gallery: entry('dev.html') } } }
    : {},
  server: {
    host: true, // reachable from phone on the same network / Tailscale
    /* Vite checks the Host header and answers anything it does not recognise
       with a block page instead of the app. `tailscale serve` reaches this
       server under the tailnet name, so without this the whole point of
       publishing a port — tap the row, look at the app in a frame — shows
       Vite's refusal instead, and a capture photographs that refusal.

       A leading dot matches the host and its subdomains, so this is every
       tailnet without naming this machine's, which changes with the tailnet.
       Dev only: `vite build` never reads it. */
    allowedHosts: ['.ts.net'],
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3001',
      },
    },
  },
})
