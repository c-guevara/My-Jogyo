/**
 * Literature Search Tool - OpenCode tool for finding and citing academic papers
 *
 * Provides access to academic literature via Crossref and arXiv APIs with:
 * - Search across multiple sources (Crossref, arXiv)
 * - Citation formatting (APA, BibTeX)
 * - Related paper discovery for research context
 *
 * Usage via tool invocation:
 * - search: Find papers matching a query
 * - cite: Get formatted citation for a DOI or arXiv ID
 * - related: Find papers related to a research topic
 *
 * @module literature-search
 */

import { tool } from "@opencode-ai/plugin";
import {
  searchCrossref,
  searchArxiv,
  searchLiterature,
  getCitationByDOI,
  getArxivPaper,
  formatCitationAPA,
  formatCitationBibTeX,
  LiteratureAPIError,
  type Citation,
  type SearchResult,
} from "../lib/literature-client";

// =============================================================================
// TYPES
// =============================================================================

type LiteratureSource = "crossref" | "arxiv" | "both";
type CitationFormat = "apa" | "bibtex";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Detect if an identifier is a DOI or arXiv ID.
 *
 * @param identifier - The identifier to classify
 * @returns "doi" | "arxiv" | "unknown"
 */
function detectIdentifierType(identifier: string): "doi" | "arxiv" | "unknown" {
  const normalized = identifier.trim();

  // DOI patterns: 10.xxxx/... or https://doi.org/10.xxxx/...
  if (/^(https?:\/\/doi\.org\/)?10\.\d{4,}\/\S+$/i.test(normalized)) {
    return "doi";
  }

  // arXiv patterns: 2301.12345, arxiv:2301.12345, or arXiv:2301.12345v2
  if (/^(arxiv:)?(\d{4}\.\d{4,5})(v\d+)?$/i.test(normalized)) {
    return "arxiv";
  }

  // Old arXiv format: hep-th/9901001
  if (/^[a-z-]+\/\d{7}$/i.test(normalized)) {
    return "arxiv";
  }

  return "unknown";
}

/**
 * Format a citation based on the requested format.
 *
 * @param citation - The citation to format
 * @param format - The output format
 * @returns Formatted citation string
 */
function formatCitation(citation: Citation, format: CitationFormat): string {
  switch (format) {
    case "apa":
      return formatCitationAPA(citation);
    case "bibtex":
      return formatCitationBibTeX(citation);
    default:
      return formatCitationAPA(citation);
  }
}

/**
 * Format a list of citations as a summary for display.
 *
 * @param citations - Array of citations
 * @param format - Output format for each citation
 * @returns Formatted results
 */
function formatCitationList(
  citations: Citation[],
  format: CitationFormat = "apa"
): string[] {
  return citations.map((c, i) => {
    const formatted = formatCitation(c, format);
    const source = c.source === "arxiv" ? `arXiv:${c.arxivId}` : c.doi ? `DOI:${c.doi}` : "";
    return `[${i + 1}] ${formatted}${source ? `\n    ${source}` : ""}`;
  });
}

// =============================================================================
// TOOL EXPORT
// =============================================================================

export default tool({
  name: "literature-search",
  description:
    "Search and cite academic papers from Crossref and arXiv. " +
    "Actions: search (find papers by query), cite (format DOI/arXiv ID as APA/BibTeX), " +
    "related (find papers related to a research topic). Results are cached for 7 days.",

  args: {
    action: tool.schema
      .enum(["search", "cite", "related"])
      .describe(
        "Operation to perform: " +
          "search (find papers matching query), " +
          "cite (format a DOI or arXiv ID as citation), " +
          "related (find papers related to a topic for research context)"
      ),
    query: tool.schema
      .string()
      .optional()
      .describe(
        "Search query for search/related actions. " +
          "For arXiv, supports field prefixes: ti: (title), au: (author), abs: (abstract), all: (all fields)"
      ),
    source: tool.schema
      .enum(["crossref", "arxiv", "both"])
      .optional()
      .describe(
        "Which source to search. Defaults to 'both'. " +
          "crossref: Published papers with DOIs. " +
          "arxiv: Preprints in physics, math, CS, etc."
      ),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 10, max: 100)"),
    identifier: tool.schema
      .string()
      .optional()
      .describe(
        "DOI or arXiv ID for cite action. " +
          "DOI format: '10.1038/nature12373' or 'https://doi.org/10.1038/nature12373'. " +
          "arXiv format: '2301.12345' or 'arxiv:2301.12345v2'"
      ),
    format: tool.schema
      .enum(["apa", "bibtex"])
      .optional()
      .describe("Citation format for cite action. Defaults to 'apa'"),
  },

  async execute(args) {
    const { action, query, source = "both", limit = 10, identifier, format = "apa" } = args;

    switch (action) {
      // =========================================================================
      // SEARCH ACTION
      // =========================================================================
      case "search": {
        if (!query || query.trim().length === 0) {
          throw new Error("query is required for search action");
        }

        const clampedLimit = Math.min(Math.max(1, limit), 100);
        let result: SearchResult;

        try {
          if (source === "crossref") {
            result = await searchCrossref(query, clampedLimit);
          } else if (source === "arxiv") {
            result = await searchArxiv(query, clampedLimit);
          } else {
            // Search both sources
            result = await searchLiterature(query, {
              limit: clampedLimit,
              sources: ["crossref", "arxiv"],
            });
          }
        } catch (error) {
          if (error instanceof LiteratureAPIError) {
            throw new Error(`Literature search failed: ${error.message}`);
          }
          throw error;
        }

        const formattedCitations = formatCitationList(result.citations, "apa");

        return JSON.stringify(
          {
            success: true,
            action: "search",
            query,
            source: source === "both" ? "crossref+arxiv" : source,
            totalResults: result.totalResults,
            returnedResults: result.citations.length,
            fromCache: result.fromCache,
            citations: result.citations.map((c) => ({
              title: c.title,
              authors: c.authors,
              year: c.year,
              journal: c.journal,
              doi: c.doi,
              arxivId: c.arxivId,
              url: c.url,
              abstract: c.abstract?.substring(0, 500) + (c.abstract && c.abstract.length > 500 ? "..." : ""),
              source: c.source,
            })),
            formatted: formattedCitations,
          },
          null,
          2
        );
      }

      // =========================================================================
      // CITE ACTION
      // =========================================================================
      case "cite": {
        if (!identifier || identifier.trim().length === 0) {
          throw new Error("identifier (DOI or arXiv ID) is required for cite action");
        }

        const idType = detectIdentifierType(identifier);

        if (idType === "unknown") {
          throw new Error(
            `Could not detect identifier type. ` +
              `Expected DOI (e.g., '10.1038/nature12373') or arXiv ID (e.g., '2301.12345'). ` +
              `Got: '${identifier}'`
          );
        }

        let citation: Citation | null;

        try {
          if (idType === "doi") {
            citation = await getCitationByDOI(identifier);
          } else {
            citation = await getArxivPaper(identifier);
          }
        } catch (error) {
          if (error instanceof LiteratureAPIError) {
            throw new Error(`Failed to fetch citation: ${error.message}`);
          }
          throw error;
        }

        if (!citation) {
          throw new Error(
            `${idType === "doi" ? "DOI" : "arXiv paper"} not found: ${identifier}`
          );
        }

        const formattedCitation = formatCitation(citation, format);

        return JSON.stringify(
          {
            success: true,
            action: "cite",
            identifier,
            identifierType: idType,
            format,
            citation: {
              title: citation.title,
              authors: citation.authors,
              year: citation.year,
              journal: citation.journal,
              doi: citation.doi,
              arxivId: citation.arxivId,
              url: citation.url,
              abstract: citation.abstract,
              source: citation.source,
            },
            formatted: formattedCitation,
          },
          null,
          2
        );
      }

      // =========================================================================
      // RELATED ACTION
      // =========================================================================
      case "related": {
        if (!query || query.trim().length === 0) {
          throw new Error("query (research topic) is required for related action");
        }

        // For related papers, we search both sources with a slightly higher limit
        // to provide more context for researchers
        const clampedLimit = Math.min(Math.max(1, limit), 100);

        let result: SearchResult;

        try {
          // Determine sources based on user preference
          const sources: Array<"crossref" | "arxiv"> =
            source === "crossref"
              ? ["crossref"]
              : source === "arxiv"
              ? ["arxiv"]
              : ["crossref", "arxiv"];

          result = await searchLiterature(query, {
            limit: clampedLimit,
            sources,
          });
        } catch (error) {
          if (error instanceof LiteratureAPIError) {
            throw new Error(`Related paper search failed: ${error.message}`);
          }
          throw error;
        }

        // Group citations by year for easier review
        const byYear: Record<string, Citation[]> = {};
        for (const c of result.citations) {
          const yearKey = c.year?.toString() ?? "Unknown";
          if (!byYear[yearKey]) {
            byYear[yearKey] = [];
          }
          byYear[yearKey].push(c);
        }

        // Extract key topics from abstracts for context
        const allAbstracts = result.citations
          .filter((c) => c.abstract)
          .map((c) => c.abstract!)
          .join(" ");

        // Simple summary: list papers with their key info
        const summaryList = result.citations.slice(0, 5).map((c) => ({
          title: c.title,
          authors: c.authors.split(",")[0] + (c.authors.includes(",") ? " et al." : ""),
          year: c.year,
          source: c.source,
          identifier: c.doi ? `doi:${c.doi}` : c.arxivId ? `arXiv:${c.arxivId}` : null,
        }));

        return JSON.stringify(
          {
            success: true,
            action: "related",
            topic: query,
            source: source === "both" ? "crossref+arxiv" : source,
            totalResults: result.totalResults,
            returnedResults: result.citations.length,
            fromCache: result.fromCache,
            topPapers: summaryList,
            byYear: Object.keys(byYear)
              .sort((a, b) => (b === "Unknown" ? -1 : a === "Unknown" ? 1 : parseInt(b) - parseInt(a)))
              .slice(0, 5)
              .reduce(
                (acc, year) => ({
                  ...acc,
                  [year]: byYear[year].length,
                }),
                {} as Record<string, number>
              ),
            citations: result.citations.map((c) => ({
              title: c.title,
              authors: c.authors,
              year: c.year,
              journal: c.journal,
              doi: c.doi,
              arxivId: c.arxivId,
              url: c.url,
              abstract: c.abstract?.substring(0, 300) + (c.abstract && c.abstract.length > 300 ? "..." : ""),
              source: c.source,
            })),
            hint:
              "Use the 'cite' action with a DOI or arXiv ID to get formatted citations for papers you want to reference.",
          },
          null,
          2
        );
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  },
});
