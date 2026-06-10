import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    
    // 1. Make new pipeline fields optional so older posts don't crash the server
    date: z.coerce.date().optional(), 
    source: z.enum(['digest', 'thread', 'link']).optional(),
    
    // 2. Retain legacy fields so your older posts remain valid
    pubDate: z.coerce.date().optional(),
    updatedDate: z.coerce.date().optional(),
    
    image: z.string().optional(), 
    video: z.string().optional(),
    tts: z.string().optional(),
    author: z.string().optional(),
  }).transform((data) => {
    // 3. Dynamic Fallback: If a post lacks 'date', seamlessly use 'pubDate'
    // If it lacks 'source', default it to 'digest' or a fallback string
    return {
      ...data,
      date: data.date || data.pubDate || new Date(),
      source: data.source || 'digest', 
    };
  }),
});

export const collections = { blog };