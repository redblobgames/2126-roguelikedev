/*
 * From https://www.redblobgames.com/x/2126-roguelike-dev/
 * Copyright 2021 Red Blob Games <redblobgames@gmail.com>
 * License: Apache-2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 */

import { NOWHERE, entities, Entity, EntityOnMap } from "./entity";
import { gameMap, edgeBetween, goToNextLevel } from "./map";
import { randint, clamp, distance } from "./util";
import { print, draw, targetingOverlay, upgradeOverlay } from "./ui";

function canMoveTo(entity: EntityOnMap, x: number, y: number): boolean {
    let edge = edgeBetween(entity.location, {x, y});
    let edgeData = gameMap.edges.get(edge);
    return !edgeData || edgeData === 'open-door';
}

//////////////////////////////////////////////////////////////////////
// entities

/** swap an inventory item with an equipment slot */
function swapEquipment(entity: Entity, inventory_slot: number, equipment_slot: number) {
    let heldId = entity.inventory[inventory_slot],
        equippedId = entity.equipment[equipment_slot];
    if (heldId === null) throw `invalid: swap equipment must be with non-empty inventory slot`;
    if (equippedId === null) throw `invalid: swap equipment must be with non-empty equipment slot`;
    
    let held = entities.get(heldId);
    let equipped = entities.get(equippedId);
    if (!('carried_by' in held.location)) throw `invalid: inventory item not being held`;
    if (held.location.carried_by !== entity.id) throw `invalid: inventory item not held by entity`;
    if (held.location.slot !== inventory_slot) throw `invalid: inventory item not held in correct slot`;
    if (!('equipped_by' in equipped.location)) throw `invalid: item not equipped`;
    if (equipped.location.equipped_by !== entity.id) throw `invalid: item not equipped by entity`;
    if (equipped.location.slot !== equipment_slot) throw `invalid: item not equipped in correct slot`;
    
    let held_equipment_slot = held.equipment_slot;
    if (held_equipment_slot === undefined) throw `invalid: swap equipment must be with something equippable`;
    if (held_equipment_slot !== equipment_slot) throw `invalid: swap equipment must be to the correct slot`;
    
    entity.inventory[inventory_slot] = equippedId;
    entity.equipment[equipment_slot] = heldId;
    held.location = {equipped_by: entity.id, slot: equipment_slot};
    equipped.location = {carried_by: entity.id, slot: inventory_slot};
}

//////////////////////////////////////////////////////////////////////
// leveling

export function xpForLevel(level: number): number {
    return 200 * level + 150 * (level * (level+1)) / 2;
}


function gainXp(entity: Entity, amount: number) {
    if (entity.xp === undefined) { return; } // this entity doesn't gain experience
    entity.xp += amount;
    if (entity.id !== entities.player.id) { throw `XP for non-player not implemented`; }
    print(`You gain ${amount} experience points.`, 'info');
    while (entity.xp > xpForLevel(entity.level)) {
        entity.level += 1;
        print(`Your battle skills grow stronger! You reached level ${entity.level}!`, 'warning');
        upgradeOverlay.open();
    }
}


//////////////////////////////////////////////////////////////////////
// items

export function useItem(entity: EntityOnMap, item: Entity) {
    const player = entities.player;
    switch (item.type) {
    case 'healing potion': {
        const healing = 40;
        if (entity.hp === entity.effective_max_hp) {
            print(`You are already at full health`, 'warning');
        } else {
            print(`Your wounds start to feel better!`, 'healing');
            entity.hp = clamp(entity.hp + healing, 0, entity.effective_max_hp);
            entities.moveEntityTo(item, NOWHERE);
            enemiesMove();
        }
        break;
    }
    case 'lightning scroll': {
        if (castLighting(entity)) {
            entities.moveEntityTo(item, NOWHERE);
            enemiesMove();
            draw();
        }
        break;
    }
    case 'fireball scroll': {
        targetingOverlay.open(
            `Click a location to cast fireball, or <kbd>ESC</kbd> to cancel`,
            (x, y) => {
                if (castFireball(entity, x, y)) {
                    entities.moveEntityTo(item, NOWHERE);
                    enemiesMove();
                }
                targetingOverlay.close();
                draw();
            });
        break;
    }
    case 'confusion scroll': {
        targetingOverlay.open(
            `Click on an enemy to confuse it, or <kbd>ESC</kbd> to cancel`,
            (x, y) => {
                if (castConfusion(entity, x, y)) {
                    entities.moveEntityTo(item, NOWHERE);
                    enemiesMove();
                }
                targetingOverlay.close();
                draw();
            });
        break;
    }
    default: {
        if ('equipment_slot' in item && 'slot' in item.location) {
            let oldItem = entities.get(player.equipment[item.equipment_slot]);
            swapEquipment(player, item.location.slot, item.equipment_slot);
            print(`You unquip ${oldItem.type} and equip ${item.type}.`, 'welcome');
            enemiesMove();
        } else {
            throw `useItem on unknown item ${item}`;
        }
    }
    }
}

export function dropItem(entity: Entity, item: Entity) {
    if (entity.id !== entities.player.id) throw `Unimplemented: non-player dropping items`;
    entities.moveEntityTo(item, entities.player.location);
    print(`You dropped ${item.name} on the ground`, 'warning');
    enemiesMove();
}

//////////////////////////////////////////////////////////////////////
// combat

export function takeDamage(source: Entity, target: Entity, amount: number) {
    target.hp -= amount;
    if (target.hp <= 0) {
        print(`${target.name} dies!`, target.id === entities.player.id? 'player-die' : 'enemy-die');
        if (target.xp_award !== undefined) { gainXp(source, target.xp_award); }
        target.dead = true;
        target.type = 'corpse';
        target.name = `${target.name}'s corpse`;
        delete target.ai;
    }
}

export function attack(attacker: Entity, defender: Entity) {
    let damage = attacker.effective_power - defender.effective_defense;
    let color = attacker.id === entities.player.id? 'player-attack' : 'enemy-attack';
    if (damage > 0) {
        print(`${attacker.name} attacks ${defender.name} for ${damage} hit points.`, color);
        takeDamage(attacker, defender, damage);
    } else {
        print(`${attacker.name} attacks ${defender.name} but does no damage.`, color);
    }
}

/** return true if the item was used */
export function castFireball(caster: EntityOnMap, x: number, y: number) {
    const maximum_range = 3;
    const damage = 25;
    if (gameMap.isVisible(caster.location, {x, y})) {
        print(`You cannot target a tile outside your field of view.`, 'warning');
        return false;
    }

    let attackables = entities.onMap()
        .filter(e => e.hp !== undefined && !e.dead)
        .filter(e => gameMap.isVisible({x, y}, e.location))
        .filter(e => gameMap.isVisible(caster.location, e.location))
        .filter(e => distance(e.location, {x, y}) <= maximum_range);

    print(`The fireball explodes, burning everything within ${maximum_range} tiles!`, 'player-attack');
    for (let target of attackables) {
        print(`The ${target.name} gets burned for ${damage} hit points.`, 'player-attack');
        takeDamage(caster, target, damage);
    }
    return true;
}

/** return true if the item was used */
export function castConfusion(caster: EntityOnMap, x: number, y: number) {
    if (!gameMap.isVisible(caster.location, {x, y})) {
        print(`You cannot target a tile outside your field of view.`, 'warning');
        return false;
    }

    let target = entities.blockingEntityAt(x, y);
    if (target && target.hp !== undefined && !target.dead && target.ai) {
        target.ai = {behavior: 'confused', turns: 10};
        print(`The eyes of the ${target.name} look vacant, as it starts to stumble around!`, 'enemy-die');
        return true;
    }
    print(`There is no targetable enemy at that location.`, 'warning');
    return false;
}

/** return true if the item was used */
export function castLighting(caster: EntityOnMap) {
    const maximum_range = 5;
    const damage = 40;
    let attackables = entities.onMap()
        .filter(e => e.id !== caster.id)
        .filter(e => e.hp !== undefined && !e.dead)
        .filter(e => gameMap.isVisible(caster.location, e.location))
        .filter(e => distance(e.location, caster.location) <= maximum_range);
    attackables.sort((a, b) => distance(a.location, caster.location)
                             - distance(b.location, caster.location));
    let target = attackables[0];
    if (!target) {
        print(`No enemy is close enough to strike.`, 'error');
        return false;
    }
    print(`A lighting bolt strikes the ${target.name} with a loud thunder! The damage is ${damage}`, 'player-attack');
    takeDamage(caster, target, damage);
    return true;
}


//////////////////////////////////////////////////////////////////////
// player actions

export function playerPickupItem() {
    const player = entities.player;
    let item = entities.itemAt(player.location.x, player.location.y);
    if (!item) {
        print(`There is nothing here to pick up.`, 'warning');
        return;
    }

    let slot = player.inventory.indexOf(null); // first open inventory slot
    if (slot < 0) {
        print(`You cannot carry any more. Your inventory is full.`, 'warning');
        return;
    }

    print(`You pick up the ${item.name}!`, 'pick-up');
    entities.moveEntityTo(item, {carried_by: player.id, slot});
    enemiesMove();
}

export function playerMoveBy(dx: number, dy: number) {
    const player = entities.player;
    let x = player.location.x + dx,
        y = player.location.y + dy;
    let edge = edgeBetween(player.location, {x, y});
    if (gameMap.edges.get(edge) === 'closed-door') {
        // Open the door
        gameMap.edges.set(edge, 'open-door');
        enemiesMove();
    } else if (canMoveTo(player, x, y)) {
        let target = entities.blockingEntityAt(x, y);
        if (target && target.id !== player.id) {
            attack(player, target);
        } else {
            entities.moveEntityTo(player, {x, y});
        }
        enemiesMove();
    }
}

export function playerGoDownStairs() {
    const player = entities.player;
    if (!entities.allAt(player.location.x, player.location.y).some(e => e.stairs)) {
        print(`There are no stairs here.`, 'warning');
        return;
    }

    // Remove anything that's on the map
    for (let entity of entities.onMap()) {
        if (entity.id !== player.id) {
            entities.delete(entity.id);
        }
    }

    // Make a new map
    goToNextLevel();

    // Heal the player
    player.hp = clamp(player.hp + Math.floor(player.effective_max_hp / 2),
                      0, player.effective_max_hp);

    print(`You take a moment to rest, and recover your strength.`, 'welcome');
    draw();
}

//////////////////////////////////////////////////////////////////////
// monster actions

export function enemiesMove() {
    const player = entities.player;
    for (let entity of entities.onMap()) {
        if (!entity.dead && entity.ai) {
            switch (entity.ai.behavior) {
                case 'move_to_player': {
                    if (!gameMap.isVisible(player.location, entity.location)) {
                        // The player can't see the monster, so the monster
                        // can't see the player, so the monster doesn't move
                        continue;
                    }

                    let dx = player.location.x - entity.location.x,
                        dy = player.location.y - entity.location.y;

                    // Pick either vertical or horizontal movement randomly
                    let stepx = 0, stepy = 0;
                    if (randint(1, Math.abs(dx) + Math.abs(dy)) <= Math.abs(dx)) {
                        stepx = dx / Math.abs(dx);
                    } else {
                        stepy = dy / Math.abs(dy);
                    }
                    let x = entity.location.x + stepx,
                    y = entity.location.y + stepy;
                    if (canMoveTo(entity, x, y)) {
                        let target = entities.blockingEntityAt(x, y);
                        if (target && target.id === player.id) {
                            attack(entity, player);
                        } else if (target) {
                            // another monster there; can't move
                        } else {
                            entities.moveEntityTo(entity, {x, y});
                        }
                    }
                    break;
                }
                case 'confused': {
                    if (--entity.ai.turns > 0) {
                        let stepx = 0, stepy = 0;
                        switch (randint(0, 3)) {
                            case 0: stepx = -1; break;
                            case 1: stepx = +1; break;
                            case 2: stepy = -1; break;
                            case 3: stepy = +1; break;
                        }
                        let x = entity.location.x + stepx,
                            y = entity.location.y + stepy;
                        if (canMoveTo(entity, x, y) && !entities.blockingEntityAt(x, y)) {
                            entities.moveEntityTo(entity, {x, y});
                        }
                    } else {
                        entity.ai = {behavior: 'move_to_player'};
                        print(`The ${entity.name} is no longer confused!`, 'enemy-attack');
                    }
                    break;
                }
                default: {
                    throw `unknown enemy ai: ${entity.ai}`;
                }
            }
        }
    }
}
