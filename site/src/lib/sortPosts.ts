import type { CollectionEntry } from 'astro:content';

export function getSortedPosts(posts: CollectionEntry<'blog'>[]) {
  return posts.sort((a, b) => {
    // Both are guaranteed to have a .date field now thanks to the schema transform
    const dateA = a.data.date.valueOf();
    const dateB = b.data.date.valueOf();
    
    if (dateB !== dateA) {
      return dateB - dateA; // Newest first
    }
    return b.id.localeCompare(a.id); // Secure tie-breaker
  });
}