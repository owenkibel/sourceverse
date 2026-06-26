// site/src/content.config.ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders'; 

const blog = defineCollection({
	// Change base from '../posts' to '../../posts'
	loader: glob({ 
		pattern: '**/[^_]*.md', 
		base: '../../posts' 
	}),
	
	schema: z.object({
		title: z.string(),
		author: z.string().default('Owen'), 
		date: z.coerce.date().optional(),
		pubDate: z.coerce.date().optional(), 
		description: z.string().optional(),
		tags: z.array(z.string()).default(['Bookmarks']),
		image: z.string().optional(),
		video: z.string().optional(),
		tts: z.string().optional(),
		source: z.string().optional(),
		type: z.string().optional(),
	}),
});

export const collections = { blog };