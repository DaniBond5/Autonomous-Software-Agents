const TRACE_ENABLED =
    String(process.env.LLM_TRACE ?? "").toLowerCase() === "true";

const MAX_VALUE_LENGTH = 180;
const SIMPLE_VALUE = /^[a-zA-Z0-9_.:/,()<>-]+$/;
const QUOTED_FIELDS = new Set(["goal", "answer", "text"]);

const compact = value => {
    const normalized = String(value).replace(/\s+/g, " ").trim();
    return normalized.length <= MAX_VALUE_LENGTH
        ? normalized
        : `${normalized.slice(0, MAX_VALUE_LENGTH - 3)}...`;
};

function serialize(value) {
    try {
        const serialized = JSON.stringify(value, (_key, nested) => {
            if (typeof nested === "string") return compact(nested);
            if (typeof nested === "bigint") return String(nested);
            if (nested instanceof Error) return compact(nested.message);
            return nested;
        });
        return compact(serialized ?? String(value));
    } catch {
        return "[unserializable]";
    }
}

function formatValue(key, value) {
    if (typeof value !== "string") return serialize(value);
    const normalized = compact(value);
    if (QUOTED_FIELDS.has(key)) return JSON.stringify(normalized);
    const structured = (normalized.startsWith("{") && normalized.endsWith("}"))
        || (normalized.startsWith("[") && normalized.endsWith("]"));
    return SIMPLE_VALUE.test(normalized) || structured
        ? normalized
        : JSON.stringify(normalized);
}

export function trace(scope, event, fields = {}) {
    if (!TRACE_ENABLED) return;

    try {
        const details = Object.entries(fields)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${compact(key)}=${formatValue(key, value)}`);
        const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
        console.log(`[trace][${compact(scope)}] ${compact(event)}${suffix}`);
    } catch {}
}
