// site/src/pages/rss.xml.js
import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE_TITLE, SITE_DESCRIPTION } from '../consts';

export async function GET(context) {
  const posts = await getCollection('blog');
  
  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site,
    items: posts.map((post) => {
      // Safely fall back to parsing title strings if no explicit frontmatter date exists
      let parsedDate = post.data.date || post.data.pubDate;
      if (!parsedDate && post.data.title) {
        const match = post.data.title.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/i);
        parsedDate = match ? new Date(match[0]) : new Date();
      }

      return {
        // === UPDATE PROPERTY ACCESS MAPS TO USE .data ===
        title: post.data.title,
        description: post.data.description || 'Threadcraft narrative stream.',
        pubDate: parsedDate || new Date(),
        // Force lowercased ID structure to prevent 404 routing mismatches
        link: `/blog/${post.id.toLowerCase()}/`,
      };
    }),
  });
}