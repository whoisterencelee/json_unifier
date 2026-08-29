const fs = require('fs');

/**
 * Simple JSON structure analyzer - normalize into Maps with counts, then merge
 */

// Track frequency of ALL string values
const frequencyMap = new Map();
let totalItems = 0;

// Minimum occurrences required for a value to be considered an enum
const MIN_ENUM_OCCURRENCES = 5;

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
    
    // Must appear at least MIN_ENUM_OCCURRENCES times
    if (freq < MIN_ENUM_OCCURRENCES) {
        return false;
    }
    
    const isAllCapsWord = isAllCaps(value) && isSingleWord(value);
    const freqPct = getFrequency(value) / totalItems * 100;
    
    // ALL CAPS single words with >= 6 occurrences
    if (isAllCapsWord) {
        return true;
    }
    
    // Other values need >= 10% frequency
    return freqPct >= 10;
}

function normalizeValue(value) {
    if (value === null || value === undefined) return;
    
    const type = typeof value;
    if (type === 'string') {
        // Record frequency for all strings
        recordFrequency(value);
        
        // Check special types first
        if (isISODate(value)) return 'isodate';
        if (isUUID(value)) return 'uuid';
        if (isNumericValue(value)) return 'n';
        
        // Check if it should be an enum
        if (shouldBeEnum(value)) {
            return value;
        }
        
        // Everything else is a string
        return 'string';
    }
    if (type === 'number') return 'number';
    if (type === 'boolean') return 'boolean';
    
    throw new Error(`Unexpected value type in normalizeValue: ${type} (value: ${JSON.stringify(value)})`);
}

function normalizeArray(arr, path = 'array') {
    if (arr.length === 0) return [];
    
    let merged = normalize(arr[0], `${path}[0]`);
    
    for (let i = 1; i < arr.length; i++) {
        const normalized = normalize(arr[i], `${path}[${i}]`);
        merged = mergeObjects(merged, normalized, `${path}[${i}]`);
    }
    
    if (Array.isArray(merged)) return merged;
    return [merged];
}

function normalize(obj, path = 'root') {
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

function mergeObjects(obj1, obj2, path = 'root') {
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
                result.push(mergeObjects(val1, val2, `${path}[${i}]`));
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

function main() {
    try {
        const inputFile = process.argv[2] || 'c.json';
        console.log(`📖 Reading: ${inputFile}`);
        
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

        totalItems = data.length;
        console.log(`\n📊 Total items: ${totalItems}`);

        // First pass: collect frequencies
        console.log('\n📊 Collecting frequencies...');
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
        
        for (const item of data) {
            collectFrequencies(item);
        }
        
        // Show top frequencies with enum status
        console.log('\n📊 Values with >= 6 occurrences (enum candidates):');
        const sorted = Array.from(frequencyMap.entries())
            .filter(([value, count]) => count >= MIN_ENUM_OCCURRENCES)
            .sort((a, b) => b[1] - a[1]);
        for (const [value, count] of sorted) {
            const pct = ((count / totalItems) * 100).toFixed(1);
            const isEnum = shouldBeEnum(value) ? '✓' : ' ';
            console.log(`  ${isEnum} "${value}": ${count} (${pct}%)`);
        }

        console.log('\n🔍 Normalizing and merging...');
        const merged = normalize(data);
        console.log(`  Merged ${data.length} items total`);

        const output = stringifyEnums(merged);

        fs.writeFileSync('schema.json', JSON.stringify(output, null, 2));
        console.log('✅ Schema saved to: schema.json');

        const schemaStr = JSON.stringify(output, null, 2);
        const lines = schemaStr.split('\n');
        console.log('\n📊 Schema Preview (first 50 lines):');
        console.log(lines.slice(0, 50).join('\n'));
        if (lines.length > 50) {
            console.log('... (truncated, see schema.json for full output)');
        }

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
