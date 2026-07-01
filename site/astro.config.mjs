import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';

export default defineConfig({
  root: './site',
  
  // === RESTORE YOUR SITE URL HERE ===
  // Replace this with your actual production domain (e.g., 'https://owenkibel.github.io')
  // site: 'http://localhost:4321',
  site: 'https://latent-verse.vercel.app/',
  // ===================================

  integrations: [mdx(), sitemap()],
  markdown: {
    processor: satteri({
      features: {
        smartPunctuation: true,
        gfm: true
      }
    })
  },
  vite: {
    server: {
      fs: {
        allow: ['..']
      }
    }
  }
});