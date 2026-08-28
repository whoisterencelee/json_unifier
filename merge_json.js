const fs = require('fs');

/**
 * Simple JSON structure analyzer - normalize into Maps with counts, then merge
 */

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

function normalizeValue(value) {
    if (value === null || value === undefined) return;
    
    const type = typeof value;
    if (type === 'string') {
        if (isISODate(value)) return 'isodate';
        if (isUUID(value)) return 'uuid';
        if (isNumericValue(value)) return 'n';
        return value;
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
        
        // If the key already exists in result, merge instead of overwrite
        if (normalizedKey in result) {
            result[normalizedKey] = mergeObjects(result[normalizedKey], normalizedValue, currentPath);
        } else {
            result[normalizedKey] = normalizedValue;
        }
    }
    return result;
}

function mergeObjects(obj1, obj2, path = 'root') {
    // Both are Maps - merge counts
    if (obj1 instanceof Map && obj2 instanceof Map) {
        const merged = new Map(obj1);
        for (const [k, count] of obj2) {
            merged.set(k, (merged.get(k) || 1) + count);
        }
        return merged;
    }
    
    // Both are objects - merge recursively
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
    
    // Both are arrays - merge element by element
    if (Array.isArray(obj1) && Array.isArray(obj2)) {
        // If both arrays contain only Maps, merge them specially
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
        
        // If one array is empty and the other has Maps, return the non-empty one
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
    
    // Different types - create a Map with both
    const map = new Map();
    map.set(obj1, 1);
    map.set(obj2, 1);
    return map;
}

function stringifyEnums(obj) {
    if (obj === null || obj === undefined) return obj;
    if (obj instanceof Map) {
        const entries = Array.from(obj.entries());
        
        let totalCount = 0;
        for (const [, count] of entries) {
            totalCount += count;
        }
        
        const enumValues = [];
        const nonEnumValues = [];
        
        for (const [val, count] of entries) {
            if (typeof val !== 'string') {
                nonEnumValues.push(val);
                continue;
            }
            
            const pct = (count / totalCount) * 100;
            if (pct >= 10) {
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