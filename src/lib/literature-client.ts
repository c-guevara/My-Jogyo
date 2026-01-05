/**
 * Literature Client for Gyoshu Research System
 *
 * Provides access to academic literature APIs (Crossref, arXiv) with:
 * - Local caching to reduce API calls
 * - Rate limiting (1 request/sec for Crossref)
 * - Retry logic with exponential backoff
 * - Consistent Citation interface across sources
 *
 * Usage:
 * ```typescript
 * import { searchCrossref, searchArxiv, getCitationByDOI } from './literature-client';
 *
 * // Search by title
 * const results = await searchCrossref('neural network optimization');
 *
 * // Get specific paper by DOI
 * const citation = await getCitationByDOI('10.1038/nature12373');
 *
 * // Search arXiv
 * const arxivResults = await searchArxiv('transformer attention mechanism');
 * ```
 *
 * @module literature-client
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getReportsRootDir, ensureDirSync } from "./paths";
import { durableAtomicWrite, fileExists } from "./atomic-write";

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Represents an academic citation/paper reference.
 */
export interface Citation {
  /** First author or all authors (formatted string) */
  authors: string;
  /** Paper title */
  title: string;
  /** Publication year */
  year: number | null;
  /** Journal or venue name */
  journal: string | null;
  /** Digital Object Identifier */
  doi: string | null;
  /** URL to the paper (publisher page or PDF) */
  url: string | null;
  /** Paper abstract (if available) */
  abstract: string | null;
  /** arXiv ID if from arXiv (e.g., "2301.12345") */
  arxivId: string | null;
  /** Source of this citation: 'crossref' | 'arxiv' */
  source: "crossref" | "arxiv";
}

/**
 * Result of a literature search operation.
 */
export interface SearchResult {
  /** Array of matching citations */
  citations: Citation[];
  /** Total number of results available (may be more than returned) */
  totalResults: number;
  /** The query that was executed */
  query: string;
  /** Source of results: 'crossref' | 'arxiv' */
  source: "crossref" | "arxiv";
  /** Whether results came from cache */
  fromCache: boolean;
}

/**
 * Cache entry for a single citation or search result.
 */
interface CacheEntry {
  /** The cached data */
  data: Citation | SearchResult;
  /** Timestamp when cached (ms since epoch) */
  cachedAt: number;
}

/**
 * Literature cache stored as JSON file.
 */
export interface LiteratureCache {
  /** Version for future migrations */
  version: number;
  /** Map of cache keys to entries */
  entries: Record<string, CacheEntry>;
  /** Last time cache was written */
  lastUpdated: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Cache file name */
const CACHE_FILE_NAME = ".gyoshu-literature-cache.json";

/** Cache expiry in milliseconds (7 days) */
const CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Current cache schema version */
const CACHE_VERSION = 1;

/** Crossref API base URL */
const CROSSREF_API_BASE = "https://api.crossref.org";

/** arXiv API base URL (HTTPS required for security) */
const ARXIV_API_BASE = "https://export.arxiv.org/api/query";

/** Rate limit: minimum ms between Crossref requests */
const CROSSREF_RATE_LIMIT_MS = 1000;

/** Rate limit: minimum ms between arXiv requests (etiquette requirement) */
const ARXIV_RATE_LIMIT_MS = 3000;

/** Fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 10000;

/** Maximum number of retry attempts */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY_MS = 1000;

/** User agent for API requests (Crossref requires this for polite pool) */
const USER_AGENT = "Gyoshu-Research-System/1.0 (https://github.com/gyoshu; mailto:research@gyoshu.dev)";

// =============================================================================
// RATE LIMITING
// =============================================================================

/** Timestamp of last Crossref API call */
let lastCrossrefCallTime = 0;

/** Timestamp of last arXiv API call */
let lastArxivCallTime = 0;

/**
 * Wait to ensure rate limit compliance before making a Crossref API call.
 */
async function waitForCrossrefRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastCall = now - lastCrossrefCallTime;

  if (timeSinceLastCall < CROSSREF_RATE_LIMIT_MS) {
    const waitTime = CROSSREF_RATE_LIMIT_MS - timeSinceLastCall;
    await sleep(waitTime);
  }

  lastCrossrefCallTime = Date.now();
}

/**
 * Wait to ensure rate limit compliance before making an arXiv API call.
 * arXiv requires 3 second delay between requests per their usage guidelines.
 */
async function waitForArxivRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastCall = now - lastArxivCallTime;

  if (timeSinceLastCall < ARXIV_RATE_LIMIT_MS) {
    const waitTime = ARXIV_RATE_LIMIT_MS - timeSinceLastCall;
    await sleep(waitTime);
  }

  lastArxivCallTime = Date.now();
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// CACHE LAYER
// =============================================================================

/**
 * Get the path to the literature cache file.
 */
function getCachePath(): string {
  const reportsDir = getReportsRootDir();
  return path.join(reportsDir, CACHE_FILE_NAME);
}

/**
 * Load the literature cache from disk.
 * Returns empty cache if file doesn't exist or is invalid.
 */
async function loadCache(): Promise<LiteratureCache> {
  const cachePath = getCachePath();

  try {
    if (!(await fileExists(cachePath))) {
      return createEmptyCache();
    }

    const content = await fs.readFile(cachePath, "utf-8");
    const cache = JSON.parse(content) as LiteratureCache;

    // Check version compatibility
    if (cache.version !== CACHE_VERSION) {
      console.warn(`[literature-client] Cache version mismatch, clearing cache`);
      return createEmptyCache();
    }

    return cache;
  } catch (error) {
    console.warn(`[literature-client] Failed to load cache: ${(error as Error).message}`);
    return createEmptyCache();
  }
}

/**
 * Create an empty cache object.
 */
function createEmptyCache(): LiteratureCache {
  return {
    version: CACHE_VERSION,
    entries: {},
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Save the cache to disk atomically.
 */
async function saveCache(cache: LiteratureCache): Promise<void> {
  const cachePath = getCachePath();

  // Ensure the reports directory exists
  const reportsDir = getReportsRootDir();
  ensureDirSync(reportsDir);

  cache.lastUpdated = new Date().toISOString();

  try {
    await durableAtomicWrite(cachePath, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(`[literature-client] Failed to save cache: ${(error as Error).message}`);
  }
}

/**
 * Get a cached entry if it exists and is not expired.
 */
async function getCached<T>(key: string): Promise<T | null> {
  const cache = await loadCache();
  const entry = cache.entries[key];

  if (!entry) {
    return null;
  }

  const age = Date.now() - entry.cachedAt;
  if (age > CACHE_EXPIRY_MS) {
    // Expired, remove from cache
    delete cache.entries[key];
    await saveCache(cache);
    return null;
  }

  return entry.data as T;
}

/**
 * Store an entry in the cache.
 */
async function setCached<T extends Citation | SearchResult>(key: string, data: T): Promise<void> {
  const cache = await loadCache();

  cache.entries[key] = {
    data,
    cachedAt: Date.now(),
  };

  await saveCache(cache);
}

/**
 * Generate a cache key for a search query.
 */
function searchCacheKey(source: string, query: string, limit: number): string {
  return `search:${source}:${query.toLowerCase().trim()}:${limit}`;
}

/**
 * Generate a cache key for a DOI lookup.
 */
function doiCacheKey(doi: string): string {
  return `doi:${doi.toLowerCase().trim()}`;
}

// =============================================================================
// RETRY LOGIC
// =============================================================================

/**
 * Error thrown when API call fails after all retries.
 */
export class LiteratureAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly source?: string
  ) {
    super(message);
    this.name = "LiteratureAPIError";
  }
}

/**
 * Execute a fetch with retry logic and exponential backoff.
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @returns Response object
 * @throws LiteratureAPIError if all retries fail
 */
async function fetchWithRetry(url: string, options: RequestInit = {}): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...options.headers,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      // Success or client error (4xx) - don't retry
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        return response;
      }

      // Rate limited or server error - retry with backoff
      if (response.status === 429 || response.status >= 500) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[literature-client] Request failed with ${response.status}, retrying in ${delay}ms...`);
        await sleep(delay);
        lastError = new LiteratureAPIError(`HTTP ${response.status}`, response.status);
        continue;
      }

      // Unexpected status
      return response;
    } catch (error) {
      // Network error - retry with backoff
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[literature-client] Network error, retrying in ${delay}ms: ${(error as Error).message}`);
      await sleep(delay);
      lastError = error as Error;
    }
  }

  throw new LiteratureAPIError(
    `Failed after ${MAX_RETRIES} retries: ${lastError?.message || "Unknown error"}`,
    undefined,
    "network"
  );
}

// =============================================================================
// CROSSREF API CLIENT
// =============================================================================

/**
 * Parse a Crossref work item into a Citation.
 */
function parseCrossrefWork(work: Record<string, unknown>): Citation {
  // Extract authors
  const authorList = work.author as Array<{ given?: string; family?: string }> | undefined;
  let authors = "Unknown";
  if (authorList && authorList.length > 0) {
    authors = authorList
      .map((a) => {
        if (a.given && a.family) {
          return `${a.given} ${a.family}`;
        } else if (a.family) {
          return a.family;
        }
        return "Unknown";
      })
      .join(", ");
  }

  // Extract title
  const titleArray = work.title as string[] | undefined;
  const title = titleArray && titleArray.length > 0 ? titleArray[0] : "Untitled";

  // Extract year
  const published = work.published as { "date-parts"?: number[][] } | undefined;
  const issued = work.issued as { "date-parts"?: number[][] } | undefined;
  const dateParts = published?.["date-parts"]?.[0] || issued?.["date-parts"]?.[0];
  const year = dateParts && dateParts.length > 0 ? dateParts[0] : null;

  // Extract journal/venue
  const containerTitle = work["container-title"] as string[] | undefined;
  const journal = containerTitle && containerTitle.length > 0 ? containerTitle[0] : null;

  // Extract DOI
  const doi = (work.DOI as string) || null;

  // Extract URL
  const url = (work.URL as string) || (doi ? `https://doi.org/${doi}` : null);

  // Extract abstract
  const abstract = (work.abstract as string) || null;

  return {
    authors,
    title,
    year,
    journal,
    doi,
    url,
    abstract,
    arxivId: null,
    source: "crossref",
  };
}

/**
 * Get citation metadata for a DOI from Crossref.
 *
 * @param doi - Digital Object Identifier (e.g., "10.1038/nature12373")
 * @returns Citation object or null if not found
 *
 * @example
 * const citation = await getCitationByDOI('10.1038/nature12373');
 * console.log(citation?.title);
 */
export async function getCitationByDOI(doi: string): Promise<Citation | null> {
  // Normalize DOI
  const normalizedDoi = doi.replace(/^https?:\/\/doi\.org\//i, "").trim();

  // Check cache first
  const cacheKey = doiCacheKey(normalizedDoi);
  const cached = await getCached<Citation>(cacheKey);
  if (cached) {
    return cached;
  }

  // Make API call
  await waitForCrossrefRateLimit();

  const url = `${CROSSREF_API_BASE}/works/${encodeURIComponent(normalizedDoi)}`;

  try {
    const response = await fetchWithRetry(url);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new LiteratureAPIError(
        `Crossref API error: ${response.status} ${response.statusText}`,
        response.status,
        "crossref"
      );
    }

    const data = (await response.json()) as { message: Record<string, unknown> };
    const citation = parseCrossrefWork(data.message);

    // Cache the result
    await setCached(cacheKey, citation);

    return citation;
  } catch (error) {
    if (error instanceof LiteratureAPIError) {
      throw error;
    }
    throw new LiteratureAPIError(
      `Failed to fetch DOI ${normalizedDoi}: ${(error as Error).message}`,
      undefined,
      "crossref"
    );
  }
}

/**
 * Search Crossref for papers matching a title query.
 *
 * @param query - Search query (title, author, keyword)
 * @param limit - Maximum number of results to return (default: 10, max: 100)
 * @returns SearchResult with matching citations
 *
 * @example
 * const results = await searchCrossref('deep learning optimization', 5);
 * console.log(`Found ${results.totalResults} results`);
 * results.citations.forEach(c => console.log(c.title));
 */
export async function searchCrossref(query: string, limit: number = 10): Promise<SearchResult> {
  // Clamp limit to reasonable range
  const clampedLimit = Math.min(Math.max(1, limit), 100);

  // Check cache first
  const cacheKey = searchCacheKey("crossref", query, clampedLimit);
  const cached = await getCached<SearchResult>(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  // Make API call
  await waitForCrossrefRateLimit();

  const params = new URLSearchParams({
    query: query,
    rows: clampedLimit.toString(),
  });

  const url = `${CROSSREF_API_BASE}/works?${params.toString()}`;

  try {
    const response = await fetchWithRetry(url);

    if (!response.ok) {
      throw new LiteratureAPIError(
        `Crossref API error: ${response.status} ${response.statusText}`,
        response.status,
        "crossref"
      );
    }

    const data = (await response.json()) as {
      message: {
        "total-results": number;
        items: Array<Record<string, unknown>>;
      };
    };

    const citations = data.message.items.map(parseCrossrefWork);

    const result: SearchResult = {
      citations,
      totalResults: data.message["total-results"],
      query,
      source: "crossref",
      fromCache: false,
    };

    // Cache the result
    await setCached(cacheKey, result);

    return result;
  } catch (error) {
    if (error instanceof LiteratureAPIError) {
      throw error;
    }
    throw new LiteratureAPIError(
      `Crossref search failed: ${(error as Error).message}`,
      undefined,
      "crossref"
    );
  }
}

// =============================================================================
// ARXIV API CLIENT
// =============================================================================

/**
 * Parse arXiv Atom XML response into Citations.
 * Uses regex-based parsing to avoid XML library dependency.
 */
function parseArxivResponse(xml: string): { citations: Citation[]; totalResults: number } {
  const citations: Citation[] = [];

  // Extract total results
  const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/);
  const totalResults = totalMatch ? parseInt(totalMatch[1], 10) : 0;

  // Extract entries
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch;

  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const entry = entryMatch[1];

    // Extract title (remove newlines)
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch
      ? titleMatch[1].replace(/\s+/g, " ").trim()
      : "Untitled";

    // Extract authors
    const authorRegex = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
    const authors: string[] = [];
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    // Extract abstract/summary
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const abstract = summaryMatch
      ? summaryMatch[1].replace(/\s+/g, " ").trim()
      : null;

    // Extract arXiv ID from id URL
    const idMatch = entry.match(/<id>http:\/\/arxiv\.org\/abs\/([\d.]+v?\d*)<\/id>/);
    const arxivId = idMatch ? idMatch[1] : null;

    // Extract published date (for year)
    const publishedMatch = entry.match(/<published>(\d{4})-\d{2}-\d{2}/);
    const year = publishedMatch ? parseInt(publishedMatch[1], 10) : null;

    // Extract PDF link
    const pdfMatch = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/);
    const pdfUrl = pdfMatch ? pdfMatch[1] : null;

    // Extract abstract page URL
    const absMatch = entry.match(/<link[^>]*type="text\/html"[^>]*href="([^"]+)"/);
    const absUrl = absMatch ? absMatch[1] : (arxivId ? `https://arxiv.org/abs/${arxivId}` : null);

    // Extract primary category for journal/venue equivalent
    const categoryMatch = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/);
    const category = categoryMatch ? `arXiv:${categoryMatch[1]}` : "arXiv";

    citations.push({
      authors: authors.length > 0 ? authors.join(", ") : "Unknown",
      title,
      year,
      journal: category,
      doi: null, // arXiv papers may have DOIs but not directly in the API
      url: pdfUrl || absUrl,
      abstract,
      arxivId,
      source: "arxiv",
    });
  }

  return { citations, totalResults };
}

/**
 * Search arXiv for papers matching a query.
 *
 * @param query - Search query (supports arXiv search syntax)
 * @param limit - Maximum number of results to return (default: 10, max: 100)
 * @returns SearchResult with matching citations
 *
 * @example
 * const results = await searchArxiv('all:transformer attention', 5);
 * results.citations.forEach(c => {
 *   console.log(`${c.title} (arXiv:${c.arxivId})`);
 *   console.log(`  PDF: ${c.url}`);
 * });
 */
export async function searchArxiv(query: string, limit: number = 10): Promise<SearchResult> {
  // Clamp limit to reasonable range
  const clampedLimit = Math.min(Math.max(1, limit), 100);

  // Check cache first
  const cacheKey = searchCacheKey("arxiv", query, clampedLimit);
  const cached = await getCached<SearchResult>(cacheKey);
  if (cached) {
    return { ...cached, fromCache: true };
  }

  // Build query URL
  // arXiv uses 'search_query' parameter with special field prefixes:
  // - ti: title, au: author, abs: abstract, all: all fields
  // If user doesn't specify a field, search all
  const searchQuery = query.includes(":") ? query : `all:${query}`;

  const params = new URLSearchParams({
    search_query: searchQuery,
    start: "0",
    max_results: clampedLimit.toString(),
    sortBy: "relevance",
    sortOrder: "descending",
  });

  const url = `${ARXIV_API_BASE}?${params.toString()}`;

  try {
    // Enforce arXiv rate limiting (3s between requests)
    await waitForArxivRateLimit();

    const response = await fetchWithRetry(url, {
      headers: {
        Accept: "application/atom+xml",
      },
    });

    if (!response.ok) {
      throw new LiteratureAPIError(
        `arXiv API error: ${response.status} ${response.statusText}`,
        response.status,
        "arxiv"
      );
    }

    const xml = await response.text();
    const { citations, totalResults } = parseArxivResponse(xml);

    const result: SearchResult = {
      citations,
      totalResults,
      query,
      source: "arxiv",
      fromCache: false,
    };

    // Cache the result
    await setCached(cacheKey, result);

    return result;
  } catch (error) {
    if (error instanceof LiteratureAPIError) {
      throw error;
    }
    throw new LiteratureAPIError(
      `arXiv search failed: ${(error as Error).message}`,
      undefined,
      "arxiv"
    );
  }
}

/**
 * Get a paper by arXiv ID.
 *
 * @param arxivId - arXiv identifier (e.g., "2301.12345" or "2301.12345v2")
 * @returns Citation object or null if not found
 *
 * @example
 * const paper = await getArxivPaper('2301.07041');
 * console.log(paper?.title);
 * console.log(paper?.url); // PDF URL
 */
export async function getArxivPaper(arxivId: string): Promise<Citation | null> {
  // Normalize arXiv ID (remove arxiv: prefix if present)
  const normalizedId = arxivId.replace(/^arxiv:/i, "").trim();

  // Check cache first
  const cacheKey = `arxiv:${normalizedId}`;
  const cached = await getCached<Citation>(cacheKey);
  if (cached) {
    return cached;
  }

  // Use id_list parameter for direct lookup
  const params = new URLSearchParams({
    id_list: normalizedId,
  });

  const url = `${ARXIV_API_BASE}?${params.toString()}`;

  try {
    // Enforce arXiv rate limiting (3s between requests)
    await waitForArxivRateLimit();

    const response = await fetchWithRetry(url, {
      headers: {
        Accept: "application/atom+xml",
      },
    });

    if (!response.ok) {
      throw new LiteratureAPIError(
        `arXiv API error: ${response.status} ${response.statusText}`,
        response.status,
        "arxiv"
      );
    }

    const xml = await response.text();
    const { citations } = parseArxivResponse(xml);

    if (citations.length === 0) {
      return null;
    }

    const citation = citations[0];

    // Cache the result
    await setCached(cacheKey, citation);

    return citation;
  } catch (error) {
    if (error instanceof LiteratureAPIError) {
      throw error;
    }
    throw new LiteratureAPIError(
      `Failed to fetch arXiv paper ${normalizedId}: ${(error as Error).message}`,
      undefined,
      "arxiv"
    );
  }
}

// =============================================================================
// UNIFIED SEARCH
// =============================================================================

/**
 * Search both Crossref and arXiv for papers matching a query.
 * Results are combined and deduplicated where possible.
 *
 * @param query - Search query
 * @param options - Search options
 * @returns Combined SearchResult from both sources
 *
 * @example
 * const results = await searchLiterature('neural network pruning', {
 *   limit: 5,
 *   sources: ['crossref', 'arxiv']
 * });
 */
export async function searchLiterature(
  query: string,
  options: {
    limit?: number;
    sources?: Array<"crossref" | "arxiv">;
  } = {}
): Promise<SearchResult> {
  const { limit = 10, sources = ["crossref", "arxiv"] } = options;

  const results: Citation[] = [];
  let totalResults = 0;
  let fromCache = true;

  // Search each requested source
  const searchPromises: Promise<void>[] = [];

  if (sources.includes("crossref")) {
    searchPromises.push(
      searchCrossref(query, limit)
        .then((result) => {
          results.push(...result.citations);
          totalResults += result.totalResults;
          if (!result.fromCache) fromCache = false;
        })
        .catch((error) => {
          console.warn(`[literature-client] Crossref search failed: ${error.message}`);
        })
    );
  }

  if (sources.includes("arxiv")) {
    searchPromises.push(
      searchArxiv(query, limit)
        .then((result) => {
          results.push(...result.citations);
          totalResults += result.totalResults;
          if (!result.fromCache) fromCache = false;
        })
        .catch((error) => {
          console.warn(`[literature-client] arXiv search failed: ${error.message}`);
        })
    );
  }

  await Promise.all(searchPromises);

  // Sort by year (newest first), with null years at the end
  results.sort((a, b) => {
    if (a.year === null && b.year === null) return 0;
    if (a.year === null) return 1;
    if (b.year === null) return -1;
    return b.year - a.year;
  });

  // Limit total results
  const limitedResults = results.slice(0, limit);

  return {
    citations: limitedResults,
    totalResults,
    query,
    source: sources.length === 1 ? sources[0] : "crossref", // Default to crossref for mixed
    fromCache,
  };
}

// =============================================================================
// CITATION FORMATTING
// =============================================================================

/**
 * Format a Citation as APA style reference.
 *
 * @param citation - Citation to format
 * @returns APA formatted string
 *
 * @example
 * const apa = formatCitationAPA(citation);
 * // "Smith, J., & Jones, M. (2023). Paper title. Journal Name."
 */
export function formatCitationAPA(citation: Citation): string {
  const parts: string[] = [];

  // Authors
  parts.push(citation.authors);

  // Year
  if (citation.year) {
    parts.push(`(${citation.year}).`);
  } else {
    parts.push("(n.d.).");
  }

  // Title
  parts.push(citation.title + ".");

  // Journal/venue
  if (citation.journal) {
    parts.push(`*${citation.journal}*.`);
  }

  // DOI or URL
  if (citation.doi) {
    parts.push(`https://doi.org/${citation.doi}`);
  } else if (citation.url) {
    parts.push(citation.url);
  }

  return parts.join(" ");
}

/**
 * Format a Citation as BibTeX entry.
 *
 * @param citation - Citation to format
 * @param key - BibTeX entry key (defaults to generated key)
 * @returns BibTeX formatted string
 *
 * @example
 * const bibtex = formatCitationBibTeX(citation);
 */
export function formatCitationBibTeX(citation: Citation, key?: string): string {
  // Generate a key if not provided
  const entryKey =
    key ||
    (citation.authors.split(",")[0].split(" ").pop() || "unknown") +
      (citation.year || "nd");

  const lines: string[] = [];

  const entryType = citation.arxivId ? "misc" : "article";
  lines.push(`@${entryType}{${entryKey.toLowerCase().replace(/\s+/g, "")},`);

  // Author
  lines.push(`  author = {${citation.authors}},`);

  // Title
  lines.push(`  title = {${citation.title}},`);

  // Year
  if (citation.year) {
    lines.push(`  year = {${citation.year}},`);
  }

  // Journal
  if (citation.journal) {
    lines.push(`  journal = {${citation.journal}},`);
  }

  // DOI
  if (citation.doi) {
    lines.push(`  doi = {${citation.doi}},`);
  }

  // URL
  if (citation.url) {
    lines.push(`  url = {${citation.url}},`);
  }

  // arXiv ID
  if (citation.arxivId) {
    lines.push(`  eprint = {${citation.arxivId}},`);
    lines.push(`  archivePrefix = {arXiv},`);
  }

  lines.push("}");

  return lines.join("\n");
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

/**
 * Clear the literature cache.
 * Useful for testing or when cache needs to be refreshed.
 */
export async function clearLiteratureCache(): Promise<void> {
  const cachePath = getCachePath();

  try {
    if (await fileExists(cachePath)) {
      await fs.unlink(cachePath);
    }
  } catch (error) {
    console.warn(`[literature-client] Failed to clear cache: ${(error as Error).message}`);
  }
}

/**
 * Get cache statistics.
 *
 * @returns Object with cache stats
 */
export async function getCacheStats(): Promise<{
  entryCount: number;
  oldestEntry: string | null;
  newestEntry: string | null;
  cacheFilePath: string;
}> {
  const cache = await loadCache();
  const entries = Object.values(cache.entries);

  if (entries.length === 0) {
    return {
      entryCount: 0,
      oldestEntry: null,
      newestEntry: null,
      cacheFilePath: getCachePath(),
    };
  }

  const sorted = entries.sort((a, b) => a.cachedAt - b.cachedAt);

  return {
    entryCount: entries.length,
    oldestEntry: new Date(sorted[0].cachedAt).toISOString(),
    newestEntry: new Date(sorted[sorted.length - 1].cachedAt).toISOString(),
    cacheFilePath: getCachePath(),
  };
}
