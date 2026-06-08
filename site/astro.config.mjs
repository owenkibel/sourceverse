import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import remarkHeadingId from 'remark-heading-id'; 

export default defineConfig({
  site: 'https://example.com', 
  integrations: [mdx(), sitemap()],
  
  markdown: {
    // Switch compiler to Prism to strip out pre-baked inline styles
    syntaxHighlight: 'prism',
    remarkPlugins: [remarkHeadingId],
  },
  
  vite: {
    preserveSymlinks: true,
    server: {
      fs: {
        allow: ['..'],
      },
    },
  },
});