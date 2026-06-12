import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

/** Drafts are visible in dev, excluded from prod builds, RSS, and sitemap. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('posts', (post) => import.meta.env.DEV || !post.data.draft);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** Draft posts only — served unlisted + noindexed under /drafts in prod. */
export async function getDrafts(): Promise<Post[]> {
  const posts = await getCollection('posts', (post) => post.data.draft);
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function readingTime(body: string): number {
  const words = body.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}
