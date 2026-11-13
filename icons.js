export const SHEET_COLS = 16;
export const ICON_COUNT = 432;

export const ICON_INDEX = {
    sword: 81,
    'power-strike': 48,
    cleave: 49,
    staff: 104,
    'arcane-bolt': 8,
    'arcane-surge': 336,
    mend: 53,
    gather: 70,
    health: 144,
    mana: 145,
    bomb: 172,
    bag: 160,
    character: 117,
    wood: 272,
    stone: 273,
    cloth: 279,
    leather: 280,
    ore: 274,
    gem: 276,
    herb: 191,
    powder: 321,
    coins: 200,
    junk: 268,
    recipe: 218,
    quest: 219,
    'head-cloth': 112,
    'head-leather': 114,
    'head-plate': 113,
    'neck-cloth': 134,
    'neck-leather': 136,
    'neck-plate': 134,
    'shoulders-cloth': 120,
    'shoulders-leather': 118,
    'shoulders-plate': 116,
    'cloak-cloth': 126,
    'cloak-leather': 126,
    'cloak-plate': 126,
    'chest-cloth': 120,
    'chest-leather': 118,
    'chest-plate': 116,
    'hands-cloth': 128,
    'hands-leather': 128,
    'hands-plate': 129,
    'waist-cloth': 127,
    'waist-leather': 127,
    'waist-plate': 127,
    'legs-cloth': 122,
    'legs-leather': 122,
    'legs-plate': 122,
    'feet-cloth': 130,
    'feet-leather': 130,
    'feet-plate': 131,
    'offhand-cloth': 105,
    'offhand-leather': 96,
    'offhand-plate': 97
};

export function iconIndex(value) {
    const key = canonicalIconKey(value);
    if (!key) return null;
    if (/^\d+$/.test(key)) return Number(key);
    return Object.prototype.hasOwnProperty.call(ICON_INDEX, key) ? ICON_INDEX[key] : null;
}

export function defaultIconName(item) {
    if (!item) return '';
    if (item.icon != null && String(item.icon).trim() !== '') return String(item.icon).trim();
    if (item.kind === 'weapon') {
        if (item.weapon === 'staff') return 'staff';
        if (item.weapon === 'bow' || item.weapon === 'crossbow' || item.weapon === 'shortbow' || item.weapon === 'longbow') return 'bow';
        if (item.weapon === 'wand') return 'wand';
        return 'sword';
    }
    if (item.kind === 'health' || item.kind === 'mana' || item.kind === 'bomb') return item.kind;
    if (item.kind === 'armor') {
        const key = (item.slot || 'chest') + '-' + (item.style || 'plate');
        if (ICON_INDEX[key] != null) return key;
    }
    if (ICON_INDEX[item.kind] != null) return item.kind;
    return '';
}

const ICON_LABEL = {
    sword: 'Sword',
    'power-strike': 'Power strike',
    cleave: 'Cleave',
    staff: 'Staff',
    'arcane-bolt': 'Arcane missile',
    'arcane-surge': 'Arcane surge',
    mend: 'Mend',
    gather: 'Gather',
    health: 'Health potion',
    mana: 'Mana potion',
    bomb: 'Bomb',
    bag: 'Bag',
    character: 'Character',
    wood: 'Wood',
    stone: 'Stone',
    cloth: 'Cloth',
    leather: 'Leather',
    ore: 'Ore',
    gem: 'Gem',
    herb: 'Herb',
    powder: 'Powder',
    coins: 'Coins',
    junk: 'Junk',
    recipe: 'Pattern',
    quest: 'Quest scroll',
    'head-cloth': 'Cloth hat',
    'head-leather': 'Leather cap',
    'head-plate': 'Plate helm',
    'neck-cloth': 'Cloth necklace',
    'neck-leather': 'Leather necklace',
    'neck-plate': 'Plate necklace',
    'shoulders-cloth': 'Cloth shoulders',
    'shoulders-leather': 'Leather shoulders',
    'shoulders-plate': 'Plate shoulders',
    'cloak-cloth': 'Cloth cloak',
    'cloak-leather': 'Leather cloak',
    'cloak-plate': 'Plate cloak',
    'chest-cloth': 'Cloth robe',
    'chest-leather': 'Leather chest',
    'chest-plate': 'Plate chest',
    'hands-cloth': 'Cloth gloves',
    'hands-leather': 'Leather gloves',
    'hands-plate': 'Plate gauntlets',
    'waist-cloth': 'Cloth belt',
    'waist-leather': 'Leather belt',
    'waist-plate': 'Plate belt',
    'legs-cloth': 'Cloth pants',
    'legs-leather': 'Leather pants',
    'legs-plate': 'Plate pants',
    'feet-cloth': 'Cloth shoes',
    'feet-leather': 'Leather boots',
    'feet-plate': 'Plate boots',
    'offhand-cloth': 'Spell focus',
    'offhand-leather': 'Leather buckler',
    'offhand-plate': 'Iron buckler'
};

const LABEL_TO_KEY = new Map(Object.entries(ICON_LABEL).map(([key, label]) => [label.toLowerCase(), key]));

function canonicalIconKey(value) {
    if (value == null || value === '') return '';
    const text = String(value).trim();
    if (!text) return '';
    if (Object.prototype.hasOwnProperty.call(ICON_INDEX, text)) return text;
    const loose = text.toLowerCase().replace(/[\s_]+/g, '-');
    if (Object.prototype.hasOwnProperty.call(ICON_INDEX, loose)) return loose;
    const fromLabel = LABEL_TO_KEY.get(text.toLowerCase());
    if (fromLabel) return fromLabel;
    const iconWord = text.match(/^(?:icon|cell|picture)\s+(\d+)$/i);
    const numeric = iconWord ? iconWord[1] : (/^\d+$/.test(text) ? text : '');
    if (!numeric) return '';
    const n = Number(numeric);
    if (!(n >= 0 && n < ICON_COUNT)) return '';
    const owners = Object.keys(ICON_INDEX).filter(key => ICON_INDEX[key] === n);
    return owners.length === 1 ? owners[0] : String(n);
}

export function iconKeyFromChoice(value) {
    const key = canonicalIconKey(value);
    if (key) return key;
    return String(value ?? '').trim().slice(0, 32);
}

export function iconChoice(value) {
    const key = canonicalIconKey(value);
    if (!key) return '';
    if (ICON_LABEL[key]) return ICON_LABEL[key];
    if (/^\d+$/.test(key)) return 'Icon ' + key;
    return key;
}

export function iconCatalog() {
    return Object.keys(ICON_INDEX).map(key => ({
        key,
        label: ICON_LABEL[key] || key,
        index: ICON_INDEX[key],
        means: (ICON_LABEL[key] || key) + '. Cell ' + ICON_INDEX[key] + ' on the icon image, 16 across.'
    })).sort((a, b) => a.label.localeCompare(b.label));
}

export function iconChoices() {
    const names = Object.keys(ICON_INDEX);
    const numbers = [];
    for (let i = 0; i < ICON_COUNT; i++) numbers.push(String(i));
    return names.concat(numbers);
}
