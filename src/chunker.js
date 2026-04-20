import { readFileSync, statSync } from 'fs';
import matter from 'gray-matter';
import { relative } from 'path';
import { VAULT_PATH } from './config.js';

/**
 * Parse a markdown note into frontmatter + heading-boundary chunks.
 *
 * Chunking strategy:
 * - Split on H1/H2/H3 headings (lines starting with #, ##, ###)
 * - Each chunk gets the heading it falls under
 * - Frontmatter fields (cohort, status, tags) are extracted and attached to every chunk
 * - Very short chunks (<50 chars) are merged into the next chunk
 * - The relative vault path and folder are attached as metadata
 */
export function parseAndChunkNote(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const stat = statSync(filePath);
  const relPath = relative(VAULT_PATH, filePath);
  const folder = relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '';

  // Parse frontmatter
  let fm = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    fm = parsed.data || {};
    body = parsed.content;
  } catch {
    // If frontmatter parsing fails, just use the raw content
    body = raw;
  }

  // Extract metadata from frontmatter
  const meta = {
    path: relPath,
    folder,
    cohort: fm.cohort || null,
    status: fm.status || null,
    tags: Array.isArray(fm.tags) ? fm.tags.join(', ') : (fm.tags || null),
    modified: stat.mtimeMs / 1000,
  };

  // Split body into sections by headings
  const lines = body.split('\n');
  const sections = [];
  let currentHeading = null;
  let currentLines = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      // Flush previous section
      if (currentLines.length > 0) {
        const content = currentLines.join('\n').trim();
        if (content.length > 0) {
          sections.push({ heading: currentHeading, content });
        }
      }
      currentHeading = headingMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section
  if (currentLines.length > 0) {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      sections.push({ heading: currentHeading, content });
    }
  }

  // If no headings found, treat the whole body as one chunk
  if (sections.length === 0 && body.trim().length > 0) {
    sections.push({ heading: null, content: body.trim() });
  }

  // Merge very short chunks into the following one
  const merged = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (sec.content.length < 50 && i + 1 < sections.length) {
      // Prepend this tiny section to the next one
      const label = sec.heading ? `## ${sec.heading}\n` : '';
      sections[i + 1].content = `${label}${sec.content}\n\n${sections[i + 1].content}`;
      if (!sections[i + 1].heading && sec.heading) {
        sections[i + 1].heading = sec.heading;
      }
    } else {
      merged.push(sec);
    }
  }

  // Split overly long chunks at paragraph boundaries.
  // Must stay under the embedding model's context window (~6K chars for dense text).
  const MAX_CHUNK_CHARS = 5_000;
  const sizedChunks = [];
  for (const sec of merged) {
    if (sec.content.length <= MAX_CHUNK_CHARS) {
      sizedChunks.push(sec);
    } else {
      // Split at double newlines (paragraph breaks)
      const paragraphs = sec.content.split(/\n\n+/);
      let current = '';
      let partNum = 1;
      for (const para of paragraphs) {
        if (current.length + para.length > MAX_CHUNK_CHARS && current.length > 0) {
          sizedChunks.push({
            heading: sec.heading ? `${sec.heading} (part ${partNum})` : `(part ${partNum})`,
            content: current.trim(),
          });
          partNum++;
          current = para;
        } else {
          current += (current ? '\n\n' : '') + para;
        }
      }
      if (current.trim().length > 0) {
        sizedChunks.push({
          heading: partNum > 1 ? `${sec.heading || ''} (part ${partNum})` : sec.heading,
          content: current.trim(),
        });
      }
    }
  }

  // Build chunk objects
  return sizedChunks.map(sec => {
    // Prefix chunk content with the note title and heading for better embedding context
    const title = fm.title || relPath.replace(/\.md$/, '').split('/').pop();
    const contextPrefix = sec.heading
      ? `${title} > ${sec.heading}:\n`
      : `${title}:\n`;

    return {
      ...meta,
      heading: sec.heading,
      content: sec.content,
      // embedText includes context prefix for better semantic retrieval
      embedText: contextPrefix + sec.content,
    };
  });
}
