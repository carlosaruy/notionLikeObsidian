/**
 * Simple local cache layer using SQLite (via sql.js for now, can be swapped for better-sqlite3 later).
 * 
 * Goal:
 * - Avoid re-fetching titles and basic page info from Notion every time we load a database.
 * - Make the graph feel instant and "conceptual" instead of abstract (no more Untitled nodes for known pages).
 * 
 * Schema v1 (initial):
 * 
 * pages
 *   - id (TEXT, PRIMARY KEY)          // Notion page ID (with or without dashes)
 *   - title (TEXT)
 *   - last_fetched (INTEGER)          // Unix timestamp (ms)
 *   - url (TEXT)
 * 
 * page_links (for caching direct outgoing links/mentions from a page)
 *   - source_id (TEXT)
 *   - target_id (TEXT)
 *   - relation_type (TEXT)            // e.g. 'mention', 'child_page', 'explicit:tematicas', etc.
 *   - last_fetched (INTEGER)
 * 
 * This allows us to:
 * - Return titles instantly for known pages.
 * - Know which pages we already crawled for links.
 * - Only hit Notion for new pages or pages that need refresh.
 * 
 * Targeted Refresh Feature (planned):
 * - The user can trigger a full refresh of a single node (e.g. right-click → "Refresh this node").
 * - This will re-fetch the page + its direct relations from Notion and update the cache.
 * - Much faster than reloading the entire graph when the user knows a specific page changed.
 */

export interface CachedPage {
  id: string;
  title: string;
  lastFetched: number;
  url?: string;
}

export interface CachedLink {
  sourceId: string;
  targetId: string;
  relationType: string;
  lastFetched: number;
}

export interface PageCache {
  getPage(id: string): Promise<CachedPage | null>;
  savePage(page: CachedPage): Promise<void>;

  getOutgoingLinks(sourceId: string): Promise<CachedLink[]>;
  saveLinks(links: CachedLink[]): Promise<void>;

  /**
   * Marks a specific page as needing a full refresh.
   * Useful when the user knows that a particular node was updated in Notion.
   */
  markForRefresh(id: string): Promise<void>;

  /**
   * Returns a list of page IDs that have been marked for refresh
   * (either manually by the user or by some staleness policy).
   */
  getPagesMarkedForRefresh(): Promise<string[]>;

  /**
   * Removes the "needs refresh" flag from a page (after it has been successfully refreshed).
   */
  clearRefreshFlag(id: string): Promise<void>;

  /**
   * Completely removes a page and its outgoing links from the cache.
   * This forces a full re-fetch the next time the graph is loaded.
   */
  invalidatePage(id: string): Promise<void>;
}

/**
 * In-memory implementation for now (easy to develop against).
 * Later we can swap the backing store for sql.js (browser) or better-sqlite3 (Node/Tauri).
 */
export class InMemoryPageCache implements PageCache {
  private pages = new Map<string, CachedPage>();
  private links = new Map<string, CachedLink[]>(); // sourceId -> links

  async getPage(id: string): Promise<CachedPage | null> {
    return this.pages.get(id) ?? null;
  }

  async savePage(page: CachedPage): Promise<void> {
    this.pages.set(page.id, page);
  }

  async getOutgoingLinks(sourceId: string): Promise<CachedLink[]> {
    return this.links.get(sourceId) ?? [];
  }

  async saveLinks(links: CachedLink[]): Promise<void> {
    for (const link of links) {
      const existing = this.links.get(link.sourceId) ?? [];
      // Avoid duplicates (simple check)
      const alreadyExists = existing.some(
        (l) => l.targetId === link.targetId && l.relationType === link.relationType
      );
      if (!alreadyExists) {
        existing.push(link);
        this.links.set(link.sourceId, existing);
      }
    }
  }

  private needsRefresh = new Set<string>();

  async markForRefresh(id: string): Promise<void> {
    this.needsRefresh.add(id);
  }

  async getPagesMarkedForRefresh(): Promise<string[]> {
    return Array.from(this.needsRefresh);
  }

  async clearRefreshFlag(id: string): Promise<void> {
    this.needsRefresh.delete(id);
  }

  async invalidatePage(id: string): Promise<void> {
    this.pages.delete(id);
    this.links.delete(id);
    this.needsRefresh.delete(id);
  }
}

// Future: real SQLite implementation (sql.js for browser, better-sqlite3 for desktop)
export type { PageCache };