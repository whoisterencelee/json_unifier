const fs = require('fs');

/**
 * Simple JSON structure analyzer - normalize and merge incrementally
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

function isShortString(value) {
    return typeof value === 'string' && value.length <= 50 && value.length > 0;
}

function isEnglishLetter(char) {
    return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z');
}

function isAllEnglishLetters(value) {
    for (const char of value) {
        if (!isEnglishLetter(char)) {
            return false;
        }
    }
    return true;
}

function calculateEnumScore(value) {
    if (typeof value !== 'string') return 0;
    if (isISODate(value)) return 0;
    if (isUUID(value)) return 0;
    if (isNumericValue(value)) return 0;
    if (value.length > 50) return 0;
    if (value.length < 2) return 0;
    
    if (!isAllEnglishLetters(value)) {
        return 0.2;
    }
    
    let score = 0;
    const isAllCaps = value === value.toUpperCase() && value !== value.toLowerCase();
    const isCapitalized = value[0] === value[0].toUpperCase() && value.slice(1) === value.slice(1).toLowerCase();
    const isSingleWord = !value.includes(' ');
    
    if (isAllCaps && isSingleWord) score = 1.0;
    else if (isCapitalized && isSingleWord) score = 0.8;
    else if (isAllCaps) score = 0.6;
    else if (isCapitalized) score = 0.4;
    else score = 0.2;
    
    return score;
}

function normalizeValue(value) {
    if (value === null || value === undefined) return 'null';
    
    const type = typeof value;
    if (type === 'string') {
        if (isISODate(value)) return 'isodate';
        if (isUUID(value)) return 'uuid';
        if (isNumericValue(value)) return 'n';
        if (isShortString(value)) {
            const score = calculateEnumScore(value);
            if (score >= 0.8) {
                return value;
            }
            return 'string';
        }
        return 'string';
    }
    if (type === 'number') return 'number';
    if (type === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (type === 'object') return 'object';
    return type;
}

// Normalize an object - arrays become 'array'
function normalizeObject(obj) {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj !== 'object') return normalizeValue(obj);
    if (Array.isArray(obj)) return 'array';
    
    const result = {};
    const keys = Object.keys(obj);
    for (const key of keys) {
        const normalizedKey = isNumericKey(key) ? 'n' : key;
        const value = obj[key];
        
        if (Array.isArray(value)) {
            result[normalizedKey] = 'array';
        } else if (typeof value === 'object' && value !== null) {
            result[normalizedKey] = normalizeObject(value);
        } else {
            result[normalizedKey] = normalizeValue(value);
        }
    }
    return result;
}

// Merge two objects - simple key by key merge
function mergeObjects(obj1, obj2) {
    const result = {};
    const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);
    
    for (const key of allKeys) {
        const val1 = obj1[key];
        const val2 = obj2[key];
        
        if (val1 === undefined) {
            result[key] = val2;
        } else if (val2 === undefined) {
            result[key] = val1;
        } else if (val1 === val2) {
            result[key] = val1;
        } else {
            // Both exist and are different
            if (typeof val1 === 'object' && val1 !== null &&
                typeof val2 === 'object' && val2 !== null) {
                // Both are objects - merge them
                result[key] = mergeObjects(val1, val2);
            } else if (typeof val1 === 'string' && typeof val2 === 'string') {
                // Both strings - create a Set (for enum detection)
                const set = new Set();
                set.add(val1);
                set.add(val2);
                result[key] = set;
            } else {
                // Different types - create a Set
                const set = new Set();
                set.add(val1);
                set.add(val2);
                result[key] = set;
            }
        }
    }
    return result;
}

function simplifySchema(schema) {
    if (schema === null || schema === undefined) return null;
    if (typeof schema === 'string') return schema;
    if (typeof schema === 'number') return 'number';
    if (typeof schema === 'boolean') return 'boolean';
    if (schema === '...') return '...';
    if (schema === 'n') return 'n';
    
    if (schema instanceof Set) {
        const values = Array.from(schema);
        const setSize = values.length;
        
        if (setSize > 10) {
            return 'string';
        }
        
        const enumValues = [];
        const regularValues = [];
        
        for (const val of values) {
            if (typeof val === 'string') {
                if (isISODate(val)) {
                    regularValues.push('isodate');
                } else if (isUUID(val)) {
                    regularValues.push('uuid');
                } else if (isNumericValue(val)) {
                    regularValues.push('n');
                } else {
                    const score = calculateEnumScore(val);
                    if (score >= 0.8) {
                        enumValues.push(val);
                    } else {
                        regularValues.push('string');
                    }
                }
            } else {
                regularValues.push(val);
            }
        }
        
        if (enumValues.length >= 2) {
            return `{${enumValues.join('|')}}`;
        }
        
        if (enumValues.length === 1) {
            const uniqueRegular = [];
            for (const val of regularValues) {
                if (!uniqueRegular.includes(val)) {
                    uniqueRegular.push(val);
                }
            }
            if (uniqueRegular.length === 0 || (uniqueRegular.length === 1 && uniqueRegular[0] === 'string')) {
                return enumValues[0];
            }
            return `{${enumValues[0]}|${uniqueRegular.join('|')}}`;
        }
        
        const uniqueValues = [];
        for (const val of regularValues) {
            if (!uniqueValues.includes(val)) {
                uniqueValues.push(val);
            }
        }
        
        if (uniqueValues.length === 0) {
            return 'string';
        }
        
        if (uniqueValues.length === 1) {
            return uniqueValues[0];
        }
        
        const allStrings = uniqueValues.every(v => v === 'string');
        if (allStrings) {
            return 'string';
        }
        
        return `{${uniqueValues.join('|')}}`;
    }
    
    if (typeof schema === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(schema)) {
            result[key] = simplifySchema(value);
        }
        return result;
    }
    
    return schema;
}

// Main execution
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

        console.log('\n🔍 Analyzing structure...');
        const startTime = Date.now();

        // Start with first object - normalize it
        let merged = normalizeObject(data[0]);
        console.log(`  Started with object 1`);

        // Merge with each subsequent object
        for (let i = 1; i < data.length; i++) {
            const normalized = normalizeObject(data[i]);
            merged = mergeObjects(merged, normalized);
            if (i % 50 === 0) {
                console.log(`  Merged ${i + 1} objects...`);
            }
        }
        console.log(`  Merged ${data.length} objects total`);

        const simplified = simplifySchema(merged);
        const elapsed = Date.now() - startTime;

        fs.writeFileSync('schema.json', JSON.stringify(simplified, null, 2));
        console.log('✅ Schema saved to: schema.json');

        console.log(`\n⏱️  Completed in ${elapsed}ms`);

        const schemaStr = JSON.stringify(simplified, null, 2);
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

// Run
main();