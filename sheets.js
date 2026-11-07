const ITEM_HEADERS = ['id', 'name', 'set', 'kind', 'slot', 'style', 'weapon', 'armor', 'amount', 'magic', 'loot', 'cost', 'strength', 'stamina', 'intellect', 'reqLevel', 'icon'];
const QUEST_HEADERS = ['id', 'name', 'zoneId', 'minLevel', 'giver', 'giverRole', 'giverCamp', 'requires', 'type', 'mob', 'count', 'item', 'named', 'elite', 'dungeonId', 'protectRole', 'protectCamp', 'custom', 'text', 'coins', 'xp', 'rewardKind', 'rewardName', 'rewardQty'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function xml(value) {
    return String(value ?? '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
}

function colLetter(index) {
    let n = index + 1;
    let out = '';
    while (n > 0) {
        const m = (n - 1) % 26;
        out = String.fromCharCode(65 + m) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

function cellXml(ref, value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) return '<c r="' + ref + '"><v>' + value + '</v></c>';
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
}

function sheetXml(headers, rows, validations) {
    const all = [headers, ...rows];
    const body = all.map((row, r) => {
        const cells = row.map((value, c) => cellXml(colLetter(c) + (r + 1), value)).filter(Boolean).join('');
        return '<row r="' + (r + 1) + '">' + cells + '</row>';
    }).join('');
    const rules = (validations || []).map(rule => {
        return '<dataValidation type="list" allowBlank="1" sqref="' + rule.sqref + '"><formula1>' + xml(rule.formula) + '</formula1></dataValidation>';
    }).join('');
    const block = rules ? '<dataValidations count="' + validations.length + '">' + rules + '</dataValidations>' : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData>' + body + '</sheetData>' + block + '</worksheet>';
}

function yesNo(value) {
    return value ? 'yes' : 'no';
}

function itemRow(item) {
    return [
        item.id || '',
        item.name || '',
        item.set || '',
        item.kind || '',
        item.slot || '',
        item.style || '',
        item.weapon || '',
        item.armor || 0,
        item.amount || 0,
        yesNo(item.magic),
        yesNo(item.loot),
        item.cost || '',
        item.strength || 0,
        item.stamina || 0,
        item.intellect || 0,
        item.reqLevel || 1,
        item.icon || ''
    ];
}

function questRow(quest) {
    return [
        quest.id || '',
        quest.name || '',
        quest.zoneId || '',
        quest.minLevel || 1,
        quest.giver || '',
        quest.giverRole || '',
        quest.giverCamp || 0,
        quest.requires || '',
        quest.type || 'kill',
        quest.mob || '',
        quest.count || 1,
        quest.item || '',
        quest.named || '',
        yesNo(quest.elite),
        quest.dungeonId || '',
        quest.protectRole || '',
        quest.protectCamp || 0,
        yesNo(quest.custom),
        quest.text || '',
        quest.coins || 0,
        quest.xp || 0,
        quest.rewardKind || '',
        quest.rewardName || '',
        quest.rewardQty || 1
    ];
}

function listColumn(rows, index) {
    const values = [''];
    for (const row of rows) values.push(row[index] || '');
    return values;
}

function validation(column, formula) {
    return { sqref: column + '2:' + column + '300', formula };
}

export function buildWorkbook({ items, quests, icons, lists }) {
    const itemRows = (items || []).map(itemRow);
    const questRows = (quests || []).map(questRow);
    const iconRows = (icons || []).map(entry => [entry.name, entry.index]);
    const listRows = [];
    const width = Math.max(...Object.values(lists || { kind: [] }).map(column => column.length), 1);
    for (let i = 0; i < width; i++) {
        listRows.push([
            (lists.kind || [])[i] || '',
            (lists.slot || [])[i] || '',
            (lists.style || [])[i] || '',
            (lists.weapon || [])[i] || '',
            (lists.set || [])[i] || '',
            (lists.yes || [])[i] || '',
            (lists.type || [])[i] || '',
            (lists.mob || [])[i] || '',
            (lists.reward || [])[i] || '',
            (lists.role || [])[i] || ''
        ]);
    }
    const iconEnd = iconRows.length + 1;
    const sheets = [
        {
            name: 'Items',
            xml: sheetXml(ITEM_HEADERS, itemRows, [
                validation('C', 'Lists!$E$2:$E$' + ((lists.set || []).length + 1)),
                validation('D', 'Lists!$A$2:$A$' + ((lists.kind || []).length + 1)),
                validation('E', 'Lists!$B$2:$B$' + ((lists.slot || []).length + 1)),
                validation('F', 'Lists!$C$2:$C$' + ((lists.style || []).length + 1)),
                validation('G', 'Lists!$D$2:$D$' + ((lists.weapon || []).length + 1)),
                validation('J', 'Lists!$F$2:$F$3'),
                validation('K', 'Lists!$F$2:$F$3'),
                validation('Q', 'Icons!$A$2:$A$' + iconEnd)
            ])
        },
        {
            name: 'Quests',
            xml: sheetXml(QUEST_HEADERS, questRows, [
                validation('F', 'Lists!$J$2:$J$' + ((lists.role || []).length + 1)),
                validation('I', 'Lists!$G$2:$G$' + ((lists.type || []).length + 1)),
                validation('J', 'Lists!$H$2:$H$' + ((lists.mob || []).length + 1)),
                validation('N', 'Lists!$F$2:$F$3'),
                validation('P', 'Lists!$J$2:$J$' + ((lists.role || []).length + 1)),
                validation('R', 'Lists!$F$2:$F$3'),
                validation('V', 'Lists!$I$2:$I$' + ((lists.reward || []).length + 1))
            ])
        },
        { name: 'Icons', xml: sheetXml(['icon', 'index'], iconRows) },
        { name: 'Lists', xml: sheetXml(['kind', 'slot', 'style', 'weapon', 'set', 'yes', 'type', 'mob', 'reward', 'role'], listRows) },
        {
            name: 'How',
            xml: sheetXml(['note'], [[
                'Edit Items and Quests, then import this file on the setup page. The Icon column is a dropdown: pick a name, or a number. Numbers are cells on the icon image, 16 across. Cost is written as cloth:2, ore:1. Leave a sheet unchanged if you only mean to edit the other one. Do not rename the header row.'
            ]])
        }
    ];
    return zipSheets(sheets);
}

function zipSheets(sheets) {
    const files = [];
    const overrides = sheets.map((_, index) => '<Override PartName="/xl/worksheets/sheet' + (index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('');
    files.push({
        name: '[Content_Types].xml',
        data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            overrides + '</Types>')
    });
    files.push({
        name: '_rels/.rels',
        data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            '</Relationships>')
    });
    const sheetTags = sheets.map((sheet, index) => '<sheet name="' + xml(sheet.name) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>').join('');
    files.push({
        name: 'xl/workbook.xml',
        data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            '<sheets>' + sheetTags + '</sheets></workbook>')
    });
    const rels = sheets.map((_, index) => '<Relationship Id="rId' + (index + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>').join('');
    files.push({
        name: 'xl/_rels/workbook.xml.rels',
        data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            rels +
            '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
            '</Relationships>')
    });
    files.push({
        name: 'xl/styles.xml',
        data: encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
            '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
            '<borders count="1"><border/></borders>' +
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
            '</styleSheet>')
    });
    sheets.forEach((sheet, index) => {
        files.push({ name: 'xl/worksheets/sheet' + (index + 1) + '.xml', data: encoder.encode(sheet.xml) });
    });
    return zipStore(files);
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts) {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function zipStore(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
        const name = encoder.encode(file.name);
        const crc = crc32(file.data);
        const local = new Uint8Array(30 + name.length);
        const view = new DataView(local.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(8, 0, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, file.data.length, true);
        view.setUint32(22, file.data.length, true);
        view.setUint16(26, name.length, true);
        local.set(name, 30);
        locals.push(local, file.data);
        const central = new Uint8Array(46 + name.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, file.data.length, true);
        cv.setUint32(24, file.data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        central.set(name, 46);
        centrals.push(central);
        offset += local.length + file.data.length;
    }
    const central = concat(centrals);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, offset, true);
    return concat([...locals, central, end]);
}

function u16(view, offset) {
    return view.getUint16(offset, true);
}

function u32(view, offset) {
    return view.getUint32(offset, true);
}

async function inflateRaw(data) {
    if (typeof DecompressionStream === 'function') {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const zlib = await import('node:zlib');
    return new Uint8Array(zlib.inflateRawSync(data));
}

export async function unzip(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const start = Math.max(0, bytes.length - 22 - 65536);
    for (let i = bytes.length - 22; i >= start; i--) {
        if (u32(view, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a spreadsheet');
    const count = u16(view, eocd + 10);
    let cursor = u32(view, eocd + 16);
    const files = {};
    for (let n = 0; n < count; n++) {
        if (u32(view, cursor) !== 0x02014b50) throw new Error('Bad spreadsheet');
        const method = u16(view, cursor + 10);
        const compressed = u32(view, cursor + 20);
        const nameLength = u16(view, cursor + 28);
        const extra = u16(view, cursor + 30);
        const comment = u16(view, cursor + 32);
        const localAt = u32(view, cursor + 42);
        const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
        const nameAtLocal = u16(view, localAt + 26);
        const extraAtLocal = u16(view, localAt + 28);
        const dataAt = localAt + 30 + nameAtLocal + extraAtLocal;
        const raw = bytes.subarray(dataAt, dataAt + compressed);
        files[name] = method === 8 ? await inflateRaw(raw) : raw;
        cursor += 46 + nameLength + extra + comment;
    }
    return files;
}

function decodeXml(text) {
    return text.replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, "'").replace(/&/g, '&');
}

function sharedStrings(xmlText) {
    if (!xmlText) return [];
    const out = [];
    const blocks = xmlText.match(/<si[\s\S]*?<\/si>/g) || [];
    for (const block of blocks) {
        const parts = [...block.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1]));
        out.push(parts.join(''));
    }
    return out;
}

function columnIndex(ref) {
    const letters = String(ref || '').replace(/[^A-Z]/gi, '').toUpperCase();
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

function sheetTable(xmlText, strings) {
    const rows = [];
    const rowMatches = xmlText.match(/<row\b[\s\S]*?<\/row>/g) || [];
    for (const rowXml of rowMatches) {
        const cells = [];
        const cellMatches = rowXml.match(/<c\b[\s\S]*?(?:\/>|<\/c>)/g) || [];
        for (const cell of cellMatches) {
            const ref = (cell.match(/\br="([^"]+)"/) || [])[1] || '';
            const type = (cell.match(/\bt="([^"]+)"/) || [])[1] || '';
            const index = columnIndex(ref);
            let value = '';
            if (type === 'inlineStr') {
                value = decodeXml(((cell.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]) || '');
            } else if (type === 's') {
                const at = Number((cell.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || 0);
                value = strings[at] || '';
            } else if (type === 'b') {
                value = ((cell.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '') === '1' ? 'yes' : 'no';
            } else {
                value = decodeXml(((cell.match(/<v>([\s\S]*?)<\/v>/) || [])[1]) || '');
            }
            if (index >= 0) cells[index] = value;
        }
        rows.push(cells);
    }
    if (!rows.length) return [];
    const headers = (rows[0] || []).map(value => String(value || '').trim());
    const out = [];
    for (const row of rows.slice(1)) {
        if (!row || !row.some(value => String(value || '').trim())) continue;
        const entry = {};
        headers.forEach((header, index) => {
            if (header) entry[header] = row[index] == null ? '' : String(row[index]);
        });
        out.push(entry);
    }
    return out;
}

function findSheet(files, name) {
    const workbook = decoder.decode(files['xl/workbook.xml'] || new Uint8Array());
    const rels = decoder.decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
    const sheets = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"|<sheet\b[^>]*r:id="([^"]+)"[^>]*name="([^"]+)"/g)];
    let id = '';
    for (const match of sheets) {
        const sheetName = match[1] || match[4];
        const rel = match[2] || match[3];
        if (sheetName === name) { id = rel; break; }
    }
    if (!id) return '';
    const rel = (rels.match(new RegExp('<Relationship[^>]*Id="' + id + '"[^>]*>')) || [])[0] || '';
    const target = (rel.match(/Target="([^"]+)"/) || [])[1] || '';
    if (!target) return '';
    const path = target.replace(/^\//, '').replace(/^xl\//, 'xl/');
    const key = files[path] ? path : (target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    return files[key] ? decoder.decode(files[key]) : '';
}

export async function readWorkbook(buffer) {
    const files = await unzip(buffer);
    const strings = sharedStrings(decoder.decode(files['xl/sharedStrings.xml'] || new Uint8Array()));
    const itemsXml = findSheet(files, 'Items');
    const questsXml = findSheet(files, 'Quests');
    if (!itemsXml && !questsXml) throw new Error('The spreadsheet needs an Items or Quests sheet');
    return {
        items: itemsXml ? sheetTable(itemsXml, strings) : null,
        quests: questsXml ? sheetTable(questsXml, strings) : null
    };
}

export { listColumn };
