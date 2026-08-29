/**
 * JSON Unifier - Schema Analyzer
 * Unifies multiple JSON objects into a single schema with enum detection
 * Works in both browser and Node.js
 */

(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        // Node.js
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        // AMD
        define(factory);
    } else {
        // Browser global
        root.JSONUnifier = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {

    // ============================================================
    // Configuration
    // ============================================================
    const MIN_ENUM_OCCURRENCES = 6;

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

    function isSingleWord(value) {
        if (typeof value !== 'string') return false;
        return /^[a-zA-Z0-9_]+$/.test(value);
    }

    function isAllCaps(value) {
        if (typeof value !== 'string') return false;
        return value === value.toUpperCase() && value !== value.toLowerCase();
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
            if (value.length > 30) return false;
            if (value.length < 2) return false;
            
            const freq = getFrequency(value);
            
            if (freq < MIN_ENUM_OCCURRENCES) {
                return false;
            }
            
            const isAllCapsWord = isAllCaps(value) && isSingleWord(value);
            const freqPct = (freq / totalItems) * 100;
            
            if (isAllCapsWord) {
                return true;
            }
            
            return freqPct >= 10;
        }

        function normalizeValue(value) {
            if (value === null || value === undefined) return;
            
            const type = typeof value;
            if (type === 'string') {
                recordFrequency(value);
                
                if (isISODate(value)) return 'isodate';
                if (isUUID(value)) return 'uuid';
                if (isNumericValue(value)) return 'n';
                
                if (shouldBeEnum(value)) {
                    return value;
                }
                
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
                const normalized = normalizeValue(obj);
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
                const normalizedKey = isNumericKey(key) ? 'n' : key;
                const value = obj[key];
                const currentPath = path ? `${path}.${key}` : key;
                
                let normalizedValue;
                if (Array.isArray(value)) {
                    normalizedValue = normalizeArray(value, currentPath);
                } else if (typeof value === 'object' && value !== null) {
                    normalizedValue = normalize(value, currentPath);
                } else {
                    const normalized = normalizeValue(value);
                    const map = new Map();
                    map.set(normalized, 1);
                    normalizedValue = map;
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
                
                if (obj1.length === 0 && obj2.length > 0 && obj2.every(item => item instanceof Map)) {
                    return obj2;
                }
                if (obj2.length === 0 && obj1.length > 0 && obj1.every(item => item instanceof Map)) {
                    return obj1;
                }
                
                const maxLen = Math.max(obj1.length, obj2.length);
                const result = [];
                for (let i = 0; i < maxLen; i++) {
                    const val1 = i < obj1.length ? obj1[i] : undefined;
                    const val2 = i < obj2.length ? obj2[i] : undefined;
                    
                    if (val1 === undefined) {
                        result.push(val2);
                    } else if (val2 === undefined) {
                        result.push(val1);
                    } else {
                        result.push(mergeObjects(val1, val2, path ? `${path}[${i}]` : `[${i}]`));
                    }
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
                const nonEnumValues = [];
                
                for (const [val, count] of entries) {
                    if (typeof val !== 'string') {
                        nonEnumValues.push(val);
                        continue;
                    }
                    
                    if (shouldBeEnum(val)) {
                        enumValues.push(val);
                    } else {
                        nonEnumValues.push(val);
                    }
                }
                
                if (enumValues.length >= 2) {
                    return `{${enumValues.join('|')}}`;
                }
                if (enumValues.length === 1) {
                    if (nonEnumValues.length > 0) {
                        const allValues = [...enumValues, ...nonEnumValues];
                        const uniqueValues = [...new Set(allValues)];
                        return `{${uniqueValues.join('|')}}`;
                    }
                    return enumValues[0];
                }
                
                if (nonEnumValues.length > 0) {
                    const uniqueValues = [...new Set(nonEnumValues)];
                    const filtered = uniqueValues.filter(v => 
                        v !== 'array' && v !== 'null' && v !== 'number' && v !== 'boolean'
                    );
                    if (filtered.length === 0) {
                        return 'string';
                    }
                    if (filtered.length === 1) {
                        return filtered[0];
                    }
                    if (filtered.length > 10) {
                        return 'string';
                    }
                    return `{${filtered.join('|')}}`;
                }
                return 'string';
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
                if (typeof obj === 'string') {
                    recordFrequency(obj);
                }
                return;
            }
            if (Array.isArray(obj)) {
                for (const item of obj) {
                    collectFrequencies(item);
                }
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
                for (const item of data) {
                    collectFrequencies(item);
                }
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
                    "root": {
                        "id": "root",
                        "parent": null,
                        "children": ["1"],
                        "message": null
                    },
                    "1": {
                        "id": "1",
                        "parent": "root",
                        "children": ["2"],
                        "message": {
                            "model": "deepseek-chat",
                            "inserted_at": "2025-02-03T06:00:28.185000+08:00",
                            "fragments": [
                                {
                                    "type": "REQUEST",
                                    "content": "write this in chinese: To: Economic and Technological Development Bureau"
                                }
                            ]
                        }
                    },
                    "2": {
                        "id": "2",
                        "parent": "1",
                        "children": [],
                        "message": {
                            "model": "deepseek-chat",
                            "inserted_at": "2025-02-03T06:00:28.185000+08:00",
                            "fragments": [
                                {
                                    "type": "RESPONSE",
                                    "content": "致：经济及科技发展局"
                                }
                            ]
                        }
                    }
                }
            },
            {
                "id": "e89a8e12-73ee-4601-8f0f-87c271ac5614",
                "title": "JS generate question HTML",
                "inserted_at": "2026-07-30T23:22:38.206000+08:00",
                "updated_at": "2026-07-30T23:23:40.078000+08:00",
                "mapping": {
                    "root": {
                        "id": "root",
                        "parent": null,
                        "children": ["1", "3"],
                        "message": null
                    },
                    "1": {
                        "id": "1",
                        "parent": "root",
                        "children": ["2"],
                        "message": {
                            "model": "deepseek-chat",
                            "inserted_at": "2026-07-30T23:23:02.830000+08:00",
                            "fragments": [
                                {
                                    "type": "REQUEST",
                                    "content": "give me the javascript that can generate this HTML question"
                                }
                            ]
                        }
                    },
                    "2": {
                        "id": "2",
                        "parent": "1",
                        "children": [],
                        "message": {
                            "model": "deepseek-chat",
                            "inserted_at": "2026-07-30T23:23:02.823000+08:00",
                            "fragments": [
                                {
                                    "type": "RESPONSE",
                                    "content": "Here's the JavaScript code that generates the HTML..."
                                }
                            ]
                        }
                    },
                    "3": {
                        "id": "3",
                        "parent": "root",
                        "children": ["4"],
                        "message": {
                            "model": "deepseek-chat",
                            "inserted_at": "2026-07-30T23:23:34.757000+08:00",
                            "fragments": [
                                {
                                    "type": "REQUEST",
                                    "content": "I just need to append the readonly input generated from the legend"
                                }
                            ]
                        }
                    },
                    "4": {
                        "id": "4",
                        "parent": "3",
                        "children": [],
                        "message": {
                            "model": "deepseek-chat",
                            "inserted_at": "2026-07-30T23:23:34.754000+08:00",
                            "fragments": [
                                {
                                    "type": "RESPONSE",
                                    "content": "Here's the JavaScript code that generates the readonly input..."
                                }
                            ]
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
        getSampleData: getSampleData,
        createUnifier: createUnifier
    };

    // Node.js specific: add fs support
    if (typeof require === 'function') {
        try {
            const fs = require('fs');
            exports.analyzeFile = function(filePath) {
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                return analyzeJSON(data);
            };
        } catch (e) {
            // fs not available
        }
    }

    return exports;
}));

// ============================================================
// Node.js CLI - Run directly with: node json_unifier.js [file]
// ============================================================
if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
    const fs = require('fs');
    const path = require('path');
    
    // Get the exported analyzeJSON function
    const unifier = require('./json_unifier.js');
    const analyzeJSON = unifier.analyzeJSON;
    
    const args = process.argv.slice(2);
    const inputFile = args[0] || 'c.json';
    
    console.log(`📖 Reading: ${inputFile}`);
    
    try {
        if (!fs.existsSync(inputFile)) {
            console.error(`❌ File not found: ${inputFile}`);
            process.exit(1);
        }
        
        const fileContent = fs.readFileSync(inputFile, 'utf8');
        console.log(`📄 File size: ${fileContent.length} bytes`);
        
        console.log('🔄 Parsing JSON...');
        const data = JSON.parse(fileContent);
        console.log(`✅ Parsed ${Array.isArray(data) ? 'array with ' + data.length + ' items' : 'object'}`);
        
        if (!Array.isArray(data) || data.length === 0) {
            console.error('❌ Expected an array with at least one item');
            process.exit(1);
        }
        
        console.log('\n🔍 Analyzing...');
        const result = analyzeJSON(data);
        
        console.log(`  Merged ${result.totalItems} items total`);
        console.log(`  ⏱️ Completed in ${result.elapsed}ms`);
        
        // Show frequencies
        if (result.frequencies.length > 0) {
            console.log('\n📊 Values with >= 6 occurrences:');
            for (const item of result.frequencies) {
                const check = item.isEnum ? '✓' : ' ';
                console.log(`  ${check} "${item.value}": ${item.count} (${item.pct}%)`);
            }
        }
        
        // Write schema to file
        const outputFile = 'schema.json';
        fs.writeFileSync(outputFile, JSON.stringify(result.schema, null, 2));
        console.log(`\n✅ Schema saved to: ${outputFile}`);
        
        // Preview
        const schemaStr = JSON.stringify(result.schema, null, 2);
        const lines = schemaStr.split('\n');
        console.log('\n📊 Schema Preview (first 30 lines):');
        console.log(lines.slice(0, 30).join('\n'));
        if (lines.length > 30) {
            console.log('... (truncated, see schema.json for full output)');
        }
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        if (error.code === 'ENOENT') {
            console.error(`File "${error.path}" not found.`);
        } else if (error instanceof SyntaxError) {
            console.error('Invalid JSON in input file.');
        }
        console.error(error.stack);
        process.exit(1);
    }
}