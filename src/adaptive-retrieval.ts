/**
 * Adaptive Retrieval
 * Determines whether a query needs memory retrieval at all.
 * Skips retrieval for greetings, commands, simple instructions, and system messages.
 * Saves embedding API calls and reduces noise injection.
 */

const SKIP_PATTERNS = [
    /^(hi|hello|hey|good\s*(morning|afternoon|evening|night)|greetings|yo|sup|howdy|what'?s up)\b/i,
    /^\//,
    /^(run|build|test|ls|cd|git|npm|pip|docker|curl|cat|grep|find|make|sudo)\b/i,
    /^(yes|no|yep|nope|ok|okay|sure|fine|thanks|thank you|thx|ty|got it|understood|cool|nice|great|good|perfect|awesome|👍|👎|✅|❌)\s*[.!]?$/i,
    /^(go ahead|continue|proceed|do it|start|begin|next|實施|開始|繼續|好的|可以|行)\s*[.!]?$/i,
    /^[\p{Emoji}\s]+$/u,
    /HEARTBEAT/i,
    /^\[System/i,
    /^(ping|pong|test|debug)\s*[.!?]?$/i,
];

const FORCE_RETRIEVE_PATTERNS = [
    /\b(remember|recall|forgot|memory|memories)\b/i,
    /\b(last time|before|previously|earlier|yesterday|ago)\b/i,
    /\b(my (name|email|phone|address|birthday|preference))\b/i,
    /\b(what did (i|we)|did i (tell|say|mention))\b/i,
    /(你記得|之前|上次|以前|還記得|提到過|說過)/i,
];

/**
 * Normalize the raw prompt before applying skip/force rules.
 */
function normalizeQuery(query: string): string {
    let s = query.trim();
    s = s.replace(/^\[cron:[^\]]+\]\s*/i, "");
    if (/^Conversation info \(untrusted metadata\):/i.test(s)) {
        s = s.replace(/^Conversation info \(untrusted metadata\):\s*/i, "");
        const parts = s.split(/\n\s*\n/, 2);
        if (parts.length === 2) s = parts[1];
    }
    return s.trim();
}

/**
 * Determine if a query should skip memory retrieval.
 * Returns true if retrieval should be skipped.
 */
export function shouldSkipRetrieval(query: string, minLength?: number): boolean {
    const trimmed = normalizeQuery(query);

    // Force retrieve if query has memory-related intent
    if (FORCE_RETRIEVE_PATTERNS.some(p => p.test(trimmed))) return false;

    if (trimmed.length < 5) return true;

    if (SKIP_PATTERNS.some(p => p.test(trimmed))) return true;

    if (minLength !== undefined && minLength > 0) {
        if (trimmed.length < minLength && !trimmed.includes('?') && !trimmed.includes('？')) return true;
        return false;
    }

    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(trimmed);
    const defaultMinLength = hasCJK ? 6 : 15;
    if (trimmed.length < defaultMinLength && !trimmed.includes('?') && !trimmed.includes('？')) return true;

    return false;
}
