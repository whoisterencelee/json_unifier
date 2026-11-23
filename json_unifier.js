/**
 * JSON Unifier - Schema Analyzer
 * Unifies multiple JSON objects into a single schema with enum detection
 * Works in both browser and Node.js
 */

(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define(factory);
    } else {
        root.JSONUnifier = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {

    // ============================================================
    // Configuration
    // ============================================================
    const MIN_ENUM_OCCURRENCES = 6;
    const MAX_LITERAL_SET = 3;        // > this many distinct bare literals -> "string"
    const MAX_ENUM_CARDINALITY = 20;  // > this many distinct values -> not a closed enum

    // Field names that are free-form text by convention. If a key matches,
    // its value is forced to 'string' regardless of value shape.
    const TEXT_FIELD_NAMES = new Set([
        // conversational
        'title', 'content', 'body', 'text', 'message', 'msg', 'prompt', 'response',
        'question', 'answer', 'query', 'input', 'output', 'completion',
        // descriptive
        'description', 'desc', 'summary', 'abstract', 'excerpt', 'snippet',
        'note', 'notes', 'comment', 'comments', 'remark', 'remarks',
        'caption', 'headline', 'subject', 'subtitle', 'tagline',
        // chat / docs
        'preview', 'transcript', 'dialogue', 'conversation',
        'reasoning', 'thought', 'explanation', 'rationale',
        // high-cardinality labels
        'site_name', 'sitename', 'domain', 'host', 'hostname', 'source', 'publisher',
        'vendor', 'brand', 'site', 'website', 'origin', 'referrer',
        'author', 'username', 'display_name', 'full_name',
        'tag', 'tags', 'keyword', 'keywords'
    ]);

    const FILENAME_EXTENSIONS = new Set([
        // images
        'webp','png','jpg','jpeg','gif','svg','bmp','tiff','tif','heic','heif','avif','ico',
        // documents
        'pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','rtf','odt','ods','odp',
        'csv','tsv','json','xml','yaml','yml','html','htm','css',
        // archives
        'zip','tar','gz','tgz','rar','7z','bz2','xz',
        // audio / video
        'mp3','wav','ogg','oga','flac','aac','m4a','opus','mp4','m4v','mov','avi','mkv','webm','wmv','flv',
        // code
        'js','mjs','cjs','ts','jsx','tsx','py','rb','go','rs','java','kt','c','h','cpp','hpp','cc','cs','php','swift','sh','bash','ps1','sql','lua','pl','r','scala','dart','vue','svelte'
    ]);

    const TYPE_SENTINELS = new Set([
        'string', 'filename', 'isodate', 'uuid', 'n', 'number', 'boolean', 'null', 'array'
    ]);

    // ============================================================
    // Utility Functions
    // ============================================================
    function isNumericKey(key) {
        return !isNaN(parseInt(key)) && parseInt(key).toString() === key;
    }

    function isNumericValue(value) {
        if (typeof value === 'string') {
            return !isNaN(parseInt(value)) && parseInt(value).toString() === value;
        }
        return false;
    }

    function isISODate(value) {
        if (typeof value !== 'string') return false;
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3,6})?([+-]\d{2}:\d{2}|Z)?$/.test(value);
    }

    function isUUID(value) {
        if (typeof value !== 'string') return false;
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    function isUUIDKey(key) {
        return isUUID(key);
    }

    function isSingleWord(value) {
        if (typeof value !== 'string') return false;
        return /^[a-zA-Z0-9_]+$/.test(value);
    }

    function isAllCaps(value) {
        if (typeof value !== 'string') return false;
        return value === value.toUpperCase() && value !== value.toLowerCase();
    }

    function isFilename(value) {
        if (typeof value !== 'string') return false;

        const m = value.match(/\.([a-zA-Z0-9]{2,5})$/);
        if (!m) return false;

        const ext = m[1].toLowerCase();
        if (!FILENAME_EXTENSIONS.has(ext)) return false;

        const base = value.slice(0, value.length - m[0].length);
        if (base.length === 0) return false;

        if (value.includes('\n') || value.includes('\r')) return false;

        return true;
    }

    function isFreeText(value) {
        if (typeof value !== 'string') return false;
        if (value.length < 2) return false;

        // Whitespace, CJK/Hangul, or sentence punctuation -> free text
        if (/\s/.test(value)) return true;
        if (/[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(value)) return true;
        if (/[，。！？、；：,.!?;:]/.test(value)) return true;

        // Single token. All-caps or lower-with-separators -> enum candidate.
        if (/^[A-Z0-9_]+$/.test(value)) return false;        // ACTIVE, V2
        if (/^[a-z0-9_.-]+$/.test(value)) return false;      // in_progress, deepseek-chat

        // Mixed case with lowercase tail -> proper-noun-ish free text (Monday)
        if (/^[A-Z][a-z]/.test(value)) return true;

        return false;
    }

    function isTextFieldName(key) {
        if (typeof key !== 'string') return false;
        return TEXT_FIELD_NAMES.has(key.toLowerCase());
    }

    // ============================================================
    // Core Functions
    // ============================================================
    function createUnifier() {
        const frequencyMap = new Map();
        let totalItems = 0;

        function recordFrequency(value) {
            if (typeof value !== 'string') return;
            if (isISODate(value)) return;
            if (isUUID(value)) return;
            if (isNumericValue(value)) return;
            if (value.length > 50) return;
            if (value.length < 2) return;

            if (!frequencyMap.has(value)) {
                frequencyMap.set(value, 0);
            }
            frequencyMap.set(value, frequencyMap.get(value) + 1);
        }

        function getFrequency(value) {
            return frequencyMap.get(value) || 0;
        }

        function shouldBeEnum(value) {
            if (typeof value !== 'string') return false;
            if (isISODate(value)) return false;
            if (isUUID(value)) return false;
            if (isNumericValue(value)) return false;
            if (isFilename(value)) return false;
            if (isFreeText(value)) return false;
            if (value.length > 30) return false;
            if (value.length < 2) return false;

            const freq = getFrequency(value);
            if (freq < MIN_ENUM_OCCURRENCES) return false;

            const isAllCapsWord = isAllCaps(value) && isSingleWord(value);
            const freqPct = (freq / totalItems) * 100;
            if (isAllCapsWord) return true;
            return freqPct >= 10;
        }

        // key is optional; when provided, text-field-name rules apply.
        function normalizeValue(value, key) {
            if (value === null || value === undefined) return;
            const type = typeof value;
            if (type === 'string') {
                recordFrequency(value);

                // Key-based rule wins: known text fields are always 'string'.
                if (key !== undefined && isTextFieldName(key)) return 'string';

                if (isISODate(value)) return 'isodate';
                if (isUUID(value)) return 'uuid';
                if (isFilename(value)) return 'filename';
                if (isFreeText(value)) return 'string';
                if (isNumericValue(value)) return 'n';
                if (shouldBeEnum(value)) return value;
                return 'string';
            }
            if (type === 'number') return 'number';
            if (type === 'boolean') return 'boolean';
            throw new Error(`Unexpected value type in normalizeValue: ${type} (value: ${JSON.stringify(value)})`);
        }

        function normalizeArray(arr, path) {
            if (arr.length === 0) return [];
            let merged = normalize(arr[0], path ? `${path}[0]` : 'array[0]');
            for (let i = 1; i < arr.length; i++) {
                const normalized = normalize(arr[i], path ? `${path}[${i}]` : `array[${i}]`);
                merged = mergeObjects(merged, normalized, path ? `${path}[${i}]` : `array[${i}]`);
            }
            if (Array.isArray(merged)) return merged;
            return [merged];
        }

        function normalize(obj, path) {
            path = path || 'root';
            if (obj === null || obj === undefined) return;
            if (typeof obj !== 'object') {
                // No key context at the top level.
                const normalized = normalizeValue(obj);
                if (normalized === undefined) return new Map();
                const map = new Map();
                map.set(normalized, 1);
                return map;
            }
            if (Array.isArray(obj)) {
                return normalizeArray(obj, path);
            }

            const result = {};
            const keys = Object.keys(obj);
            for (const key of keys) {
                let normalizedKey;
                if (isNumericKey(key)) normalizedKey = 'n';
                else if (isUUIDKey(key)) normalizedKey = 'uuid';
                else normalizedKey = key;

                const value = obj[key];
                const currentPath = path ? `${path}.${key}` : key;

                let normalizedValue;
                if (Array.isArray(value)) {
                    normalizedValue = normalizeArray(value, currentPath);
                } else if (typeof value === 'object' && value !== null) {
                    normalizedValue = normalize(value, currentPath);
                } else {
                    // Pass the key so text-field-name rules apply.
                    const normalized = normalizeValue(value, key);
                    if (normalized === undefined) {
                        normalizedValue = new Map();   // nullish -> empty, merges harmlessly
                    } else {
                        const map = new Map();
                        map.set(normalized, 1);
                        normalizedValue = map;
                    }
                }

                if (normalizedKey in result) {
                    result[normalizedKey] = mergeObjects(result[normalizedKey], normalizedValue, currentPath);
                } else {
                    result[normalizedKey] = normalizedValue;
                }
            }
            return result;
        }

        function mergeObjects(obj1, obj2, path) {
            path = path || 'root';

            if (obj1 instanceof Map && obj2 instanceof Map) {
                const merged = new Map(obj1);
                for (const [k, count] of obj2) {
                    merged.set(k, (merged.get(k) || 1) + count);
                }
                return merged;
            }

            if (typeof obj1 === 'object' && obj1 !== null && !Array.isArray(obj1) && !(obj1 instanceof Map) &&
                typeof obj2 === 'object' && obj2 !== null && !Array.isArray(obj2) && !(obj2 instanceof Map)) {
                const result = { ...obj1 };
                for (const key of Object.keys(obj2)) {
                    const val1 = obj1[key];
                    const val2 = obj2[key];
                    const currentPath = path ? `${path}.${key}` : key;
                    if (val1 === undefined) {
                        result[key] = val2;
                    } else {
                        result[key] = mergeObjects(val1, val2, currentPath);
                    }
                }
                return result;
            }

            if (Array.isArray(obj1) && Array.isArray(obj2)) {
                const allMaps1 = obj1.every(item => item instanceof Map);
                const allMaps2 = obj2.every(item => item instanceof Map);

                if (allMaps1 && allMaps2 && obj1.length > 0 && obj2.length > 0) {
                    const merged = new Map();
                    for (const map of obj1) {
                        for (const [k, count] of map) {
                            merged.set(k, (merged.get(k) || 1) + count);
                        }
                    }
                    for (const map of obj2) {
                        for (const [k, count] of map) {
                            merged.set(k, (merged.get(k) || 1) + count);
                        }
                    }
                    return [merged];
                }

                if (obj1.length === 0 && obj2.length > 0 && obj2.every(item => item instanceof Map)) return obj2;
                if (obj2.length === 0 && obj1.length > 0 && obj1.every(item => item instanceof Map)) return obj1;

                const maxLen = Math.max(obj1.length, obj2.length);
                const result = [];
                for (let i = 0; i < maxLen; i++) {
                    const val1 = i < obj1.length ? obj1[i] : undefined;
                    const val2 = i < obj2.length ? obj2[i] : undefined;
                    if (val1 === undefined) result.push(val2);
                    else if (val2 === undefined) result.push(val1);
                    else result.push(mergeObjects(val1, val2, path ? `${path}[${i}]` : `[${i}]`));
                }
                return result;
            }

            const map = new Map();
            map.set(obj1, 1);
            map.set(obj2, 1);
            return map;
        }

        function stringifyEnums(obj) {
            if (obj === null || obj === undefined) return obj;
            if (obj instanceof Map) {
                const entries = Array.from(obj.entries());
                const enumValues = [];
                const typeSentinels = new Set();
                const literalValues = [];

                for (const [val, count] of entries) {
                    if (typeof val !== 'string' || TYPE_SENTINELS.has(val)) {
                        typeSentinels.add(val);
                    } else if (shouldBeEnum(val)) {
                        enumValues.push(val);
                    } else {
                        literalValues.push(val);
                    }
                }

                // Pure type-typed Map (number, boolean, string, ...): resolve by type.
                if (enumValues.length === 0 && literalValues.length === 0) {
                    if (typeSentinels.size === 1) {
                        return typeSentinels.values().next().value;
                    }
                    if (typeSentinels.has('string'))   return 'string';
                    if (typeSentinels.has('filename')) return 'filename';
                    if (typeSentinels.has('isodate'))  return 'isodate';
                    if (typeSentinels.has('uuid'))     return 'uuid';
                    if (typeSentinels.has('n'))        return 'n';
                    if (typeSentinels.has('number'))   return 'number';
                    if (typeSentinels.has('boolean'))  return 'boolean';
                    return 'string';
                }

                // High-cardinality field: not a closed enum, treat as string.
                if (entries.length > MAX_ENUM_CARDINALITY) {
                    return 'string';
                }

                if (enumValues.length >= 2) {
                    return `{${enumValues.join('|')}}`;
                }
                if (enumValues.length === 1) {
                    return enumValues[0];
                }

                // Literal tail: a tiny closed set stays as {a|b|c}; otherwise string.
                if (literalValues.length === 0) return 'string';
                if (literalValues.length === 1) return literalValues[0];
                if (literalValues.length > MAX_LITERAL_SET) return 'string';
                return `{${literalValues.join('|')}}`;
            }
            if (Array.isArray(obj)) {
                return obj.map(item => stringifyEnums(item));
            }
            if (typeof obj === 'object') {
                const result = {};
                for (const [key, value] of Object.entries(obj)) {
                    result[key] = stringifyEnums(value);
                }
                return result;
            }
            return obj;
        }

        function collectFrequencies(obj) {
            if (obj === null || obj === undefined) return;
            if (typeof obj !== 'object') {
                if (typeof obj === 'string') recordFrequency(obj);
                return;
            }
            if (Array.isArray(obj)) {
                for (const item of obj) collectFrequencies(item);
                return;
            }
            for (const key of Object.keys(obj)) {
                collectFrequencies(obj[key]);
            }
        }

        function analyze(data) {
            frequencyMap.clear();
            totalItems = 0;

            if (Array.isArray(data)) {
                totalItems = data.length;
                for (const item of data) collectFrequencies(item);
            } else {
                totalItems = 1;
                collectFrequencies(data);
            }

            const startTime = Date.now();
            const merged = normalize(data);
            const schema = stringifyEnums(merged);
            const elapsed = (Date.now() - startTime);

            const frequencies = [];
            const sorted = Array.from(frequencyMap.entries())
                .filter(([value, count]) => count >= MIN_ENUM_OCCURRENCES)
                .sort((a, b) => b[1] - a[1]);

            for (const [value, count] of sorted) {
                const pct = ((count / totalItems) * 100);
                frequencies.push({
                    value: value,
                    count: count,
                    pct: pct.toFixed(1),
                    isEnum: shouldBeEnum(value)
                });
            }

            return {
                schema: schema,
                frequencies: frequencies,
                totalItems: totalItems,
                elapsed: elapsed.toFixed(2)
            };
        }

        return {
            analyze: analyze,
            normalize: normalize,
            normalizeValue: normalizeValue,
            normalizeArray: normalizeArray,
            mergeObjects: mergeObjects,
            stringifyEnums: stringifyEnums,
            shouldBeEnum: shouldBeEnum,
            getFrequency: getFrequency,
            getFrequencyMap: function() { return frequencyMap; },
            totalItems: function() { return totalItems; }
        };
    }

    // ============================================================
    // Directory Mode: Scan + Group + Analyze
    // ============================================================

    const KNOWN_TOP_FILES = {
        'manifest.json':         { mode: 'single', group: 'manifest' },
        'user.json':             { mode: 'single', group: 'user' },
        'chat_session_index.json': { mode: 'array',  group: 'chat_session_index' }
    };

    const CHAT_SESSIONS_DIR = 'chat_sessions';

    function discoverSources(dirPath, fs, path) {
        const sources = [];

        function readJSON(filePath) {
            const raw = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(raw);
        }

        for (const [filename, spec] of Object.entries(KNOWN_TOP_FILES)) {
            const full = path.join(dirPath, filename);
            if (!fs.existsSync(full)) {
                console.warn(`  âš ï¸  Missing expected file: ${filename}`);
                continue;
            }
            try {
                const parsed = readJSON(full);
                if (spec.mode === 'array' && !Array.isArray(parsed)) {
                    console.warn(`  âš ï¸  ${filename} is not an array, wrapping as single item`);
                    sources.push({ group: spec.group, name: filename, filePath: full, parsed: [parsed] });
                } else if (spec.mode === 'single') {
                    sources.push({ group: spec.group, name: filename, filePath: full, parsed: [parsed] });
                } else {
                    sources.push({ group: spec.group, name: filename, filePath: full, parsed });
                }
            } catch (e) {
                console.warn(`  âš ï¸  Failed to parse ${filename}: ${e.message}`);
            }
        }

        const sessionsDir = path.join(dirPath, CHAT_SESSIONS_DIR);
        if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
            const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                if (!entry.name.toLowerCase().endsWith('.json')) continue;

                const full = path.join(sessionsDir, entry.name);
                try {
                    const parsed = readJSON(full);
                    sources.push({
                        group: 'chat_session',
                        name: entry.name,
                        filePath: full,
                        parsed: [parsed]
                    });
                } catch (e) {
                    console.warn(`  âš ï¸  Failed to parse chat_sessions/${entry.name}: ${e.message}`);
                }
            }
        } else {
            console.warn(`  âš ï¸  No ${CHAT_SESSIONS_DIR}/ directory found`);
        }

        return sources;
    }

    function analyzeDirectory(dirPath, deps) {
        const fs = deps && deps.fs;
        const path = deps && deps.path;
        if (!fs || !path) {
            throw new Error('analyzeDirectory requires fs and path (Node.js only)');
        }

        const startTime = Date.now();
        const sources = discoverSources(dirPath, fs, path);

        if (sources.length === 0) {
            throw new Error(`No JSON sources found in ${dirPath}`);
        }

        const byGroup = {};
        for (const src of sources) {
            if (!byGroup[src.group]) byGroup[src.group] = [];
            byGroup[src.group].push(src);
        }

        const groups = {};
        for (const [groupName, srcs] of Object.entries(byGroup)) {
            const allItems = [];
            for (const src of srcs) {
                for (const item of src.parsed) allItems.push(item);
            }
            const unifier = createUnifier();
            const result = unifier.analyze(allItems);
            groups[groupName] = {
                schema: result.schema,
                frequencies: result.frequencies,
                totalItems: result.totalItems,
                elapsed: result.elapsed,
                fileCount: srcs.length
            };
        }

        const combinedItems = [];
        for (const src of sources) {
            for (const item of src.parsed) combinedItems.push(item);
        }
        const combinedUnifier = createUnifier();
        const combined = combinedUnifier.analyze(combinedItems);

        return {
            groups: groups,
            combined: combined,
            totalFiles: sources.length,
            elapsed: (Date.now() - startTime).toFixed(2)
        };
    }

    // ============================================================
    // Sample Data
    // ============================================================
    function getSampleData() {
        return [
            {
                "id": "3f36e079-449b-417b-9ad3-5c8f75617388",
                "title": "write this in chinese: To: Econo",
                "inserted_at": "2025-02-03T06:00:27.917000+08:00",
                "updated_at": "2025-02-03T06:00:42.773000+08:00",
                "mapping": {
                    "root": { "id": "root", "parent": null, "children": ["1"], "message": null },
                    "1": {
                        "id": "1", "parent": "root", "children": ["2"],
                        "message": {
                            "model": "deepseek-chat",
                            "inserted_at": "2025-02-03T06:00:28.185000+08:00",
                            "fragments": [{ "type": "REQUEST", "content": "write this in chinese: To: Economic and Technological Development Bureau" }]
                        }
                    },
                    "2": {
                        "id": "2", "parent": "1", "children": [],
                        "message": {
                            "model": "deepseek-chat",
                            "inserted_at": "2025-02-03T06:00:28.185000+08:00",
                            "fragments": [{ "type": "RESPONSE", "content": "è‡´ï¼šç»æµŽåŠç§‘æŠ€å‘å±•å±€" }]
                        }
                    }
                }
            }
        ];
    }

    // ============================================================
    // Public API
    // ============================================================
    function analyzeJSON(data) {
        const unifier = createUnifier();
        return unifier.analyze(data);
    }

    // ============================================================
    // Export
    // ============================================================
    const exports = {
        analyzeJSON: analyzeJSON,
        analyzeDirectory: analyzeDirectory,
        getSampleData: getSampleData,
        createUnifier: createUnifier,
        discoverSources: discoverSources,
        isFilename: isFilename,
        isFreeText: isFreeText,
        isTextFieldName: isTextFieldName
    };

    if (typeof require === 'function') {
        try {
            const fs = require('fs');
            const path = require('path');

            exports.analyzeFile = function(filePath) {
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                return analyzeJSON(data);
            };

            exports.analyzePath = function(dirPath) {
                const stat = fs.statSync(dirPath);
                if (stat.isDirectory()) {
                    return analyzeDirectory(dirPath, { fs, path });
                }
                return analyzeJSON(JSON.parse(fs.readFileSync(dirPath, 'utf8')));
            };

        } catch (e) {
            // fs not available
        }
    }

    return exports;
}));

// ============================================================
// Node.js CLI - node json_unifier.js <file-or-directory>
// ============================================================
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
    const fs = require('fs');
    const path = require('path');

    const unifier = require('./json_unifier.js');
    const args = process.argv.slice(2);
    const inputPath = args[0] || 'c.json';

    function printSchemaPreview(schema, maxLines) {
        const schemaStr = JSON.stringify(schema, null, 2);
        const lines = schemaStr.split('\n');
        console.log(lines.slice(0, maxLines).join('\n'));
        if (lines.length > maxLines) {
            console.log('... (truncated)');
        }
        return schemaStr;
    }

    try {
        if (!fs.existsSync(inputPath)) {
            console.error(`âŒ Path not found: ${inputPath}`);
            process.exit(1);
        }

        const stat = fs.statSync(inputPath);

        if (stat.isDirectory()) {

            console.log(`ðŸ“ Scanning directory: ${inputPath}`);
            const result = unifier.analyzeDirectory(inputPath, { fs, path });

            console.log(`  Found ${result.totalFiles} JSON file(s) in ${Object.keys(result.groups).length} group(s)`);
            console.log(`  â±ï¸  Total time: ${result.elapsed}ms\n`);

            const outDir = path.join('./')

            for (const [groupName, g] of Object.entries(result.groups)) {
                console.log(`â”€â”€ ${groupName} (${g.fileCount} file(s), ${g.totalItems} item(s), ${g.elapsed}ms) â”€â”€`);

                const outPath = path.join(outDir, `${groupName}.schema.json`);
                fs.writeFileSync(outPath, JSON.stringify(g.schema, null, 2));
                console.log(`   ðŸ’¾ ${outPath}`);

                if (g.frequencies.length > 0) {
                    const enums = g.frequencies.filter(f => f.isEnum).slice(0, 10);
                    if (enums.length > 0) {
                        console.log(`   Enums: ${enums.map(e => `${e.value}(${e.count})`).join(', ')}`);
                    }
                }
                console.log();
            }

            console.log(`â”€â”€ combined (${result.combined.totalItems} item(s)) â”€â”€`);
            const combinedPath = path.join(outDir, 'combined.schema.json');
            fs.writeFileSync(combinedPath, JSON.stringify(result.combined.schema, null, 2));
            console.log(`   ðŸ’¾ ${combinedPath}\n`);

            for (const [groupName, g] of Object.entries(result.groups)) {
                console.log(`ðŸ“Š Preview: ${groupName}.schema.json`);
                printSchemaPreview(g.schema, 20);
                console.log();
            }

        } else {
            console.log(`ðŸ“– Reading: ${inputPath}`);
            const fileContent = fs.readFileSync(inputPath, 'utf8');
            console.log(`ðŸ“„ File size: ${fileContent.length} bytes`);

            console.log('ðŸ”„ Parsing JSON...');
            const data = JSON.parse(fileContent);
            console.log(`âœ… Parsed ${Array.isArray(data) ? 'array with ' + data.length + ' items' : 'object'}`);

            if (!Array.isArray(data) || data.length === 0) {
                console.error('âŒ Expected an array with at least one item');
                process.exit(1);
            }

            console.log('\nðŸ” Analyzing...');
            const result = unifier.analyzeJSON(data);

            console.log(`  Merged ${result.totalItems} items total`);
            console.log(`  â±ï¸ Completed in ${result.elapsed}ms`);

            if (result.frequencies.length > 0) {
                console.log('\nðŸ“Š Values with >= 6 occurrences:');
                for (const item of result.frequencies) {
                    const check = item.isEnum ? 'âœ“' : ' ';
                    console.log(`  ${check} "${item.value}": ${item.count} (${item.pct}%)`);
                }
            }

            const outputFile = 'schema.json';
            fs.writeFileSync(outputFile, JSON.stringify(result.schema, null, 2));
            console.log(`\nâœ… Schema saved to: ${outputFile}`);

            console.log('\nðŸ“Š Schema Preview (first 30 lines):');
            printSchemaPreview(result.schema, 30);
        }

    } catch (error) {
        console.error('\nâŒ Error:', error.message);
        if (error.code === 'ENOENT') {
            console.error(`File "${error.path}" not found.`);
        } else if (error instanceof SyntaxError) {
            console.error('Invalid JSON in input file.');
        }
        console.error(error.stack);
        process.exit(1);
    }
}
