/*
 * From https://www.redblobgames.com/x/2126-roguelike-dev/
 * Copyright 2021 Red Blob Games <redblobgames@gmail.com>
 * License: Apache-2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 */

export type Point = {x: number, y: number};

export const NOWHERE = {nowhere: true};
export type Location =
      typeof NOWHERE
    | Point                                 // on map
    | {carried_by: number; slot: number;}   // allowed only if .item
    | {equipped_by: number; slot: number;}  // allowed only if .equipment == slot

export type EntityAt<LocationType> = {
    id: number;
    type: string;
    blocks?: boolean;
    item?: boolean;
    equipment_slot?: any;
    render_order?: number;
    visuals: any[];
    location: LocationType;
    inventory: (number | null)[]; // should only contain entities with .item
    equipment: (number | null)[]; // should only contain items with .equipment_slot
    [key: string]: any;
};
export type Entity = EntityAt<Location>;
export type EntityOnMap = EntityAt<Point>;

/** Entity properties that are shared among all the instances of the type.
    visuals: [sprite name, color]
    item: true if can go into inventory
    equipment_slot: 0–25 if it can go into equipment, undefined otherwise
*/
export const NUM_LAYERS = 6;
export const EQUIP_MAIN_HAND = 0;
export const EQUIP_OFF_HAND = 1;
const ENTITY_PROPERTIES = {
    player: { blocks: true, render_layer: 5, visuals: ['character', "hsl(60, 100%, 70%)"], },
    stairs: { stairs: true, render_layer: 1, visuals: ['stairs', "hsl(200, 100%, 90%)"], visible_in_shadow: true, },
    troll:  { blocks: true, render_layer: 3, visuals: ['minotaur', "hsl(120, 60%, 60%)"], xp_award: 100, },
    orc:    { blocks: true, render_layer: 3, visuals: ['bully-minion', "hsl(100, 50%, 60%)"], xp_award: 35, },
    corpse: { blocks: false, render_layer: 0, visuals: ['carrion', "darkred"], },
    'healing potion': { item: true, render_layer: 2, visuals: ['health-potion', "hsl(330, 50%, 75%)"], },
    'lightning scroll': { item: true, render_layer: 2, visuals: ['scroll-unfurled', "hsl(60, 50%, 75%)"], },
    'fireball scroll': { item: true, render_layer: 2, visuals: ['scroll-unfurled', "hsl(0, 50%, 60%)"], },
    'confusion scroll': { item: true, render_layer: 2, visuals: ['scroll-unfurled', "hsl(0, 100%, 75%)"], },
    dagger: { item: true, equipment_slot: EQUIP_MAIN_HAND, render_layer: 2, bonus_power: 0, visuals: ['plain-dagger', "hsl(200, 30%, 90%)"], },
    sword: { item: true, equipment_slot: EQUIP_MAIN_HAND, render_layer: 2, bonus_power: 3, visuals: ['broadsword', "hsl(200, 30%, 90%)"], },
    towel: { item: true, equipment_slot: EQUIP_OFF_HAND, render_layer: 2, bonus_defense: 0, visuals: ['towel', "hsl(40, 50%, 80%)"], },
    shield: { item: true, equipment_slot: EQUIP_OFF_HAND, render_layer: 2, bonus_defense: 1, visuals: ['shield', "hsl(40, 50%, 80%)"], },
};
/* Always use the current value of 'type' to get the entity
    properties, so that we can change the object type later (e.g. to
    'corpse'). JS lets us forward these properties to a getter, and I
    use the getter to get the corresponding value from
    ENTITY_PROPERTIES. This loop looks weird but I kept having bugs
    where I forgot to forward a property manually, so I wanted to
    automate it. */
export function calculateEquipmentBonus(equipment, field: string) {
    if (!equipment) return 0;
    return equipment
        .filter((id: number|null) => id !== null)
        .reduce((sum: number, id: number) => sum + (entities.get(id)[field] || 0), 0);
}
const entity_prototype = {
    get increased_max_hp() { return calculateEquipmentBonus(this.equipment, 'bonus_max_hp'); },
    get increased_power() { return calculateEquipmentBonus(this.equipment, 'bonus_power'); },
    get increased_defense() { return calculateEquipmentBonus(this.equipment, 'bonus_defense'); },
    get effective_max_hp() { return this.base_max_hp + this.increased_max_hp; },
    get effective_power() { return this.base_power + this.increased_power; },
    get effective_defense() { return this.base_defense + this.increased_defense; },
};
for (let property of
     new Set(Object.values(ENTITY_PROPERTIES).flatMap(p => Object.keys(p))).values()) {
    Object.defineProperty(entity_prototype, property,
                          {get() { return ENTITY_PROPERTIES[this.type][property]; }});
}

export class Entities extends Map<number, Entity> {
    player = null;
    id = 0;

    create(type: string, location: Location, properties={}): Entity {
        let id = ++this.id;
        let entity: Entity = Object.create(entity_prototype);
        entity.name = type;
        Object.assign(entity, { id, type, location: NOWHERE, ...properties });
        this.moveEntityTo(entity, location);
        if (entity.base_max_hp !== undefined && entity.hp === undefined) {
            entity.hp = entity.base_max_hp;
        }
        this.set(id, entity);
        return entity;
    }
    
    /** all entities on the map (not being held) */
    onMap(): EntityOnMap[] {
        function isOnMap(e: Entity): e is EntityOnMap { return (e.location as Point).x !== undefined; }
        return Array.from(this.values()).filter<EntityOnMap>(isOnMap);
    }

    /** return all entities at (x, y) */
    allAt(x: number, y: number): EntityOnMap[] {
        return this.onMap().filter(e => e.location.x === x && e.location.y === y);
    }

    /** return an item at (x, y) or null if there isn't one */
    itemAt(x: number, y: number) {
        let entities = this.allAt(x, y).filter(e => e.item);
        return entities[0] ?? null;
    }

    /** return a blocking entity at (x,y) or null if there isn't one */
    blockingEntityAt(x: number, y: number) {
        let entities = this.allAt(x, y).filter(e => e.blocks);
        if (entities.length > 1) throw `invalid: more than one blocking entity at ${x},${y}`;
        return entities[0] ?? null;
    }

    /** move an entity to a new location:
     *   {x:int y:int} on the map
     *   {carried_by_by:id slot:int} in id's 'inventory' 
     *   {equipped_by:id slot:int} is a valid location but NOT allowed here
     */
    moveEntityTo(entity: Entity, location: Location) {
        if ('carried_by' in entity.location) {
            let {carried_by, slot} = entity.location;
            let carrier = this.get(carried_by);
            if (carrier.inventory[slot] !== entity.id) throw `invalid: inventory slot ${slot} contains ${carrier.inventory[slot]} but should contain ${entity.id}`;
            carrier.inventory[slot] = null;
        }
        entity.location = location;
        if ('carried_by' in entity.location) {
            let {carried_by, slot} = entity.location;
            let carrier = this.get(carried_by);
            if (carrier.inventory === undefined) throw `invalid: moving to an entity without inventory`;
            if (carrier.inventory[slot] !== null) throw `invalid: inventory already contains an item ${carrier.inventory[slot]} in slot ${slot}`;
            carrier.inventory[slot] = entity.id;
        }
    }
}


// NOTE: this has to be a global singleton! even though most of the
// code doesn't depend on that, the equipment bonuses do, for now
export let entities = new Entities();


// The player is also a global singleton, but I put it inside the
// entities object
/** inventory is represented as an array with (null | entity.id) */
function createInventoryArray(capacity: number): any[] {
    return Array.from({length: capacity}, () => null);
}

entities.player = (function() {
    let player = entities.create(
        'player', NOWHERE,
        {
            base_max_hp: 100,
            base_defense: 1, base_power: 4,
            xp: 0, level: 1,
            inventory: createInventoryArray(26),
            equipment: createInventoryArray(26),
        }
    ) as EntityOnMap; // NOTE: I'm lying, as it's not actually this type yet until I move the player to the first room

    // Insert the initial equipment with the correct invariants
    function equip(slot: number, type: string) {
        let entity = entities.create(type, {equipped_by: player.id, slot: slot});
        player.equipment[slot] = entity.id;
    }
    equip(EQUIP_MAIN_HAND, 'dagger');
    equip(EQUIP_OFF_HAND, 'towel');
    return player;
})();
