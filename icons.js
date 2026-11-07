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
    if (value == null || value === '') return null;
    const text = String(value).trim();
    if (/^\d+$/.test(text)) {
        const n = Number(text);
        return n >= 0 && n < ICON_COUNT ? n : null;
    }
    if (Object.prototype.hasOwnProperty.call(ICON_INDEX, text)) return ICON_INDEX[text];
    const loose = text.toLowerCase().replace(/[\s_]+/g, '-');
    if (Object.prototype.hasOwnProperty.call(ICON_INDEX, loose)) return ICON_INDEX[loose];
    return null;
}

export function defaultIconName(item) {
    if (!item) return '';
    if (item.icon != null && String(item.icon).trim() !== '') return String(item.icon).trim();
    if (item.kind === 'weapon') return item.weapon === 'staff' ? 'staff' : 'sword';
    if (item.kind === 'health' || item.kind === 'mana' || item.kind === 'bomb') return item.kind;
    if (item.kind === 'armor') {
        const key = (item.slot || 'chest') + '-' + (item.style || 'plate');
        if (ICON_INDEX[key] != null) return key;
    }
    if (ICON_INDEX[item.kind] != null) return item.kind;
    return '';
}

export function iconChoices() {
    const names = Object.keys(ICON_INDEX);
    const numbers = [];
    for (let i = 0; i < ICON_COUNT; i++) numbers.push(String(i));
    return names.concat(numbers);
}
