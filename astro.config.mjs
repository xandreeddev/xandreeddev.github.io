import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { rehypeHeadingIds } from '@astrojs/markdown-remark';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import {
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerMetaHighlight,
} from '@shikijs/transformers';

/** Reads `title="…"` from the fence meta and exposes it for the CSS label. */
const transformerCodeTitle = {
  name: 'code-title',
  pre(node) {
    const raw = this.options.meta?.__raw ?? '';
    const match = raw.match(/title="([^"]+)"/);
    if (match) node.properties['data-title'] = match[1];
  },
};

export default defineConfig({
  site: 'https://xandreed.dev',
  // /drafts is unlisted: never in the sitemap (pages also carry noindex)
  integrations: [sitemap({ filter: (page) => !page.includes('/drafts/') })],
  markdown: {
    rehypePlugins: [
      rehypeHeadingIds,
      [
        rehypeAutolinkHeadings,
        {
          behavior: 'append',
          content: { type: 'text', value: '#' },
          properties: { className: ['anchor'], ariaHidden: 'true', tabIndex: -1 },
        },
      ],
    ],
    shikiConfig: {
      themes: { light: 'github-light', dark: 'vesper' },
      defaultColor: false,
      transformers: [
        transformerNotationDiff(),
        transformerNotationHighlight(),
        transformerMetaHighlight(),
        transformerCodeTitle,
      ],
    },
  },
});
