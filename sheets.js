import { iconCatalog, iconChoice, iconKeyFromChoice } from './icons.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ITEM_HEADERS = ['Name', 'What it is', 'Crafting set', 'Kind', 'Worn on', 'Armor type', 'Weapon', 'Armor', 'Potion or bomb amount', 'Magic', 'Found in chests', 'Materials', 'Strength', 'Stamina', 'Intellect', 'Required level', 'Icon', 'Game id'];
const QUEST_HEADERS = ['Name', 'What it is', 'Zone', 'Zone id', 'Minimum level', 'Giver', 'Giver role', 'Camp number', 'After quest', 'Type', 'Creature', 'How many', 'Item', 'Named target', 'Elite', 'Dungeon', 'Dungeon id', 'Protect role', 'Protect camp', 'Custom text', 'Quest text', 'Coin reward', 'XP reward', 'Reward kind', 'Reward item', 'Reward amount', 'Game id'];
const ITEM_WIDTHS = [24, 56, 16, 12, 16, 14, 12, 10, 22, 12, 16, 24, 12, 12, 12, 16, 20, 22];
const QUEST_WIDTHS = [24, 56, 22, 18, 16, 16, 14, 14, 18, 12, 14, 12, 16, 18, 10, 22, 18, 14, 14, 14, 42, 14, 12, 14, 20, 16, 22];

const HEADER_ALIAS = new Map([
    ['id', 'id'],
    ['game id', 'id'],
    ['name', 'name'],
    ['what it is', 'about'],
    ['about', 'about'],
    ['set', 'set'],
    ['crafting set', 'set'],
    ['kind', 'kind'],
    ['slot', 'slot'],
    ['worn on', 'slot'],
    ['style', 'style'],
    ['armor type', 'style'],
    ['weapon', 'weapon'],
    ['armor', 'armor'],
    ['amount', 'amount'],
    ['potion or bomb amount', 'amount'],
    ['magic', 'magic'],
    ['loot', 'loot'],
    ['found in chests', 'loot'],
    ['cost', 'cost'],
    ['materials', 'cost'],
    ['strength', 'strength'],
    ['stamina', 'stamina'],
    ['intellect', 'intellect'],
    ['reqlevel', 'reqLevel'],
    ['req level', 'reqLevel'],
    ['required level', 'reqLevel'],
    ['icon', 'icon'],
    ['zoneid', 'zoneId'],
    ['zone id', 'zoneId'],
    ['zone', 'zoneName'],
    ['zonename', 'zoneName'],
    ['minlevel', 'minLevel'],
    ['min level', 'minLevel'],
    ['minimum level', 'minLevel'],
    ['giver', 'giver'],
    ['giverrole', 'giverRole'],
    ['giver role', 'giverRole'],
    ['givercamp', 'giverCamp'],
    ['camp number', 'giverCamp'],
    ['requires', 'requires'],
    ['after quest', 'requires'],
    ['type', 'type'],
    ['mob', 'mob'],
    ['creature', 'mob'],
    ['count', 'count'],
    ['how many', 'count'],
    ['item', 'item'],
    ['named', 'named'],
    ['named target', 'named'],
    ['elite', 'elite'],
    ['dungeonid', 'dungeonId'],
    ['dungeon id', 'dungeonId'],
    ['dungeon', 'dungeonName'],
    ['dungeonname', 'dungeonName'],
    ['protectrole', 'protectRole'],
    ['protect role', 'protectRole'],
    ['protectcamp', 'protectCamp'],
    ['protect camp', 'protectCamp'],
    ['custom', 'custom'],
    ['custom text', 'custom'],
    ['text', 'text'],
    ['quest text', 'text'],
    ['coins', 'coins'],
    ['coin reward', 'coins'],
    ['xp', 'xp'],
    ['xp reward', 'xp'],
    ['rewardkind', 'rewardKind'],
    ['reward kind', 'rewardKind'],
    ['rewardname', 'rewardName'],
    ['reward name', 'rewardName'],
    ['reward item', 'rewardName'],
    ['rewardqty', 'rewardQty'],
    ['reward qty', 'rewardQty'],
    ['reward amount', 'rewardQty']
]);

function xml(value) {
    return String(value ?? '').replace(/&/g, '\u0026amp;').replace(/</g, '\u0026lt;').replace(/>/g, '\u0026gt;').replace(/"/g, '\u0026quot;');
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

function cellXml(ref, value, style) {
    if (value == null || value === '') return '';
    const styled = style ? ' s="' + style + '"' : '';
    if (typeof value === 'number' && Number.isFinite(value)) return '<c r="' + ref + '"' + styled + '><v>' + value + '</v></c>';
    return '<c r="' + ref + '" t="inlineStr"' + styled + '><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
}

function sheetXml(headers, rows, options = {}) {
    const validations = (options.validations || []).filter(Boolean);
    const widths = options.widths || [];
    const wrapCol = options.wrapCol;
    const freeze = options.freeze !== false;
    const filter = options.filter === true;
    const tall = options.rowHeight || 0;
    const all = [headers, ...rows];
    const body = all.map((row, r) => {
        const rowNumber = r + 1;
        const cells = row.map((value, c) => {
            const style = rowNumber === 1 ? 1 : (wrapCol === c ? 2 : 0);
            return cellXml(colLetter(c) + rowNumber, value, style);
        }).filter(Boolean).join('');
        const height = rowNumber === 1 ? 22 : tall;
        const sized = height ? ' ht="' + height + '" customHeight="1"' : '';
        return '<row r="' + rowNumber + '"' + sized + '>' + cells + '</row>';
    }).join('');
    const lastCol = colLetter(Math.max(headers.length - 1, 0));
    const lastRow = Math.max(all.length, 1);
    const cols = widths.some(Boolean)
        ? '<cols>' + widths.map((width, index) => width ? '<col min="' + (index + 1) + '" max="' + (index + 1) + '" width="' + width + '" customWidth="1"/>' : '').join('') + '</cols>'
        : '';
    const views = freeze
        ? '<sheetViews><sheetView workbookViewId="0"' + (options.selected ? ' tabSelected="1"' : '') + '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
        : '';
    const filterXml = filter ? '<autoFilter ref="A1:' + lastCol + lastRow + '"/>' : '';
    const rules = validations.map(rule => '<dataValidation type="list" allowBlank="1" showInputMessage="0" showErrorMessage="0" sqref="' + xml(rule.sqref) + '"><formula1>' + xml(rule.formula) + '</formula1></dataValidation>').join('');
    const block = rules ? '<dataValidations count="' + validations.length + '">' + rules + '</dataValidations>' : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="A1:' + lastCol + lastRow + '"/>' +
        views +
        '<sheetFormatPr defaultRowHeight="18"/>' +
        cols +
        '<sheetData>' + body + '</sheetData>' +
        filterXml +
        block +
        '</worksheet>';
}

function yesNo(value) {
    return value === true || value === 'yes' || value === 'true' || value === 1 ? 'yes' : 'no';
}

function numberOrBlank(value, fallback) {
    if (value == null || value === '') value = fallback;
    if (value == null || value === '') return '';
    const n = Number(value);
    return Number.isFinite(n) ? n : String(value);
}

function cap(word) {
    const text = String(word || '');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function materialsPhrase(cost) {
    const bits = [];
    for (const part of String(cost || '').split(',')) {
        const bit = part.trim();
        if (!bit) continue;
        const colon = bit.match(/^([a-z]+)\s*:\s*(\d+)$/i);
        if (colon) bits.push(colon[2] + ' ' + colon[1]);
        else bits.push(bit);
    }
    return bits.join(', ');
}

function itemAbout(item) {
    const kind = item.kind || '';
    const sentences = [];
    if (kind === 'armor') {
        const where = {
            head: 'worn on the head',
            neck: 'worn at the neck',
            shoulders: 'worn on the shoulders',
            cloak: 'worn as a cloak',
            chest: 'worn on the chest',
            hands: 'worn on the hands',
            waist: 'worn at the waist',
            legs: 'worn on the legs',
            feet: 'worn on the feet',
            weapon: 'wielded',
            offhand: 'held in the off hand'
        }[item.slot] || 'armor';
        sentences.push((item.style ? cap(item.style) : 'Armor') + ' ' + where + (Number(item.armor) ? ', armor ' + item.armor : ''));
    } else if (kind === 'weapon') {
        sentences.push((yesNo(item.magic) === 'yes' ? 'Magic ' : '') + (item.weapon === 'staff' ? 'Staff' : 'Sword'));
    } else if (kind === 'health') {
        sentences.push('Health potion' + (Number(item.amount) ? ' that restores ' + item.amount + ' health' : ''));
    } else if (kind === 'mana') {
        sentences.push('Mana potion' + (Number(item.amount) ? ' that restores ' + item.amount + ' mana' : ''));
    } else if (kind === 'bomb') {
        sentences.push('Bomb' + (Number(item.amount) ? ' that hits for ' + item.amount : ''));
    } else if (kind === 'junk') {
        sentences.push('Junk');
    } else {
        sentences.push(item.name || cap(kind) || 'Item');
    }
    const stats = [];
    if (Number(item.strength)) stats.push('+' + item.strength + ' Strength');
    if (Number(item.stamina)) stats.push('+' + item.stamina + ' Stamina');
    if (Number(item.intellect)) stats.push('+' + item.intellect + ' Intellect');
    if (stats.length) sentences.push(stats.join(', '));
    const req = Number(item.reqLevel) || 1;
    if (kind === 'armor' || kind === 'weapon') sentences.push(req > 1 ? 'Requires level ' + req : 'Anyone can equip it');
    const made = materialsPhrase(item.cost);
    if (made) sentences.push('Made from ' + made);
    if (yesNo(item.loot) === 'yes') sentences.push('Also found in chests');
    if (yesNo(item.magic) === 'yes' && kind !== 'weapon') sentences.push('Magical');
    return sentences.join('. ') + '.';
}

function pluralMob(mob, count) {
    const word = mob || 'creature';
    if (Number(count) === 1) return word;
    if (word === 'wolf') return 'wolves';
    if (word.endsWith('s')) return word;
    return word + 's';
}

function questAbout(quest, zoneLabel, dungeonLabel) {
    const place = dungeonLabel || zoneLabel || (quest.dungeonId ? 'dungeon ' + quest.dungeonId : (quest.zoneId ? 'zone ' + quest.zoneId : 'any zone'));
    let job;
    if (quest.type === 'gather') job = 'Collect ' + (quest.count || 1) + ' ' + (quest.item || 'items') + ' from ' + pluralMob(quest.mob, quest.count) + ' in ' + place;
    else if (quest.type === 'named') job = 'Defeat ' + (quest.named || quest.mob || 'a named foe') + (yesNo(quest.elite) === 'yes' ? ', an elite,' : '') + ' in ' + place;
    else if (quest.type === 'protect') job = 'Protect the ' + (quest.protectRole || 'camp') + ' in ' + place + ' from ' + (quest.count || 1) + ' ' + pluralMob(quest.mob, quest.count);
    else job = 'Kill ' + (quest.count || 1) + ' ' + pluralMob(quest.mob, quest.count) + ' in ' + place;
    const sentences = [job];
    if (Number(quest.minLevel) > 1) sentences.push('From level ' + quest.minLevel);
    if (quest.giver) sentences.push('Offered by ' + quest.giver + (quest.giverRole ? ' (' + quest.giverRole + ')' : ''));
    if (quest.requires) sentences.push('After ' + quest.requires);
    const rewards = [];
    if (Number(quest.coins)) rewards.push(quest.coins + ' coins');
    if (Number(quest.xp)) rewards.push(quest.xp + ' xp');
    if (quest.rewardName) rewards.push((Number(quest.rewardQty) > 1 ? quest.rewardQty + ' ' : '') + quest.rewardName);
    else if (quest.rewardKind) rewards.push(quest.rewardKind);
    if (rewards.length) sentences.push('Reward: ' + rewards.join(', '));
    if (quest.text) sentences.push(String(quest.text).trim().replace(/[. ]+$/, '').slice(0, 140));
    return sentences.join('. ') + '.';
}

function itemRow(item) {
    return [
        item.name || '',
        itemAbout(item),
        item.set || '',
        item.kind || '',
        item.slot || '',
        item.style || '',
        item.weapon || '',
        numberOrBlank(item.armor, 0),
        numberOrBlank(item.amount, 0),
        yesNo(item.magic),
        yesNo(item.loot),
        item.cost || '',
        numberOrBlank(item.strength, 0),
        numberOrBlank(item.stamina, 0),
        numberOrBlank(item.intellect, 0),
        numberOrBlank(item.reqLevel, 1),
        iconChoice(item.icon || ''),
        item.id || ''
    ];
}

function placeChoices(list) {
    const rows = (list || []).filter(entry => entry && (entry.id || entry.name));
    const counts = new Map();
    for (const entry of rows) {
        const name = String(entry.name || entry.id || 'Unnamed').trim() || 'Unnamed';
        counts.set(name, (counts.get(name) || 0) + 1);
    }
    return rows.map(entry => {
        const name = String(entry.name || entry.id || 'Unnamed').trim() || 'Unnamed';
        const id = String(entry.id || '');
        const label = counts.get(name) > 1 && id ? name + ' (' + id + ')' : name;
        return { label, id, name };
    }).sort((a, b) => a.label.localeCompare(b.label));
}

function labelFor(choices, id) {
    if (!id) return '';
    const found = choices.find(entry => entry.id === id);
    return found ? found.label : '';
}

function questRow(quest, zoneChoices, dungeonChoices) {
    const zoneLabel = labelFor(zoneChoices, quest.zoneId);
    const dungeonLabel = labelFor(dungeonChoices, quest.dungeonId);
    return [
        quest.name || '',
        questAbout(quest, zoneLabel, dungeonLabel),
        zoneLabel,
        quest.zoneId || '',
        numberOrBlank(quest.minLevel, 1),
        quest.giver || '',
        quest.giverRole || '',
        numberOrBlank(quest.giverCamp, 0),
        quest.requires || '',
        quest.type || 'kill',
        quest.mob || '',
        numberOrBlank(quest.count, 1),
        quest.item || '',
        quest.named || '',
        yesNo(quest.elite),
        dungeonLabel,
        quest.dungeonId || '',
        quest.protectRole || '',
        numberOrBlank(quest.protectCamp, 0),
        yesNo(quest.custom),
        quest.text || '',
        numberOrBlank(quest.coins, 0),
        numberOrBlank(quest.xp, 0),
        quest.rewardKind || '',
        quest.rewardName || '',
        numberOrBlank(quest.rewardQty, 1),
        quest.id || ''
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

function listRule(column, sheet, count, sourceColumn = 'A') {
    if (!count) return null;
    return validation(column, sheet + '!$' + sourceColumn + '$2:$' + sourceColumn + '$' + (count + 1));
}

function columnRows(columns) {
    const width = Math.max(...columns.map(column => column.length), 0);
    const rows = [];
    for (let i = 0; i < width; i++) rows.push(columns.map(column => column[i] || ''));
    return rows;
}

const HOW_NOTES = [
    'In setup, paste the Google Sheet link and import from it. Share the sheet as anyone with the link. Setup also shows an export link you can open instead of downloading.',
    'Do not rename the blue header row. The game reads those column names.',
    'Read Name first. What it is explains the row in plain language. The game ignores that column when you import.',
    'Game id is the internal id. Leave it alone on a row that already exists. On a new row, leave it blank and the game makes one from the name.',
    'Zone and Dungeon are dropdowns of names from this world. If two places share a name, the choice includes the id. On import, a matching name is used instead of the id column.',
    'Icon is a dropdown of picture names, such as Plate helm or Sword. You can also type a cell number. The picture grid is 16 across, starting at 0. A typed number is kept even though it is not in the list.',
    'Materials are written as cloth:2, ore:1. Yes and no columns are dropdowns.',
    'Edit Items, Quests, or both, then import that link on the setup page. If a sheet is missing, that part of the game is left alone.',
    'A spreadsheet exported before this layout still imports.'
];

export function buildWorkbook({ items, quests, zones, dungeons, lists }) {
    lists = lists || {};
    const zoneChoices = placeChoices(zones);
    const dungeonChoices = placeChoices(dungeons);
    const itemRows = (items || []).map(itemRow);
    const questRows = (quests || []).map(quest => questRow(quest, zoneChoices, dungeonChoices));
    const icons = iconCatalog();
    const iconRows = icons.map(entry => [entry.label, entry.key, entry.index, entry.means]);
    const listRows = columnRows([
        lists.kind || [],
        lists.slot || [],
        lists.style || [],
        lists.weapon || [],
        lists.set || [],
        lists.yes || [],
        lists.type || [],
        lists.mob || [],
        lists.reward || [],
        lists.role || []
    ]);
    const zoneRows = zoneChoices.map(entry => [entry.label, entry.id, entry.name]);
    const dungeonRows = dungeonChoices.map(entry => [entry.label, entry.id, entry.name]);
    const sheets = [
        {
            name: 'Items',
            xml: sheetXml(ITEM_HEADERS, itemRows, {
                selected: true,
                filter: true,
                wrapCol: 1,
                rowHeight: 48,
                widths: ITEM_WIDTHS,
                validations: [
                    listRule('C', 'Lists', (lists.set || []).length, 'E'),
                    listRule('D', 'Lists', (lists.kind || []).length, 'A'),
                    listRule('E', 'Lists', (lists.slot || []).length, 'B'),
                    listRule('F', 'Lists', (lists.style || []).length, 'C'),
                    listRule('G', 'Lists', (lists.weapon || []).length, 'D'),
                    listRule('J', 'Lists', (lists.yes || []).length, 'F'),
                    listRule('K', 'Lists', (lists.yes || []).length, 'F'),
                    listRule('Q', 'Icons', iconRows.length, 'A')
                ]
            })
        },
        {
            name: 'Quests',
            xml: sheetXml(QUEST_HEADERS, questRows, {
                filter: true,
                wrapCol: 1,
                rowHeight: 48,
                widths: QUEST_WIDTHS,
                validations: [
                    listRule('C', 'Zones', zoneRows.length, 'A'),
                    listRule('G', 'Lists', (lists.role || []).length, 'J'),
                    listRule('J', 'Lists', (lists.type || []).length, 'G'),
                    listRule('K', 'Lists', (lists.mob || []).length, 'H'),
                    listRule('O', 'Lists', (lists.yes || []).length, 'F'),
                    listRule('P', 'Dungeons', dungeonRows.length, 'A'),
                    listRule('R', 'Lists', (lists.role || []).length, 'J'),
                    listRule('T', 'Lists', (lists.yes || []).length, 'F'),
                    listRule('X', 'Lists', (lists.reward || []).length, 'I')
                ]
            })
        },
        { name: 'Icons', xml: sheetXml(['Picture', 'Key', 'Cell', 'What you see'], iconRows, { widths: [22, 22, 10, 64], wrapCol: 3, rowHeight: 32 }) },
        { name: 'Lists', xml: sheetXml(['kind', 'slot', 'style', 'weapon', 'set', 'yes', 'type', 'mob', 'reward', 'role'], listRows) },
        { name: 'Zones', xml: sheetXml(['Zone', 'Game id', 'Name'], zoneRows, { widths: [28, 22, 28] }) },
        { name: 'Dungeons', xml: sheetXml(['Dungeon', 'Game id', 'Name'], dungeonRows, { widths: [28, 22, 28] }) },
        { name: 'How', xml: sheetXml(['How to use this in Google Sheets'], HOW_NOTES.map(note => [note]), { widths: [120], wrapCol: 0, rowHeight: 32, freeze: true }) }
    ];
    return zipSheets(sheets);
}

function resolvePlace(label, id, choices) {
    const text = String(label || '').trim();
    const current = String(id || '').trim();
    if (!text) return current;
    const byLabel = choices.filter(entry => entry.label === text);
    if (byLabel.length === 1) return byLabel[0].id;
    const byName = choices.filter(entry => entry.name === text);
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) {
        const same = byName.find(entry => entry.id === current);
        return same ? same.id : byName[0].id;
    }
    const wrapped = text.match(/^(.*) \(([^)]+)\)$/);
    if (wrapped) {
        const found = choices.find(entry => entry.id === wrapped[2]);
        if (found) return found.id;
    }
    const byId = choices.find(entry => entry.id === text);
    if (byId) return byId.id;
    return current;
}

export function applyQuestPlaces(quests, zones, dungeons) {
    if (!Array.isArray(quests)) return quests;
    const zoneChoices = placeChoices(zones);
    const dungeonChoices = placeChoices(dungeons);
    return quests.map(quest => {
        const next = {
            ...quest,
            zoneId: resolvePlace(quest.zoneName, quest.zoneId, zoneChoices),
            dungeonId: resolvePlace(quest.dungeonName, quest.dungeonId, dungeonChoices)
        };
        delete next.zoneName;
        delete next.dungeonName;
        delete next.about;
        return next;
    });
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
            '<fonts count="2">' +
            '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
            '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
            '</fonts>' +
            '<fills count="3">' +
            '<fill><patternFill patternType="none"/></fill>' +
            '<fill><patternFill patternType="gray125"/></fill>' +
            '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>' +
            '</fills>' +
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            '<cellXfs count="3">' +
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
            '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>' +
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
            '</cellXfs>' +
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
    return text.replace(/\u0026lt;/g, '<').replace(/\u0026gt;/g, '>').replace(/\u0026quot;/g, '"').replace(/\u0026apos;/g, "'").replace(/\u0026#39;/g, "'").replace(/\u0026amp;/g, '&');
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
    const headers = (rows[0] || []).map(value => HEADER_ALIAS.get(String(value || '').trim().toLowerCase()) || '');
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

function normalizeItem(row) {
    if (!row || (!String(row.name || '').trim() && !String(row.id || '').trim())) return null;
    return {
        id: row.id || '',
        name: row.name || '',
        set: row.set || '',
        kind: row.kind || '',
        slot: row.slot || '',
        style: row.style || '',
        weapon: row.weapon || '',
        armor: row.armor == null ? '' : row.armor,
        amount: row.amount == null ? '' : row.amount,
        magic: row.magic || '',
        loot: row.loot || '',
        cost: row.cost || '',
        strength: row.strength == null ? '' : row.strength,
        stamina: row.stamina == null ? '' : row.stamina,
        intellect: row.intellect == null ? '' : row.intellect,
        reqLevel: row.reqLevel == null || row.reqLevel === '' ? '' : row.reqLevel,
        icon: iconKeyFromChoice(row.icon)
    };
}

function normalizeQuest(row) {
    if (!row || (!String(row.name || '').trim() && !String(row.id || '').trim())) return null;
    return {
        id: row.id || '',
        name: row.name || '',
        zoneName: row.zoneName || '',
        zoneId: row.zoneId || '',
        minLevel: row.minLevel == null ? '' : row.minLevel,
        giver: row.giver || '',
        giverRole: row.giverRole || '',
        giverCamp: row.giverCamp == null ? '' : row.giverCamp,
        requires: row.requires || '',
        type: row.type || '',
        mob: row.mob || '',
        count: row.count == null ? '' : row.count,
        item: row.item || '',
        named: row.named || '',
        elite: row.elite || '',
        dungeonName: row.dungeonName || '',
        dungeonId: row.dungeonId || '',
        protectRole: row.protectRole || '',
        protectCamp: row.protectCamp == null ? '' : row.protectCamp,
        custom: row.custom || '',
        text: row.text || '',
        coins: row.coins == null ? '' : row.coins,
        xp: row.xp == null ? '' : row.xp,
        rewardKind: row.rewardKind || '',
        rewardName: row.rewardName || '',
        rewardQty: row.rewardQty == null ? '' : row.rewardQty
    };
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
        items: itemsXml ? sheetTable(itemsXml, strings).map(normalizeItem).filter(Boolean) : null,
        quests: questsXml ? sheetTable(questsXml, strings).map(normalizeQuest).filter(Boolean) : null
    };
}

export { listColumn };

function blockedSpreadsheetHost(host) {
    const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!name || name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name === 'metadata.google.internal' || name === '::1') return true;
    const parts = name.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!parts) return false;
    const n = parts.slice(1).map(Number);
    if (n[0] === 0 || n[0] === 10 || n[0] === 127) return true;
    if (n[0] === 169 && n[1] === 254) return true;
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
    if (n[0] === 192 && n[1] === 168) return true;
    if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return true;
    return false;
}

export function spreadsheetUrl(input) {
    const text = String(input || '').trim();
    if (!text || text.length > 2000) throw new Error('Paste a Google Sheet link');
    let url;
    try { url = new URL(text); } catch { throw new Error('That is not a spreadsheet link'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The link has to start with https');
    if (blockedSpreadsheetHost(url.hostname)) throw new Error('That link cannot be used');
    if (url.hostname.toLowerCase() !== 'docs.google.com') return url;
    const published = url.pathname.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]{10,})/);
    if (published) {
        if (url.pathname.includes('/pub')) url.searchParams.set('output', 'xlsx');
        return url;
    }
    const id = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})(?:\/|$)/);
    if (!id) throw new Error('Paste the Google Sheet link from the address bar');
    const out = new URL('https://docs.google.com/spreadsheets/d/' + id[1] + '/export');
    out.searchParams.set('format', 'xlsx');
    const resource = url.searchParams.get('resourcekey');
    if (resource) out.searchParams.set('resourcekey', resource);
    return out;
}
