import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
// 1. Import the heading ID interceptor package
import remarkHeadingId from 'remark-heading-id'; 

export default defineConfig({
  site: 'https://example.com', 
  integrations: [mdx(), sitemap()],
  
  // 2. Configure Astro to parse custom markdown text attribute overrides
  markdown: {
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