/*
 * From https://www.redblobgames.com/x/2126-roguelike-dev/
 * Copyright 2021 Red Blob Games <redblobgames@gmail.com>
 * License: Apache-2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * rot.js licensed under BSD 3-Clause "New" or "Revised" License
 * <https://github.com/ondras/rot.js/blob/master/license.txt>
 */

import { RNG, Util } from "./third-party/rotjs_lib/";
import { EQUIP_MAIN_HAND, EQUIP_OFF_HAND, NUM_LAYERS, NOWHERE,
         entities, Point, Location, Entity, EntityOnMap } from "./entity";

let DEBUG_ALL_VISIBLE = true; // TODO: fov is broken, need to rewrite it

const NUM_ROOMS = 100;
const WIDTH = 40, HEIGHT = 30;
const VIEWWIDTH = 21, VIEWHEIGHT = 15;
RNG.setSeed(127);


type TileData = {
    roomId: number,
    explored: boolean;
};
type TileMap<T> = {
    _values: any;
    has(x: number, y: number): boolean;
    get(x: number, y: number): T;
    set(x: number, y: number, value: T): void;
};
type WallSet = {
    has(x: number, y: number, s: Side): boolean;
    add(x: number, y: number, s: Side): void;
    delete(x: number, y: number, s: Side): void;
};
type GameMap = {
    dungeonLevel: number;
    tiles: TileMap<TileData>;
    walls: WallSet;
    rooms: any[];
    fov?: any; // NOTE: can't convince typescript to use FOV.PreciseShadowcasting
};

const display = {
    el: document.querySelector("#game") as SVGSVGElement,
    eventToPosition(event: MouseEvent) {         // Compatibility with ROT.js
        let point = this.el.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        let coords = point.matrixTransform(this.el.querySelector(".view").getScreenCTM().inverse());
        let x = Math.floor(coords.x), y = Math.floor(coords.y);
        if (0 <= x && x < WIDTH && 0 <= y && y < HEIGHT) { return [x, y]; }
        else { return [-1, -1]; }
    },
};
display.el.setAttribute('viewBox', `0 0 ${VIEWWIDTH} ${VIEWHEIGHT}`);

/** like python's randint */
const randint = RNG.getUniformInt.bind(RNG);

/** euclidean distance */
function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** step function: given a sorted table [[x, y], …] 
    and an input x1, return the y1 for the first x that is <x1 */
function evaluateStepFunction(table: number[][], x: number) {
    let candidates = table.filter(xy => x >= xy[0]);
    return candidates.length > 0 ? candidates[candidates.length-1][1] : 0;
}

/** console messages */
const MAX_MESSAGE_LINES = 100;
let messages = []; // [text, className]
function drawMessages() {
    let messageBox = document.querySelector("#messages");
    // If there are more messages than there are <div>s, add some
    while (messageBox.children.length < messages.length) {
        messageBox.appendChild(document.createElement('div'));
    }
    // Remove any extra <div>s
    while (messages.length < messageBox.children.length) {
        messageBox.removeChild(messageBox.lastChild);
    }
    // Update the <div>s to have the right message text and color
    for (let line = 0; line < messages.length; line++) {
        let div = messageBox.children[line];
        div.textContent = messages[line][0];
        div.setAttribute('class', messages[line][1]);
    }
    // Scroll to the bottom
    messageBox.scrollTop = messageBox.scrollHeight;
}

function print(message: string, className: string) {
    messages.push([message, className]);
    messages.splice(0, messages.length - MAX_MESSAGE_LINES);
    drawMessages();
}

/** overlay messages - hide if text is empty, optionally clear automatically */
const [setOverlayMessage, setTemporaryOverlayMessage] = (() => {
    let area = document.querySelector("#message-overlay");
    let timeout = 0;
    function set(text: string) {
        clearTimeout(timeout);
        area.textContent = text;
        area.classList.toggle('visible', !!text);
    }
    return [
        set,
        function(text: string) {
            set(text);
            timeout = setTimeout(() => { area.classList.remove('visible'); }, 1000);
        }
    ];
})();

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

/** inventory is represented as an array with (null | entity.id) */
function createInventoryArray(capacity: number): any[] {
    return Array.from({length: capacity}, () => null);
}

let player = (function() {
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

function populateRoom(room, dungeonLevel: number) {
    let maxMonstersPerRoom = evaluateStepFunction([[1, 2], [4, 3], [6, 5]], dungeonLevel),
        maxItemsPerRoom = evaluateStepFunction([[1, 1], [4, 2]], dungeonLevel);

    const ai = {behavior: 'move_to_player'};
    const monsterChances = {
        orc: 80,
        troll: evaluateStepFunction([[3, 15], [5, 30], [7, 60]], dungeonLevel),
    };
    const monsterProps = {
        orc:   {base_max_hp: 20, base_defense: 0, base_power: 4, ai},
        troll: {base_max_hp: 30, base_defense: 2, base_power: 8, ai},
    };
    
    const numMonsters = randint(0, maxMonstersPerRoom);
    for (let i = 0; i < numMonsters; i++) {
        let {x, y} = RNG.getItem(room.tiles);
        if (!entities.blockingEntityAt(x, y)) {
            let type = RNG.getWeightedValue(monsterChances);
            entities.create(type, {x, y}, monsterProps[type]);
        }
    }

    const itemChances = {
        'healing potion': 70,
        'lightning scroll': evaluateStepFunction([[4, 25]], dungeonLevel),
        'fireball scroll': evaluateStepFunction([[6, 25]], dungeonLevel),
        'confusion scroll': evaluateStepFunction([[2, 10]], dungeonLevel),
        sword: evaluateStepFunction([[4, 5]], dungeonLevel),
        shield: evaluateStepFunction([[8, 15]], dungeonLevel),
    };
    const numItems = randint(0, maxItemsPerRoom);
    for (let i = 0; i < numItems; i++) {
        let {x, y} = RNG.getItem(room.tiles);
        if (entities.allAt(x, y).length === 0) {
            entities.create(RNG.getWeightedValue(itemChances), {x, y});
        }
    }
}

function createTileMap<T>(): TileMap<T> {
    function key(x: number, y: number) { return `${x},${y}`; }
    return {
        _values: {}, // use object instead of Map so it can be saved to json
        has(x: number, y: number): boolean  { return this._values[key(x, y)] !== undefined; },
        get(x: number, y: number): T        { return this._values[key(x, y)]; },
        set(x: number, y: number, value: T) { this._values[key(x, y)] = value; },
    };
}

type Side = 'W' | 'N';
function createWallSet() {
    function key(x: number, y: number, s: Side) { return `${x},${y},${s}`; }
    return {
        _values: {},
        has(x: number, y: number, s: Side): boolean { return this._values[key(x, y, s)] !== undefined; },
        add(x: number, y: number, s: Side)          { this._values[key(x, y, s)] = true; },
        delete(x: number, y: number, s: Side)       { delete this._values[key(x, y, s)]; },
    };
}
        
function updateTileMapFov(_gameMap: GameMap) {
    // TODO: need to implement this for thin walls
}

function edgeBetween(a: Point, b: Point): undefined | {x: number, y: number, s: Side} {
    if (a.x === b.x && a.y === b.y-1) { return {x: b.x, y: b.y, s: 'N'}; }
    if (a.x === b.x && a.y === b.y+1) { return {x: a.x, y: a.y, s: 'N'}; }
    if (a.x === b.x-1 && a.y === b.y) { return {x: b.x, y: b.y, s: 'W'}; }
    if (a.x === b.x+1 && a.y === b.y) { return {x: a.x, y: a.y, s: 'W'}; }
    return undefined;
}

function canMoveTo(entity: EntityOnMap, x: number, y: number): boolean {
    let edge = edgeBetween(entity.location, {x, y});
    return !gameMap.walls.has(edge.x, edge.y, edge.s);
}

function createGameMap(dungeonLevel: number): GameMap {
    let gameMap = {
        dungeonLevel,
        tiles: createTileMap<TileData>(),
        walls: createWallSet(),
        rooms: [],
        doors: new Map<string, {tile1: Point, tile2: Point, open: boolean}>(),
    };

    const seeds = Array.from({length: NUM_ROOMS}, () => ({
        x: randint(0, WIDTH), y: randint(0, HEIGHT)
    }));
    const DIRS_8 = [[0, -1], [+1, 0], [0, +1], [-1, 0],
                    [-1, -1], [+1, -1], [+1, +1], [-1, +1]];
    gameMap.rooms = seeds.map(seed => ({center: seed, tiles: []}));

    for (let roomId = 0; roomId < NUM_ROOMS; roomId++) {
        let roomSize = randint(0, 100) < 10 ? {w: 10, h: 1}
            : randint(0, 100) < 10 ? {w: 1, h: 10}
            : roomId < NUM_ROOMS * 0.9 ? {w: randint(2, 8), h: randint(2, 8)}
            : {w: 15, h: 15};
        
        let left   = Math.max(0, seeds[roomId].x - (roomSize.w >> 1)),
            top    = Math.max(0, seeds[roomId].y - (roomSize.h >> 1)),
            right  = Math.min(WIDTH-1, left + roomSize.w - 1),
            bottom = Math.min(HEIGHT-1, top + roomSize.h - 1);

        let start = seeds[roomId];
        if (gameMap.tiles.has(start.x, start.y)) {
            // This room was placed inside an existing room, so skip it. It will be allocated 0 tiles.
            continue;
        }
        let queue = [start];
        let queueIndex = 0;
        gameMap.tiles.set(start.x, start.y, {roomId, explored: false});
        while (queueIndex < queue.length) {
            let current = queue[queueIndex++];
            for (let neighbor of DIRS_8.map(([dx, dy]) => ({x: current.x + dx, y: current.y + dy}))) {
                if (neighbor.x < left || neighbor.x > right || neighbor.y < top || neighbor.y > bottom) {
                    continue; // out of bounds
                }
                if (!gameMap.tiles.has(neighbor.x, neighbor.y)) {
                    gameMap.tiles.set(neighbor.x, neighbor.y, {roomId, explored: false});
                    queue.push(neighbor);
                }
            }
        }
        gameMap.rooms[roomId].tiles = queue;
    }

    gameMap.rooms = gameMap.rooms.filter(room => room.tiles.length > 0); // remove rooms that failed to allocate
    gameMap.dungeonLevel = dungeonLevel;

    // Add thin walls between rooms. One thin wall between each pair of rooms will become a door.
    let doorCandidates = new Map<string, {tile1: Point, tile2: Point, edge: {x, y, s}}[]>();
    function addWallMaybe(x1: number, y1: number, x2: number, y2: number, edge: {x, y, s}) {
        let room1 = roomAt(x1, y1), room2 = roomAt(x2, y2);
        if (room1 !== room2) {
            gameMap.walls.add(edge.x, edge.y, edge.s);
            if (room1 !== null && room2 !== null) {
                // Wish we had something like python's setdefault
                let key = `${Math.min(room1, room2)},${Math.max(room1, room2)}`;
                let edges = doorCandidates.has(key) ? doorCandidates.get(key) : [];
                edges.push({tile1: {x: x1, y: y1}, tile2: {x: x2, y: y2}, edge});
                doorCandidates.set(key, edges);
            }
        }
    }
    function roomAt(x: number, y: number) { return gameMap.tiles.get(x, y)?.roomId ?? null; }
    for (let y = 0; y <= HEIGHT; y++) {
        for (let x = 0; x <= WIDTH; x++) {
            addWallMaybe(x-1, y, x, y, {x, y, s: 'W'});
            addWallMaybe(x, y-1, x, y, {x, y, s: 'N'});
        }
    }

    // Now add doors by removing walls
    for (let doors of doorCandidates.values()) {
        let {edge} = RNG.getItem(doors);
        gameMap.walls.delete(edge.x, edge.y, edge.s);
    }

    // TODO: ensure all or most of the rooms are connected
    
    // Put the player in the first room
    let {x: playerX, y: playerY} = gameMap.rooms[0].center;
    entities.moveEntityTo(player, {x: playerX, y: playerY});

    // Put stairs in the last room
    let {x: stairX, y: stairY} = gameMap.rooms[gameMap.rooms.length-1].center;
    entities.create('stairs', {x: stairX, y: stairY});

    // Put monster and items in all the rooms
    for (let room of gameMap.rooms) {
        populateRoom(room, dungeonLevel);
    }

    updateTileMapFov(gameMap);
    return gameMap;
}

let gameMap = createGameMap(1);



function computeLightMap(_center: Point, _gameMap: GameMap) {
    let lightMap = createTileMap<number>(); // 0.0–1.0
    // TODO: FOV with thin walls
    if (DEBUG_ALL_VISIBLE) {
        lightMap.get = (_x, _y) => 1.0;
    }
    return lightMap;
}

let previouslyDrawnSprites = Array.from({length: NUM_LAYERS}, () => new Map<number, SVGElement>());
function draw() {
    document.querySelector<HTMLElement>("#health-bar").style.width = `${Math.ceil(100*player.hp/player.effective_max_hp)}%`;
    document.querySelector<HTMLElement>("#health-text").textContent = ` HP: ${player.hp} / ${player.effective_max_hp}`;

    let lightMap = computeLightMap(player.location, gameMap);

    // Draw the map
    let svgTileHtml = ``;
    let svgWallHtml = ``;
    function explored(x: number, y: number) { return true; /* gameMap.tiles.has(x, y) && gameMap.tiles.get(x, y).explored; */ }
    for (let y = Math.floor(player.location.y - VIEWHEIGHT/2);
         y <= Math.ceil(player.location.y + VIEWHEIGHT/2); y++) {
        for (let x = Math.floor(player.location.x - VIEWWIDTH/2);
             x <= Math.ceil(player.location.x + VIEWWIDTH/2); x++) {
            let lit = lightMap.get(x, y) > 0;
            if (lit || explored(x, y)) {
                let bg = lit ? "hsl(50, 5%, 35%)" : "hsl(250, 10%, 25%)";
                let hue = (gameMap.tiles.get(x, y)?.roomId ?? -1) / NUM_ROOMS * 360 | 0;
                if (hue >= 0) bg = `hsl(${hue}, 20%, 45%)`;
                svgTileHtml += `<rect x="${x}" y="${y}" width="1" height="1" fill="${bg}" stroke="${bg}" stroke-width="0.05"/>`;
            }
            if (gameMap.walls.has(x, y, 'W') && (explored(x, y) || explored(x-1, y))) {
                let fg = Math.max(lightMap.get(x, y), lightMap.get(x-1, y)) > 0 ? "hsl(50, 15%, 65%)" : "hsl(250, 25%, 30%)";
                svgWallHtml += `<line x1="${x}" y1="${y}" x2="${x}" y2="${y+1}" fill="none" stroke="${fg}" stroke-width="0.1" stroke-linecap="round"/>`;
            }
            if (gameMap.walls.has(x, y, 'N') && (explored(x, y) || explored(x, y-1))) {
                let fg = Math.max(lightMap.get(x, y), lightMap.get(x, y-1)) > 0 ? "hsl(50, 15%, 65%)" : "hsl(250, 25%, 30%)";
                svgWallHtml += `<line x1="${x}" y1="${y}" x2="${x+1}" y2="${y}" fill="none" stroke="${fg}" stroke-width="0.1" stroke-linecap="round"/>`;
            }
        }
    }
    display.el.querySelector<HTMLElement>(".view").style.transform = `translate(${-player.location.x-0.5+VIEWWIDTH/2}px, ${-player.location.y-0.5+VIEWHEIGHT/2}px)`;
    display.el.querySelector(".map").innerHTML = svgTileHtml + svgWallHtml;

    // Draw the entities on top of the map. This is a little tricky in
    // SVG because there are two conflicting goals:
    //    1. I want to use CSS transition, so I need to reuse the DOM nodes.
    //    2. SVG draws in DOM order, so I need the DOM to be in my order.
    // But the various ways to reorder DOM nodes lose the CSS transitions!
    // So my solution is to not have a total order, but only have layers,
    // and then have CSS transitions only work within a layer.
    let spritesToDraw = Array.from({length: NUM_LAYERS}, () => new Map<number, SVGElement>());
    let entitiesArray = Array.from(entities.onMap());
    for (let entity of entitiesArray) {
        let {x, y} = entity.location;
        let explored = gameMap.tiles.get(x, y)?.explored;
        if (lightMap.get(x, y) > 0.0 || (explored && entity.visible_in_shadow)) {
            let layer = entity.render_layer;
            let [sprite, fg] = entity.visuals;
            // Draw it twice, once to make a wide outline to partially
            // obscure anything else on the same tile
            let node = previouslyDrawnSprites[layer].get(entity.id);
            if (!node) { node = document.createElementNS("http://www.w3.org/2000/svg", 'g'); }
            node.setAttribute('class', "entity");
            node.innerHTML = `
                <use class="entity-bg" width="1" height="1" href="#${sprite}"/>
                <use class="entity-fg" width="1" height="1" href="#${sprite}" fill="${fg}"/>
            `;
            node.style.transform = `translate(${x}px,${y}px)`;
            spritesToDraw[layer].set(entity.id, node);
        }
    }
    for (let layer = 0; layer < NUM_LAYERS; layer++) {
        let g = display.el.querySelector(`.entities-${layer}`);
        for (let [id, node] of spritesToDraw[layer].entries()) {
            if (!previouslyDrawnSprites[layer].has(id)) {
                g.appendChild(node);
            }
        }
        for (let [id, node] of previouslyDrawnSprites[layer].entries()) {
            if (!spritesToDraw[layer].has(id)) {
                g.removeChild(node);
            }
        }
        previouslyDrawnSprites[layer] = spritesToDraw[layer];
    }
    
    updateInstructions();
}

function updateInstructions() {
    const instructions = document.getElementById('game-instructions');
    let standingOn = entities.allAt(player.location.x, player.location.y);
    
    let html = ``;
    if (currentKeyHandler() === handlePlayerKeys) {
        html = `Arrows move, <kbd>S</kbd>ave`;
        let hasItems = player.inventory.filter(id => id !== null).length > 0;
        let onItem = standingOn.filter(e => e.item).length > 0;
        let onStairs = standingOn.filter(e => e.stairs).length > 0;
        html += ` game`;
        if (hasItems) html += `, <kbd>U</kbd>se, <kbd>D</kbd>rop`;
        if (onItem) html += `, <kbd>G</kbd>et item`;
        if (onStairs) html += `, <kbd>&gt;</kbd> stairs`;
    }
    instructions.innerHTML = html;
}


//////////////////////////////////////////////////////////////////////
// items

function useItem(entity: EntityOnMap, item: Entity) {
    switch (item.type) {
    case 'healing potion': {
        const healing = 40;
        if (entity.hp === entity.effective_max_hp) {
            print(`You are already at full health`, 'warning');
        } else {
            print(`Your wounds start to feel better!`, 'healing');
            entity.hp = Util.clamp(entity.hp + healing, 0, entity.effective_max_hp);
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

function dropItem(entity: Entity, item: Entity) {
    if (entity.id !== player.id) throw `Unimplemented: non-player dropping items`;
    entities.moveEntityTo(item, player.location);
    print(`You dropped ${item.name} on the ground`, 'warning');
    enemiesMove();
}

//////////////////////////////////////////////////////////////////////
// leveling

function xpForLevel(level: number): number {
    return 200 * level + 150 * (level * (level+1)) / 2;
}


function gainXp(entity: Entity, amount: number) {
    if (entity.xp === undefined) { return; } // this entity doesn't gain experience
    entity.xp += amount;
    if (entity.id !== player.id) { throw `XP for non-player not implemented`; }
    print(`You gain ${amount} experience points.`, 'info');
    while (entity.xp > xpForLevel(entity.level)) {
        entity.level += 1;
        print(`Your battle skills grow stronger! You reached level ${entity.level}!`, 'warning');
        upgradeOverlay.open();
    }
}


//////////////////////////////////////////////////////////////////////
// combat

function takeDamage(source: Entity, target: Entity, amount: number) {
    target.hp -= amount;
    if (target.hp <= 0) {
        print(`${target.name} dies!`, target.id === player.id? 'player-die' : 'enemy-die');
        if (target.xp_award !== undefined) { gainXp(source, target.xp_award); }
        target.dead = true;
        target.type = 'corpse';
        target.name = `${target.name}'s corpse`;
        delete target.ai;
    }
}

function attack(attacker: Entity, defender: Entity) {
    let damage = attacker.effective_power - defender.effective_defense;
    let color = attacker.id === player.id? 'player-attack' : 'enemy-attack';
    if (damage > 0) {
        print(`${attacker.name} attacks ${defender.name} for ${damage} hit points.`, color);
        takeDamage(attacker, defender, damage);
    } else {
        print(`${attacker.name} attacks ${defender.name} but does no damage.`, color);
    }
}

/** return true if the item was used */
function castFireball(caster: EntityOnMap, x: number, y: number) {
    const maximum_range = 3;
    const damage = 25;
    let visibleToCaster = computeLightMap(caster.location, gameMap);
    if (!(visibleToCaster.get(x, y) > 0)) {
        print(`You cannot target a tile outside your field of view.`, 'warning');
        return false;
    }

    let visibleFromFireball = computeLightMap({x, y}, gameMap);
    let attackables = entities.onMap()
        .filter(e => e.hp !== undefined && !e.dead)
        .filter(e => visibleFromFireball.get(e.location.x, e.location.y) > 0)
        .filter(e => visibleToCaster.get(e.location.x, e.location.y) > 0)
        .filter(e => distance(e.location, {x, y}) <= maximum_range);

    print(`The fireball explodes, burning everything within ${maximum_range} tiles!`, 'player-attack');
    for (let target of attackables) {
        print(`The ${target.name} gets burned for ${damage} hit points.`, 'player-attack');
        takeDamage(caster, target, damage);
    }
    return true;
}

/** return true if the item was used */
function castConfusion(caster: EntityOnMap, x: number, y: number) {
    let visibleToCaster = computeLightMap(caster.location, gameMap);
    if (!(visibleToCaster.get(x, y) > 0)) {
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
function castLighting(caster: EntityOnMap) {
    const maximum_range = 5;
    const damage = 40;
    let visibleToCaster = computeLightMap(caster.location, gameMap);
    let attackables = entities.onMap()
        .filter(e => e.id !== caster.id)
        .filter(e => e.hp !== undefined && !e.dead)
        .filter(e => visibleToCaster.get(e.location.x, e.location.y) > 0)
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

function playerPickupItem() {
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

function playerMoveBy(dx: number, dy: number) {
    let x = player.location.x + dx,
        y = player.location.y + dy;
    if (canMoveTo(player, x, y)) {
        let target = entities.blockingEntityAt(x, y);
        if (target && target.id !== player.id) {
            attack(player, target);
        } else {
            entities.moveEntityTo(player, {x, y});
        }
        enemiesMove();
    }
}

function playerGoDownStairs() {
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
    gameMap = createGameMap(gameMap.dungeonLevel + 1);

    // Heal the player
    player.hp = Util.clamp(player.hp + Math.floor(player.effective_max_hp / 2),
                           0, player.effective_max_hp);

    print(`You take a moment to rest, and recover your strength.`, 'welcome');
    draw();
}

//////////////////////////////////////////////////////////////////////
// monster actions

function enemiesMove() {
    let lightMap = computeLightMap(player.location, gameMap);
    for (let entity of entities.onMap()) {
        if (!entity.dead && entity.ai) {
            switch (entity.ai.behavior) {
                case 'move_to_player': {
                    if (!(lightMap.get(entity.location.x, entity.location.y) > 0.0)) {
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
                        let stepx = randint(-1, 1), stepy = randint(-1, 1);
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


//////////////////////////////////////////////////////////////////////
// ui
type Action = any[];

function createTargetingOverlay() {
    const overlay = document.querySelector(`#targeting`);
    let visible = false;
    let callback = (_x: number, _y: number): void => { throw `set callback`; };

    function onClick(event: MouseEvent) {
        let [x, y] = display.eventToPosition(event);
        callback(x, y);
        // Ugh, the overlay is nice for capturing mouse events but
        // when you click, the game loses focus. Workaround:
        display.el.focus();
    }
    function onMouseMove(event: MouseEvent) {
        let [_x, _y] = display.eventToPosition(event);
        // TODO: feedback
    }

    overlay.addEventListener('click', onClick);
    overlay.addEventListener('mousemove', onMouseMove);

    return {
        get visible() { return visible; },
        open(instructions: string, callback_: (x: number, y: number) => void) {
            visible = true;
            callback = callback_;
            overlay.classList.add('visible');
            overlay.innerHTML = `<div>${instructions}</div>`;
        },
        close() {
            visible = false;
            overlay.classList.remove('visible');
        },
    };
}

function createCharacterOverlay() {
    const overlay = document.querySelector(`#overlay-character`);
    let visible = false;

    return {
        get visible() { return visible; },
        open() {
            const experienceToLevel = xpForLevel(player.level) - player.xp;
            const equipmentHTML = Object.values(player.equipment)
                  .filter(id => id !== null)
                  .map(id => entities.get(id).type)
                  .join(" and ");
            overlay.innerHTML = `<div>Character information</div>
             <ul>
               <li>Level: ${player.level}</li>
               <li>Experience: ${player.xp}</li>
               <li>Experience to Level: ${experienceToLevel}</li>
               <li>Maximum HP: ${player.base_max_hp} + ${player.increased_max_hp}</li>
               <li>Attack: ${player.base_power} + ${player.increased_power}</li>
               <li>Defense: ${player.base_defense} + ${player.increased_defense}</li>
             </ul>
             <p>Equipped: ${equipmentHTML}</p>
             <div><kbd>ESC</kbd> to exit</div>`;
            
            visible = true;
            overlay.classList.add('visible');
        },
        close() {
            visible = false;
            overlay.classList.remove('visible');
        },
    };
}

function createUpgradeOverlay() {
    const overlay = document.querySelector(`#upgrade`);
    let visible = false;

    return {
        get visible() { return visible; },
        open() {
            visible = true;
            overlay.innerHTML = `<div>Level up! Choose a stat to raise:</div>
             <ul>
               <li><kbd>A</kbd> Constitution (+20 HP, from ${player.base_max_hp})</li>
               <li><kbd>B</kbd> Strength (+1 attack, from ${player.base_power})</li>
               <li><kbd>C</kbd> Agility (+1 defense, from ${player.base_defense})</li>
             </ul>`;
            overlay.classList.add('visible');
        },
        close() {
            visible = false;
            overlay.classList.remove('visible');
        },
    };
}

function createInventoryOverlay(actionType: string) {
    const overlay = document.querySelector(`#inventory-${actionType}`);
    let visible = false;

    function draw() {
        let html = `<ul>`;
        let empty = true;
        player.inventory.forEach((id, slot) => {
            if (id !== null) {
                let item = entities.get(id);
                html += `<li><kbd>${String.fromCharCode(65 + slot)}</kbd> ${item.name}</li>`;
                empty = false;
            }
        });
        html += `</ul>`;
        if (empty) {
            html = `<div>Your inventory is empty. Press <kbd>ESC</kbd> to cancel.</div>${html}`;
        } else {
            html = `<div>Select an item to ${actionType} it, or <kbd>ESC</kbd> to cancel.</div>${html}`;
        }
        overlay.innerHTML = html;
    }

    return {
        get visible() { return visible; },
        open() { visible = true; overlay.classList.add('visible'); draw(); },
        close() { visible = false; overlay.classList.remove('visible'); },
    };
}


function handlePlayerDeadKeys(key: string): Action {
    const actions = {
        o:  ['toggle-debug'],
        c:  ['character-open'],
    };
    return actions[key];
}

function handlePlayerKeys(key: string): Action {
    const actions = {
        ArrowRight:  ['move', +1, 0],
        ArrowLeft:   ['move', -1, 0],
        ArrowDown:   ['move', 0, +1],
        ArrowUp:     ['move', 0, -1],
        l:           ['move', +1, 0],
        h:           ['move', -1, 0],
        j:           ['move', 0, +1],
        k:           ['move', 0, -1],
        z:           ['move', 0, 0],
        g:           ['pickup'],
        '>':         ['stairs-down'],
        u:           ['inventory-open-use'],
        d:           ['inventory-open-drop'],
    };
    let action = actions[key];
    return action || handlePlayerDeadKeys(key);
}

function handleUpgradeKeys(key: string): Action {
    const actions = {
        a:  ['upgrade', 'hp'],
        b:  ['upgrade', 'str'],
        c:  ['upgrade', 'def'],
    };
    return actions[key];
}

function handleInventoryKeys(action: string): (key: string) => Action {
    return key => {
        if (key === 'Escape') { return [`inventory-close-${action}`]; }
        let slot = key.charCodeAt(0) - 'a'.charCodeAt(0);
        if (0 <= slot && slot < 26) {
            let id = player.inventory[slot];
            if (id !== null) {
                return [`inventory-do-${action}`, id];
            }
        }
        return undefined;
    };
}

function handleCharacterKeys(key: string): Action {
    return (key === 'Escape' || key == 'c') && ['character-close'];
}
    
function handleTargetingKeys(key: string): Action {
    return key === 'Escape' && ['targeting-cancel'];
}

function runAction(action: Action) {
    switch (action[0]) {
    case 'move': {
        let [_, dx, dy] = action;
        playerMoveBy(dx, dy);
        break;
    }

    case 'pickup':               { playerPickupItem();           break; }
    case 'stairs-down':          { playerGoDownStairs();         break; }
    case 'inventory-open-use':   { inventoryOverlayUse.open();   break; }
    case 'inventory-close-use':  { inventoryOverlayUse.close();  break; }
    case 'inventory-open-drop':  { inventoryOverlayDrop.open();  break; }
    case 'inventory-close-drop': { inventoryOverlayDrop.close(); break; }
    case 'character-open':       { characterOverlay.open();      break; }
    case 'character-close':      { characterOverlay.close();     break; }
    case 'targeting-cancel':     { targetingOverlay.close();     break; }

    case 'upgrade': {
        let [_, stat] = action;
        switch (stat) {
        case 'hp':
            player.base_max_hp += 20;
            player.hp += 20;
            break;
        case 'str':
            player.base_power += 1;
            break;
        case 'def':
            player.base_defense += 1;
            break;
        default:
            throw `invalid upgrade ${stat}`;
        }
        upgradeOverlay.close();
        break;
    }
    case 'inventory-do-use': {
        let [_, id] = action;
        inventoryOverlayUse.close();
        useItem(player, entities.get(id));
        break;
    }
    case 'inventory-do-drop': {
        let [_, id] = action;
        inventoryOverlayDrop.close();
        dropItem(player, entities.get(id));
        break;
    }
    case 'toggle-debug': {
        DEBUG_ALL_VISIBLE = !DEBUG_ALL_VISIBLE;
        break;
    }
    default:
        throw `unhandled action ${action}`;
    }
    draw();
}

function currentKeyHandler() {
    return targetingOverlay.visible? handleTargetingKeys
         : upgradeOverlay.visible? handleUpgradeKeys
         : inventoryOverlayUse.visible? handleInventoryKeys('use')
         : inventoryOverlayDrop.visible? handleInventoryKeys('drop')
         : characterOverlay.visible? handleCharacterKeys
         : player.dead? handlePlayerDeadKeys
         : handlePlayerKeys;
}

function handleKeyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let action = currentKeyHandler()(event.key);
    if (action) {
        event.preventDefault();
        runAction(action);
    }
}

function handleMousemove(event: MouseEvent) {
    let lightMap = computeLightMap(player.location, gameMap);
    let [x, y] = display.eventToPosition(event); // returns -1, -1 for out of bounds
    let entitiesAtMouse = lightMap.get(x, y) > 0.0 ? entities.allAt(x, y) : [];
    let text = entitiesAtMouse.map(e => e.name).join("\n");
    setOverlayMessage(text);
}

function handleMouseout(_event: MouseEvent) {
    setOverlayMessage("");
}

function setupInputHandlers(display) {
    const canvas = display.el;
    const instructions = document.getElementById('focus-instructions');
    canvas.setAttribute('tabindex', "1");
    canvas.addEventListener('keydown', handleKeyDown);
    canvas.addEventListener('mousemove', handleMousemove);
    canvas.addEventListener('mouseout', handleMouseout);
    canvas.addEventListener('blur', () => { instructions.classList.add('visible'); });
    canvas.addEventListener('focus', () => { instructions.classList.remove('visible'); });
    canvas.focus();
}

print("Hello and welcome, adventurer, to yet another dungeon!", 'welcome');
const inventoryOverlayUse = createInventoryOverlay('use');
const inventoryOverlayDrop = createInventoryOverlay('drop');
const targetingOverlay = createTargetingOverlay();
const upgradeOverlay = createUpgradeOverlay();
const characterOverlay = createCharacterOverlay();
setupInputHandlers(display);
draw();
