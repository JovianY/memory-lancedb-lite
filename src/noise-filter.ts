/**
 * Noise Filter
 * Filters out low-quality memories (meta-questions, agent denials, session boilerplate).
 */

const DENIAL_PATTERNS = [
    /i don'?t have (any )?(information|data|memory|record)/i,
    /i'?m not sure about/i,
    /i don'?t recall/i,
    /i don'?t remember/i,
    /it looks like i don'?t/i,
    /i wasn'?t able to find/i,
    /no (relevant )?memories found/i,
    /i don'?t have access to/i,
];

const META_QUESTION_PATTERNS = [
    /\bdo you (remember|recall|know about)\b/i,
    /\bcan you (remember|recall)\b/i,
    /\bdid i (tell|mention|say|share)\b/i,
    /\bhave i (told|mentioned|said)\b/i,
    /\bwhat did i (tell|say|mention)\b/i,
];

const BOILERPLATE_PATTERNS = [
    /^(hi|hello|hey|good morning|good evening|greetings)/i,
    /^fresh session/i,
    /^new session/i,
    /^HEARTBEAT/i,
];

export interface NoiseFilterOptions {
    filterDenials?: boolean;
    filterMetaQuestions?: boolean;
    filterBoilerplate?: boolean;
}

const DEFAULT_OPTIONS: Required<NoiseFilterOptions> = {
    filterDenials: true,
    filterMetaQuestions: true,
    filterBoilerplate: true,
};

/**
 * Check if a memory text is noise that should be filtered out.
 * Returns true if the text is noise.
 */
export function isNoise(text: string, options: NoiseFilterOptions = {}): boolean {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const trimmed = text.trim();

    if (trimmed.length < 5) return true;

    if (opts.filterDenials && DENIAL_PATTERNS.some(p => p.test(trimmed))) return true;
    if (opts.filterMetaQuestions && META_QUESTION_PATTERNS.some(p => p.test(trimmed))) return true;
    if (opts.filterBoilerplate && BOILERPLATE_PATTERNS.some(p => p.test(trimmed))) return true;

    return false;
}

/**
 * Filter an array of items, removing noise entries.
 */
export function filterNoise<T>(
    items: T[],
    getText: (item: T) => string,
    options?: NoiseFilterOptions
): T[] {
    return items.filter(item => !isNoise(getText(item), options));
}
