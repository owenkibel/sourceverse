import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    pubDate: z.coerce.date().optional(),
    updatedDate: z.coerce.date().optional(),
    // Change heroImage to image to align with your GenAI pipeline layout
    image: z.string().optional(), 
    video: z.string().optional(),
    tts: z.string().optional(),
    author: z.string().optional(),
  }),
});

export const collections = { blog };